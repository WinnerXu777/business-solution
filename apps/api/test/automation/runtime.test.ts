import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { CallEnvelope } from '@bs/contracts';
import { FakeGateway } from '@bs/core';
import Fastify from 'fastify';
import { registerAutomation } from '../../src/automation/index.ts';
import type { RuntimeCapability } from '../../src/automation/runtime-routes.ts';
import type { SettledTurn } from '../../src/channels/settled.ts';

function harness(
  t: TestContext,
  authorizeRuntime?: (scope: CallEnvelope, capability: RuntimeCapability) => boolean,
  overrides: Partial<Parameters<typeof registerAutomation>[1]> = {},
) {
  const gateway = new FakeGateway();
  const app = Fastify();
  void app.register(
    (instance) =>
      registerAutomation(instance, {
        gateway,
        identity: (request) => ({
          tenantId:
            request.headers['x-fixture-tenant'] === 'other'
              ? 'tenant-spoolharbour'
              : 'tenant-rivetquay',
          actor: {
            id:
              request.headers['x-fixture-actor'] === 'approver'
                ? 'actor-approver'
                : 'actor-operator',
            kind: 'person',
          },
        }),
        authorizeRuntime: authorizeRuntime ?? (() => true),
        sign: (scope, approvalId) => gateway.approveFixture(scope, approvalId),
        ...overrides,
      }),
    { prefix: '/automation' },
  );
  t.after(() => app.close());
  function call(path: string, payload?: object, headers: Record<string, string> = {}) {
    return app.inject({
      url: '/automation' + path,
      method: payload ? 'POST' : 'GET',
      payload,
      headers,
    });
  }
  return { app, call, gateway };
}

const approver = { 'x-fixture-actor': 'approver' };
const chat = {
  botId: 'fixture-chat',
  version: 1,
  sessionId: 'test',
  prompt: 'Draft PO for pr-001',
  route: 'native',
};

test('bot routes replay SSE cursors, isolate runs and resume only with the designated approval', async (t) => {
  const { call, gateway } = harness(t);
  const list = (await call('/bots')).json();
  assert.deepEqual(
    list.map(({ id, version }: { id: string; version: number }) => [id, version]),
    [['fixture-chat', 1]],
  );
  const key = { 'idempotency-key': 'draft' };
  const start = await call('/bots/runs', chat, key);
  assert.equal(start.statusCode, 202);
  const { id } = start.json();
  const path = '/bots/runs/' + id;
  assert.equal((await call('/bots/runs', { ...chat, prompt: 'Different' }, key)).statusCode, 409);
  assert.equal((await call('/bots/runs', { ...chat, version: 55 })).statusCode, 404);

  const events = await call(path + '/events');
  assert.match(String(events.headers['content-type']), /text\/event-stream/);
  assert.match(events.body, /event: started/);
  assert.match(events.body, /event: approval_required/);
  assert.doesNotMatch(events.body, /Draft PO|pr-001/);
  assert.equal(
    (await call(path + '/events', undefined, { 'x-fixture-tenant': 'other' })).statusCode,
    404,
  );
  const pending = (await call(path)).json();
  const { approval } = pending.pending;
  const body = { approvalId: approval.id };
  assert.equal((await call(path + '/resume', body)).statusCode, 404);
  assert.equal((await call(path + '/resume', { approvalId: 'other' }, approver)).statusCode, 404);

  const [resumed, duplicate] = await Promise.all([
    call(path + '/resume', body, approver),
    call(path + '/resume', body, approver),
  ]);
  assert.equal(resumed.json().status, 'completed');
  assert.deepEqual(resumed.json(), duplicate.json());
  const cursor = [...events.body.matchAll(/^id: (\d+)$/gm)].at(-1)![1];
  const replay = await call(path + '/events', undefined, { 'last-event-id': cursor });
  assert.match(replay.body, /event: resumed/);
  assert.match(replay.body, /event: settled/);
  assert.doesNotMatch(replay.body, /event: started/);
  assert.equal(gateway.audit().filter(({ tool }) => tool === 'purchase.order.approve').length, 1);
});

test('cancelling a bot waiting for approval blocks resume', async (t) => {
  const { call, gateway } = harness(t);
  const { id } = (await call('/bots/runs', chat)).json();
  const path = '/bots/runs/' + id;
  await call(path + '/events');
  const { approval } = (await call(path)).json().pending;
  assert.equal((await call(path + '/cancel', {})).json().status, 'cancelled');
  assert.equal(
    (await call(path + '/resume', { approvalId: approval.id }, approver)).statusCode,
    404,
  );
  assert.equal(
    gateway.audit().some(({ tool }) => tool === 'purchase.order.approve'),
    false,
  );
});

test('recreates the worker and API, then resumes a bot and replays its journal cursor', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'fictional-bot-restart-'));
  const previous = process.env.BS_TEST_RUNTIME_STATE;
  process.env.BS_TEST_RUNTIME_STATE = join(folder, 'state.bin');
  const reports: SettledTurn[] = [];
  const gateway = new FakeGateway();
  const options = {
    gateway,
    workerModule: 'workers.tests.runtime.postgres_worker',
    onSettledTurn(turn: SettledTurn) {
      reports.push(turn);
    },
    sign: (scope: CallEnvelope, approvalId: string) => gateway.approveFixture(scope, approvalId),
  };
  const first = harness(t, undefined, options);
  const key = { 'idempotency-key': 'persisted-draft' };
  const { id } = (await first.call('/bots/runs', chat, key)).json();
  assert(id);
  const path = '/bots/runs/' + id;
  const before = await first.call(path + '/events');
  assert.match(before.body, /event: approval_required/);
  const { approval } = (await first.call(path)).json().pending;
  await first.app.close();

  const second = harness(t, undefined, options);
  t.after(async () => {
    await second.app.close();
    if (previous === undefined) delete process.env.BS_TEST_RUNTIME_STATE;
    else process.env.BS_TEST_RUNTIME_STATE = previous;
    await rm(folder, { recursive: true, force: true });
  });
  assert.equal(
    (await second.call('/bots/runs', { ...chat, prompt: 'Different' }, key)).statusCode,
    409,
  );
  assert.equal((await second.call('/bots/runs', chat, key)).json().id, id);
  const resumed = await second.call(path + '/resume', { approvalId: approval.id }, approver);
  assert.equal(resumed.json().status, 'completed', resumed.body);
  const cursor = [...before.body.matchAll(/^id: (\d+)$/gm)].at(-1)![1];
  const replay = await second.call(path + '/events', undefined, { 'last-event-id': cursor });
  assert.match(replay.body, /event: resumed/);
  assert.match(replay.body, /event: settled/);
  assert.doesNotMatch(replay.body, /event: started/);
  const next = await second.call('/bots/runs', { ...chat, prompt: 'Check ord-001' });
  assert.equal(next.statusCode, 202, next.body);
  const reply = await second.call('/bots/runs/' + next.json().id + '/events');
  assert.match(reply.body, /event: reply_delta\ndata: .*"delta":"Order ord-001 is /);
  const session = await second.call('/bots/sessions/test/turns');
  assert.deepEqual(
    session.json().map((item: { id: string }) => item.id),
    [id, next.json().id],
  );
  assert.deepEqual(
    (await second.call('/bots/sessions/test/turns', undefined, approver)).json(),
    [],
  );
  assert.deepEqual(
    reports.map(({ conversationId }) => conversationId),
    ['test', 'test'],
  );
  assert.equal(gateway.audit().filter(({ tool }) => tool === 'purchase.order.approve').length, 1);
});

test('workflow APIs publish immutable versions and preview with zero gateway calls', async (t) => {
  const { call, gateway } = harness(t);
  const definition = {
    id: 'order-check',
    version: 1,
    nodes: [
      { id: 'manual', kind: 'trigger', trigger: 'manual', next: 'match' },
      {
        id: 'match',
        kind: 'condition',
        left: { ref: 'enabled' },
        equals: true,
        next: 'read',
        otherwise: null,
      },
      { id: 'read', kind: 'action', action: { tool: 'order.read', orderId: 'ord-001' } },
    ],
  };
  const target = {
    definitionId: definition.id,
    version: 1,
    input: { trigger: { kind: 'manual' }, values: { enabled: true } },
  };
  assert.equal((await call('/workflows/definitions', definition)).statusCode, 201);
  assert.equal((await call('/workflows/definitions', definition)).statusCode, 409);
  assert.equal(
    (await call('/workflows/definitions', { ...definition, version: 2 })).statusCode,
    201,
  );
  const definitions = (await call('/workflows/definitions')).json();
  assert.equal(definitions.length, 3);
  assert.equal(
    (await call('/workflows/definitions', undefined, { 'x-fixture-tenant': 'other' })).json()
      .length,
    1,
  );
  const plan = await call('/workflows/preview', target);
  assert.equal(plan.statusCode, 200, plan.body);
  assert.deepEqual(
    plan.json().map(({ kind }: { kind: string }) => kind),
    ['trigger', 'condition', 'action'],
  );
  assert.equal(gateway.audit().length, 0);
  assert.equal(gateway.usage().length, 0);

  const start = await call('/workflows/runs', target, { 'idempotency-key': 'once' });
  assert.equal(start.statusCode, 202, start.body);
  const run = start.json();
  assert.equal(run.status, 'completed');
  assert.equal(run.version, 1);
  assert.equal(
    (await call('/workflows/runs', target, { 'idempotency-key': 'once' })).json().id,
    run.id,
  );
  assert.equal((await call('/workflows/runs')).json().length, 1);
  assert.equal(
    (await call('/workflows/runs/' + run.id + '/history')).json().history.at(-1).kind,
    'settled',
  );
  assert.equal(
    (
      await call('/workflows/runs/' + run.id + '/history', undefined, {
        'x-fixture-tenant': 'other',
      })
    ).statusCode,
    404,
  );
  assert.equal((await call('/workflows/runs/' + run.id + '/replay', {})).statusCode, 409);
  assert.deepEqual((await call('/workflows/dead-letters')).json(), []);
  assert.equal(gateway.audit().length, 1);
});

test('a delayed workflow checks the requester permission again at dispatch', async (t) => {
  let revoked = false;
  const blocked = Promise.withResolvers<void>();
  const { call, gateway } = harness(t, (_scope, capability) => {
    if (capability === 'workflow' && revoked) {
      blocked.resolve();
      return false;
    }
    return true;
  });
  const definition = {
    id: 'delay-read',
    version: 1,
    nodes: [
      { id: 'manual', kind: 'trigger', trigger: 'manual', next: 'wait' },
      { id: 'wait', kind: 'delay', milliseconds: 200, next: 'read' },
      { id: 'read', kind: 'action', action: { tool: 'order.read', orderId: 'ord-001' } },
    ],
  };
  assert.equal((await call('/workflows/definitions', definition)).statusCode, 201);
  const started = await call('/workflows/runs', {
    definitionId: definition.id,
    version: 1,
    input: { trigger: { kind: 'manual' } },
  });
  assert.equal(started.json().status, 'delayed');
  revoked = true;
  await blocked.promise;
  revoked = false;
  const finished = await call('/workflows/runs/' + started.json().id + '/history');
  assert.equal(finished.json().result.code, 'forbidden');
  assert.equal(gateway.audit().length, 0);
});
