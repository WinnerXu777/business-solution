import assert from 'node:assert/strict';
import { createClient } from '../../../packages/sdk/src/index.ts';

const client = createClient({
  baseUrl: process.env.BS_BASE_URL ?? 'http://127.0.0.1:3000',
  auth: { bearerToken: process.env.BS_TOKEN ?? 'fixture-reader' },
});

const rest = await client.records.get('order', 'ord-001');
const mcp = await client.mcp.call('order.read', { orderId: 'ord-001' });
assert.equal(rest.state, 'ok');
assert.deepEqual(rest, mcp);
console.log(rest.output.id);
