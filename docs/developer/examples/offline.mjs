import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createClient, verifyWebhookSignature } from '../../../packages/sdk/src/index.ts';

const order = { id: 'ord-001' };
const result = { state: 'ok', output: order };
const client = createClient({
  baseUrl: 'https://api.fixture.example',
  auth: { bearerToken: 'fixture-reader' },
  llm: { auth: { apiKey: 'fixture-llm-key' } },
  maxRetries: 0,
  async fetch(url, init) {
    switch (url.pathname) {
      case '/platform/v1/me':
        return Response.json({
          tenant: { id: 'tenant-rivetquay', name: 'Rivetquay' },
          actor: { id: 'actor-reader', kind: 'person', displayName: 'Fixture Reader' },
          role: 'reader',
          workspaces: [],
        });
      case '/v1/tools/order.read': {
        const call = JSON.parse(init.body);
        assert.equal(call.input.orderId, order.id);
        assert.equal(
          call.envelope.idempotencyKey,
          new Headers(init.headers).get('idempotency-key'),
        );
        return Response.json(result);
      }
      case '/platform/v1/audit':
        return url.searchParams.has('cursor')
          ? Response.json({ items: [{ id: 'audit-002' }], nextCursor: null })
          : Response.json({ items: [{ id: 'audit-001' }], nextCursor: 'fixture-cursor' });
      case '/mcp': {
        const { id, method, params } = JSON.parse(init.body);
        if (method === 'notifications/initialized') return new Response(null, { status: 202 });
        const reply = (result) => Response.json({ jsonrpc: '2.0', id, result });
        if (method === 'initialize')
          return reply({
            protocolVersion: params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          });
        if (method === 'tools/list')
          return reply({ tools: [{ name: 'order.read', inputSchema: {} }] });
        assert.equal(method, 'tools/call');
        assert.equal(params.arguments.orderId, order.id);
        return reply({ content: [], structuredContent: result });
      }
      case '/llm/v1/chat/completions':
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer fixture-llm-key');
        return new Response(
          'data: ' +
            JSON.stringify({
              object: 'chat.completion.chunk',
              choices: [{ delta: { content: 'Fictional order.' } }],
            }) +
            '\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      default:
        throw new Error('Unexpected fixture path ' + url.pathname);
    }
  },
});

const rest = await client.records.get('order', 'ord-001');
const mcp = await client.mcp.call('order.read', { orderId: 'ord-001' });
assert.deepEqual(rest, mcp);
console.log('Order', rest.output.id);
const audit = await Array.fromAsync(client.platform.auditEntries());
console.log('Audit', audit.map(({ id }) => id).join(', '));

const messages = [{ role: 'user', content: 'Summarize the fictional order.' }];
for await (const chunk of client.llm.streamChat({ model: 'tenant-chat', messages })) {
  process.stdout.write(chunk.choices.map(({ delta }) => delta.content ?? '').join(''));
}
console.log();

const body = Buffer.from('{"eventId":"evt-fixture-001"}');
const stamp = '1795618800';
const secret = 'fixture-webhook-secret';
const signature = createHmac('sha256', secret)
  .update(stamp + '.')
  .update(body)
  .digest('hex');
assert.ok(
  verifyWebhookSignature(
    body,
    {
      'x-connector-timestamp': stamp,
      'x-connector-signature': signature,
    },
    secret,
    { nowSeconds: Number(stamp) },
  ),
);
console.log('Verified fixture webhook');
