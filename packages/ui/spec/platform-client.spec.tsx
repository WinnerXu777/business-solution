import { expect, test, vi } from 'vitest';
import { HttpPlatformClient, MockPlatformClient } from '../src/index.ts';

test('HTTP client sends the platform paths, methods, payloads and bearer identity', async () => {
  const fake = vi.fn<typeof fetch>(async () => Response.json({ secret: 'fixture-secret' }));
  const client = new HttpPlatformClient({
    baseUrl: 'https://platform.example/',
    token: 'fixture-token',
    fetch: fake,
  });
  await client.getMe();
  await client.getWorkspaces();
  await client.getWorkspace('workspace/one');
  await client.getModules();
  await client.updateModule('records', false);
  await client.getCapabilities();
  await client.getProviders('speech-to-text');
  await client.updateBinding('llm', {
    providerId: 'openai',
    credentialRef: 'fixture/llm',
    fallbackProviderId: 'fixture-native',
  });
  await client.getAudit({
    tool: 'one tool',
    actorId: 'actor-demo',
    state: 'ok',
    from: '2026-11-01',
    to: '2026-11-25',
    cursor: 'audit/first',
    limit: 10,
  });
  await client.getUsage({ module: 'ai', from: '2026-11-01', to: '2026-11-25' });
  await client.getApprovals('expired');
  await client.signApproval('approval/one');
  await client.rejectApproval('approval/one', 'Review again.');
  await client.getConnections();
  expect(
    await client.createConnection({
      kind: 'mcp_client',
      name: 'Fixture',
      scopes: ['records:read'],
    }),
  ).toEqual({ secret: 'fixture-secret' });
  await client.revokeConnection('connection/one');
  await client.getBots();
  await client.getWorkflows();
  await client.getHealth();
  const requests = fake.mock.calls.map(([url, options]) => {
    expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer fixture-token');
    expect(String(url)).toMatch(/^https:\/\/platform\.example\/platform\/v1\//);
    return [
      options?.method,
      String(url).split('/platform/v1')[1],
      options?.body && JSON.parse(String(options.body)),
    ];
  });
  expect(requests).toEqual([
    ['GET', '/me', undefined],
    ['GET', '/workspaces', undefined],
    ['GET', '/workspaces/workspace%2Fone', undefined],
    ['GET', '/modules', undefined],
    ['PATCH', '/modules/records', { enabled: false }],
    ['GET', '/capabilities', undefined],
    ['GET', '/providers?capability=speech-to-text', undefined],
    [
      'PUT',
      '/capabilities/llm/binding',
      { providerId: 'openai', credentialRef: 'fixture/llm', fallbackProviderId: 'fixture-native' },
    ],
    [
      'GET',
      '/audit?tool=one+tool&actorId=actor-demo&state=ok&from=2026-11-01&to=2026-11-25&cursor=audit%2Ffirst&limit=10',
      undefined,
    ],
    ['GET', '/usage?module=ai&from=2026-11-01&to=2026-11-25', undefined],
    ['GET', '/approvals?state=expired', undefined],
    ['POST', '/approvals/approval%2Fone/sign', undefined],
    ['POST', '/approvals/approval%2Fone/reject', { reason: 'Review again.' }],
    ['GET', '/connections', undefined],
    ['POST', '/connections', { kind: 'mcp_client', name: 'Fixture', scopes: ['records:read'] }],
    ['DELETE', '/connections/connection%2Fone', undefined],
    ['GET', '/registry/bots', undefined],
    ['GET', '/registry/workflows', undefined],
    ['GET', '/health', undefined],
  ]);
});

test('HTTP client preserves denial codes, tolerates empty mutations, and wraps transport errors', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ code: 'idempotency_conflict' }, { status: 409 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockRejectedValueOnce(new Error('offline'));
  const client = new HttpPlatformClient({ token: 'fake', fetch });
  await expect(client.signApproval('fixture')).rejects.toMatchObject({
    code: 'idempotency_conflict',
  });
  await expect(client.revokeConnection('fixture')).resolves.toBeUndefined();
  await expect(client.getMe()).rejects.toMatchObject({ code: 'unavailable' });
});

test('mock enforces isolation, expiry, cursor paging and admin permissions', async () => {
  const reader = new MockPlatformClient({ role: 'reader' });
  await expect(reader.getWorkspace('tenant-spoolharbour')).rejects.toMatchObject({
    code: 'not_found',
  });
  await expect(reader.updateModule('ai', false)).rejects.toMatchObject({ code: 'forbidden' });
  const client = new MockPlatformClient({ now: '2026-11-25T16:01:00Z' });
  const expired = await client.getApprovals('expired');
  expect(expired).toHaveLength(1);
  await expect(client.signApproval(expired[0].id)).rejects.toMatchObject({
    code: 'invalid_approval',
  });
  const first = await client.getAudit({ limit: 1 });
  const second = await client.getAudit({ limit: 1, cursor: first.nextCursor! });
  expect(first.items[0].id).not.toBe(second.items[0].id);
  expect(second.nextCursor).toBeNull();
});
