import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { Approval, ListOrdersResult, ToolResult } from '@bs/contracts';
import { createApp } from '../../apps/api/src/app.ts';
import { platformLlm } from '../../apps/api/src/llm-bootstrap.ts';
import { fakeOidc } from '../../packages/core/test/platform/fake-oidc.ts';

const tenant = 'tenant-rivetquay';
const otherTenant = 'tenant-spoolharbour';
const platform = '/platform/v1';
type Role = 'admin' | 'operator' | 'approver' | 'reader' | 'isolation';

function harness(t: TestContext, options: Parameters<typeof createApp>[1] = {}) {
  const app = createApp(
    {
      BS_FIXTURE_LOGIN: '1',
      BS_PLATFORM_VAULT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    },
    options,
  );
  t.after(() => app.close());
  function request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    token: string,
    payload?: object,
  ) {
    return app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + token } });
  }
  async function fixture<Result>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    role: Role,
    payload?: object,
    status = 200,
  ) {
    const response = await request(method, url, 'fixture-' + role, payload);
    assert.equal(response.statusCode, status, response.body);
    return response.body ? response.json<Result>() : undefined;
  }
  async function rest<Result = ToolResult>(
    role: Role,
    tool: string,
    input: object,
    tenantId = role === 'isolation' ? otherTenant : tenant,
  ) {
    const key = randomUUID();
    const result = await fixture<Result>(
      'POST',
      '/v1/tools/' + tool,
      role,
      {
        envelope: {
          version: 'v1',
          tenantId,
          actor: { id: 'actor-' + role, kind: 'person' },
          source: 'rest',
          traceId: key,
          correlationId: key,
          idempotencyKey: key,
        },
        tool,
        input,
      },
      role === 'isolation' && tenantId === tenant ? 403 : 200,
    );
    return result!;
  }
  async function mcp<Result>(role: Role, method: string, params?: object) {
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: 'Bearer fixture-' + role, accept: 'application/json' },
      payload: { jsonrpc: '2.0', id: 1, method, params },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().error, undefined, response.body);
    return response.json<{ result: Result }>().result;
  }
  return { app, request, fixture, rest, mcp };
}

test('governed lists page and search through REST and MCP with the same tenant scope', async (t) => {
  const { rest, mcp } = harness(t);
  const tools = (await mcp<{ tools: { name: string }[] }>('reader', 'tools/list')).tools;
  for (const name of [
    'order.list',
    'purchase.request.list',
    'purchase.order.list',
    'inventory.list',
    'vendor.list',
    'customer.list',
    'contact.list',
    'invoice.list',
  ]) {
    assert.ok(
      tools.some((tool) => tool.name === name),
      name,
    );
    const result = await rest('reader', name, { limit: 1 });
    assert.equal(result.state, 'ok', name);
    assert.ok('items' in result.output);
    assert.ok(result.output.items.length <= 1);
  }

  const first = await rest<ListOrdersResult>('reader', 'order.list', { limit: 1, query: ' ORD- ' });
  assert.equal(first.state, 'ok');
  const { nextCursor, items } = first.output;
  assert.ok(nextCursor);
  assert.deepEqual(
    items.map(({ id }) => id),
    ['ord-001'],
  );
  const second = { limit: 1, query: 'ord-', cursor: nextCursor };
  const rpc = await mcp<{ structuredContent: ListOrdersResult }>('reader', 'tools/call', {
    name: 'order.list',
    arguments: second,
  });
  assert.deepEqual(rpc.structuredContent, await rest('reader', 'order.list', second));
  assert.equal(rpc.structuredContent.state, 'ok');
  assert.deepEqual(
    rpc.structuredContent.output.items.map(({ id }) => id),
    ['ord-002'],
  );
  const foreign = await mcp<{ structuredContent: ToolResult; isError: boolean }>(
    'isolation',
    'tools/call',
    { name: 'order.list', arguments: second },
  );
  assert.equal(foreign.isError, true);
  assert.deepEqual(foreign.structuredContent, await rest('isolation', 'order.list', second));
  assert.deepEqual(await rest('isolation', 'order.list', {}, tenant), { error: 'forbidden' });

  const search = { name: 'order.list', arguments: { query: 'ord-isolation' } };
  const hidden = await rest('reader', search.name, search.arguments);
  assert.deepEqual(hidden, { state: 'ok', output: { items: [], nextCursor: null } });
  assert.deepEqual(
    (await mcp<{ structuredContent: ToolResult }>('reader', 'tools/call', search))
      .structuredContent,
    hidden,
  );
  const other = (
    await mcp<{ structuredContent: ListOrdersResult }>('isolation', 'tools/call', search)
  ).structuredContent;
  assert.equal(other.state, 'ok');
  assert.deepEqual(
    other.output.items.map(({ id }) => id),
    ['ord-isolation'],
  );
});

test('fraud review requires a reviewer and persists the decision across transports', async (t) => {
  const { rest, mcp } = harness(t);
  const input = { orderId: 'ord-003', decision: 'escalate' };
  assert.equal((await rest('approver', 'fraud.score', { orderId: input.orderId })).state, 'ok');
  assert.equal((await rest('operator', 'fraud.review', input)).state, 'denied');
  assert.equal((await rest('approver', 'fraud.review', input)).state, 'ok');
  const queue = await mcp<{ structuredContent: ToolResult }>('reader', 'tools/call', {
    name: 'fraud.queue',
  });
  assert.equal(queue.structuredContent.state, 'ok');
  assert.ok(Array.isArray(queue.structuredContent.output));
  assert.ok(
    queue.structuredContent.output.some(
      (row) =>
        'decision' in row && row.orderId === input.orderId && row.decision === input.decision,
    ),
  );
});

test('a scoped tenant key selects the LLM binding and records token usage in billing', async (t) => {
  const { fixture, request } = harness(t, { llm: platformLlm });
  const connection = await fixture<{ id: string; secret: string }>(
    'POST',
    platform + '/connections',
    'admin',
    {
      kind: 'api_client',
      name: 'Synthetic inference client',
      scopes: ['llm.chat.completions'],
    },
    201,
  );
  const credential = await fixture<{ ref: string }>(
    'POST',
    platform + '/credentials',
    'admin',
    {
      capability: 'llm',
      providerId: 'openai',
      secret: 'synthetic-credential',
    },
    201,
  );
  const binding = await fixture<{ version: number }>(
    'PUT',
    platform + '/capabilities/llm/binding',
    'admin',
    {
      providerId: 'openai',
      credentialRef: credential!.ref,
    },
  );
  const secret = connection!.id + '.' + connection!.secret;
  const key = tenant + '.' + secret;
  const payload = {
    model: 'fixture-chat',
    messages: [{ role: 'user', content: 'Explain a fictional order' }],
    max_completion_tokens: 10,
  };
  const chatPath = '/llm/v1/chat/completions';
  assert.equal(
    (await request('POST', chatPath, otherTenant + '.' + secret, payload)).statusCode,
    401,
  );
  assert.equal((await request('GET', '/llm/v1/models', key)).statusCode, 401);
  const result = await request('POST', chatPath, key, payload);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.headers['x-llm-binding-version'], String(binding!.version));
  const completion = result.json<{ model: string; usage: { total_tokens: number } }>();
  assert.equal(completion.model, 'openai-fixture-chat');
  assert.ok(completion.usage.total_tokens > 0);
  const plan = await fixture<{ allowances: { unit: string; used: number }[] }>(
    'GET',
    platform + '/billing/plan',
    'admin',
  );
  assert.equal(
    plan?.allowances.find(({ unit }) => unit === 'tokens')?.used,
    completion.usage.total_tokens,
  );
  const invoices = await fixture<{
    items: { lines: { providerId?: string; amountCents: number; quantity: number }[] }[];
  }>('GET', platform + '/billing/invoices', 'admin');
  const line = invoices?.items[0].lines.find(({ providerId }) => providerId === 'openai');
  assert.equal(line?.quantity, completion.usage.total_tokens);
  assert.equal(line.amountCents, 0);
  await fixture('DELETE', platform + '/connections/' + connection!.id, 'admin', undefined, 204);
  assert.equal((await request('POST', chatPath, key, payload)).statusCode, 401);
});

test('connector install and fixture sync make imported CRM records visible only to the installing tenant', async (t) => {
  const { fixture, rest, request } = harness(t, { fixtureConnectors: true });
  const path = '/connectors/ui/hubspot-fixture';
  assert.equal((await request('GET', '/connectors/ui', 'invalid')).statusCode, 401);
  await fixture('POST', path + '/install', 'reader', undefined, 403);
  const input = { query: 'fixture@spindle.example' };
  const empty = { state: 'ok', output: { items: [], nextCursor: null } };
  assert.deepEqual(await rest('reader', 'contact.list', input), empty);
  await fixture('POST', path + '/install', 'admin', undefined, 204);
  await fixture('POST', path + '/sync', 'admin', undefined, 204);
  const status = await fixture<{ state: string; lastSyncAt: string }>(
    'GET',
    path + '/status',
    'reader',
  );
  assert.equal(status?.state, 'connected');
  assert.ok(status.lastSyncAt);
  const result = await rest('reader', 'contact.list', input);
  assert.equal(result.state, 'ok');
  assert.ok('items' in result.output);
  assert.deepEqual(
    result.output.items.map((record) => 'email' in record && record.email),
    ['fixture@spindle.example'],
  );
  assert.deepEqual(await rest('isolation', 'contact.list', input), empty);
  const vault = await fixture<{ ref: string }[]>('GET', platform + '/credentials', 'admin');
  assert.equal(vault?.length, 1);
  assert.ok(vault[0].ref);
  assert.deepEqual(Object.keys(vault[0]), ['ref']);
});

test('OIDC sessions govern requester bot history and assigned approval discovery', async (t) => {
  const issuer = fakeOidc(() => Date.now());
  const { app, request } = harness(t, {
    auth: {
      options: { oidc: issuer.config, signingKey: Buffer.alloc(32, 9), requireStepUp: false },
      subjects: {
        'actor-operator': 'synthetic-requester',
        'actor-approver': 'synthetic-reviewer',
        'actor-isolation': 'synthetic-isolation',
      },
    },
  });
  async function login(tenantId: string, subject: string) {
    const start = await app.inject({ url: platform + '/auth/login?tenantId=' + tenantId });
    assert.equal(start.statusCode, 200, start.body);
    const cookie = start.cookies.find(({ name }) => name === '__Host-bs_oidc');
    assert.ok(cookie?.secure && cookie.httpOnly);
    const { state, code } = issuer.authorize(start.json().authorizeUrl, {
      claims: { sub: subject },
    });
    const callback = await app.inject({
      url: platform + '/auth/callback?' + new URLSearchParams({ state, code }),
      cookies: { [cookie.name]: cookie.value },
    });
    assert.equal(callback.statusCode, 200, callback.body);
    const session = callback.json<{ status: string; accessToken: string }>();
    assert.equal(session.status, 'authenticated');
    return session.accessToken;
  }

  assert.equal((await request('GET', platform + '/me', 'fixture-operator')).statusCode, 401);
  const operator = await login(tenant, 'synthetic-requester');
  const approver = await login(tenant, 'synthetic-reviewer');
  const isolation = await login(otherTenant, 'synthetic-isolation');
  const me = await request('GET', platform + '/me', operator);
  assert.equal(me.statusCode, 200, me.body);
  assert.equal(me.json().actor.id, 'actor-operator');
  const runs = '/automation/bots/runs';
  const approvals = '/automation/bots/approvals';
  const started = await request('POST', runs, operator, {
    botId: 'fixture-chat',
    version: 1,
    sessionId: 'oidc-test',
    prompt: 'Draft PO for pr-001',
    route: 'native',
  });
  assert.equal(started.statusCode, 202, started.body);
  const { id } = started.json<{ id: string }>();
  const events = await request('GET', runs + '/' + id + '/events', operator);
  assert.match(events.body, /event: approval_required/);
  const history = await request('GET', runs, operator);
  assert.deepEqual(
    history.json().map((run: { id: string }) => run.id),
    [id],
  );
  assert.deepEqual((await request('GET', runs, isolation)).json(), []);
  assert.deepEqual((await request('GET', runs, approver)).json(), []);
  assert.equal((await request('GET', approvals, operator)).statusCode, 403);
  const assigned = await request('GET', approvals, approver);
  assert.equal(assigned.statusCode, 200, assigned.body);
  const [{ runId, pending }] =
    assigned.json<
      { runId: string; pending: { approval: Approval; draft: { requestId: string } } }[]
    >();
  assert.equal(runId, id);
  assert.equal(pending.draft.requestId, 'pr-001');
  assert.equal(pending.approval.requestedBy, 'actor-operator');
  assert.equal(pending.approval.approverId, 'actor-approver');
  const resume = runs + '/' + id + '/resume';
  const approval = { approvalId: pending.approval.id };
  assert.equal((await request('POST', resume, operator, approval)).statusCode, 403);
  const finished = await request('POST', resume, approver, approval);
  assert.equal(finished.statusCode, 200, finished.body);
  assert.equal(finished.json().status, 'completed');
  assert.deepEqual((await request('GET', approvals, approver)).json(), []);
});
