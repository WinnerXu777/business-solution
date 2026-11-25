import { expect, test, vi } from 'vitest';
import { HttpPlatformClient } from '../src/index.ts';

const json = (data: unknown, status = 200) => Response.json(data, { status });
const requestUrl = (input: string | URL | Request) => String(input);

async function collect<T>(stream: AsyncIterable<T>) {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

test('binds auth to session cookies and exposes step-up challenges distinctly', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(json({ authorizeUrl: 'https://identity.rivetquay.example/login' }))
    .mockResolvedValueOnce(json({ expiresAt: '2026-11-25T16:00:00Z' }))
    .mockResolvedValueOnce(json({}))
    .mockResolvedValueOnce(json({ code: 'step_up_required' }, 401))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const client = new HttpPlatformClient({ fetch });
  await client.auth.login('/#/members', true);
  const [input, options] = fetch.mock.calls[0];
  const url = new URL(requestUrl(input), 'https://platform.rivetquay.example');
  expect(url.pathname).toBe('/platform/v1/auth/login');
  expect(url.searchParams.get('returnTo')).toBe('/#/members');
  expect(url.searchParams.get('stepUp')).toBe('true');
  expect(options).toMatchObject({ method: 'GET', credentials: 'include' });
  expect(new Headers(options?.headers).has('authorization')).toBe(false);
  await client.auth.callback('fixture-code', 'fixture-state');
  expect(fetch.mock.calls[1][0]).toBe(
    '/platform/v1/auth/callback?code=fixture-code&state=fixture-state',
  );
  await client.auth.refresh();
  expect(fetch.mock.calls[2]).toEqual([
    '/platform/v1/auth/refresh',
    expect.objectContaining({ method: 'POST' }),
  ]);
  await expect(
    client.access.invite({ email: 'mina@rivetquay.example', roleId: 'reader' }),
  ).rejects.toMatchObject({ code: 'step_up_required' });
  await client.auth.logout();
  expect(fetch.mock.calls[4]).toEqual([
    '/platform/v1/auth/logout',
    expect.objectContaining({ method: 'POST' }),
  ]);
});

test('uses OpenAI completion streaming, handles chunk boundaries and exposes route metadata', async () => {
  const buffers = [
    ': heartbeat\r\n\r\ndata: {"choices":[{"index":0,"delta":{"content":"Or',
    'der confirmed."}}]}\r\n\r\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\r\n\r\n',
    'data: [DONE]\r\n\r\n',
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const part of buffers) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(json({ data: [{ id: 'fixture-chat', owned_by: 'fixture' }] }))
    .mockResolvedValueOnce(
      new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'X-Provider-Route': 'fixture-byo',
          'X-Binding-Version': '2',
        },
      }),
    )
    .mockResolvedValueOnce(json({ data: [{ index: 0, embedding: [0.25] }] }));
  const client = new HttpPlatformClient({ fetch, token: 'fictional-bearer' });
  const [model] = await client.llm.models();
  const signal = new AbortController().signal;
  const input = {
    model: model.id,
    messages: [{ role: 'user' as const, content: 'Fixture order' }],
  };
  const chunks = await collect(client.llm.chat(input, signal));
  expect(chunks).toEqual([
    { choices: [], provider_route: 'fixture-byo', binding_version: 2 },
    { choices: [{ index: 0, delta: { content: 'Order confirmed.' } }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
  ]);
  expect(fetch.mock.calls[0][0]).toBe('/llm/v1/models');
  const [url, init] = fetch.mock.calls[1];
  expect(url).toBe('/llm/v1/chat/completions');
  expect(init).toMatchObject({ method: 'POST', signal });
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fictional-bearer');
  expect(JSON.parse(String(init?.body))).toEqual({
    ...input,
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(await client.llm.embeddings('fixture-embedding', ['Fixture text'])).toEqual({
    data: [{ index: 0, embedding: [0.25] }],
  });
  expect(fetch.mock.calls[2][0]).toBe('/llm/v1/embeddings');
});

test('uploads voice turns with a stable key and consumes SSE transcript events', async () => {
  const event = { kind: 'partial', text: 'Order' };
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response('data: ' + JSON.stringify(event) + '\n\ndata: {"kind":"settled"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    }),
  );
  const client = new HttpPlatformClient({ fetch });
  const audio = new Blob(['synthetic'], { type: 'audio/webm' });
  const chunks = await collect(
    client.conversations.voiceTurn(
      'voice/example',
      audio,
      'fixture-key',
      new AbortController().signal,
    ),
  );
  expect(chunks).toEqual([event, { kind: 'settled' }]);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe('/platform/v1/conversations/voice%2Fexample/voice');
  expect(init?.body).toBeInstanceOf(FormData);
  expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('fixture-key');
  expect(new Headers(init?.headers).has('content-type')).toBe(false);
});
