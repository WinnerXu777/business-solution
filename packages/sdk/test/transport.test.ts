import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ApiError,
  DenialError,
  UnknownOutcome,
  createClient,
  paginate,
  parseSse,
  verifyWebhookSignature,
  type Fetch,
} from '../src/index.ts';

const identity = {
  tenant: { id: 'tenant-rivetquay' },
  actor: { id: 'actor-operator', kind: 'person', displayName: 'Fixture Operator' },
};
const endpoint = 'https://api.fixture.example';
async function collect<Item>(source: AsyncIterable<Item>): Promise<Item[]> {
  const items: Item[] = [];
  for await (const item of source) items.push(item);
  return items;
}

const makeClient = (fetch: Fetch) =>
  createClient({
    baseUrl: endpoint,
    auth: { bearerToken: 'fixture-operator' },
    fetch,
    retryBaseMs: 0,
  });

test('bearer sessions and LLM API keys reach their configured hosts', async () => {
  const requests: Request[] = [];
  const client = createClient({
    baseUrl: endpoint,
    auth: { bearerToken: 'fixture-session' },
    llm: { baseUrl: 'https://llm.fixture.example', auth: { apiKey: 'fixture-llm-key' } },
    async fetch(url, init) {
      requests.push(new Request(url, init));
      return Response.json(url.pathname.endsWith('/me') ? identity : { object: 'list', data: [] });
    },
  });
  await client.platform.getPlatformIdentity();
  await client.llm.models();
  assert.deepEqual(
    requests.map((r) => [r.url, r.headers.get('authorization'), r.redirect]),
    [
      [endpoint + '/platform/v1/me', 'Bearer fixture-session', 'error'],
      ['https://llm.fixture.example/llm/v1/models', 'Bearer fixture-llm-key', 'error'],
    ],
  );
});

test('generated REST calls reuse the automatic key and serialized envelope on retries', async () => {
  const requests: Request[] = [];
  const client = makeClient(async (url, init) => {
    if (url.pathname === '/platform/v1/me') return Response.json(identity);
    assert.equal(url.pathname, '/v1/tools/order.read');
    requests.push(new Request(url, init));
    if (requests.length === 1) throw new TypeError('fixture connection failure');
    if (requests.length === 2) return Response.json({ error: 'unavailable' }, { status: 503 });
    return Response.json({ state: 'ok', output: { id: 'ord-001' } });
  });
  assert.deepEqual(await client.tools.readOrder({ orderId: 'ord-001' }), {
    state: 'ok',
    output: { id: 'ord-001' },
  });
  const keys = requests.map((r) => r.headers.get('idempotency-key'));
  assert.match(keys[0] ?? '', /^[a-f0-9-]{36}$/);
  assert.deepEqual(keys, Array(3).fill(keys[0]));
  const bodies = await Promise.all(requests.map((r) => r.text()));
  assert.deepEqual(bodies, Array(3).fill(bodies[0]));
  const { envelope, tool, input } = JSON.parse(bodies[0]);
  assert.equal(envelope.idempotencyKey, keys[0]);
  assert.equal(envelope.tenantId, 'tenant-rivetquay');
  assert.deepEqual(envelope.actor, { id: 'actor-operator', kind: 'person' });
  assert.equal(tool, 'order.read');
  assert.deepEqual(input, { orderId: 'ord-001' });
});

test('a key does not enable retries on unkeyed writes; Retry-After caps safe retries', async () => {
  const requests: Request[] = [];
  const client = makeClient(async (url, init) => {
    requests.push(new Request(url, init));
    return Response.json(
      { error: 'unavailable' },
      {
        status: 503,
        headers: {
          'retry-after': init.method === 'POST' ? '0' : '30',
        },
      },
    );
  });
  await assert.rejects(
    client.platform.signPlatformApproval({ path: { id: 'approval-001' } }),
    (error) => error instanceof ApiError && error.status === 503,
  );
  await assert.rejects(
    client.llm.chat({ model: 'fixture-chat', messages: [] }, { idempotencyKey: 'explicit-key' }),
    ApiError,
  );
  await assert.rejects(
    client.platform.getPlatformIdentity(),
    (error) => error instanceof ApiError && error.retryAfterMs === 30_000,
  );
  assert.equal(requests.length, 3);
  assert.ok(requests[0].headers.get('idempotency-key'));
  assert.equal(requests[1].headers.get('idempotency-key'), 'explicit-key');
});

test('denial codes map for HTTP and governed results; ambiguous outcomes surface their action ID', async () => {
  const cases = [
    { state: 'denied', code: 'invalid_approval' },
    { state: 'unknown', actionId: 'fixture-action' },
    { state: 'pending_approval', approval: { id: 'approval-001' } },
  ];
  const client = makeClient(async (url) => {
    if (url.pathname === '/platform/v1/me') return Response.json(identity);
    if (url.pathname === '/platform/v1/usage') {
      return Response.json(
        { error: 'forbidden' },
        { status: 403, headers: { 'x-request-id': 'fixture-request' } },
      );
    }
    return Response.json(cases.shift());
  });
  await assert.rejects(
    client.platform.listPlatformUsage(),
    (error) =>
      error instanceof DenialError &&
      error.code === 'forbidden' &&
      error.requestId === 'fixture-request',
  );
  await assert.rejects(
    client.tools.readOrder({ orderId: 'ord-001' }),
    (error) => error instanceof DenialError && error.code === 'invalid_approval',
  );
  await assert.rejects(
    client.tools.readOrder({ orderId: 'ord-001' }),
    (error) => error instanceof UnknownOutcome && error.actionId === 'fixture-action',
  );
  assert.equal((await client.tools.readOrder({ orderId: 'ord-001' })).state, 'pending_approval');
});

test('audit iteration keeps filters, encodes opaque cursors and stops at null', async () => {
  const cursors: (string | null)[] = [];
  const client = makeClient(async (url) => {
    assert.equal(url.searchParams.get('tool'), 'order.read');
    const cursor = url.searchParams.get('cursor');
    cursors.push(cursor);
    return Response.json(
      cursor === 'a+/='
        ? { items: [{ id: 'audit-002' }], nextCursor: null }
        : { items: [{ id: 'audit-001' }], nextCursor: 'a+/=' },
    );
  });
  const ids = [];
  for await (const entry of client.platform.auditEntries({ tool: 'order.read' }))
    ids.push(entry.id);
  assert.deepEqual(ids, ['audit-001', 'audit-002']);
  assert.deepEqual(cursors, [null, 'a+/=']);
  await assert.rejects(
    collect(paginate(async () => ({ items: [], nextCursor: 'loop' }))),
    (error) => error instanceof ApiError && error.code === 'repeated_cursor',
  );
});

function bytes(stream: string, width: number) {
  const encoded = new TextEncoder().encode(stream);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < encoded.length; i += width)
        controller.enqueue(encoded.slice(i, i + width));
      controller.close();
    },
  });
}
const sse = (data: string) =>
  new Response(bytes(data, 3), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });

test('SSE handles split UTF-8, CRLF, comments, multiline data and incomplete final frames', async () => {
  const stream = bytes(
    '\uFEFF: comment\r\nid: 42\r\nevent: result\r\ndata: Montréal\r\ndata: deux\r\n\r\ndata: next\n\ndata: discarded',
    1,
  );
  assert.deepEqual(await collect(parseSse(stream)), [
    { id: '42', event: 'result', data: 'Montréal\ndeux' },
    { id: '42', event: 'message', data: 'next' },
  ]);
});

test('LLM chunks stop at DONE and interrupted streams fail; bot streams pass Last-Event-ID', async () => {
  const chunk = { object: 'chat.completion.chunk', choices: [{ delta: { content: 'Fixture' } }] };
  const botEvent = { id: 3, runId: 'run-001', kind: 'settled' };
  let done = true;
  const client = makeClient(async (url, init) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('accept'), 'text/event-stream');
    if (url.pathname.endsWith('/events')) {
      assert.equal(headers.get('last-event-id'), '2');
      return sse('id: 3\nevent: settled\ndata: ' + JSON.stringify(botEvent) + '\n\n');
    }
    assert.equal(JSON.parse(String(init.body)).stream, true);
    return sse('data: ' + JSON.stringify(chunk) + '\n\n' + (done ? 'data: [DONE]\n\n' : ''));
  });
  const input = { model: 'fixture-chat', messages: [] };
  assert.deepEqual(await collect(client.llm.streamChat(input)), [chunk]);
  assert.deepEqual(await collect(client.automation.streamBot('run-001', { after: 2 })), [botEvent]);
  done = false;
  await assert.rejects(collect(client.llm.streamChat(input)), {
    code: 'incomplete_stream',
  });
});

test('webhook signature verifies the exact bytes and enforces timestamp tolerance', () => {
  const body = Buffer.from('{"id":"fixture-é"}\n');
  const secret = 'fictional-secret';
  const timestamp = '1795618800';
  const signature = createHmac('sha256', secret)
    .update(timestamp + '.')
    .update(body)
    .digest('hex');
  const headers = { 'X-Connector-Timestamp': timestamp, 'X-Connector-Signature': signature };
  const nowSeconds = Number(timestamp) + 300;
  assert.ok(verifyWebhookSignature(body, headers, secret, { nowSeconds }));
  assert.equal(
    verifyWebhookSignature(body.subarray(0, -1), headers, secret, { nowSeconds }),
    false,
  );
  assert.equal(
    verifyWebhookSignature(body, headers, secret, { nowSeconds: nowSeconds + 1 }),
    false,
  );
  assert.equal(
    verifyWebhookSignature(body, { ...headers, 'X-Connector-Signature': 'bad' }, secret, {
      nowSeconds,
    }),
    false,
  );
});

test('MCP negotiates once, carries session/version and handles JSON and SSE results', async () => {
  const methods: string[] = [];
  const client = makeClient(async (url, init) => {
    const request = new Request(url, init);
    const { method, id, params } = await request.json();
    methods.push(method);
    assert.equal(url.pathname, '/mcp');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('accept'), 'application/json, text/event-stream');
    assert.equal(request.headers.get('authorization'), 'Bearer fixture-operator');
    const rpc = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') {
      return Response.json(
        rpc({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fixture', version: '1' },
        }),
        { headers: { 'Mcp-Session-Id': 'fake-session' } },
      );
    }
    assert.equal(request.headers.get('mcp-session-id'), 'fake-session');
    assert.equal(request.headers.get('mcp-protocol-version'), '2025-06-18');
    if (method === 'notifications/initialized') {
      assert.equal(id, undefined);
      return new Response(null, { status: 202 });
    }
    if (method === 'tools/list')
      return Response.json(rpc({ tools: [{ name: 'order.read', inputSchema: {} }] }));
    assert.equal(method, 'tools/call');
    assert.equal(request.headers.get('idempotency-key'), 'mcp-order-001');
    assert.deepEqual(params, { name: 'order.read', arguments: { orderId: 'ord-001' } });
    return sse(
      'data: ' +
        JSON.stringify(
          rpc({
            structuredContent: { state: 'ok', output: { id: 'ord-001' } },
            content: [],
          }),
        ) +
        '\n\n',
    );
  });
  assert.equal((await client.mcp.listTools()).tools[0].name, 'order.read');
  assert.deepEqual(
    await client.mcp.call(
      'order.read',
      { orderId: 'ord-001' },
      { idempotencyKey: 'mcp-order-001' },
    ),
    {
      state: 'ok',
      output: { id: 'ord-001' },
    },
  );
  assert.deepEqual(methods, [
    'initialize',
    'notifications/initialized',
    'tools/list',
    'tools/call',
  ]);
});

test('checked-in SDK matches its generated sources', () => {
  const script = fileURLToPath(new URL('../scripts/generate.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
