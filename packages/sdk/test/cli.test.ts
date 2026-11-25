import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatOutput, parseCliArgs, runCli, type CliContext } from '../src/cli.ts';
import type { Profiles } from '../src/profiles.ts';

function fixture(
  fetch?: CliContext['fetch'],
  env: NodeJS.ProcessEnv = { BS_API_KEY: 'fixture-key' },
) {
  let config: Profiles = { profiles: {} };
  let stdout = '';
  let stderr = '';
  return {
    context: {
      env,
      fetch,
      stdout: (value) => {
        stdout += value;
      },
      stderr: (value) => {
        stderr += value;
      },
      store: {
        async load() {
          return config;
        },
        async save(next) {
          config = next;
        },
      },
    } satisfies CliContext,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get config() {
      return config;
    },
  };
}

const identity = {
  tenant: { id: 'tenant-rivetquay' },
  actor: { id: 'actor-operator', kind: 'person' },
};

test('CLI parses interspersed flags and serializes JSON and tables', () => {
  const parsed = parseCliArgs([
    '--profile',
    'fixture',
    'records',
    'get',
    'order',
    'ord-001',
    '--json',
  ]);
  assert.equal(parsed.output, 'json');
  assert.equal(parsed.values.profile, 'fixture');
  assert.deepEqual(parsed.positionals, ['records', 'get', 'order', 'ord-001']);
  assert.throws(() => parseCliArgs(['--bogus']));
  assert.throws(() => parseCliArgs(['--output', 'csv']));
  assert.deepEqual(JSON.parse(formatOutput({ id: 'ord-001' }, 'json')), { id: 'ord-001' });
  assert.equal(
    formatOutput([{ id: 'ord-001', state: 'open' }, { id: 'ord-002' }], 'table'),
    'id       state\nord-001  open\nord-002',
  );
  assert.equal(formatOutput([], 'table'), '(empty)');
});

test('login verifies tenant and stores only the credential reference; wrong-tenant profiles fail', async () => {
  const app = fixture(async (url, init) => {
    assert.equal(url.pathname, '/platform/v1/me');
    const token = new Headers(init.headers).get('authorization');
    return Response.json(
      token === 'Bearer fixture-key'
        ? identity
        : { ...identity, tenant: { id: 'tenant-spoolharbour' } },
    );
  });
  assert.equal(
    await runCli(
      ['login', '--profile', 'rq', '--tenant', 'tenant-rivetquay', '--json'],
      app.context,
    ),
    0,
  );
  assert.equal(app.config.active, 'rq');
  assert.equal(app.config.profiles.rq.credential.env, 'BS_API_KEY');
  assert.ok(!JSON.stringify(app.config).includes('fixture-key'));
  const selected = JSON.parse(app.stdout);
  assert.equal(selected.tenant, 'tenant-rivetquay');
  app.context.env.BS_API_KEY = 'fixture-other';
  assert.equal(await runCli(['usage'], app.context), 1);
  assert.match(app.stderr, /Credential belongs to another tenant/);
});

test('records list calls governed reads for explicit IDs and returns machine-readable output', async () => {
  const ids: string[] = [];
  const app = fixture(async (url, init) => {
    if (url.pathname === '/platform/v1/me') return Response.json(identity);
    assert.equal(url.pathname, '/v1/tools/order.read');
    const { input } = JSON.parse(String(init.body));
    ids.push(input.orderId);
    return Response.json({ state: 'ok', output: { id: input.orderId } });
  });
  assert.equal(
    await runCli(['records', 'list', 'order', 'ord-001', 'ord-002', '--json'], app.context),
    0,
  );
  assert.deepEqual(ids, ['ord-001', 'ord-002']);
  assert.deepEqual(JSON.parse(app.stdout), [{ id: 'ord-001' }, { id: 'ord-002' }]);
});

test('workflow preview and connector sync send documented routes and bodies', async () => {
  const requests: [string, unknown][] = [];
  const app = fixture(async (url, init) => {
    requests.push([url.pathname, JSON.parse(String(init.body))]);
    return Response.json([]);
  });
  assert.equal(await runCli(['workflows', 'preview', 'win-back-v1'], app.context), 0);
  assert.equal(
    await runCli(['connectors', 'sync', 'fixture-binding', '--max-pages', '5'], app.context),
    0,
  );
  assert.deepEqual(requests, [
    [
      '/automation/workflows/preview',
      {
        definitionId: 'win-back-v1',
        version: 1,
        input: { trigger: { kind: 'manual' }, values: {} },
      },
    ],
    ['/connectors/fixture-binding/sync', { mode: 'poll', maxPages: 5 }],
  ]);
});

test('device login stub needs no credential or transport', async () => {
  const app = fixture(async () => assert.fail('device stub must not fetch'), {});
  assert.equal(await runCli(['login', '--device', '--json'], app.context), 0);
  assert.equal(JSON.parse(app.stdout).status, 'device_flow_unavailable');
  assert.deepEqual(app.config, { profiles: {} });
});
