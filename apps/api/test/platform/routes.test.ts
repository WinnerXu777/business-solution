import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { loadDemoFixtures, type CallEnvelope } from '@bs/contracts';
import Fastify, { type HTTPMethods } from 'fastify';
import { createFakeProviders } from '../../../../packages/adapters/src/index.ts';
import { GovernedGateway } from '../../../../packages/core/src/governance/index.ts';
import {
  capabilities,
  createPlatformServices,
  fixtureAdmin,
  type PlatformIdentity,
} from '../../../../packages/core/src/platform/index.ts';
import { createPlatformFixtureIdentityVerifier, platformRoutes } from '../../src/platform/index.ts';
import openapi from '../../src/platform/openapi.json' with { type: 'json' };

const fixtures = loadDemoFixtures();
const [operator, approver, reader, , other] = fixtures.grants;
const base = '/platform/v1';

function env(key: string, identity = operator): CallEnvelope {
  return {
    tenantId: identity.tenantId,
    actor: identity.actor,
    version: 'v1',
    source: 'rest',
    traceId: key,
    correlationId: key,
    idempotencyKey: key,
  };
}

async function setup(t: TestContext) {
  let instant = fixtures.asOf;
  const now = () => instant;
  const providers = createFakeProviders();
  const services = createPlatformServices({
    vaultMasterKey: Buffer.alloc(32, 0x34),
    now,
    gateway: new GovernedGateway({ now, providers }),
  });
  const verifyIdentity = createPlatformFixtureIdentityVerifier(
    new Map<string, PlatformIdentity>([
      ['admin', fixtureAdmin],
      ['operator', operator],
      ['approver', approver],
      ['reader', reader],
      ['other', other],
    ]),
    services.directory,
  );
  const app = Fastify();
  t.after(() => app.close());
  const routes = new Set<string>();
  app.addHook('onRoute', (route) => {
    if (route.method !== 'HEAD')
      routes.add(route.method + ' ' + route.url.replace(/:(\w+)/g, '{$1}'));
  });
  await app.register(platformRoutes, { services, verifyIdentity });
  function request(
    path: string,
    token: string | null = 'reader',
    method: HTTPMethods = 'GET',
    payload?: object,
  ) {
    return app.inject({
      method,
      url: base + path,
      headers: token ? { authorization: 'Bearer ' + token } : {},
      payload,
    });
  }
  return {
    request,
    routes,
    gateway: services.gateway,
    setTime(value: string) {
      instant = value;
    },
  };
}

test('OpenAPI matches the registered endpoints and health requires a verified fixture identity', async (t) => {
  const { request, routes } = await setup(t);
  const documented = Object.entries(openapi.paths).flatMap(([path, operations]) =>
    Object.keys(operations).map((method) => method.toUpperCase() + ' ' + path),
  );
  assert.deepEqual([...routes].sort(), documented.sort());
  const health = await request('/health');
  assert.deepEqual(health.json(), { status: 'ok', version: 'v1' });
  assert.equal(health.headers['cache-control'], 'no-store');
  for (const token of [null, 'tenant-rivetquay:actor-admin', 'admin,other']) {
    const denied = await request('/health', token);
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.headers['www-authenticate'], 'Bearer');
    assert.deepEqual(denied.json(), { error: 'forbidden' });
  }
});

test('identity, workspaces and navigation are derived from the verified tenant', async (t) => {
  const { request } = await setup(t);
  const me = await request('/me', 'admin');
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json(), {
    tenant: { id: 'tenant-rivetquay', name: 'Rivetquay Industrial Supply' },
    actor: { id: 'actor-admin', kind: 'person', displayName: 'Fixture Admin' },
    role: 'admin',
    workspaces: [{ id: 'tenant-rivetquay', name: 'Rivetquay Industrial Supply' }],
  });
  assert.equal((await request('/me', 'other')).json().role, 'operator');
  assert.deepEqual((await request('/workspaces')).json(), me.json().workspaces);
  assert.deepEqual((await request('/workspaces/tenant-rivetquay')).json(), me.json().tenant);
  const foreign = await request('/workspaces/tenant-rivetquay', 'other');
  assert.equal(foreign.statusCode, 404);
  assert.deepEqual(foreign.json(), (await request('/workspaces/missing', 'other')).json());
  assert.ok(
    (await request('/registry/bots')).json().some(({ id }: { id: string }) => id === 'order-chat'),
  );
  assert.equal((await request('/registry/workflows')).json()[0].id, 'win-back-v1');
  assert.deepEqual((await request('/registry/bots', 'other')).json(), []);
  assert.deepEqual((await request('/registry/workflows', 'other')).json(), []);
});

test('only admins can change modules and updates respect tenant and body shape', async (t) => {
  const { request, gateway } = await setup(t);
  const read = {
    tool: 'order.read',
    input: { orderId: 'ord-001' },
    envelope: env('meter-module'),
  } as const;
  assert.equal((await gateway.call(read)).state, 'ok');
  const modules = (await request('/modules')).json();
  assert.equal(modules.length, 6);
  assert.deepEqual(
    Object.keys(modules[0]).sort(),
    [
      'moduleId',
      'name',
      'description',
      'enabled',
      'allowance',
      'used',
      'windowStart',
      'windowEnd',
    ].sort(),
  );
  assert.equal(modules[0].used, 1);
  for (const token of ['reader', 'operator', 'approver', 'other']) {
    const denied = await request('/modules/records', token, 'PATCH', { enabled: false });
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(denied.json(), { error: 'forbidden' });
  }
  assert.equal(
    (await request('/modules/records', 'admin', 'PATCH', { enabled: 'false' })).statusCode,
    400,
  );
  assert.equal(
    (
      await request('/modules/records', 'admin', 'PATCH', {
        enabled: false,
        tenantId: 'tenant-spoolharbour',
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await request('/modules/unknown', 'admin', 'PATCH', { enabled: false })).statusCode,
    404,
  );
  const changed = await request('/modules/records', 'admin', 'PATCH', { enabled: false });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().enabled, false);
  assert.equal((await request('/modules')).json()[0].enabled, false);
  assert.equal((await request('/modules', 'other')).json()[0].enabled, true);
  assert.equal((await gateway.call({ ...read, envelope: env('new-work') })).state, 'denied');
});

test('provider and capability routes match the public shapes and reject incompatible bindings', async (t) => {
  const { request } = await setup(t);
  const capabilityResponse = await request('/capabilities');
  assert.equal(capabilityResponse.statusCode, 200);
  assert.deepEqual(
    capabilityResponse.json().map(({ capability }: { capability: string }) => capability),
    capabilities,
  );
  const providers = await request('/providers?capability=llm');
  assert.equal(providers.statusCode, 200);
  assert.deepEqual(
    providers.json().map(({ providerId }: { providerId: string }) => providerId),
    ['fixture-native', 'openai', 'anthropic', 'amazon-bedrock'],
  );
  assert.deepEqual(
    Object.keys(providers.json()[0]).sort(),
    ['providerId', 'capability', 'name', 'mode', 'regions', 'features', 'notes'].sort(),
  );
  assert.equal(
    (await request('/providers?capability=accounting')).json()[1].name,
    'QuickBooks Online',
  );
  const path = '/capabilities/llm/binding';
  assert.equal((await request(path, 'operator', 'PUT', { providerId: 'openai' })).statusCode, 403);
  assert.equal((await request(path, 'admin', 'PUT', { providerId: 'twilio' })).statusCode, 404);
  assert.equal(
    (await request(path, 'admin', 'PUT', { providerId: 'openai', credentialRef: 'test-raw-value' }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await request('/capabilities/contact-centre/binding', 'admin', 'PUT', {
        providerId: 'ringcentral-ringcx',
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request('/capabilities/speech-to-text/binding', 'admin', 'PUT', {
        providerId: 'azure-speech',
      })
    ).statusCode,
    200,
  );
  const bound = await request(path, 'admin', 'PUT', {
    providerId: 'openai',
    credentialRef: 'fixture:demo-llm',
    fallbackProviderId: 'fixture-native',
  });
  assert.equal(bound.statusCode, 200);
  assert.deepEqual(bound.json(), {
    providerId: 'openai',
    mode: 'byo',
    status: 'active',
    region: 'global',
    dataClasses: ['synthetic'],
    fallbackProviderId: 'fixture-native',
    version: 2,
  });
  assert.deepEqual((await request('/capabilities')).json()[0].binding, bound.json());
  assert.equal((await request('/capabilities', 'other')).json()[0].binding.version, 1);
  assert.doesNotMatch((await request('/audit')).body, /fixture:demo-llm|credentialRef/);
});

test('audit and usage provide scoped and filtered gateway data', async (t) => {
  const { request, gateway } = await setup(t);
  for (const [identity, id, key] of [
    [operator, 'ord-001', 'one'],
    [operator, 'ord-001', 'two'],
    [other, 'ord-isolation', 'three'],
  ] as const) {
    await gateway.call({
      tool: 'order.read',
      input: { orderId: id },
      envelope: env(key, identity),
    });
  }
  const path = '/audit?tool=order.read&actorId=actor-operator&state=ok&limit=1';
  const first = await request(path);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().items.length, 1);
  assert.ok(first.json().nextCursor);
  const next = await request(path + '&cursor=' + first.json().nextCursor);
  assert.equal(next.statusCode, 200);
  assert.equal(next.json().items.length, 1);
  assert.notEqual(next.json().items[0].id, first.json().items[0].id);
  assert.equal(next.json().nextCursor, null);
  assert.equal(
    (await request(path + '&cursor=' + first.json().nextCursor, 'other')).statusCode,
    403,
  );
  assert.equal((await request('/audit?limit=1&limit=2')).statusCode, 400);
  const usage = await request('/usage?module=records&from=2026-11-25T15%3A00%3A00Z');
  assert.equal(usage.statusCode, 200);
  assert.equal(usage.json().items.length, 2);
  assert.deepEqual(usage.json().totals, [{ module: 'records', used: 2, allowance: 40 }]);
  assert.equal((await request('/usage?module=records', 'other')).json().items.length, 1);
  assert.equal((await request('/usage?module=ai')).json().items.length, 0);
});

test('approval routes sign through governance, reject pending grants and expose effective states', async (t) => {
  const { request, gateway, setTime } = await setup(t);
  const draft = await gateway.call({
    tool: 'purchase.order.draft',
    input: { requestId: 'pr-001' },
    envelope: env('draft-po'),
  });
  assert.equal(draft.state, 'ok');
  const po = draft.output.approval.id;
  assert.deepEqual((await request('/approvals', 'other')).json(), []);
  assert.equal((await request('/approvals?state=pending')).json()[0].id, po);
  assert.equal((await request('/approvals/' + po + '/sign', 'operator', 'POST')).statusCode, 403);
  assert.equal((await request('/approvals/' + po + '/sign', 'admin', 'POST')).statusCode, 403);
  const signedPo = await request('/approvals/' + po + '/sign', 'approver', 'POST');
  assert.equal(signedPo.statusCode, 200);
  assert.equal(signedPo.json().state, 'consumed');
  assert.ok(
    gateway.audit().some(({ tool, state }) => tool === 'purchase.order.approve' && state === 'ok'),
  );
  assert.equal((await request('/approvals/' + po + '/sign', 'approver', 'POST')).statusCode, 409);

  async function prepare(channel: 'email' | 'sms' | 'voice') {
    const preview = await gateway.call({
      tool: 'message.preview',
      input: { invoiceId: 'inv-001', channel },
      envelope: env('preview-' + channel),
    });
    assert.equal(preview.state, 'ok');
    const previewId = preview.output.id;
    const pending = await gateway.call({
      tool: `collections.${channel}.send`,
      envelope: env('prepare-' + channel),
      input: { previewId, approvalId: null },
    });
    assert.equal(pending.state, 'pending_approval');
    return { approval: pending.approval, previewId };
  }
  const email = await prepare('email');
  const sign = await request('/approvals/' + email.approval.id + '/sign', 'approver', 'POST');
  assert.equal(sign.statusCode, 200);
  assert.equal(sign.json().state, 'approved');
  assert.equal((await request('/approvals?state=approved')).json()[0].id, email.approval.id);
  assert.equal(
    (
      await gateway.call({
        tool: 'collections.email.send',
        envelope: env('send-email'),
        input: { approvalId: email.approval.id, previewId: email.previewId },
      })
    ).state,
    'ok',
  );
  const sms = await prepare('sms');
  const reject = '/approvals/' + sms.approval.id + '/reject';
  assert.equal(
    (await request(reject, 'operator', 'POST', { reason: 'Fixture reason' })).statusCode,
    403,
  );
  assert.equal((await request(reject, 'approver', 'POST', { reason: '' })).statusCode, 400);
  const rejected = await request(reject, 'approver', 'POST', { reason: 'Fixture reason' });
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.json().state, 'rejected');
  assert.equal((await request('/approvals?state=rejected')).json()[0].id, sms.approval.id);
  const voice = await prepare('voice');
  setTime(voice.approval.expiresAt);
  assert.equal((await request('/approvals?state=expired')).json()[0].id, voice.approval.id);
  assert.equal(
    (await request('/approvals/' + voice.approval.id + '/sign', 'approver', 'POST')).statusCode,
    409,
  );
  const audit = await request('/audit');
  assert.doesNotMatch(audit.body, /Fixture reason|@rivetquay\.example/);
});

test('connection creation returns the one-time secret and deletion is tenant-scoped', async (t) => {
  const { request } = await setup(t);
  const payload = { kind: 'api_client', name: 'Demo REST integration', scopes: ['order.read'] };
  assert.equal((await request('/connections', 'reader', 'POST', payload)).statusCode, 403);
  assert.equal(
    (await request('/connections', 'admin', 'POST', { ...payload, scopes: 'order.read' }))
      .statusCode,
    400,
  );
  const response = await request('/connections', 'admin', 'POST', payload);
  assert.equal(response.statusCode, 201);
  assert.equal(response.headers['cache-control'], 'no-store');
  const { secret, ...connection } = response.json();
  assert.match(secret, /^fixture_[a-zA-Z0-9_-]{43}$/);
  const list = await request('/connections');
  assert.deepEqual(list.json(), [connection]);
  assert.ok(!list.body.includes(secret));
  assert.deepEqual((await request('/connections', 'other')).json(), []);
  const path = '/connections/' + connection.id;
  assert.equal((await request(path, 'other', 'DELETE')).statusCode, 403);
  assert.equal((await request('/connections/missing', 'admin', 'DELETE')).statusCode, 404);
  assert.equal((await request(path, 'admin', 'DELETE')).statusCode, 204);
  assert.deepEqual((await request('/connections')).json(), []);
  assert.ok(!(await request('/audit')).body.includes(secret));
});

test('billing routes expose catalog and prorated drafts, and finalize the same tenant invoice once', async (t) => {
  const { request, setTime } = await setup(t);
  const catalog = await request('/billing/skus');
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().length, 12);
  assert.equal((await request('/billing/plan')).json().monthlyCents, 65_000);
  assert.equal(
    (await request('/billing/plan', 'reader', 'POST', { addOns: ['erp'] })).statusCode,
    403,
  );
  assert.equal(
    (await request('/billing/plan', 'admin', 'POST', { addOns: ['platform'] })).statusCode,
    400,
  );
  const changed = await request('/billing/plan', 'admin', 'POST', { addOns: ['erp'] });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().monthlyCents, 105_000);
  const list = await request('/billing/invoices');
  assert.equal(list.statusCode, 200);
  const [draft] = list.json().items;
  assert.equal(draft.status, 'draft');
  const path = '/billing/invoices/' + draft.id;
  assert.deepEqual((await request(path)).json(), draft);
  assert.equal((await request(path, 'other')).statusCode, 404);
  assert.equal((await request(path + '/finalize', 'admin', 'POST')).statusCode, 403);
  setTime('2026-12-01T00:00:00Z');
  assert.equal((await request(path + '/finalize', 'reader', 'POST')).statusCode, 403);
  const finalized = await request(path + '/finalize', 'admin', 'POST');
  assert.equal(finalized.statusCode, 200);
  assert.equal(finalized.json().settlement.status, 'simulated');
  assert.deepEqual((await request(path + '/finalize', 'admin', 'POST')).json(), finalized.json());
});

test('credential routes accept synthetic secrets once and scope references and mutations', async (t) => {
  const { request } = await setup(t);
  const secret = 'fixture-secret-never-in-responses';
  const input = { capability: 'llm', providerId: 'amazon-bedrock', secret };
  assert.equal((await request('/credentials', 'reader', 'POST', input)).statusCode, 403);
  assert.equal(
    (await request('/credentials', 'admin', 'POST', { ...input, tenantId: 'tenant-spoolharbour' }))
      .statusCode,
    400,
  );
  assert.equal(
    (await request('/credentials', 'admin', 'POST', { ...input, providerId: 'unknown' }))
      .statusCode,
    404,
  );
  const created = await request('/credentials', 'admin', 'POST', input);
  assert.equal(created.statusCode, 201);
  const { ref } = created.json();
  assert.deepEqual(created.json(), { ref });
  assert.deepEqual((await request('/credentials')).json(), [{ ref }]);
  assert.deepEqual((await request('/credentials', 'other')).json(), []);
  const path = '/credentials/' + encodeURIComponent(ref);
  const rotation = { secret: 'fixture-rotated-secret' };
  assert.equal((await request(path + '/rotate', 'other', 'POST', rotation)).statusCode, 403);
  assert.equal((await request(path + '/rotate', 'admin', 'POST', { secret: '' })).statusCode, 400);
  assert.deepEqual((await request(path + '/rotate', 'admin', 'POST', rotation)).json(), { ref });
  assert.equal((await request(path, 'reader', 'DELETE')).statusCode, 403);
  assert.equal((await request(path, 'admin', 'DELETE')).statusCode, 204);
  assert.deepEqual((await request('/credentials')).json(), []);
  assert.equal((await request(path + '/rotate', 'admin', 'POST', rotation)).statusCode, 404);
  assert.doesNotMatch(
    (await request('/audit')).body,
    /fixture-secret-never-in-responses|fixture-rotated-secret|ciphertext/,
  );
});
