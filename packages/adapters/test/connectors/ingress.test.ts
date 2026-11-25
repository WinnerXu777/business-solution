import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConnectorLifecycle,
  MemoryCredentialStore,
  PartnerMcpConnector,
  WebhookIngestor,
  createFixtureConnectors,
  fixtureAccounts,
  mcpCallerVerifier,
  signWebhook,
  type McpTransport,
  type PartnerMcpServer,
  type WebhookEvent,
} from '../../src/connectors/index.ts';

const now = Date.parse('2026-11-25T15:00:00Z');
const clock = () => now;
const tenantId = 'workspace-a';
const fixture = () => createFixtureConnectors(clock).registrations[1].connector;

test('webhooks authenticate the exact body and account, deduplicate, and track per-entity order', async () => {
  const lifecycle = new ConnectorLifecycle(
    [{ connector: fixture() }],
    new MemoryCredentialStore(),
    clock,
  );
  const binding = lifecycle.install(tenantId, 'hubspot-fixture', fixtureAccounts.crm);
  await lifecycle.authorizeApiKey(binding, fixtureAccounts.crmKey);
  await lifecycle.verifyAccount(binding);
  await lifecycle.activate(binding);
  const applied: string[] = [];
  const ingestor = new WebhookIngestor(
    lifecycle,
    {
      async get(ref) {
        if (ref.connectionId === binding.connectionId && ref.tenantId === tenantId)
          return 'fixture-signing-secret';
      },
    },
    async (_ref, event) => {
      if (event.eventId === 'failure') throw new Error('raw provider error');
      applied.push(event.eventId);
    },
    clock,
  );
  const delivery = (
    eventId: string,
    sequence: number,
    changes: Partial<WebhookEvent> = {},
    when = now,
  ) => {
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        eventId,
        sequence,
        accountId: fixtureAccounts.crm,
        recordClass: 'contact',
        externalId: 'contact-1',
        occurredAt: new Date(now).toISOString(),
        ...changes,
      } satisfies WebhookEvent),
    );
    const timestamp = String(when / 1000);
    return { body, timestamp, signature: signWebhook('fixture-signing-secret', timestamp, body) };
  };
  const send = (event: ReturnType<typeof delivery>) =>
    ingestor.receive(binding.connectionId, event);
  const signed = delivery('signed', 5);
  await assert.rejects(send({ ...signed, body: Buffer.concat([signed.body, Buffer.from(' ')]) }), {
    code: 'auth_required',
  });
  await assert.rejects(send(delivery('expired', 5, {}, now - 301_000)), { code: 'auth_required' });
  await assert.rejects(send(delivery('future', 5, {}, now + 301_000)), { code: 'auth_required' });
  await assert.rejects(send(delivery('foreign', 5, { accountId: 'different-account' })), {
    code: 'permission_denied',
  });
  const duplicates = await Promise.all([send(signed), send(signed)]);
  assert.deepEqual(
    duplicates.map(({ status }) => status),
    ['accepted', 'duplicate'],
  );
  assert.equal((await send(delivery('signed', 6))).status, 'duplicate');
  assert.equal((await send(delivery('stale', 4))).status, 'out_of_order');
  assert.equal(
    (await send(delivery('other-entity', 4, { externalId: 'contact-2' }))).status,
    'accepted',
  );
  const failure = delivery('failure', 6);
  assert.equal((await send(failure)).status, 'dead_lettered');
  assert.equal((await send(failure)).status, 'duplicate');
  assert.equal((await send(delivery('recovery', 6))).status, 'accepted');
  assert.deepEqual(applied, ['signed', 'other-entity', 'recovery']);
  assert.deepEqual(ingestor.listDeadLetters(binding), [
    {
      tenantId,
      connectionId: binding.connectionId,
      eventId: 'failure',
      recordClass: 'contact',
      externalId: 'contact-1',
      receivedAt: new Date(now).toISOString(),
      reason: 'provider_unavailable',
    },
  ]);
});

test('partner MCP uses explicit tools, scopes, audience and a separately stored account grant', async () => {
  const platformAudience = 'https://platform.fixture.example/mcp';
  const partnerAudience = 'https://partner.fixture.example/mcp';
  const caller = mcpCallerVerifier(async (token) => {
    if (token === 'inbound-token' || token === 'wrong-audience') {
      return {
        subject: 'actor-a',
        audience: token === 'inbound-token' ? platformAudience : partnerAudience,
        scopes: ['connectors:sync'],
        tenantIds: [tenantId],
      };
    }
    return null;
  }, platformAudience);
  assert.deepEqual(await caller('inbound-token', tenantId, 'connectors:sync'), {
    tenantId,
    actorId: 'actor-a',
  });
  await assert.rejects(caller('wrong-audience', tenantId, 'connectors:sync'), {
    code: 'auth_required',
  });
  await assert.rejects(caller('inbound-token', 'workspace-b', 'connectors:sync'), {
    code: 'permission_denied',
  });
  await assert.rejects(caller('inbound-token', tenantId, 'connectors:manage'), {
    code: 'permission_denied',
  });

  const names = { read: 'get_v1', snapshot: 'snapshot_v1', listChangedSince: 'changes_v1' };
  const server: PartnerMcpServer = {
    id: 'partner-fixture',
    audience: partnerAudience,
    protocolVersion: '2025-11-25',
    tools: { get_v1: 'crm.read', snapshot_v1: 'crm.snapshot', changes_v1: 'crm.delta' },
  };
  const transportCalls: Parameters<McpTransport>[0][] = [];
  const transport: McpTransport = async (request) => {
    transportCalls.push(request);
    switch (request.tool) {
      case 'get_v1':
        return { structuredContent: { record: null } };
      case 'snapshot_v1':
        return { structuredContent: { records: [], checkpoint: 'one' } };
      case 'changes_v1':
        return { structuredContent: { records: [], checkpoint: 'two', hasMore: false } };
      default:
        return { isError: true };
    }
  };
  const options: ConstructorParameters<typeof PartnerMcpConnector>[0] = {
    allowlist: [server],
    serverId: server.id,
    platformAudience,
    manifest: {
      ...fixture().manifest,
      id: 'mcp-fixture',
      webhook: false,
      scopes: { read: ['crm.read'], snapshot: ['crm.snapshot'], listChangedSince: ['crm.delta'] },
    },
    names,
    verifyPartnerToken: async (token) => ({
      audience: token === 'inbound-token' ? platformAudience : partnerAudience,
      accountId: fixtureAccounts.crm,
      scopes:
        token === 'provider-read-only' ? ['crm.read'] : ['crm.read', 'crm.snapshot', 'crm.delta'],
    }),
    transport,
  };
  assert.throws(() => new PartnerMcpConnector({ ...options, serverId: 'unapproved' }), {
    code: 'permission_denied',
  });
  assert.throws(
    () =>
      new PartnerMcpConnector({ ...options, names: { ...names, read: 'tool-added-by-provider' } }),
    { code: 'permission_denied' },
  );
  assert.throws(
    () =>
      new PartnerMcpConnector({
        ...options,
        allowlist: [{ ...server, audience: platformAudience }],
      }),
    { code: 'permission_denied' },
  );

  const connector = new PartnerMcpConnector(options);
  const lifecycle = new ConnectorLifecycle([{ connector }], new MemoryCredentialStore(), clock);
  const binding = lifecycle.install(tenantId, options.manifest.id, fixtureAccounts.crm);
  await lifecycle.authorizeApiKey(binding, 'provider-token');
  await lifecycle.verifyAccount(binding);
  await lifecycle.activate(binding);
  assert.deepEqual(
    await lifecycle.withActive(binding, 'snapshot', ({ connector, context }) =>
      connector.snapshot(context),
    ),
    {
      records: [],
      checkpoint: 'one',
    },
  );

  const context = {
    ...binding,
    credential: { type: 'api-key' as const, key: 'provider-read-only' },
  };
  assert.equal(
    await connector.read(context, { recordClass: 'contact', externalId: 'fixture-contact' }),
    null,
  );
  await assert.rejects(connector.snapshot(context), { code: 'permission_denied' });
  await assert.rejects(connector.snapshot({ ...context, accountId: 'other-account' }), {
    code: 'permission_denied',
  });
  await assert.rejects(
    connector.snapshot({ ...context, credential: { type: 'api-key', key: 'inbound-token' } }),
    { code: 'auth_required' },
  );
  assert.deepEqual(
    transportCalls.map(({ tool, providerToken }) => [tool, providerToken]),
    [
      ['snapshot_v1', 'provider-token'],
      ['get_v1', 'provider-read-only'],
    ],
  );
  assert.equal(transportCalls[0].protocolVersion, server.protocolVersion);
});
