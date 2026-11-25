import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDemoFixtures, toolModules } from '@bs/contracts';
import { createApp } from '../src/app.ts';

test('app serves a fixture order and MCP tool catalog with a host-provisioned bearer', async (t) => {
  const fixtures = loadDemoFixtures();
  const order = fixtures.orders.find((row) => row.id === 'ord-001')!;
  const { tenantId, actor } = fixtures.grants.find(
    (grant) => grant.tenantId === order.tenantId && grant.role === 'reader',
  )!;
  const token = randomUUID();
  const app = createApp({
    FIXTURE_BEARER_BINDINGS: JSON.stringify({ [token]: { tenantId, actorId: actor.id } }),
  });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${token}` };
  const response = await app.inject({
    method: 'POST',
    url: '/v1/tools/order.read',
    headers,
    payload: {
      tool: 'order.read',
      input: { orderId: order.id },
      envelope: {
        version: 'v1',
        tenantId,
        actor,
        source: 'rest',
        traceId: 'smoke-trace',
        correlationId: 'smoke-correlation',
        idempotencyKey: 'smoke-order-read',
      },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { state: 'ok', output: order });

  const list = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { ...headers, accept: 'application/json' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(
    list.json().result.tools.map((tool: { name: string }) => tool.name),
    Object.keys(toolModules),
  );
});

test('app requires a configured bearer binding for governed routes', async (t) => {
  const app = createApp({});
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { authorization: 'Bearer actor-reader', accept: 'application/json' },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  assert.equal(response.statusCode, 401);
});
