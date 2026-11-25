import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  loadDemoFixtures,
  toolModules,
  type CallEnvelope,
  type ToolInputMap,
  type ToolName,
} from '@bs/contracts';
import Fastify from 'fastify';
import { GovernedGateway } from '../../../../packages/core/src/governance/index.ts';
import { createFixtureIdentityVerifier, governanceRoutes } from '../../src/governance/index.ts';

const fixtures = loadDemoFixtures();
const [operator, approver, reader, , isolation] = fixtures.grants;
const tokens = new Map(fixtures.grants.map((grant) => [grant.actor.id, randomUUID()]));
const verifyIdentity = createFixtureIdentityVerifier(
  new Map(
    fixtures.grants.map(({ tenantId, actor }) => [tokens.get(actor.id)!, { tenantId, actor }]),
  ),
);

function credentials(grant = reader) {
  return { authorization: 'Bearer ' + tokens.get(grant.actor.id) };
}

function envelope(grant = reader, key = randomUUID() as string): CallEnvelope {
  return {
    version: 'v1',
    tenantId: grant.tenantId,
    actor: grant.actor,
    source: 'rest',
    traceId: 'trace-' + key,
    correlationId: 'scenario-1',
    idempotencyKey: key,
  };
}

function fixtureApp(gateway = new GovernedGateway()) {
  const app = Fastify();
  app.register(governanceRoutes, {
    gateway,
    verifyIdentity,
    allowedMcpOrigins: ['http://localhost:5173'],
  });
  function rest<Tool extends ToolName>(
    tool: Tool,
    input: ToolInputMap[Tool],
    grant = reader,
    claim = envelope(grant),
  ) {
    return app.inject({
      method: 'POST',
      url: '/v1/tools/' + tool,
      headers: credentials(grant),
      payload: { tool, input, envelope: claim },
    });
  }
  function mcp(
    method: string,
    params?: unknown,
    grant = reader,
    extraHeaders = {},
    id: number | undefined = 1,
  ) {
    return app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        ...credentials(grant),
        accept: 'application/json, text/event-stream',
        ...extraHeaders,
      },
      payload: { jsonrpc: '2.0', id, method, params },
    });
  }
  return { app, gateway, rest, mcp };
}

test('REST and authenticated MCP serve the same tenant-scoped order and use the shared catalog', async (t) => {
  const { app, gateway, rest, mcp } = fixtureApp();
  t.after(() => app.close());
  const initialized = await mcp('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(initialized.statusCode, 200);
  assert.equal(initialized.json().result.protocolVersion, '2025-06-18');
  const notification = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { ...credentials(), accept: 'application/json, text/event-stream' },
    payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
  });
  assert.equal(notification.statusCode, 202);
  assert.equal(notification.body, '');
  const list = await mcp('tools/list');
  const listed = list.json().result.tools;
  assert.deepEqual(
    listed.map((item: { name: string }) => item.name),
    Object.keys(toolModules),
  );
  assert.ok(
    listed.every((item: { inputSchema: { type: string } }) => item.inputSchema.type === 'object'),
  );
  const lookup = (orderId: string, grant = reader) =>
    mcp('tools/call', { name: 'order.read', arguments: { orderId } }, grant);
  const restOrder = await rest('order.read', { orderId: 'ord-001' });
  const mcpOrder = await lookup('ord-001');
  assert.equal(restOrder.statusCode, 200);
  assert.equal(restOrder.json().output.id, 'ord-001');
  assert.equal(mcpOrder.statusCode, 200);
  assert.deepEqual(mcpOrder.json().result.structuredContent, restOrder.json());
  assert.deepEqual(JSON.parse(mcpOrder.json().result.content[0].text), restOrder.json());
  const missing = await rest('order.read', { orderId: 'ord-absent' });
  const foreign = await rest('order.read', { orderId: 'ord-isolation' });
  assert.equal(missing.json().code, 'not_found');
  assert.deepEqual(foreign.json(), missing.json());
  assert.deepEqual(
    (await lookup('ord-isolation')).json().result,
    (await lookup('ord-absent')).json().result,
  );
  assert.deepEqual((await lookup('ord-isolation')).json().result.structuredContent, missing.json());
  assert.equal(
    (await lookup('ord-isolation', isolation)).json().result.structuredContent.output.id,
    'ord-isolation',
  );
  assert.deepEqual(
    gateway
      .audit()
      .slice(0, 2)
      .map((entry) => entry.source),
    ['rest', 'mcp'],
  );
});

test('transport validation rejects unauthenticated callers, claim mismatches and malformed inputs', async (t) => {
  const { app, gateway, rest, mcp } = fixtureApp();
  t.after(() => app.close());
  for (const url of ['/mcp', '/v1/tools/order.read']) {
    const missing = await app.inject({ method: 'POST', url, payload: {} });
    const bad = await app.inject({
      method: 'POST',
      url,
      payload: {},
      headers: { authorization: 'Bearer actor-reader' },
    });
    assert.equal(missing.statusCode, 401);
    assert.equal(bad.statusCode, 401);
  }
  const order = { orderId: 'ord-001' };
  const wrongTenant = { ...envelope(), tenantId: isolation.tenantId };
  const wrongActor = { ...envelope(), actor: operator.actor };
  for (const claim of [wrongTenant, wrongActor]) {
    assert.equal((await rest('order.read', order, reader, claim)).statusCode, 403);
  }
  const invalid = await app.inject({
    method: 'POST',
    url: '/v1/tools/order.read',
    headers: credentials(),
    payload: { tool: 'order.read', input: { orderId: 123 }, envelope: envelope() },
  });
  assert.equal(invalid.statusCode, 400);
  const spoofed = await mcp('tools/call', {
    name: 'order.read',
    arguments: { ...order, tenantId: isolation.tenantId },
  });
  assert.equal(spoofed.json().error.code, -32602);
  assert.equal(
    (await mcp('tools/list', undefined, reader, { origin: 'https://foreign.example' })).statusCode,
    403,
  );
  assert.equal(
    (await mcp('tools/list', undefined, reader, { 'mcp-protocol-version': 'invalid' })).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ method: 'GET', url: '/mcp', headers: credentials() })).statusCode,
    405,
  );
  assert.equal(gateway.audit().length, 0);
});

test('approval through REST retries through MCP with the same PO and one approval usage event', async (t) => {
  const local = loadDemoFixtures();
  local.entitlements.find((entry) => entry.flag.module === 'insights')!.flag.enabled = false;
  const gateway = new GovernedGateway({ fixtures: local });
  const { app, rest, mcp } = fixtureApp(gateway);
  t.after(() => app.close());
  const draft = await rest('purchase.order.draft', { requestId: 'pr-001' }, operator);
  assert.equal(draft.json().state, 'ok');
  const { draft: order, approval } = draft.json().output;
  const input = { draftId: order.id, approvalId: approval.id };
  const approved = await rest(
    'purchase.order.approve',
    input,
    approver,
    envelope(approver, 'approve'),
  );
  assert.equal(approved.json().output.status, 'approved');
  const retry = await mcp(
    'tools/call',
    { name: 'purchase.order.approve', arguments: input },
    approver,
    { 'idempotency-key': 'approve' },
  );
  assert.deepEqual(retry.json().result.structuredContent, approved.json());
  const denied = await rest('fraud.score', { orderId: 'ord-003' }, operator);
  assert.equal(denied.json().code, 'module_disabled');
  const nullable = await mcp(
    'tools/call',
    { name: 'forecast.run', arguments: { series: 'weekly_sales', skuId: null, horizonWeeks: 1 } },
    operator,
  );
  assert.equal(nullable.json().result.structuredContent.code, 'module_disabled');
  const audited = gateway.audit().find((entry) => entry.tool === 'purchase.order.approve')!;
  assert.equal(gateway.usage().filter((event) => event.outcomeId === audited.actionId).length, 1);
  assert.doesNotMatch(
    JSON.stringify(gateway.audit()),
    /pr-001|ord-003|approvalId|draftId|vendor-002/,
  );
});
