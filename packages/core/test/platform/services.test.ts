import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeProviders } from '@bs/adapters';
import { loadDemoFixtures, type AuditEntry, type CallEnvelope } from '@bs/contracts';
import { GovernedGateway } from '../../src/governance/index.ts';
import {
  capabilities,
  createPlatformServices,
  fixtureAdmin,
  MemoryTenantRepository,
  type MutationContext,
} from '../../src/platform/index.ts';
import type { StoredConnection } from '../../src/platform/connections.ts';

const fixtures = loadDemoFixtures();
const [operator, approver, reader, , other] = fixtures.grants;
const tenant = operator.tenantId;
const clock = () => fixtures.asOf;

function context(
  identity: Pick<MutationContext, 'tenantId' | 'actor'> = fixtureAdmin,
): MutationContext {
  return {
    tenantId: identity.tenantId,
    actor: identity.actor,
    source: 'rest',
    traceId: 'trace-platform',
    correlationId: 'platform-test',
  };
}

function envelope(identity: typeof operator, idempotencyKey: string): CallEnvelope {
  return { ...context(identity), version: 'v1', idempotencyKey };
}

test('tenant directory resolves roles and returns only the verified tenant workspace', async () => {
  const { directory, registry } = createPlatformServices();
  assert.deepEqual(await directory.resolve(fixtureAdmin), {
    tenant: { id: tenant, name: 'Rivetquay Industrial Supply' },
    actor: { ...fixtureAdmin.actor, displayName: 'Fixture Admin' },
    role: 'admin',
    workspaces: [{ id: tenant, name: 'Rivetquay Industrial Supply' }],
  });
  assert.equal((await directory.resolve(reader))?.role, 'reader');
  assert.equal(await directory.resolve({ ...reader, tenantId: other.tenantId }), undefined);
  assert.equal(
    await directory.resolve({ ...reader, actor: { ...reader.actor, kind: 'service' } }),
    undefined,
  );
  assert.deepEqual(
    (await directory.workspaces(other.tenantId)).map(({ id }) => id),
    [other.tenantId],
  );
  assert.equal(registry(tenant, 'workflows')[0].id, 'win-back-v1');
  assert.deepEqual(registry(other.tenantId, 'workflows'), []);
});

test('module allowance and metered actions reflect gateway usage, with tenant-local switches', async () => {
  const { entitlements, gateway, queries } = createPlatformServices({ now: clock });
  const read = {
    tool: 'order.read',
    envelope: envelope(operator, 'read'),
    input: { orderId: 'ord-001' },
  } as const;
  assert.equal((await gateway.call(read)).state, 'ok');
  const disabled = await gateway.setModule(context(), 'records', false);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.allowance, 40);
  assert.equal(disabled.used, 1);
  assert.equal((await gateway.call(read)).state, 'ok');
  const newRead = { ...read, envelope: envelope(operator, 'new-read') };
  assert.equal((await gateway.call(newRead)).state, 'denied');
  assert.match(JSON.stringify(await gateway.call(newRead)), /module_disabled/);
  assert.equal(
    (await entitlements.listing(other.tenantId, await gateway.usage(other.tenantId)))[0].enabled,
    true,
  );
  assert.equal(
    (await entitlements.listing(other.tenantId, await gateway.usage(other.tenantId)))[0].used,
    0,
  );
  await gateway.setModule(context(), 'records', true);
  assert.equal((await gateway.call(newRead)).state, 'ok');
  assert.equal((await queries.audit(tenant, { tool: 'platform.module.update' })).items.length, 2);
});

test('capability bindings preserve versions, keep references private, and validate fallback residency', async () => {
  const { bindings, providers, queries } = createPlatformServices({ now: clock });
  for (const capability of capabilities) {
    const options = providers.list(capability);
    assert.equal(options.filter(({ mode }) => mode === 'native').length, 1);
    assert.ok(options.some(({ mode }) => mode !== 'native'));
  }
  const [first, second] = await Promise.all([
    bindings.bind(context(), 'llm', {
      providerId: 'openai',
      credentialRef: 'fixture:openai',
      fallbackProviderId: 'fixture-native',
    }),
    bindings.bind(context(), 'llm', { providerId: 'anthropic' }),
  ]);
  assert.equal(first.version, 2);
  assert.equal(first.status, 'active');
  assert.equal(first.fallbackProviderId, 'fixture-native');
  assert.equal(second.version, 3);
  assert.equal(second.status, 'pending');
  assert.equal((await bindings.history(tenant, 'llm'))[1].credentialRef, 'fixture:openai');
  assert.equal((await bindings.history(other.tenantId, 'llm')).length, 1);
  assert.doesNotMatch(JSON.stringify(await bindings.list(tenant)), /fixture:openai|credentialRef/);
  await assert.rejects(bindings.bind(context(), 'telephony', { providerId: 'twilio' }), {
    code: 'forbidden',
  });
  await assert.rejects(
    bindings.bind(context(), 'speech-to-text', {
      providerId: 'azure-speech',
      fallbackProviderId: 'elevenlabs',
    }),
    { code: 'forbidden' },
  );
  await assert.rejects(bindings.bind(context(), 'llm', { providerId: 'stripe-radar' }), {
    code: 'not_found',
  });
  await assert.rejects(
    bindings.bind(context(), 'llm', {
      providerId: 'openai',
      credentialRef: 'a-raw-test-secret',
    }),
    { code: 'forbidden' },
  );
  assert.equal((await bindings.history(tenant, 'llm')).length, 3);
  const audit = await queries.audit(tenant, { tool: 'platform.binding.update' });
  assert.equal(audit.items.length, 2);
  assert.doesNotMatch(JSON.stringify(audit), /fixture:openai|credentialRef/);
});

test('connections persist only secret digests, require tenant, kind and scope, and can be revoked', async () => {
  const repository = new MemoryTenantRepository<StoredConnection>();
  const { connections, queries } = createPlatformServices({
    repositories: { connections: repository },
    now: clock,
  });
  const created = await connections.create(context(), {
    kind: 'mcp_client',
    name: 'Demo MCP',
    scopes: ['order.read'],
  });
  const { secret, id } = created;
  assert.match(secret, /^fixture_[a-zA-Z0-9_-]{43}$/);
  assert.match((await repository.get(tenant, id))!.secretHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(await repository.list(tenant)).includes(secret));
  assert.deepEqual(await connections.list(other.tenantId), []);
  assert.doesNotMatch(JSON.stringify(await connections.list(tenant)), /secret/i);
  assert.equal(
    await connections.authenticate(tenant, id, secret + 'x', 'mcp_client', 'order.read'),
    undefined,
  );
  assert.equal(
    await connections.authenticate(other.tenantId, id, secret, 'mcp_client', 'order.read'),
    undefined,
  );
  assert.equal(
    await connections.authenticate(tenant, id, secret, 'api_client', 'order.read'),
    undefined,
  );
  assert.equal(
    await connections.authenticate(tenant, id, secret, 'mcp_client', 'order.write'),
    undefined,
  );
  assert.equal(
    (await connections.authenticate(tenant, id, secret, 'mcp_client', 'order.read'))?.lastUsedAt,
    clock(),
  );
  await connections.delete(context(), id);
  assert.equal(
    await connections.authenticate(tenant, id, secret, 'mcp_client', 'order.read'),
    undefined,
  );
  assert.deepEqual(await connections.list(tenant), []);
  const audit = await queries.audit(tenant);
  assert.equal(audit.items.length, 3);
  assert.ok(!JSON.stringify(audit).includes(secret));
});

test('audit merges gateway decisions with redacted platform writes and uses tenant-scoped keyset cursors', async () => {
  const mirrored: AuditEntry[] = [];
  let now = fixtures.asOf;
  const { gateway, connections, queries } = createPlatformServices({
    now: () => now,
    auditSink: {
      async append(entry) {
        mirrored.push(entry);
      },
    },
  });
  for (const identity of [operator, operator, other]) {
    await gateway.call({
      tool: 'order.read',
      envelope: envelope(identity, 'query-' + (await gateway.audit(tenant)).length),
      input: { orderId: identity === other ? 'ord-isolation' : 'ord-001' },
    });
  }
  const filters = {
    tool: 'order.read',
    actorId: operator.actor.id,
    state: 'ok',
    limit: 1,
  } as const;
  const first = await queries.audit(tenant, filters);
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  now = '2026-11-25T15:01:00Z';
  await gateway.call({
    tool: 'order.read',
    envelope: envelope(operator, 'newer'),
    input: { orderId: 'ord-001' },
  });
  const second = await queries.audit(tenant, { ...filters, cursor: first.nextCursor });
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].id, second.items[0].id);
  assert.equal(second.nextCursor, null);
  await assert.rejects(queries.audit(other.tenantId, { ...filters, cursor: first.nextCursor }), {
    code: 'forbidden',
  });
  await assert.rejects(
    queries.audit(tenant, { ...filters, state: 'denied', cursor: first.nextCursor }),
    { code: 'forbidden' },
  );
  await connections.create(context(), { kind: 'api_client', name: 'Demo API', scopes: [] });
  assert.equal(mirrored[0].tool, 'platform.connection.create');
  assert.equal((await queries.audit(tenant, { from: now })).items.length, 2);
  const historical = await queries.usage(tenant, {
    module: 'records',
    from: fixtures.asOf,
    to: now,
  });
  assert.equal(historical.items.length, 2);
  assert.deepEqual(historical.totals, [{ module: 'records', used: 2, allowance: 40 }]);
  const usagePage = await queries.usagePage(tenant, { limit: 1 });
  assert.ok(usagePage.nextCursor);
  const rest = await queries.usagePage(tenant, { limit: 2, cursor: usagePage.nextCursor });
  assert.equal(rest.items.length, 2);
  assert.equal(rest.nextCursor, null);
  assert.deepEqual(await queries.audit(tenant, { from: now, to: now }), {
    items: [],
    nextCursor: null,
  });
});

test('competing sign and reject requests serialize and rejected grants cannot reach the gateway effect', async () => {
  const providers = createFakeProviders();
  const governed = new GovernedGateway({ providers, now: clock });
  const { gateway, queries } = createPlatformServices({ now: clock, gateway: governed });
  const preview = await gateway.call({
    tool: 'message.preview',
    envelope: envelope(operator, 'preview'),
    input: { invoiceId: 'inv-001', channel: 'email' },
  });
  assert.equal(preview.state, 'ok');
  const request = {
    tool: 'collections.email.send',
    envelope: envelope(operator, 'prepare'),
    input: { previewId: preview.output.id, approvalId: null as string | null },
  } as const;
  const prepared = await gateway.call(request);
  assert.equal(prepared.state, 'pending_approval');
  const id = prepared.approval.id;
  const identity = {
    tenantId: approver.tenantId,
    actor: { id: approver.actor.id, kind: 'person' as const },
  };
  const [reject, sign] = await Promise.allSettled([
    gateway.reject(context(identity), id, 'Synthetic decision reason'),
    gateway.sign(context(identity), id),
  ]);
  assert.equal(reject.status, 'fulfilled');
  assert.equal(reject.value.state, 'rejected');
  assert.equal(sign.status, 'rejected');
  assert.equal(sign.reason.code, 'invalid_approval');
  const attempt = await gateway.call({
    ...request,
    envelope: envelope(operator, 'attempt'),
    input: { ...request.input, approvalId: id },
  });
  assert.equal(attempt.state, 'denied');
  assert.equal(attempt.code, 'invalid_approval');
  assert.equal(governed.audit().filter((entry) => entry.tool === request.tool).length, 1);
  assert.equal((await gateway.listApprovals(tenant, 'rejected')).length, 1);
  assert.deepEqual(await gateway.listApprovals(other.tenantId), []);
  assert.doesNotMatch(JSON.stringify(await queries.audit(tenant)), /Synthetic decision reason/);
});

test('the platform facade reads approval decisions and reports from the injected governance API', async () => {
  const governed = new GovernedGateway({ now: clock });
  const prepared = await governed.call({
    envelope: envelope(operator, 'native-prepare'),
    tool: 'workflow.template.run',
    input: { templateId: 'win-back-v1', mode: 'run', approvalId: null },
  });
  assert.equal(prepared.state, 'pending_approval');
  if (prepared.state !== 'pending_approval') return;
  const first = prepared.approval;
  const second = { ...first, id: 'synthetic-second-grant' };
  const grants = new Map([first, second].map((grant) => [grant.id, grant]));
  const reads: string[] = [];
  const decisions: string[] = [];
  const { gateway, queries } = createPlatformServices({
    now: clock,
    gateway: {
      call: governed.call.bind(governed),
      async listApprovals(tenantId) {
        reads.push('approval:' + tenantId);
        return [...grants.values()];
      },
      async signApproval(decision, id) {
        decisions.push('sign:' + decision.tenantId + ':' + id);
        const grant = { ...grants.get(id)!, state: 'approved' as const };
        grants.set(id, grant);
        return grant;
      },
      async rejectApproval(decision, id, reason) {
        decisions.push('reject:' + decision.tenantId + ':' + id + ':' + reason);
        grants.delete(id);
        return { ...second, state: 'rejected' };
      },
      async reportingSnapshot(tenantId) {
        reads.push('audit:' + tenantId);
        return { audit: governed.audit(), usage: [] };
      },
      async listUsage(tenantId) {
        reads.push('usage:' + tenantId);
        return [];
      },
    },
  });
  assert.deepEqual(
    (await gateway.listApprovals(tenant)).map(({ id }) => id),
    [first.id, second.id],
  );
  assert.deepEqual(await gateway.listApprovals(other.tenantId), []);
  assert.equal((await gateway.sign(context(approver), first.id)).state, 'approved');
  assert.equal(
    (await gateway.reject(context(approver), second.id, 'Synthetic rejection')).state,
    'rejected',
  );
  assert.deepEqual(decisions, [
    'sign:' + tenant + ':' + first.id,
    'reject:' + tenant + ':' + second.id + ':Synthetic rejection',
  ]);
  assert.deepEqual((await queries.audit(other.tenantId)).items, []);
  assert.deepEqual((await queries.usage(other.tenantId)).items, []);
  assert.ok(reads.includes('audit:' + other.tenantId));
  assert.ok(reads.includes('usage:' + other.tenantId));
});
