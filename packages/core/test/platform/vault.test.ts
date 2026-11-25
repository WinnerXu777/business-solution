import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPlatformServices,
  fixtureAdmin,
  MemoryTenantRepository,
} from '../../src/platform/index.ts';
import type { DataClass } from '../../src/platform/providers.ts';
import {
  masterKeyEnvironment,
  readVaultMasterKey,
  type StoredCredential,
  type WrappedTenantKey,
} from '../../src/platform/vault.ts';

const instant = '2026-11-25T15:00:00Z';
const admin = {
  ...fixtureAdmin,
  source: 'rest',
  traceId: 'fixture-trace',
  correlationId: 'fixture-corr',
} as const;
const tenantId = admin.tenantId;
const otherTenant = 'tenant-spoolharbour';
const secret = 'fictional-secret-version-one';
const read = async (bytes: Uint8Array) => Buffer.from(bytes).toString();

function setup() {
  const credentials = new MemoryTenantRepository<StoredCredential>();
  const credentialKeys = new MemoryTenantRepository<WrappedTenantKey>();
  let llmData: DataClass[] = ['synthetic'];
  const services = createPlatformServices({
    now: () => instant,
    vaultMasterKey: Buffer.alloc(32, 0x73),
    repositories: { credentials, credentialKeys },
    dataClasses: () => llmData,
  });
  return {
    ...services,
    credentials,
    credentialKeys,
    changeData: (value: DataClass[]) => {
      llmData = value;
    },
  };
}

test('vault wraps distinct tenant keys, scopes access, rotates in place and audits a revoked access', async () => {
  const { vault, bindings, resolveBinding, queries, credentials, credentialKeys } = setup();
  const input = { capability: 'llm', providerId: 'amazon-bedrock', secret } as const;
  const credential = await vault.create(admin, input);
  const other = await vault.create({ ...admin, tenantId: otherTenant }, input);
  const { ref } = credential;
  assert.notDeepEqual(await credentialKeys.list(tenantId), await credentialKeys.list(otherTenant));
  assert.doesNotMatch(JSON.stringify(await credentials.list(tenantId)), /fictional-secret/);
  assert.deepEqual(
    (await vault.list(otherTenant)).map(({ ref }) => ref),
    [other.ref],
  );
  await assert.rejects(
    bindings.bind(admin, 'llm', { providerId: 'amazon-bedrock', credentialRef: other.ref }),
    { code: 'not_found' },
  );
  await assert.rejects(bindings.bind(admin, 'llm', { providerId: 'openai', credentialRef: ref }), {
    code: 'not_found',
  });
  await bindings.bind(admin, 'llm', { providerId: 'amazon-bedrock', credentialRef: ref });
  const { credentialAccessor } = await resolveBinding(tenantId, 'llm');
  assert.ok(credentialAccessor);
  let borrowed: Uint8Array | undefined;
  assert.equal(
    await credentialAccessor(admin, (bytes) => {
      borrowed = bytes;
      return read(bytes);
    }),
    secret,
  );
  assert.ok(borrowed?.every((value) => value === 0));
  const rotated = await vault.rotate(admin, ref, 'fictional-secret-version-two');
  assert.equal(rotated.ref, ref);
  assert.equal(rotated.version, 2);
  assert.equal(await credentialAccessor(admin, read), 'fictional-secret-version-two');
  assert.equal((await resolveBinding(tenantId, 'llm')).version, 2);

  await assert.rejects(vault.revoke({ ...admin, tenantId: otherTenant }, ref), {
    code: 'not_found',
  });
  await vault.revoke(admin, ref);
  await assert.rejects(credentialAccessor(admin, read), { code: 'not_found' });
  assert.equal((await credentials.get(tenantId, ref))?.sealed, undefined);
  await assert.rejects(resolveBinding(tenantId, 'llm'), { code: 'not_found' });
  const { items } = await queries.audit(tenantId, { tool: 'platform.credential.access' });
  assert.deepEqual(items.map(({ state }) => state).sort(), ['denied', 'ok', 'ok']);
  assert.ok(items.every(({ actor }) => actor.id === 'adapter-amazon-bedrock'));
  assert.doesNotMatch(JSON.stringify(items), /fictional-secret|ciphertext/);
});

test('vault rejects ciphertext moved across tenants', async () => {
  const { vault, credentials, queries } = setup();
  const { ref } = await vault.create(admin, {
    capability: 'llm',
    providerId: 'amazon-bedrock',
    secret,
  });
  await vault.create(
    { ...admin, tenantId: otherTenant },
    { capability: 'llm', providerId: 'amazon-bedrock', secret },
  );
  await credentials.put(otherTenant, ref, (await credentials.get(tenantId, ref))!);
  const accessor = vault.accessor(otherTenant, 'llm', 'amazon-bedrock', ref);
  await assert.rejects(accessor(admin, read), { code: 'unavailable' });
  const { items } = await queries.audit(otherTenant, { tool: 'platform.credential.access' });
  assert.equal(items[0].state, 'failed');
});

test('vault master key configuration accepts only a canonical base64 AES-256 key', () => {
  assert.equal(readVaultMasterKey({}), undefined);
  assert.throws(() => readVaultMasterKey({ [masterKeyEnvironment]: 'fictional-invalid-key' }));
  const expected = Buffer.alloc(32, 73);
  assert.deepEqual(
    readVaultMasterKey({ [masterKeyEnvironment]: expected.toString('base64') }),
    expected,
  );
});

test('resolver pins versions, rechecks current call policy and enables configured fallback only for eligible calls', async () => {
  const { bindings, vault, resolveBinding, changeData } = setup();
  const credential = await vault.create(admin, {
    capability: 'llm',
    providerId: 'amazon-bedrock',
    secret,
  });
  const call = { operation: 'inference', dataClasses: ['synthetic'] } as const;
  assert.equal((await resolveBinding(tenantId, 'llm', call)).fallbackPolicy, null);
  await bindings.bind(admin, 'llm', {
    providerId: 'amazon-bedrock',
    credentialRef: credential.ref,
    fallbackProviderId: 'fixture-native',
  });
  const pinned = await resolveBinding(tenantId, 'llm', call);
  assert.equal(pinned.version, 2);
  assert.equal(pinned.region, 'ca-central-1');
  assert.equal(pinned.fallbackPolicy?.provider.providerId, 'fixture-native');
  assert.equal(
    (await resolveBinding(tenantId, 'llm', { ...call, operation: 'read' })).fallbackPolicy?.trigger,
    'retryable_failure',
  );
  for (const operation of ['write', 'delivery'] as const) {
    assert.equal(
      (await resolveBinding(tenantId, 'llm', { ...call, operation })).fallbackPolicy,
      null,
    );
  }
  assert.equal(
    (await resolveBinding(tenantId, 'llm', { ...call, features: ['tool-calling'] })).fallbackPolicy,
    null,
  );
  await assert.rejects(resolveBinding(tenantId, 'llm', { ...call, region: 'global' }), {
    code: 'forbidden',
  });
  await assert.rejects(
    resolveBinding(tenantId, 'llm', { ...call, dataClasses: ['contact-data'] }),
    { code: 'forbidden' },
  );
  await bindings.bind(admin, 'llm', { providerId: 'fixture-native' });
  assert.equal((await resolveBinding(tenantId, 'llm', call)).version, 3);
  assert.equal(pinned.version, 2);
  assert.equal(pinned.provider.providerId, 'amazon-bedrock');
  assert.equal((await resolveBinding(otherTenant, 'llm', call)).version, 1);

  const global = await vault.create(admin, { capability: 'llm', providerId: 'openai', secret });
  await bindings.bind(admin, 'llm', {
    providerId: 'openai',
    credentialRef: global.ref,
    fallbackProviderId: 'fixture-native',
  });
  assert.equal((await resolveBinding(tenantId, 'llm', call)).fallbackPolicy, null);
  changeData(['contact-data']);
  await assert.rejects(resolveBinding(tenantId, 'llm', call), { code: 'forbidden' });
});
