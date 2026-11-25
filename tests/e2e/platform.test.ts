import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import {
  loadDemoFixtures,
  type Approval,
  type CompleteLlmResult,
  type RunChatResult,
} from '@bs/contracts';
import { createApp } from '../../apps/api/src/app.ts';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
const { grants, llmRoutes } = loadDemoFixtures();
const operator = grants.find(({ actor }) => actor.id === 'actor-operator')!;

function fixtureApp(t: TestContext) {
  const app = createApp({
    BS_FIXTURE_LOGIN: '1',
    BS_PLATFORM_VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  });
  t.after(() => app.close());
  async function request<Result>(
    method: Method,
    url: string,
    role: string,
    payload?: object,
    status = 200,
  ) {
    const response = await app.inject({
      method,
      url,
      payload,
      headers: { authorization: 'Bearer fixture-' + role },
    });
    assert.equal(response.statusCode, status, response.body);
    return response.body ? response.json<Result>() : (undefined as Result);
  }
  function tool<Result>(name: string, input: object, key: string = randomUUID()) {
    return request<Result>('POST', '/v1/tools/' + name, 'operator', {
      tool: name,
      envelope: {
        version: 'v1',
        tenantId: operator.tenantId,
        actor: operator.actor,
        source: 'rest',
        traceId: key,
        correlationId: key,
        idempotencyKey: key,
      },
      input,
    });
  }
  return { request, tool };
}

const platform = '/platform/v1';

test('module changes govern new REST and automation work across the app and keep completed retries', async (t) => {
  const { request, tool } = fixtureApp(t);
  const input = { orderId: 'ord-001' };
  const cached = await tool('order.read', input, 'read-while-enabled');
  assert.equal((cached as { state: string }).state, 'ok');
  await request('PATCH', platform + '/modules/records', 'operator', { enabled: false }, 403);
  const disabled = await request<{ enabled: boolean }>(
    'PATCH',
    platform + '/modules/records',
    'admin',
    { enabled: false },
  );
  assert.equal(disabled.enabled, false);
  assert.equal((await tool<{ code: string }>('order.read', input)).code, 'module_disabled');
  assert.deepEqual(await tool('order.read', input, 'read-while-enabled'), cached);
  const bridge = await request<{ code: string }>('GET', '/automation/orders/ord-001', 'operator');
  assert.equal(bridge.code, 'module_disabled');

  await request('PATCH', platform + '/modules/workflows', 'admin', { enabled: false });
  await request('GET', '/automation/workflows/definitions', 'operator', undefined, 403);
  const modules = await request<{ moduleId: string; used: number }[]>(
    'GET',
    platform + '/modules',
    'admin',
  );
  assert.equal(modules.find(({ moduleId }) => moduleId === 'records')?.used, 1);
});

test('a tenant LLM binding routes chat dispatch and keeps a committed completion pinned on retry', async (t) => {
  const { request, tool } = fixtureApp(t);
  const credential = await request<{ ref: string }>(
    'POST',
    platform + '/credentials',
    'admin',
    { capability: 'llm', providerId: 'openai', secret: 'synthetic-credential' },
    201,
  );
  const binding = await request<{ version: number }>(
    'PUT',
    platform + '/capabilities/llm/binding',
    'admin',
    { providerId: 'openai', credentialRef: credential.ref },
  );
  assert.equal(binding.version, 2);
  const chat = await request<RunChatResult>('POST', '/automation/chat', 'operator', {
    sessionId: 'configured-chat',
    prompt: 'Check ord-001',
    route: 'native',
  });
  assert.equal(chat.state, 'ok');
  const input = {
    model: 'fixture-chat',
    turns: [{ role: 'user', content: 'synthetic turn' }],
    maxOutputTokens: 8,
    route: llmRoutes.find(({ kind }) => kind === 'native'),
  };
  const complete = await tool<CompleteLlmResult>('llm.complete', input, 'pinned-completion');
  assert.equal(complete.state, 'ok');
  assert.equal(complete.output.route.kind, 'byo');
  assert.equal(complete.output.route.providerId, 'openai');

  await request('PUT', platform + '/capabilities/llm/binding', 'admin', {
    providerId: 'fixture-native',
  });
  assert.deepEqual(await tool('llm.complete', input, 'pinned-completion'), complete);
  const later = await tool<CompleteLlmResult>('llm.complete', input);
  assert.equal(later.state, 'ok');
  assert.equal(later.output.route.kind, 'native');
  const audit = await request<{
    items: { source: string; providerId?: string; bindingVersion?: number }[];
  }>('GET', platform + '/audit?tool=llm.complete', 'admin');
  assert.ok(
    audit.items.some(
      ({ source, providerId, bindingVersion }) =>
        source === 'chat' && providerId === 'openai' && bindingVersion === binding.version,
    ),
  );
  assert.equal(audit.items.filter(({ bindingVersion }) => bindingVersion === 2).length, 2);
  const plan = await request<{ allowances: { unit: string; used: number }[] }>(
    'GET',
    platform + '/billing/plan',
    'admin',
  );
  assert.equal(plan.allowances.find(({ unit }) => unit === 'tokens')?.used, 18);
  const invoices = await request<{
    items: { lines: { providerId?: string; amountCents: number; quantity: number }[] }[];
  }>('GET', platform + '/billing/invoices', 'admin');
  const byo = invoices.items[0].lines.find(({ providerId }) => providerId === 'openai');
  assert.equal(byo?.quantity, 12);
  assert.equal(byo.amountCents, 0);
});

test('platform rejection acts on the same approval that automation prepared', async (t) => {
  const { request, tool } = fixtureApp(t);
  const pending = await request<{ approval: Approval }>(
    'POST',
    '/automation/collections/request',
    'operator',
    { invoiceId: 'inv-001', channel: 'email' },
  );
  const id = pending.approval.id;
  const list = (role: string, state: Approval['state']) =>
    request<Approval[]>('GET', platform + '/approvals?state=' + state, role);
  assert.deepEqual(
    (await list('admin', 'pending')).map((grant) => grant.id),
    [id],
  );
  assert.deepEqual(await list('isolation', 'pending'), []);
  const path = platform + '/approvals/' + id;
  await request('POST', path + '/reject', 'operator', { reason: 'Fixture review' }, 403);
  const rejected = await request<Approval>('POST', path + '/reject', 'approver', {
    reason: 'Fixture review',
  });
  assert.equal(rejected.state, 'rejected');
  assert.deepEqual(await list('approver', 'pending'), []);
  assert.deepEqual(await list('admin', 'rejected'), [rejected]);
  await request('POST', path + '/sign', 'approver', undefined, 409);
  const execution = await request<{ code: string }>(
    'POST',
    '/automation/approvals/approve',
    'approver',
    { approvalId: id },
  );
  assert.equal(execution.code, 'invalid_approval');
  const consumed = await tool<{ code: string }>('collections.email.send', {
    previewId: pending.approval.subjectId,
    approvalId: id,
  });
  assert.equal(consumed.code, 'invalid_approval');
});

test('platform signing commits and rates a subscribed PO outcome exactly once', async (t) => {
  const { request } = fixtureApp(t);
  await request('POST', platform + '/billing/plan', 'admin', { addOns: ['procurement'] });
  const draft = await request<{ output: { approval: Approval } }>(
    'POST',
    '/automation/purchase-orders/draft',
    'operator',
    { requestId: 'pr-001' },
  );
  const path = platform + '/approvals/' + draft.output.approval.id + '/sign';
  const approved = await request<Approval>('POST', path, 'approver');
  assert.equal(approved.state, 'consumed');
  assert.deepEqual(await request('POST', path, 'approver'), approved);
  const plan = await request<{ allowances: { skuId: string; used: number }[] }>(
    'GET',
    platform + '/billing/plan',
    'admin',
  );
  assert.equal(plan.allowances.find(({ skuId }) => skuId === 'procurement')?.used, 1);
});
