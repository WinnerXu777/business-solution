import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import Fastify from 'fastify';
import {
  createFixtureModelAdapter,
  ProviderError,
  type ModelAdapter,
} from '../../../../packages/adapters/src/llm/index.ts';
import {
  llmPlugin,
  type LlmPluginOptions,
  type Route,
  type UsageRecord,
} from '../../src/llm/index.ts';

const base = '/llm/v1';
const chat = base + '/chat/completions';
const embeds = base + '/embeddings';
const headers = { authorization: 'Bearer fictional-api-key' };
const other = { authorization: 'Bearer fictional-other-key' };
const prompt = 'synthetic-confidential-prompt';
const payload = {
  model: 'tenant-chat',
  messages: [{ role: 'user', content: prompt }],
  max_tokens: 16,
};
const embeddingInput = { model: 'tenant-embedding', input: ['fictional alpha', 'fictional beta'] };
const structured = {
  type: 'json_schema',
  json_schema: {
    name: 'inventory',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['sku'],
      properties: { sku: { $ref: '#/$defs/sku' } },
      $defs: { sku: { type: 'string', minLength: 3 } },
    },
  },
};

const fixture = createFixtureModelAdapter({ structuredText: '{"sku":"fictional-sku"}' });
function route(overrides: Partial<Route> = {}): Route {
  return {
    routeId: 'fixture-route',
    priceVersion: 'fictional-price-v4',
    chargeMode: 'native',
    adapter: fixture,
    models: { 'tenant-chat': 'fictional-chat-v1' },
    estimateInputTokens: () => 10,
    ...overrides,
  };
}

async function harness(t: TestContext, overrides: Partial<LlmPluginOptions> = {}) {
  const app = Fastify();
  t.after(() => app.close());
  const usage: UsageRecord[] = [];
  const logs: unknown[] = [];
  const calls: string[][] = [];
  await app.register(llmPlugin, {
    verifyApiKey: (key) =>
      ({
        'fictional-api-key': { tenantId: 'fictional-tenant-a' },
        'fictional-other-key': { tenantId: 'fictional-tenant-b' },
      })[key] ?? null,
    resolveBinding(tenant, capability) {
      calls.push([tenant, capability]);
      if (capability === 'embeddings')
        return {
          version: 'embedding-binding-v2',
          primary: route({ models: { 'tenant-embedding': 'fictional-embedding-v2' } }),
        };
      return { version: 'chat-binding-v1', primary: route() };
    },
    emitUsage: (record) => {
      usage.push(record);
    },
    logRequest: (record) => {
      logs.push(record);
    },
    ...overrides,
  });
  return { app, usage, logs, calls };
}

function frames(body: string) {
  return body
    .trimEnd()
    .split('\n\n')
    .map((frame) => {
      assert(frame.startsWith('data: '));
      const value = frame.slice(6);
      return value === '[DONE]' ? value : JSON.parse(value);
    });
}

test('authenticates before model lookup and returns a pinned OpenAI-compatible reply with usage and redacted audit', async (t) => {
  const { app, usage, logs, calls } = await harness(t);
  const unauthorized = await app.inject({ method: 'POST', url: chat, payload });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.json().error.code, 'invalid_api_key');
  assert.deepEqual(calls, []);
  const response = await app.inject({ method: 'POST', url: chat, headers, payload });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-llm-binding-version'], 'chat-binding-v1');
  const reply = response.json();
  assert.match(reply.id, /^chatcmpl-/);
  assert.equal(reply.object, 'chat.completion');
  assert.equal(reply.model, 'fictional-chat-v1');
  assert.deepEqual(reply.choices, [
    {
      index: 0,
      message: { role: 'assistant', content: 'Synthetic completion.' },
      finish_reason: 'stop',
    },
  ]);
  assert.deepEqual(reply.usage, { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 });
  assert.deepEqual(usage, [
    {
      eventId: response.headers['x-request-id'] + '-1',
      requestId: response.headers['x-request-id'],
      attempt: 1,
      tenantId: 'fictional-tenant-a',
      capability: 'llm',
      bindingVersion: 'chat-binding-v1',
      provider: 'fixture',
      model: 'fictional-chat-v1',
      route: 'fixture-route',
      priceVersion: 'fictional-price-v4',
      chargeMode: 'native',
      outcome: 'succeeded',
      inputTokens: 1,
      outputTokens: 2,
      budgetTokens: 3,
    },
  ]);
  assert.deepEqual(calls, [['fictional-tenant-a', 'llm']]);
  assert.equal(logs.length, 2);
  const metadata = JSON.stringify({ logs, usage });
  for (const sensitive of [
    prompt,
    'fictional-api-key',
    'Synthetic completion.',
    'authorization',
    'messages',
  ]) {
    assert(!metadata.includes(sensitive));
  }
  assert.match(metadata, /chat-binding-v1/);
  assert.match(metadata, /fixture-route/);
});

test('streams OpenAI-compatible SSE, tool calls, and optional usage', async (t) => {
  const { app, usage } = await harness(t);
  const tools = [
    { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } },
  ];
  const tool_choice = { type: 'function', function: { name: 'lookup' } };
  const response = await app.inject({
    method: 'POST',
    url: chat,
    headers,
    payload: {
      ...payload,
      tools,
      tool_choice,
      stream: true,
      stream_options: { include_usage: true },
    },
  });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /^text\/event-stream/);
  assert.equal(response.headers['x-llm-binding-version'], 'chat-binding-v1');
  const chunks = frames(response.body);
  assert.equal(chunks.length, 5);
  assert.equal(chunks[0].object, 'chat.completion.chunk');
  assert.deepEqual(chunks[0].choices[0].delta, { role: 'assistant' });
  assert.deepEqual(chunks[1].choices[0].delta.tool_calls, [
    {
      index: 0,
      id: 'call_fixture',
      type: 'function',
      function: { name: 'lookup', arguments: '{}' },
    },
  ]);
  assert.equal(chunks[2].choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(chunks[3].choices, []);
  assert.equal(chunks[3].type, 'final');
  assert.equal(chunks[3].route, route().routeId);
  assert.equal(chunks[3].bindingVersion, 'chat-binding-v1');
  assert.deepEqual(chunks[3].usage, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 });
  assert.equal(chunks[4], '[DONE]');
  assert.equal(usage.length, 1);
  const normal = await app.inject({
    method: 'POST',
    url: chat,
    headers,
    payload: { ...payload, tools, tool_choice },
  });
  assert.equal(normal.json().choices[0].message.tool_calls[0].function.name, 'lookup');
});

test('lists tenant model aliases and serves float or base64 embeddings from the embeddings binding', async (t) => {
  const { app, usage, calls } = await harness(t);
  const models = await app.inject({ url: base + '/models', headers });
  assert.equal(models.statusCode, 200);
  assert.equal(models.headers['x-llm-binding-version-llm'], 'chat-binding-v1');
  assert.equal(models.headers['x-llm-binding-version-embeddings'], 'embedding-binding-v2');
  assert.deepEqual(models.json(), {
    object: 'list',
    data: [
      { id: 'tenant-chat', object: 'model', created: 0, owned_by: 'platform' },
      { id: 'tenant-embedding', object: 'model', created: 0, owned_by: 'platform' },
    ],
  });
  for (const encoding_format of ['float', 'base64']) {
    const response = await app.inject({
      method: 'POST',
      url: embeds,
      headers,
      payload: { ...embeddingInput, dimensions: 4, encoding_format },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-llm-binding-version'], 'embedding-binding-v2');
    const result = response.json();
    assert.equal(result.model, 'fictional-embedding-v2');
    assert.equal(result.data[1].index, 1);
    assert.equal(result.data[1].object, 'embedding');
    const vector = result.data[1].embedding;
    assert.equal(
      typeof vector === 'string' ? Buffer.from(vector, 'base64').length / 4 : vector.length,
      4,
    );
    assert.deepEqual(result.usage, { prompt_tokens: 4, total_tokens: 4 });
  }
  assert.deepEqual(
    calls.map(([, capability]) => capability),
    ['llm', 'embeddings', 'embeddings', 'embeddings'],
  );
  assert(usage.every((record) => record.capability === 'embeddings' && record.outputTokens === 0));
});

test('validates structured output before sending JSON or SSE and rejects unsupported schemas before dispatch', async (t) => {
  const good = await harness(t);
  const bad = await harness(t, {
    resolveBinding: () => ({
      version: 'invalid-output-v1',
      primary: route({ adapter: createFixtureModelAdapter() }),
    }),
  });
  for (const stream of [false, true]) {
    const request = {
      method: 'POST' as const,
      url: chat,
      headers,
      payload: { ...payload, stream, response_format: structured },
    };
    const valid = await good.app.inject(request);
    assert.equal(valid.statusCode, 200);
    const content = stream
      ? frames(valid.body)[1].choices[0].delta.content
      : valid.json().choices[0].message.content;
    assert.deepEqual(JSON.parse(content), { sku: 'fictional-sku' });
    const invalid = await bad.app.inject(request);
    assert.equal(invalid.statusCode, 502);
    assert.equal(invalid.json().error.code, 'invalid_structured_output');
    assert.equal(invalid.headers['x-llm-binding-version'], 'invalid-output-v1');
  }
  const malformed = await good.app.inject({
    method: 'POST',
    url: chat,
    headers,
    payload: {
      ...payload,
      response_format: {
        ...structured,
        json_schema: { name: 'unsafe', schema: { $ref: 'https://fictional.example/s' } },
      },
    },
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().error.code, 'invalid_json_schema');
  assert.equal(good.calls.length, 2);
  assert(bad.usage.every((record) => record.outcome === 'failed' && record.outputTokens === 1));
});

test('rejects invalid requests and unlisted aliases without dispatch', async (t) => {
  const { app, calls, usage } = await harness(t);
  for (const body of [
    { ...payload, stream: 'true' },
    { ...payload, max_completion_tokens: 50 },
    { ...payload, tool_choice: 'required' },
    { ...payload, n: 2 },
  ]) {
    const response = await app.inject({ method: 'POST', url: chat, headers, payload: body });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'invalid_request');
  }
  assert.deepEqual(calls, []);
  const unknown = await app.inject({
    method: 'POST',
    url: chat,
    headers,
    payload: { ...payload, model: 'constructor' },
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.headers['x-llm-binding-version'], 'chat-binding-v1');
  assert.deepEqual(usage, []);
});

test('pins an in-flight request to its binding version and isolates tenants', async (t) => {
  const queued = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let version = 1;
  const oldAdapter: ModelAdapter = {
    ...fixture,
    async complete(...args) {
      queued.resolve();
      await resume.promise;
      return fixture.complete(...args);
    },
  };
  const { app, usage } = await harness(t, {
    resolveBinding(tenant) {
      if (tenant === 'fictional-tenant-b') return null;
      return {
        version: 'binding-v' + version,
        primary: route({
          models: { 'tenant-chat': 'fictional-chat-v' + version },
          adapter: version === 1 ? oldAdapter : fixture,
        }),
      };
    },
  });
  const request = { method: 'POST' as const, url: chat, headers, payload };
  const pending = app.inject(request).then((response) => response);
  await queued.promise;
  version = 2;
  const next = await app.inject(request);
  const denied = await app.inject({ ...request, headers: other });
  resume.resolve();
  const first = await pending;
  assert.equal(denied.statusCode, 503);
  assert.equal(first.headers['x-llm-binding-version'], 'binding-v1');
  assert.equal(next.headers['x-llm-binding-version'], 'binding-v2');
  assert.equal(first.json().model, 'fictional-chat-v1');
  assert.deepEqual(
    usage.map((record) => [record.bindingVersion, record.model]),
    [
      ['binding-v2', 'fictional-chat-v2'],
      ['binding-v1', 'fictional-chat-v1'],
    ],
  );
});

test('enforces per-tenant request and token windows and protects in-flight reservations across windows', async (t) => {
  let now = 100;
  const queued = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const adapter: ModelAdapter = {
    ...fixture,
    async complete(...args) {
      queued.resolve();
      await resume.promise;
      return fixture.complete(...args);
    },
  };
  const { app } = await harness(t, {
    now: () => now,
    limits: { requests: 2, tokens: 28, windowMs: 100 },
    resolveBinding: (tenant) => ({
      version: 'v1',
      primary: route({
        adapter: tenant === 'fictional-tenant-a' ? adapter : fixture,
      }),
    }),
  });
  const request = { method: 'POST' as const, url: chat, headers, payload };
  const pending = app.inject(request).then((response) => response);
  await queued.promise;
  try {
    now = 201;
    const denied = await app.inject(request);
    assert.equal(denied.statusCode, 429);
    assert.equal(denied.json().error.code, 'token_budget_exceeded');
    assert.equal((await app.inject({ ...request, headers: other })).statusCode, 200);
    assert.equal((await app.inject(request)).json().error.code, 'token_budget_exceeded');
    assert.equal((await app.inject(request)).json().error.code, 'rate_limit_exceeded');
  } finally {
    resume.resolve();
  }
  assert.equal((await pending).statusCode, 200);
  now = 302;
  assert.equal((await app.inject(request)).statusCode, 200);
});

test('falls back only for opted-in inference, meters both attempts, and leaves embeddings on their binding', async (t) => {
  const unavailable = () => new ProviderError('unavailable');
  const failing: ModelAdapter = {
    ...fixture,
    provider: 'failing-fixture',
    async complete() {
      throw unavailable();
    },
    async *stream() {
      throw unavailable();
    },
    async embed() {
      throw unavailable();
    },
  };
  const fallback = route({
    routeId: 'fallback',
    chargeMode: 'byo',
    priceVersion: 'price-fallback-v2',
    models: {
      'tenant-chat': 'fictional-fallback-chat',
      'tenant-embedding': 'fictional-fallback-embed',
    },
  });
  const { app, usage } = await harness(t, {
    resolveBinding: (tenant, capability) => ({
      version: 'fallback-binding-v3',
      primary: route({
        adapter: failing,
        models:
          capability === 'llm'
            ? { 'tenant-chat': 'fictional-chat-primary' }
            : { 'tenant-embedding': 'fictional-embed-primary' },
      }),
      ...(tenant === 'fictional-tenant-a' ? { inferenceFallback: fallback } : {}),
    }),
  });
  for (const stream of [false, true]) {
    const response = await app.inject({
      method: 'POST',
      url: chat,
      headers,
      payload: { ...payload, stream },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['x-llm-binding-version'], 'fallback-binding-v3');
    assert.equal(
      (stream ? frames(response.body)[0] : response.json()).model,
      'fictional-fallback-chat',
    );
  }
  assert.deepEqual(
    usage.map((record) => [record.attempt, record.route, record.outcome]),
    [
      [1, 'fixture-route', 'failed'],
      [2, 'fallback', 'succeeded'],
      [1, 'fixture-route', 'failed'],
      [2, 'fallback', 'succeeded'],
    ],
  );
  assert.equal(usage[0].inputTokens, null);
  assert.equal(usage[0].budgetTokens, 26);
  assert.equal(usage[1].priceVersion, 'price-fallback-v2');
  assert.equal(usage[1].chargeMode, 'byo');
  const denied = await app.inject({ method: 'POST', url: chat, headers: other, payload });
  const embedding = await app.inject({
    method: 'POST',
    url: embeds,
    headers,
    payload: embeddingInput,
  });
  assert.equal(denied.statusCode, 502);
  assert.equal(embedding.statusCode, 502);
  assert.equal(usage.length, 6);
});

test('does not replay a stream after sending a delta or leak a provider exception', async (t) => {
  const { app, usage, logs } = await harness(t, {
    resolveBinding: () => ({
      version: 'stream-binding-v1',
      primary: route({
        adapter: {
          ...fixture,
          async *stream() {
            yield { type: 'delta', content: 'Synthetic partial' };
            throw Object.assign(new ProviderError('unavailable'), { cause: prompt });
          },
        },
      }),
      inferenceFallback: route(),
    }),
  });
  const response = await app.inject({
    method: 'POST',
    url: chat,
    headers,
    payload: { ...payload, stream: true },
  });
  assert.equal(response.statusCode, 200);
  const chunks = frames(response.body);
  assert.equal(chunks[1].choices[0].delta.content, 'Synthetic partial');
  assert.equal(chunks.at(-1).error.code, 'provider_unavailable');
  assert(!chunks.includes('[DONE]'));
  assert(!response.body.includes(prompt));
  assert(!JSON.stringify(logs).includes(prompt));
  assert.equal(usage.length, 1);
  assert.equal(usage[0].outcome, 'failed');
});

test('fails closed after a sink error without leaking details or trying a fallback', async (t) => {
  let attempts = 0;
  const { app, logs } = await harness(t, {
    emitUsage: () => {
      attempts++;
      throw new Error(prompt);
    },
    resolveBinding: () => ({ version: 'v1', primary: route(), inferenceFallback: route() }),
  });
  for (let index = 0; index < 2; index++) {
    const response = await app.inject({ method: 'POST', url: chat, headers, payload });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'meter_unavailable');
    assert(!response.body.includes(prompt));
  }
  assert.equal(attempts, 1);
  assert(!JSON.stringify(logs).includes(prompt));
});

test('requires its own token reservation for a fallback attempt', async (t) => {
  const { app, usage } = await harness(t, {
    limits: { requests: 5, tokens: 40, windowMs: 10_000 },
    resolveBinding: () => ({
      version: 'fallback-binding-v1',
      primary: route({
        adapter: {
          ...fixture,
          async complete() {
            throw new ProviderError('unavailable');
          },
        },
      }),
      inferenceFallback: route({ routeId: 'fallback' }),
    }),
  });
  const response = await app.inject({ method: 'POST', url: chat, headers, payload });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['x-llm-binding-version'], 'fallback-binding-v1');
  assert.equal(response.json().error.code, 'token_budget_exceeded');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].budgetTokens, 26);
});
