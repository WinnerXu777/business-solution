import { expect, test, vi } from 'vitest';
import { HttpPlatformClient, MockPlatformClient } from '../src/index.ts';

const baseUrl = 'https://platform.example';

test('reads governed records and scores using verified actor claims and preserves tool denials', async () => {
  const identity = await new MockPlatformClient({ role: 'operator' }).getMe();
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    if (String(url).endsWith('/me')) return Response.json(identity);
    if (String(url).endsWith('/order.read'))
      return Response.json({ state: 'ok', output: { id: 'ord-001' } });
    return Response.json({ state: 'denied', code: 'module_disabled' });
  });
  const { records, insights } = new HttpPlatformClient({ baseUrl, token: 'fixture-auth', fetch });
  await expect(records.getOrder('ord-001')).resolves.toEqual({ id: 'ord-001' });
  await expect(insights.scoreFraud('ord-003')).rejects.toMatchObject({ code: 'module_disabled' });
  await expect(
    records.approvePurchaseOrder('draft-001', 'approval-002', 'retry-key'),
  ).rejects.toMatchObject({ code: 'module_disabled' });
  const calls = fetch.mock.calls
    .filter(([url]) => String(url).includes('/v1/tools/'))
    .map(([url, options]) => ({
      url,
      method: options?.method,
      authorization: new Headers(options?.headers).get('authorization'),
      body: JSON.parse(String(options?.body)),
    }));
  expect(calls).toEqual([
    {
      url: baseUrl + '/v1/tools/order.read',
      method: 'POST',
      authorization: 'Bearer fixture-auth',
      body: {
        tool: 'order.read',
        input: { orderId: 'ord-001' },
        envelope: expect.objectContaining({
          version: 'v1',
          source: 'portal',
          tenantId: identity.tenant.id,
          actor: { id: identity.actor.id, kind: identity.actor.kind },
        }),
      },
    },
    expect.objectContaining({
      url: baseUrl + '/v1/tools/fraud.score',
      body: expect.objectContaining({ input: { orderId: 'ord-003' } }),
    }),
    expect.objectContaining({
      url: baseUrl + '/v1/tools/purchase.order.approve',
      body: expect.objectContaining({
        input: { draftId: 'draft-001', approvalId: 'approval-002' },
        envelope: expect.objectContaining({ idempotencyKey: 'retry-key' }),
      }),
    }),
  ]);
});

test('parses split SSE frames and ignores already-seen and foreign run events', async () => {
  const enc = new TextEncoder();
  const events = new ReadableStream({
    start(controller) {
      controller.enqueue(
        enc.encode(
          ': keepalive\r\n\r\nid: 4\r\ndata: {"id":4,"kind":"started","runId":"bot-1"}\r\n\r\nid: 5\r',
        ),
      );
      controller.enqueue(
        enc.encode(
          '\nevent: step_started\r\ndata: {"id":5,\r\ndata: "kind":"step_started","runId":"bot-1","tool":"order.read"}\r\n\r\n',
        ),
      );
      controller.enqueue(
        enc.encode(
          'data: {"id":6,"kind":"started","runId":"bot-other"}\n\ndata: {"id":7,"kind":"settled","runId":"bot-1"}\n\n',
        ),
      );
      controller.close();
    },
  });
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(events, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }),
  );
  const { automation } = new HttpPlatformClient({ baseUrl, token: 'fixture-auth', fetch });
  const abort = new AbortController();
  const updates = [];
  for await (const event of automation.streamBot('bot-1', 4, abort.signal)) updates.push(event);
  expect(updates.map((row) => row.id)).toEqual([5, 7]);
  const [[url, init]] = fetch.mock.calls;
  expect(url).toBe(baseUrl + '/automation/bots/runs/bot-1/events');
  expect(init?.signal).toBe(abort.signal);
  const headers = new Headers(init?.headers);
  expect(headers.get('last-event-id')).toBe('4');
  expect(headers.get('authorization')).toBe('Bearer fixture-auth');
});

test('requests a workflow plan and uses only preview mode to retrieve message copy', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    String(url).endsWith('/preview')
      ? Response.json([{ kind: 'action', nodeId: 'send', tool: 'workflow.template.run' }])
      : Response.json({
          state: 'ok',
          output: { status: 'previewed', previews: [{ id: 'fixture-message-1' }], receipts: [] },
        }),
  );
  const { automation } = new HttpPlatformClient({ token: 'fake', fetch });
  const target = {
    definitionId: 'win-back-v1',
    version: 1,
    input: { trigger: { kind: 'manual' as const }, values: {} },
  };
  const preview = await automation.preview(target);
  expect(preview.messages).toEqual([{ id: 'fixture-message-1' }]);
  expect(fetch.mock.calls.map(([url, init]) => [url, JSON.parse(String(init?.body))])).toEqual([
    ['/automation/workflows/preview', target],
    ['/automation/workflows/win-back-v1', { mode: 'preview' }],
  ]);
});

test('keeps billing, vault and connector routes scoped and encodes opaque references', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    if (String(url).endsWith('/start'))
      return Response.json({ authorizeUrl: 'https://fixture.example/auth' });
    if (String(url).endsWith('/invoices')) return Response.json({ items: [], creditNotes: [] });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ ref: 'vault://fixture' });
  });
  const { billing, credentials, connectors } = new HttpPlatformClient({
    token: 'fixture-auth',
    fetch,
  });
  await billing.changePlan({ addOns: ['erp'], overageLimitCents: 0 });
  await expect(billing.listInvoices()).resolves.toEqual({ items: [], creditNotes: [] });
  await billing.finalizeInvoice('invoice-1');
  await expect(
    credentials.add({ providerId: 'fixture-byo', capability: 'llm', secret: 'fixture-value' }),
  ).resolves.toBeUndefined();
  await expect(credentials.rotate('vault://fixture', 'fixture-rotation')).resolves.toBeUndefined();
  await credentials.revoke('vault://fixture');
  await connectors.install('ledger/fixture');
  await expect(connectors.startOAuth('ledger/fixture')).resolves.toEqual({
    authorizeUrl: 'https://fixture.example/auth',
  });
  expect(
    fetch.mock.calls.map(([url, init]) => [
      init?.method,
      url,
      init?.body && JSON.parse(String(init.body)),
      new Headers(init?.headers).get('authorization'),
    ]),
  ).toEqual([
    [
      'POST',
      '/platform/v1/billing/plan',
      { addOns: ['erp'], overageLimitCents: 0 },
      'Bearer fixture-auth',
    ],
    ['GET', '/platform/v1/billing/invoices', undefined, 'Bearer fixture-auth'],
    ['POST', '/platform/v1/billing/invoices/invoice-1/finalize', undefined, 'Bearer fixture-auth'],
    [
      'POST',
      '/platform/v1/credentials',
      { providerId: 'fixture-byo', capability: 'llm', secret: 'fixture-value' },
      'Bearer fixture-auth',
    ],
    [
      'POST',
      '/platform/v1/credentials/vault%3A%2F%2Ffixture/rotate',
      { secret: 'fixture-rotation' },
      'Bearer fixture-auth',
    ],
    ['DELETE', '/platform/v1/credentials/vault%3A%2F%2Ffixture', undefined, 'Bearer fixture-auth'],
    ['POST', '/connectors/ledger%2Ffixture/install', undefined, 'Bearer fixture-auth'],
    ['POST', '/connectors/ledger%2Ffixture/oauth/start', undefined, 'Bearer fixture-auth'],
  ]);
});
