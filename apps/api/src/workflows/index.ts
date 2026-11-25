import { randomUUID } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { CallEnvelope } from '@bs/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  connectorKey,
  diffVersions,
  identifier,
  validateGraph,
  type Values,
  type WorkflowDefinition,
} from '../../../../packages/core/src/workflows/definition.ts';
import schema from '../../../../packages/core/src/workflows/definition.schema.json' with { type: 'json' };
import {
  listTemplates,
  instantiateTemplate,
} from '../../../../packages/core/src/workflows/templates.ts';
import { recordEvents, type CatchUp } from '../../../../packages/core/src/workflows/triggers.ts';
import {
  createTriggers,
  directoryTriggerStore,
  type TriggerConfig,
  type TriggerStore,
} from './triggers.ts';
import { createBuilderWorker, WorkflowError, type Relay, type Run } from './worker.ts';

const ajv = new Ajv2020();
const definitionSchema = ajv.compile<WorkflowDefinition>(schema);
const valuesSchema = ajv.compile<Values>({
  $defs: schema.$defs,
  type: 'object',
  propertyNames: { $ref: '#/$defs/id' },
  maxProperties: 32,
  additionalProperties: {
    anyOf: [
      { $ref: '#/$defs/scalar' },
      { type: 'array', minItems: 0, maxItems: 50, items: { type: 'string', maxLength: 4000 } },
    ],
  },
});

const statuses = {
  not_found: 404,
  invalid_input: 400,
  quota_exceeded: 429,
  conflict: 409,
  unavailable: 503,
  forbidden: 403,
  unauthorized: 401,
} as const;
const prefix = '/workflow-builder/v1';

type Capability = 'read' | 'manage' | 'run' | 'ingest' | 'decide';
export type WorkflowIdentity = {
  tenantId: string;
  actor: CallEnvelope['actor'];
  roles: readonly string[];
};
export type WorkflowOptions = {
  identify: (
    request: FastifyRequest,
  ) => WorkflowIdentity | undefined | Promise<WorkflowIdentity | undefined>;
  authorize: (identity: CallEnvelope, capability: Capability) => boolean | Promise<boolean>;
  relay: Relay;
  webhookSecret?: (tenant: string, ref: string) => string | undefined | Promise<string | undefined>;
  triggerStore?: TriggerStore;
  connectors?: readonly (readonly [string, string])[];
  now?: () => number;
  python?: string;
  activeLimit?: number;
  runLimit?: number;
  pollMs?: number;
  stateDirectory?: string;
};

function invalid(detail?: string): never {
  throw new WorkflowError('invalid_input', detail);
}
function id(value: unknown): string {
  return typeof value === 'string' && identifier.test(value)
    ? value
    : invalid('Expected an identifier');
}
function integer(value: unknown, min = 1, max = 2_147_483_647): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : invalid('Invalid integer');
}
function text(value: unknown, maxLength: number): string {
  return typeof value === 'string' && !!value.trim() && value.length <= maxLength
    ? value
    : invalid('Invalid text');
}
function body(value: unknown, required: string[], optional: string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid('Expected an object');
  const data = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(data, key)) ||
    Object.keys(data).some((key) => !required.includes(key) && !optional.includes(key))
  )
    return invalid('Unexpected or missing field');
  return data;
}
function values(value: unknown) {
  return valuesSchema(value) ? value : invalid('Invalid values');
}
function params(request: FastifyRequest, key: string) {
  return id((request.params as Record<string, unknown>)[key]);
}
function checkDefinition(value: unknown, connectors: ReadonlySet<string>) {
  if (!definitionSchema(value)) return invalid('Definition does not match workflow schema');
  try {
    validateGraph(value, connectors);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : 'Invalid graph');
  }
  return value;
}

function triggerConfig(value: unknown): TriggerConfig {
  const common = ['id', 'definitionId', 'kind'];
  const base = body(value, common, [
    'values',
    'expression',
    'timeZone',
    'catchUp',
    'maxRuns',
    'name',
    'threshold',
    'secretRef',
  ]);
  const config = {
    id: id(base.id),
    definitionId: id(base.definitionId),
    values: values(base.values ?? {}),
  };
  if (base.kind === 'schedule') {
    const schedule = body(
      base,
      [...common, 'expression', 'timeZone', 'catchUp'],
      ['maxRuns', 'values'],
    );
    if (!['skip', 'run-once', 'run-all'].includes(String(schedule.catchUp)))
      return invalid('Invalid catch-up policy');
    return {
      ...config,
      kind: 'schedule',
      expression: text(schedule.expression, 256),
      timeZone: text(schedule.timeZone, 128),
      catchUp: schedule.catchUp as CatchUp,
      maxRuns: integer(schedule.maxRuns ?? 10, 1, 100),
    };
  }
  if (base.kind === 'event') {
    const event = body(base, [...common, 'name'], ['threshold', 'values']);
    const name = recordEvents.find((candidate) => candidate === event.name);
    if (!name) return invalid('Unknown event');
    const usesThreshold = name === 'customer.inactive' || name === 'invoice.overdue';
    if (!usesThreshold && Object.hasOwn(event, 'threshold')) return invalid('Unexpected threshold');
    return {
      ...config,
      kind: 'event',
      name,
      ...(usesThreshold ? { threshold: integer(event.threshold, 1, 365) } : {}),
    };
  }
  if (base.kind === 'webhook') {
    const webhook = body(base, [...common, 'secretRef'], ['values']);
    return { ...config, kind: 'webhook', secretRef: id(webhook.secretRef) };
  }
  return invalid('Unknown trigger kind');
}

export const workflowRoutes: FastifyPluginAsync<WorkflowOptions> = async (app, options) => {
  const now = options.now ?? Date.now;
  const connectorPairs = options.connectors ?? [];
  const connectors = new Set(
    connectorPairs.map(([connector, operation]) => connectorKey(id(connector), id(operation))),
  );
  const worker = createBuilderWorker({ ...options, connectors: connectorPairs });
  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; scope: CallEnvelope }>();
  const drafts = new Map<string, ReturnType<typeof instantiateTemplate>>();
  let closed = false;

  function report(reply: FastifyReply, error: unknown) {
    if (!(error instanceof WorkflowError)) {
      app.log.error('Workflow builder command unavailable');
      return reply.code(503).send({ code: 'unavailable' });
    }
    return reply.code(statuses[error.code]).send({
      code: error.code,
      ...(error.detail ? { detail: error.detail } : {}),
    });
  }

  function follow(scope: CallEnvelope | undefined, run: Run) {
    const previous = timers.get(run.id);
    if (previous) clearTimeout(previous.timer);
    // A decision endpoint may move the run but only the original owner sets its timer.
    const owner = previous?.scope ?? scope;
    if (!owner || run.dueAt === null || closed) {
      timers.delete(run.id);
      return;
    }
    const timer = setTimeout(
      async () => {
        try {
          if (closed || timers.get(run.id)?.timer !== timer) return;
          const next = await worker.invoke({
            kind: 'tick',
            scope: owner,
            runId: run.id,
            now: now(),
          });
          if (timers.get(run.id)?.timer === timer) follow(owner, next);
        } catch {
          if (timers.get(run.id)?.timer === timer) timers.delete(run.id);
          app.log.error('Workflow timer unavailable');
        }
      },
      Math.max(1, Math.min(2_147_483_647, run.dueAt - now())),
    );
    timer.unref();
    timers.set(run.id, { timer, scope: owner });
  }

  const triggers = createTriggers({
    worker,
    now,
    authorize: (scope) => options.authorize(scope, 'run'),
    secret: options.webhookSecret ?? (() => undefined),
    follow,
    store:
      options.triggerStore ??
      (options.stateDirectory ? directoryTriggerStore(options.stateDirectory) : undefined),
  });
  if (options.stateDirectory !== undefined) {
    app.addHook('onReady', async () => {
      for (const { scope, run } of await worker.invoke({ kind: 'recover' })) follow(scope, run);
    });
  }
  let polling = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  if (options.pollMs !== undefined) {
    const period = integer(options.pollMs, 1000);
    app.addHook('onReady', async () => {
      interval = setInterval(async () => {
        if (polling || closed) return;
        polling = true;
        try {
          const results = await triggers.scan();
          if (results.some((result) => 'code' in result))
            app.log.warn('Workflow schedule launch deferred');
        } catch {
          app.log.error('Workflow schedule scan unavailable');
        } finally {
          polling = false;
        }
      }, period).unref();
    });
  }
  app.addHook('onClose', async () => {
    closed = true;
    clearInterval(interval);
    for (const { timer } of timers.values()) clearTimeout(timer);
    await worker.close();
  });

  type Handler = (
    request: FastifyRequest,
    reply: FastifyReply,
    scope: CallEnvelope,
    identity: WorkflowIdentity,
  ) => unknown;
  function scoped(capability: Capability, handler: Handler) {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        const caller = await options.identify(request);
        if (!caller) throw new WorkflowError('unauthorized');
        const requestKey = randomUUID();
        const scope: CallEnvelope = {
          version: 'v1',
          source: 'workflow',
          tenantId: caller.tenantId,
          actor: caller.actor,
          traceId: requestKey,
          correlationId: requestKey,
          idempotencyKey: requestKey,
        };
        if (!(await options.authorize(scope, capability))) throw new WorkflowError('forbidden');
        return await handler(request, reply, scope, caller);
      } catch (error) {
        return report(reply, error);
      }
    };
  }

  app.get(
    prefix + '/templates',
    scoped('read', () => listTemplates()),
  );
  function template(request: FastifyRequest) {
    const input = body(request.body ?? {}, [], ['parameters']);
    try {
      const entry = instantiateTemplate(params(request, 'templateId'), input.parameters ?? {});
      if (!entry) throw new WorkflowError('not_found');
      checkDefinition(entry.definition, connectors);
      return entry;
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      return invalid(error instanceof Error ? error.message : 'Invalid template');
    }
  }
  app.post(
    prefix + '/templates/:templateId/preview',
    scoped('read', async (request, _reply, scope) => {
      const entry = template(request);
      const previewDefinition = {
        ...entry.definition,
        id: 'template-' + params(request, 'templateId'),
      };
      return {
        trigger: entry.trigger,
        parameters: entry.parameters,
        ...(await worker.invoke({
          kind: 'preview',
          scope,
          definition: previewDefinition,
          values: entry.fixture,
        })),
      };
    }),
  );
  app.post(
    prefix + '/templates/:templateId/install',
    scoped('manage', (request, reply, scope) => {
      const entry = template(request);
      drafts.set(JSON.stringify([scope.tenantId, entry.definition.id]), entry);
      return reply.code(201).send({ status: 'draft', ...entry });
    }),
  );
  app.get(
    prefix + '/drafts/:definitionId',
    scoped('read', (request, _reply, scope) => {
      const entry = drafts.get(JSON.stringify([scope.tenantId, params(request, 'definitionId')]));
      if (!entry) throw new WorkflowError('not_found');
      return { status: 'draft', ...entry };
    }),
  );
  app.post(
    prefix + '/validate',
    scoped('read', (request) => {
      checkDefinition(request.body, connectors);
      return { valid: true };
    }),
  );
  app.post(
    prefix + '/definitions',
    scoped('manage', async (request, reply, scope) => {
      const definition = checkDefinition(request.body, connectors);
      const published = await worker.invoke({ kind: 'publish', scope, definition });
      drafts.delete(JSON.stringify([scope.tenantId, definition.id]));
      return reply.code(201).send(published);
    }),
  );
  app.get(
    prefix + '/definitions/:definitionId/diff',
    scoped('read', async (request, _reply, scope) => {
      const { from, to } = body(request.query, ['from', 'to']);
      const parseVersion = (value: unknown) =>
        typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value)
          ? integer(Number(value))
          : invalid('Invalid version');
      const definitionId = params(request, 'definitionId');
      const [before, after] = await Promise.all([
        worker.invoke({ kind: 'definition', scope, definitionId, version: parseVersion(from) }),
        worker.invoke({ kind: 'definition', scope, definitionId, version: parseVersion(to) }),
      ]);
      return diffVersions(before, after);
    }),
  );
  app.post(
    prefix + '/definitions/:definitionId/release',
    scoped('manage', (request, _reply, scope) => {
      const { version } = body(request.body, ['version']);
      return worker.invoke({
        kind: 'release',
        scope,
        definitionId: params(request, 'definitionId'),
        version: integer(version),
      });
    }),
  );

  app.get(
    prefix + '/triggers',
    scoped('read', (_request, _reply, scope) => triggers.list(scope.tenantId)),
  );
  app.post(
    prefix + '/triggers',
    scoped('manage', (request, reply, scope) =>
      reply.code(201).send(triggers.create(scope, triggerConfig(request.body))),
    ),
  );
  app.post(
    prefix + '/triggers/:triggerId/pause',
    scoped('manage', (request, _reply, scope) => {
      const { paused } = body(request.body, ['paused']);
      if (typeof paused !== 'boolean') return invalid('Expected a paused boolean');
      return triggers.pause(scope.tenantId, params(request, 'triggerId'), paused);
    }),
  );
  app.post(
    prefix + '/events',
    scoped('ingest', async (request, reply, scope) => {
      const input = body(
        request.body,
        ['id', 'name', 'recordId'],
        ['recipientId', 'beforeDays', 'days', 'beforeQuantity', 'quantity', 'reorderPoint'],
      );
      const name = recordEvents.find((candidate) => candidate === input.name);
      if (!name) return invalid('Unknown record event');
      const quantities = Object.fromEntries(
        ['beforeDays', 'days', 'beforeQuantity', 'quantity', 'reorderPoint']
          .filter((key) => Object.hasOwn(input, key))
          .map((key) => [
            key,
            integer(input[key], -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
          ]),
      );
      const event = {
        ...quantities,
        id: id(input.id),
        name,
        recordId: id(input.recordId),
        ...(input.recipientId === undefined ? {} : { recipientId: id(input.recipientId) }),
      };
      return reply.code(202).send(await triggers.event(scope.tenantId, event));
    }),
  );
  await app.register(async (webhooks) => {
    webhooks.removeContentTypeParser('application/json');
    webhooks.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer', bodyLimit: 256 * 1024 },
      (_request, raw, done) => done(null, raw),
    );
    webhooks.post(prefix + '/webhooks/:tenantId/:triggerId', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      try {
        if (!Buffer.isBuffer(request.body)) return invalid('Expected a JSON request body');
        const run = await triggers.webhook(
          params(request, 'tenantId'),
          params(request, 'triggerId'),
          request.headers['x-workflow-timestamp'],
          request.headers['x-workflow-signature'],
          request.body,
          (raw) => {
            let data: unknown;
            try {
              data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
            } catch {
              return invalid('Invalid webhook JSON');
            }
            const input = body(data, ['id', 'values']);
            return { id: id(input.id), values: values(input.values) };
          },
        );
        return reply.code(202).send(run);
      } catch (error) {
        return report(reply, error);
      }
    });
  });

  app.post(
    prefix + '/runs',
    scoped('run', async (request, reply, scope) => {
      const target = body(request.body, ['definitionId', 'values'], ['version']);
      const run = await worker.invoke({
        kind: 'start',
        scope,
        definitionId: id(target.definitionId),
        trigger: 'manual',
        key: id(request.headers['idempotency-key'] ?? scope.idempotencyKey),
        values: values(target.values),
        now: now(),
        ...(target.version === undefined ? {} : { version: integer(target.version) }),
      });
      follow(scope, run);
      return reply.code(202).send(run);
    }),
  );
  app.get(
    prefix + '/runs/:runId',
    scoped('read', (request, _reply, scope) =>
      worker.invoke({ kind: 'read', scope, runId: params(request, 'runId') }),
    ),
  );
  app.get(
    prefix + '/inbox',
    scoped('decide', (_request, _reply, scope, identity) =>
      worker.invoke({ kind: 'inbox', scope, roles: [...identity.roles], now: now() }),
    ),
  );
  app.post(
    prefix + '/runs/:runId/tick',
    scoped('run', async (request, _reply, scope) => {
      const run = await worker.invoke({
        kind: 'tick',
        scope,
        runId: params(request, 'runId'),
        now: now(),
      });
      follow(scope, run);
      return run;
    }),
  );
  app.post(
    prefix + '/runs/:runId/event',
    scoped('ingest', async (request, _reply, scope) => {
      const input = body(request.body, ['event', 'key']);
      const run = await worker.invoke({
        kind: 'event',
        scope,
        runId: params(request, 'runId'),
        event: id(input.event),
        key: text(input.key, 4000),
        now: now(),
      });
      follow(undefined, run);
      return run;
    }),
  );
  app.post(
    prefix + '/runs/:runId/task',
    scoped('decide', async (request, _reply, scope, identity) => {
      const { taskId } = body(request.body, ['taskId']);
      const run = await worker.invoke({
        kind: 'task',
        scope,
        runId: params(request, 'runId'),
        taskId: id(taskId),
        roles: [...identity.roles],
        now: now(),
      });
      follow(undefined, run);
      return run;
    }),
  );
  app.post(
    prefix + '/runs/:runId/approve',
    scoped('decide', async (request, _reply, scope) => {
      const { approvalId } = body(request.body, ['approvalId']);
      const run = await worker.invoke({
        kind: 'approve',
        scope,
        runId: params(request, 'runId'),
        approvalId: id(approvalId),
        now: now(),
      });
      follow(undefined, run);
      return run;
    }),
  );
  app.post(
    prefix + '/runs/:runId/migrate',
    scoped('manage', (request, _reply, scope) => {
      const { fromVersion, toVersion } = body(request.body, ['fromVersion', 'toVersion']);
      return worker.invoke({
        kind: 'migrate',
        scope,
        runId: params(request, 'runId'),
        fromVersion: integer(fromVersion),
        toVersion: integer(toVersion),
        now: now(),
      });
    }),
  );
};
