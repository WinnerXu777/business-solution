import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { isObject } from './errors.ts';
import { apiBaseUrl } from './http.ts';
import {
  ApiError,
  UnknownOutcome,
  createClient,
  isToolName,
  type Auth,
  type CallOptions,
  type Fetch,
  type RecordKind,
  type ToolInput,
  type WorkflowTarget,
} from './index.ts';
import {
  fileProfiles,
  validEnvName,
  validProfileName,
  type CredentialReference,
  type Profiles,
  type ProfileStore,
} from './profiles.ts';

const help = `Usage: bs [--profile NAME] [--base-url URL] [--output table|json] COMMAND

  login [--tenant ID] [--api-key-env NAME | --bearer-env NAME | --device]
  whoami
  config list | use NAME
  records get KIND ID
  records list KIND ID [ID ...]
  tools call NAME [--input JSON] [--idempotency-key KEY]
  approvals list [--state STATE]
  approvals sign ID [--workflow]
  approvals reject ID --reason TEXT
  workflows list
  workflows preview ID [--version N] [--input VALUES_JSON]
  workflows run ID [--version N] [--input VALUES_JSON] [--idempotency-key KEY]
  bots run ID --prompt TEXT [--route native|byo] [--version N] [--session ID] [--idempotency-key KEY]
  llm chat MODEL --prompt TEXT [--stream]
  connectors list
  connectors sync ID [--mode snapshot|poll] [--max-pages N]
  usage
  billing summary

Record kinds: order, customer, invoice, purchase-request.
Use --json for JSON output. Streamed commands emit one JSON object per line.
`;

export function parseCliArgs(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      profile: { type: 'string' },
      'base-url': { type: 'string' },
      output: { type: 'string' },
      json: { type: 'boolean' },
      tenant: { type: 'string' },
      'api-key-env': { type: 'string' },
      'bearer-env': { type: 'string' },
      device: { type: 'boolean' },
      input: { type: 'string' },
      'idempotency-key': { type: 'string' },
      state: { type: 'string' },
      reason: { type: 'string' },
      workflow: { type: 'boolean' },
      version: { type: 'string' },
      prompt: { type: 'string' },
      route: { type: 'string' },
      session: { type: 'string' },
      stream: { type: 'boolean' },
      mode: { type: 'string' },
      'max-pages': { type: 'string' },
    },
  });
  const output = values.output ?? (values.json ? 'json' : 'table');
  if (output !== 'json' && output !== 'table') throw new Error('Expected --output table or json');
  if (values.json && output !== 'json') throw new Error('--json conflicts with --output table');
  return { positionals, values, output } as const;
}

function cell(value: unknown): string {
  if (value === undefined) return '';
  const json = JSON.stringify(value);
  return typeof value === 'string' ? json.slice(1, -1) : json;
}

export function formatOutput(value: unknown, format: 'table' | 'json'): string {
  if (format === 'json') return JSON.stringify(value ?? null);
  const rows: unknown[] = Array.isArray(value) ? value : [value];
  if (!rows.length) return '(empty)';
  const records = rows.map<Record<string, unknown>>((row) =>
    isObject(row) ? row : { value: row },
  );
  const columns = Array.from(new Set(records.flatMap(Object.keys)));
  if (!columns.length) return '(empty)';
  const grid = [
    columns.map(cell),
    ...records.map((row) =>
      columns.map((key) => cell(Object.hasOwn(row, key) ? row[key] : undefined)),
    ),
  ];
  const widths = columns.map((_, index) =>
    grid.reduce((max, row) => Math.max(max, row[index].length), 0),
  );
  return grid
    .map((row) =>
      row
        .map((value, index) => value.padEnd(widths[index]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

function requireText(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error('Missing ' + name);
  return value;
}

function oneOf<const Value extends string>(
  text: string,
  allowed: readonly Value[],
  name: string,
): Value {
  if (!(allowed as readonly string[]).includes(text))
    throw new Error(`${name} must be one of ${allowed.join(', ')}`);
  return text as Value;
}

function positiveInteger(text: string, name: string, max = 2_147_483_647) {
  const number = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  }
  return number;
}

function jsonInput(text = '{}'): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('--input must contain valid JSON');
  }
  if (!isObject(value)) throw new Error('--input must be a JSON object');
  return value;
}

function workflowValues(text?: string): NonNullable<WorkflowTarget['input']['values']> {
  const values = jsonInput(text);
  for (const value of Object.values(values)) {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !Number.isSafeInteger(value)
    ) {
      throw new Error('Workflow values must be strings, integers, booleans or null');
    }
  }
  return values as NonNullable<WorkflowTarget['input']['values']>;
}

function authFrom(env: NodeJS.ProcessEnv, reference?: CredentialReference): Auth {
  if (reference) {
    const token = requireText(env[reference.env], reference.env);
    return reference.kind === 'bearer' ? { bearerToken: token } : { apiKey: token };
  }
  if (env.BS_TOKEN) return { bearerToken: env.BS_TOKEN };
  return { apiKey: requireText(env.BS_API_KEY, 'BS_API_KEY or BS_TOKEN') };
}

const commandArgs: Record<string, [min: number, max: number]> = {
  login: [0, 0],
  whoami: [0, 0],
  'config list': [0, 0],
  'config use': [1, 1],
  'records get': [2, 2],
  'records list': [2, Infinity],
  'tools call': [1, 1],
  'approvals list': [0, 0],
  'approvals sign': [1, 1],
  'approvals reject': [1, 1],
  'workflows list': [0, 0],
  'workflows preview': [1, 1],
  'workflows run': [1, 1],
  'bots run': [1, 1],
  'llm chat': [1, 1],
  'connectors list': [0, 0],
  'connectors sync': [1, 1],
  usage: [0, 0],
  'billing summary': [0, 0],
};
const recordKinds: readonly RecordKind[] = ['order', 'customer', 'invoice', 'purchase-request'];
const approvalStates = ['pending', 'approved', 'consumed', 'rejected', 'expired'] as const;

export type CliContext = {
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  store?: ProfileStore;
  signal?: AbortSignal;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
};

export async function runCli(args: string[], context: CliContext = {}): Promise<number> {
  const { env = process.env, signal } = context;
  const out = context.stdout ?? ((text) => process.stdout.write(text));
  const err = context.stderr ?? ((text) => process.stderr.write(text));
  try {
    const { positionals, values, output } = parseCliArgs(args);
    if (values.help || !positionals.length) {
      out(help);
      return 0;
    }
    const write = (value: unknown) => out(formatOutput(value, output) + '\n');
    const [group, action, ...rest] = positionals;
    const command = ['login', 'whoami', 'usage'].includes(group)
      ? group
      : `${group} ${action ?? ''}`;
    const parameters = command === group ? positionals.slice(1) : rest;
    if (!Object.hasOwn(commandArgs, command)) throw new Error('Unknown command. Run bs --help.');
    const [min, max] = commandArgs[command];
    if (parameters.length < min || parameters.length > max) {
      throw new Error(`Wrong number of arguments for bs ${command}. Run bs --help.`);
    }
    if (command === 'login' && values.device) {
      if (values['api-key-env'] || values['bearer-env'])
        throw new Error('--device requires its own login invocation');
      write({
        status: 'device_flow_unavailable',
        next: 'Use a fixture API key or a bearer session from your host.',
      });
      return 0;
    }
    const store = context.store ?? fileProfiles(env);
    const config = await store.load();
    const name = values.profile ?? env.BS_PROFILE ?? config.active;
    if (name !== undefined && !validProfileName(name)) throw new Error('Invalid profile name');
    const profile =
      name !== undefined && Object.hasOwn(config.profiles, name)
        ? config.profiles[name]
        : undefined;
    const [first, second] = parameters;

    if (command === 'config list') {
      write(
        Object.entries(config.profiles).map(([name, value]) => ({
          name,
          active: config.active === name,
          tenant: value.tenant,
          baseUrl: value.baseUrl,
          credentialEnv: value.credential.env,
        })),
      );
      return 0;
    }
    if (command === 'config use') {
      if (!Object.hasOwn(config.profiles, first)) throw new Error('Unknown profile');
      await store.save({ ...config, active: first });
      write({ active: first });
      return 0;
    }
    const baseUrl = apiBaseUrl(
      values['base-url'] ?? env.BS_BASE_URL ?? profile?.baseUrl ?? 'http://127.0.0.1:3000',
    ).href;
    const client = (auth: Auth) =>
      createClient({
        baseUrl,
        auth,
        fetch: context.fetch,
        llm: {
          ...(env.BS_LLM_BASE_URL ? { baseUrl: env.BS_LLM_BASE_URL } : {}),
          ...(env.BS_LLM_API_KEY ? { auth: { apiKey: env.BS_LLM_API_KEY } } : {}),
        },
        connectors: {
          ...(env.BS_CONNECTORS_BASE_URL ? { baseUrl: env.BS_CONNECTORS_BASE_URL } : {}),
          ...(env.BS_CONNECTORS_TOKEN ? { auth: { bearerToken: env.BS_CONNECTORS_TOKEN } } : {}),
        },
      });
    const opts: CallOptions = { signal, idempotencyKey: values['idempotency-key'] };
    if (command === 'login') {
      if (values['bearer-env'] && values['api-key-env'])
        throw new Error('Choose one credential source');
      const credential: CredentialReference = values['bearer-env']
        ? { kind: 'bearer', env: values['bearer-env'] }
        : { kind: 'api-key', env: values['api-key-env'] ?? 'BS_API_KEY' };
      if (!validEnvName(credential.env))
        throw new Error('Invalid credential environment variable name');
      const identity = await client(authFrom(env, credential)).platform.getPlatformIdentity({
        options: { signal },
      });
      const tenant = identity.tenant.id;
      if (values.tenant !== undefined && values.tenant !== tenant)
        throw new Error('Credential belongs to another tenant');
      const profileName = values.profile ?? env.BS_PROFILE ?? tenant;
      if (!validProfileName(profileName)) throw new Error('Choose a valid --profile name');
      const next: Profiles = {
        active: profileName,
        profiles: { ...config.profiles, [profileName]: { tenant, baseUrl, credential } },
      };
      await store.save(next);
      write({ profile: profileName, tenant, actor: identity.actor.id });
      return 0;
    }

    if (name && !profile) throw new Error('Unknown profile');
    const separateAuth =
      group === 'llm' && env.BS_LLM_API_KEY
        ? { apiKey: env.BS_LLM_API_KEY }
        : group === 'connectors' && env.BS_CONNECTORS_TOKEN
          ? { bearerToken: env.BS_CONNECTORS_TOKEN }
          : undefined;
    const sdk = client(separateAuth ?? authFrom(env, profile?.credential));
    const identity =
      profile && !separateAuth
        ? await sdk.platform.getPlatformIdentity({ options: { signal } })
        : undefined;
    if (identity && identity.tenant.id !== profile?.tenant)
      throw new Error('Credential belongs to another tenant');

    switch (command) {
      case 'whoami':
        write(identity ?? (await sdk.platform.getPlatformIdentity({ options: { signal } })));
        break;
      case 'records get': {
        const result = await sdk.records.get(
          oneOf(first, recordKinds, 'record kind'),
          second,
          opts,
        );
        write(result.state === 'ok' ? result.output : result);
        break;
      }
      case 'records list': {
        const records = [];
        for await (const result of sdk.records.list(
          oneOf(first, recordKinds, 'record kind'),
          parameters.slice(1),
          { signal },
        )) {
          records.push(result.state === 'ok' ? result.output : result);
        }
        write(records);
        break;
      }
      case 'tools call':
        if (!isToolName(first)) throw new Error('Unknown governed tool');
        write(
          await sdk.tools.call(first, jsonInput(values.input) as ToolInput<typeof first>, opts),
        );
        break;
      case 'approvals list':
        write(
          await sdk.platform.listPlatformApprovals({
            query: {
              state:
                values.state === undefined
                  ? undefined
                  : oneOf(values.state, approvalStates, '--state'),
            },
            options: opts,
          }),
        );
        break;
      case 'approvals sign':
        write(
          values.workflow
            ? await sdk.automation.approveWorkflow(first, opts)
            : await sdk.platform.signPlatformApproval({ path: { id: first }, options: opts }),
        );
        break;
      case 'approvals reject':
        write(
          await sdk.platform.rejectPlatformApproval({
            path: { id: first },
            body: { reason: requireText(values.reason, '--reason') },
            options: opts,
          }),
        );
        break;
      case 'workflows list':
        write(await sdk.automation.listWorkflows(opts));
        break;
      case 'workflows preview':
      case 'workflows run': {
        const target: WorkflowTarget = {
          definitionId: first,
          version: positiveInteger(values.version ?? '1', '--version'),
          input: { trigger: { kind: 'manual' }, values: workflowValues(values.input) },
        };
        write(
          command === 'workflows preview'
            ? await sdk.automation.previewWorkflow(target, opts)
            : await sdk.automation.runWorkflow(target, opts),
        );
        break;
      }
      case 'bots run': {
        const run = await sdk.automation.startBot(
          {
            botId: first,
            version: positiveInteger(values.version ?? '1', '--version'),
            sessionId:
              values.session ??
              (opts.idempotencyKey
                ? createHash('sha256').update(opts.idempotencyKey).digest('hex')
                : randomUUID()),
            prompt: requireText(values.prompt, '--prompt'),
            route: oneOf(values.route ?? 'native', ['native', 'byo'], '--route'),
          },
          opts,
        );
        write({ type: 'run', run });
        for await (const event of sdk.automation.streamBot(run.id, { signal }))
          write({ type: 'event', ...event });
        const settled = await sdk.automation.getBot(run.id, { signal });
        write({ type: 'run', run: settled });
        break;
      }
      case 'llm chat': {
        const input = {
          model: first,
          messages: [{ role: 'user' as const, content: requireText(values.prompt, '--prompt') }],
        };
        if (!values.stream) {
          write(await sdk.llm.chat(input, opts));
          break;
        }
        for await (const chunk of sdk.llm.streamChat(input, opts)) {
          if (output === 'json') write(chunk);
          else for (const choice of chunk.choices) out(cell(choice.delta.content));
        }
        if (output === 'table') out('\n');
        break;
      }
      case 'connectors list':
        write((await sdk.connectors.list(opts)).connectors);
        break;
      case 'connectors sync': {
        const mode = oneOf(values.mode ?? 'poll', ['poll', 'snapshot'], '--mode');
        if (mode === 'snapshot' && values['max-pages'] !== undefined)
          throw new Error('--max-pages requires poll mode');
        const maxPages =
          values['max-pages'] === undefined
            ? undefined
            : positiveInteger(values['max-pages'], '--max-pages', 100);
        write(
          await sdk.connectors.sync(first, mode === 'poll' ? { mode, maxPages } : { mode }, opts),
        );
        break;
      }
      case 'usage': {
        const usage = await sdk.platform.listPlatformUsage({ options: opts });
        write(output === 'table' ? usage.totals : usage);
        break;
      }
      case 'billing summary':
        write(await sdk.platform.getBillingPlan({ options: opts }));
        break;
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Command failed';
    const detail =
      error instanceof UnknownOutcome
        ? ` [action ${cell(error.actionId)}]`
        : error instanceof ApiError && error.requestId
          ? ` [request ${cell(error.requestId)}]`
          : '';
    err('bs: ' + cell(message) + detail + '\n');
    return 1;
  }
}
