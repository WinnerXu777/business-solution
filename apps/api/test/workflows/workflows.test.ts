import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import type { CallEnvelope } from '@bs/contracts';
import { FakeGateway } from '@bs/core';
import type { WorkflowDefinition } from '../../../../packages/core/src/workflows/definition.ts';
import { minute } from '../../../../packages/core/src/workflows/triggers.ts';
import { createWorkflowEffects, nativeDrafts } from '../../src/workflows/effects.ts';
import { fixtureWorkflowEffects } from '../../src/workflows/fixture-effects.ts';
import { workflowRoutes, type WorkflowIdentity } from '../../src/workflows/index.ts';
import { createTriggers, directoryTriggerStore } from '../../src/workflows/triggers.ts';
import { createBuilderWorker, type Effect, type Run } from '../../src/workflows/worker.ts';

const root = '/workflow-builder/v1';
const fixtureNow = Date.parse('2026-11-25T15:00Z');
const tenantId = 'tenant-rivetquay';
const secret = 'synthetic-webhook-audience-secret';
const users = new Map<string, WorkflowIdentity>([
  ['operator', { tenantId, actor: { kind: 'person', id: 'actor-operator' }, roles: ['operator'] }],
  [
    'approver',
    {
      tenantId,
      actor: { kind: 'person', id: 'actor-approver' },
      roles: ['approver', 'purchasing'],
    },
  ],
  [
    'foreign',
    {
      tenantId: 'tenant-spoolharbour',
      actor: { kind: 'person', id: 'actor-operator' },
      roles: ['operator'],
    },
  ],
]);

function setup(t: TestContext) {
  const app = Fastify();
  const gateway = new FakeGateway();
  const effects: Effect[] = [];
  const prompts: unknown[] = [];
  const modeledEffects = fixtureWorkflowEffects(() => fixtureNow);
  app.post('/llm/v1/chat/completions', (request) => {
    assert.equal(request.headers.authorization, 'Bearer synthetic-llm-key');
    prompts.push(request.body);
    return {
      choices: [{ finish_reason: 'stop', message: { content: 'Synthetic native draft.' } }],
    };
  });
  const relay = createWorkflowEffects({
    gateway,
    sign: async (scope, approvalId) => gateway.approveFixture(scope, approvalId),
    authorize: () => true,
    draft: nativeDrafts(app, () => 'synthetic-llm-key'),
    governed: modeledEffects.relay,
  });
  app.register(workflowRoutes, {
    now: () => fixtureNow,
    identify: (request) => users.get(request.headers.authorization ?? ''),
    authorize: (_scope, capability) =>
      capability !== 'manage' || _scope.actor.id === 'actor-operator',
    webhookSecret: (tenant, ref) =>
      tenant === tenantId && ref === 'fixture-secret' ? secret : undefined,
    relay: (effect, signal) => {
      effects.push(effect);
      return relay(effect, signal);
    },
  });
  t.after(() => app.close());

  function get(url: string, actor = 'operator') {
    return app.inject({ method: 'GET', url: root + url, headers: { authorization: actor } });
  }
  function post(
    url: string,
    payload: object,
    actor = 'operator',
    headers: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: root + url,
      payload,
      headers: { authorization: actor, ...headers },
    });
  }
  async function publish(definition: WorkflowDefinition) {
    const published = await post('/definitions', definition);
    assert.equal(published.statusCode, 201, published.body);
    const release = await post('/definitions/' + definition.id + '/release', {
      version: definition.version,
    });
    assert.equal(release.statusCode, 200, release.body);
  }
  return { app, gateway, effects, prompts, modeledEffects, get, post, publish };
}

function graph(
  id: string,
  trigger: 'manual' | 'schedule' | 'event' | 'webhook' = 'manual',
): WorkflowDefinition {
  return {
    id,
    version: 1,
    inputs: {},
    nodes: [
      { id: 'start', kind: 'trigger', trigger, next: 'checkpoint' },
      { id: 'checkpoint', kind: 'checkpoint', next: 'finish' },
      { id: 'finish', kind: 'mapping', values: { note: 'fixture' }, next: null },
    ],
  };
}

test('template preview, draft install, schema checks, version diff and migration through Fastify and Python', async (t) => {
  const { get, post, publish, effects } = setup(t);
  assert.equal((await get('/templates', 'unknown')).statusCode, 401);
  const templates = (await get('/templates')).json<{ id: string }[]>();
  assert.equal(templates.length, 10);
  for (const template of templates) {
    const preview = await post('/templates/' + template.id + '/preview', {});
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(preview.json().receipts, []);
    assert.ok(preview.json().plan.length >= 2);
  }
  assert.deepEqual(effects, []);
  const installed = await post('/templates/win-back/install', {
    parameters: { days: 120, message: 'Fictional offer' },
  });
  assert.equal(installed.statusCode, 201, installed.body);
  const draft = installed.json();
  assert.equal(draft.status, 'draft');
  assert.equal(draft.trigger.threshold, 120);
  assert.equal((await get('/drafts/' + draft.definition.id)).statusCode, 200);
  assert.equal((await get('/drafts/' + draft.definition.id, 'foreign')).statusCode, 404);
  assert.equal((await post('/templates/win-back/install', {}, 'approver')).statusCode, 403);
  assert.equal((await post('/validate', draft.definition)).statusCode, 200);
  const unreachable = structuredClone(draft.definition);
  unreachable.nodes.push({ id: 'orphan', kind: 'checkpoint', next: null });
  assert.equal((await post('/validate', unreachable)).statusCode, 400);
  const v1 = graph('versions');
  const v2 = graph('versions');
  v2.version = 2;
  v2.nodes[2] = { id: 'finish', kind: 'mapping', values: { note: 'changed' }, next: null };
  await publish(v1);
  const headers = { 'idempotency-key': 'fixture-run-key' };
  const start = await post('/runs', { definitionId: 'versions', values: {} }, 'operator', headers);
  assert.equal(start.statusCode, 202, start.body);
  const run = start.json<Run>();
  assert.equal(run.status, 'checkpoint');
  await publish(v2);
  const diff = await get('/definitions/versions/diff?from=1&to=2');
  assert.deepEqual(diff.json(), {
    from: 1,
    to: 2,
    added: [],
    removed: [],
    changed: ['finish'],
    inputsChanged: false,
  });
  assert.equal((await get('/definitions/versions/diff?from=1&to=2', 'foreign')).statusCode, 404);
  const moved = await post('/runs/' + run.id + '/migrate', { fromVersion: 1, toVersion: 2 });
  assert.equal(moved.json<Run>().version, 2);
  assert.equal(
    (await post('/runs', { definitionId: 'versions', values: {} }, 'operator', headers)).json<Run>()
      .id,
    run.id,
  );
  assert.equal((await post('/runs/' + run.id + '/tick', {})).json<Run>().status, 'completed');
  assert.equal(
    (await post('/runs/' + run.id + '/migrate', { fromVersion: 2, toVersion: 1 })).statusCode,
    409,
  );
  assert.equal((await post('/definitions/versions/release', { version: 1 })).statusCode, 200);
  assert.equal(
    (await post('/runs', { definitionId: 'versions', values: {} })).json<Run>().version,
    1,
  );
});

test('record events and raw signed webhooks deduplicate within tenant and respect pause', async (t) => {
  const { app, get, post, publish } = setup(t);
  const eventFlow = graph('event-flow', 'event');
  eventFlow.inputs = { recordId: 'string' };
  await publish(eventFlow);
  assert.equal(
    (
      await post('/triggers', {
        id: 'aging',
        definitionId: eventFlow.id,
        kind: 'event',
        name: 'invoice.overdue',
        threshold: 7,
      })
    ).statusCode,
    201,
  );
  const event = {
    id: 'fixture-1',
    name: 'invoice.overdue',
    recordId: 'inv-001',
    beforeDays: 4,
    days: 7,
  };
  assert.deepEqual((await post('/events', { ...event, days: 6 })).json(), []);
  const initial = (await post('/events', event)).json<{ run: Run }[]>();
  const duplicate = (await post('/events', event)).json<{ run: Run }[]>();
  assert.equal(initial[0].run.id, duplicate[0].run.id);
  assert.equal(
    (await post('/events', { ...event, recordId: 'inv-002' })).json()[0].code,
    'conflict',
  );
  assert.deepEqual((await post('/events', event, 'foreign')).json(), []);
  await post('/triggers/aging/pause', { paused: true });
  assert.deepEqual((await post('/events', { ...event, id: 'fixture-2' })).json(), []);

  const hook = graph('webhook-flow', 'webhook');
  await publish(hook);
  assert.equal(
    (
      await post('/triggers', {
        id: 'fixture-hook',
        definitionId: hook.id,
        kind: 'webhook',
        secretRef: 'fixture-secret',
      })
    ).statusCode,
    201,
  );
  assert.equal(
    (await get('/triggers')).json().find((entry: { id: string }) => entry.id === 'fixture-hook')
      .secretRef,
    undefined,
  );
  const timestamp = String(fixtureNow / 1000);
  const raw = '{ "id":"wh-001", "values":{} }';
  const signed =
    'sha256=' +
    createHmac('sha256', secret)
      .update(JSON.stringify([tenantId, 'fixture-hook', timestamp]) + '.')
      .update(raw)
      .digest('hex');
  function send(payload: string, signature = signed) {
    return app.inject({
      method: 'POST',
      url: root + '/webhooks/' + tenantId + '/fixture-hook',
      payload,
      headers: {
        'content-type': 'application/json',
        'x-workflow-timestamp': timestamp,
        'x-workflow-signature': signature,
      },
    });
  }
  assert.equal((await send(raw.replace(' ', ''))).statusCode, 401);
  assert.equal((await send(raw, 'wrong')).statusCode, 401);
  const accepted = await send(raw);
  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal((await send(raw)).json<Run>().id, accepted.json<Run>().id);
  await post('/triggers/fixture-hook/pause', { paused: true });
  assert.equal((await send(raw)).statusCode, 404);
});

test('governed collection dispatch and native drafts stay behind approval', async (t) => {
  const { get, post, publish, effects, prompts, modeledEffects } = setup(t);
  const flow: WorkflowDefinition = {
    id: 'collections',
    version: 1,
    inputs: { invoice: 'string', customer: 'string' },
    nodes: [
      { id: 'start', kind: 'trigger', trigger: 'manual', next: 'send' },
      {
        id: 'send',
        kind: 'message',
        channel: 'email',
        purpose: 'collections',
        sourceId: { ref: 'invoice' },
        recipientId: { ref: 'customer' },
        next: null,
      },
    ],
  };
  await publish(flow);
  const input = {
    definitionId: 'collections',
    values: { invoice: 'inv-001', customer: 'cust-002' },
  };
  const waiting = (await post('/runs', input)).json<Run>();
  assert.equal(waiting.status, 'approval');
  assert.deepEqual(
    effects.map(({ phase }) => phase),
    ['prepare'],
  );
  const inbox = (await get('/inbox', 'approver')).json();
  assert.equal(inbox[0].runId, waiting.id);
  assert.equal(inbox[0].pending.review.recipient, 'orders2@rivetquay.example');
  const signing = { approvalId: waiting.pending?.id };
  assert.equal((await post('/runs/' + waiting.id + '/approve', signing)).statusCode, 404);
  const settled = await post('/runs/' + waiting.id + '/approve', signing, 'approver');
  assert.equal(settled.json<Run>().status, 'completed', settled.body);
  assert.deepEqual(
    effects.map(({ phase }) => phase),
    ['prepare', 'sign', 'execute'],
  );
  const suppressed = (
    await post('/runs', {
      ...input,
      values: { invoice: 'inv-004', customer: 'cust-010' },
    })
  ).json<Run>();
  assert.equal(suppressed.status, 'denied');
  const draft: WorkflowDefinition = {
    id: 'native-draft',
    version: 1,
    inputs: {},
    nodes: [
      { id: 'start', kind: 'trigger', trigger: 'manual', next: 'draft' },
      {
        id: 'draft',
        kind: 'llm-draft',
        model: 'fixture-chat',
        prompt: 'Synthetic account facts',
        output: 'body',
        next: 'send',
      },
      {
        id: 'send',
        kind: 'message',
        channel: 'email',
        purpose: 'transactional',
        sourceId: 'cust-008',
        recipientId: 'cust-008',
        body: { ref: 'body' },
        next: null,
      },
    ],
  };
  await publish(draft);
  const drafted = (await post('/runs', { definitionId: draft.id, values: {} })).json<Run>();
  assert.equal(drafted.status, 'approval');
  assert.deepEqual(modeledEffects.receipts(), []);
  assert.deepEqual(prompts, [
    {
      model: 'fixture-chat',
      messages: [{ role: 'user', content: 'Synthetic account facts' }],
      max_completion_tokens: 512,
      stream: false,
    },
  ]);
  assert.equal(effects.at(-1)?.input.untrustedDraft, true);
  assert.equal(effects.at(-1)?.input.body, 'Synthetic native draft.');
  assert.equal(effects.filter(({ phase }) => phase === 'execute').length, 1);
  const sent = await post(
    '/runs/' + drafted.id + '/approve',
    { approvalId: drafted.pending?.id },
    'approver',
  );
  assert.equal(sent.json<Run>().status, 'completed', sent.body);
  assert.equal(modeledEffects.receipts()[0].recipientId, 'cust-008');
});

test('schedule cursor and receipts survive a full host restart and retry quota-deferred slots', async (t) => {
  let now = fixtureNow;
  const directory = await mkdtemp(join(tmpdir(), 'builder-fixture-'));
  const workerOptions = {
    relay: () => ({ state: 'denied' as const }),
    activeLimit: 1,
    stateDirectory: directory,
  };
  let worker = createBuilderWorker(workerOptions);
  t.after(async () => {
    await worker.close();
    await rm(directory, { recursive: true, force: true });
  });
  const scope: CallEnvelope = {
    version: 'v1',
    tenantId,
    actor: users.get('operator')!.actor,
    source: 'workflow',
    traceId: 'trace',
    correlationId: 'correlation',
    idempotencyKey: 'request',
  };
  const options = () => ({
    worker,
    store: directoryTriggerStore(directory),
    now: () => now,
    authorize: () => true,
    secret: () => undefined,
    follow: () => undefined,
  });
  const definition = graph('schedule-flow', 'schedule');
  await worker.invoke({ kind: 'publish', scope, definition });
  await worker.invoke({ kind: 'release', scope, definitionId: definition.id, version: 1 });
  createTriggers(options()).create(scope, {
    id: 'fixture-schedule',
    definitionId: definition.id,
    kind: 'schedule',
    expression: '* * * * *',
    timeZone: 'America/Toronto',
    catchUp: 'run-all',
    maxRuns: 2,
    values: {},
  });
  now += minute;
  const before = (await createTriggers(options()).scan())[0];
  assert.ok(before.runId);
  await worker.close();
  worker = createBuilderWorker(workerOptions);
  assert.equal(
    (await worker.invoke({ kind: 'read', scope, runId: before.runId })).status,
    'checkpoint',
  );
  await worker.invoke({ kind: 'tick', scope, runId: before.runId, now });
  now += 4 * minute;
  const recovered = createTriggers(options());
  for (let index = 3; index <= 5; index++) {
    const scan = await recovered.scan();
    assert.equal(scan[0].slot, fixtureNow + index * minute);
    assert.ok(scan[0].runId);
    if (index < 5) assert.equal(scan[1].code, 'quota_exceeded');
    await worker.invoke({ kind: 'tick', scope, runId: scan[0].runId, now });
  }
  assert.deepEqual(await recovered.scan(), []);
});
