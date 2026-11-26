import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { loadDemoFixtures } from '@bs/contracts';
import Fastify, { type HTTPMethods } from 'fastify';
import {
  createPlatformServices,
  fixtureAdmin,
  PlatformAuth,
} from '../../../../packages/core/src/platform/index.ts';
import { fakeOidc } from '../../../../packages/core/test/platform/fake-oidc.ts';
import { createPlatformSessionIdentityVerifier, platformRoutes } from '../../src/platform/index.ts';

const fixtures = loadDemoFixtures();
const [operator, , reader, , foreign] = fixtures.grants;
const base = '/platform/v1';
const { tenantId } = fixtureAdmin;

async function setup(t: TestContext, requireStepUp?: boolean) {
  let instant = Date.parse(fixtures.asOf);
  const fake = fakeOidc(() => instant);
  const services = createPlatformServices({
    vaultMasterKey: Buffer.alloc(32, 2),
    now: () => new Date(instant).toISOString(),
  });
  for (const [actor, subject] of [
    [fixtureAdmin.actor, 'tenant-admin'],
    [operator.actor, 'platform-operator'],
    [reader.actor, 'fixture-reader'],
    [foreign.actor, 'foreign-user'],
  ] as const)
    await services.directory.linkUser(
      actor.id === foreign.actor.id ? foreign.tenantId : tenantId,
      actor.id,
      fake.config.issuer,
      subject,
    );

  const auth = new PlatformAuth(services.directory, {
    oidc: fake.config,
    signingKey: Buffer.alloc(32, 16),
    platformOperators: [{ issuer: fake.config.issuer, subject: 'platform-operator' }],
    requireStepUp,
  });
  const verifyIdentity = createPlatformSessionIdentityVerifier(auth);
  const app = Fastify();
  t.after(() => app.close());
  // The demo verifier is available to a separate registration. It cannot bypass session assurance.
  await app.register(platformRoutes, { services, auth, verifyIdentity: () => fixtureAdmin });

  function request(method: HTTPMethods, path: string, accessToken?: string, payload?: object) {
    return app.inject({
      method,
      url: base + path,
      headers: accessToken ? { authorization: 'Bearer ' + accessToken } : {},
      payload,
    });
  }

  async function login(tenant: string, subject: string, email: string, stepUp = false) {
    const response = await request('GET', '/auth/login?tenantId=' + tenant + '&stepUp=' + stepUp);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const setCookie = String(response.headers['set-cookie']);
    assert.match(setCookie, /Secure; HttpOnly; SameSite=Lax/);
    const { authorizeUrl } = response.json();
    const { code, state } = fake.authorize(authorizeUrl, {
      claims: {
        sub: subject,
        email,
        amr: stepUp ? ['mfa'] : ['pwd'],
        auth_time: instant / 1000,
      },
    });
    const url = base + '/auth/callback?' + new URLSearchParams({ code, state });
    const noCookie = await app.inject({ url });
    assert.equal(noCookie.statusCode, 403);
    const result = await app.inject({ url, headers: { cookie: setCookie.split(';')[0] } });
    if (result.statusCode === 200) assert.match(String(result.headers['set-cookie']), /Max-Age=0/);
    return result;
  }

  async function signIn(tenant: string, subject: string, stepUp = false) {
    const result = await login(tenant, subject, 'fixture@example.test', stepUp);
    assert.equal(result.statusCode, 200);
    const body = result.json();
    assert.equal(body.status, 'authenticated');
    return body as { accessToken: string; refreshToken: string };
  }

  return {
    request,
    login,
    signIn,
    services,
    verifyIdentity,
    advance(ms: number) {
      instant += ms;
    },
  };
}

test('membership routes enforce permission, tenant scope and recent MFA, and invalidate changed memberships', async (t) => {
  const { request, signIn, verifyIdentity, advance } = await setup(t);
  const passwordAdmin = await signIn(tenantId, 'tenant-admin');
  const admin = await signIn(tenantId, 'tenant-admin', true);
  const viewer = await signIn(tenantId, 'fixture-reader');
  const other = await signIn(foreign.tenantId, 'foreign-user');
  assert.equal((await request('GET', '/me', 'fixture-token')).statusCode, 401);
  assert.deepEqual(await verifyIdentity(viewer.accessToken), { tenantId, actor: reader.actor });
  assert.ok(
    (await request('GET', '/members', viewer.accessToken))
      .json()
      .some(({ id }: { id: string }) => id === reader.actor.id),
  );
  assert.deepEqual(
    (await request('GET', '/members', other.accessToken))
      .json()
      .map(({ id }: { id: string }) => id),
    [foreign.actor.id],
  );
  const role = { id: 'member-viewer', name: 'Member viewer', permissions: ['members.read'] };
  for (const token of [passwordAdmin.accessToken, viewer.accessToken]) {
    assert.equal((await request('POST', '/roles', token, role)).statusCode, 403);
    assert.equal(
      (
        await request('POST', '/invites', token, {
          email: 'another@example.test',
          roleId: 'reader',
        })
      ).statusCode,
      403,
    );
  }
  assert.equal(
    (await request('POST', '/roles', admin.accessToken, { ...role, permissions: ['unknown'] }))
      .statusCode,
    400,
  );
  assert.equal((await request('POST', '/roles', admin.accessToken, role)).statusCode, 201);
  assert.equal((await request('GET', '/roles', other.accessToken)).json().length, 4);
  assert.equal((await request('GET', '/roles', admin.accessToken)).json().length, 5);
  assert.equal(
    (
      await request('PATCH', '/members/' + foreign.actor.id + '/role', admin.accessToken, {
        roleId: role.id,
      })
    ).statusCode,
    404,
  );

  assert.equal(
    (
      await request('PATCH', '/members/' + reader.actor.id + '/role', admin.accessToken, {
        roleId: role.id,
      })
    ).json().role,
    role.id,
  );
  assert.equal(await verifyIdentity(viewer.accessToken), undefined);
  assert.equal(
    (await request('POST', '/auth/refresh', undefined, { refreshToken: viewer.refreshToken }))
      .statusCode,
    403,
  );
  const assigned = await signIn(tenantId, 'fixture-reader');
  assert.equal((await request('GET', '/members', assigned.accessToken)).statusCode, 200);
  assert.equal((await request('GET', '/roles', assigned.accessToken)).statusCode, 403);
  assert.equal((await request('GET', '/modules', assigned.accessToken)).statusCode, 403);
  assert.equal(
    (await request('DELETE', '/members/' + reader.actor.id, admin.accessToken)).statusCode,
    204,
  );
  assert.equal((await request('GET', '/me', assigned.accessToken)).statusCode, 401);

  advance(10 * 60_000);
  const refreshed = (
    await request('POST', '/auth/refresh', undefined, { refreshToken: admin.refreshToken })
  ).json();
  assert.equal((await request('POST', '/roles', refreshed.accessToken, role)).statusCode, 403);
  const logout = await request('POST', '/auth/logout', undefined, {
    refreshToken: refreshed.refreshToken,
  });
  assert.equal(logout.statusCode, 200);
  assert.equal(new URL(logout.json().logoutUrl).hostname, 'dex.example');
  assert.equal((await request('GET', '/me', refreshed.accessToken)).statusCode, 401);
});

test('invites require a tenant-bound OIDC enrollment with the matching address, and admit a new user once', async (t) => {
  const { request, login, signIn } = await setup(t, false);
  const admin = await signIn(tenantId, 'tenant-admin');
  const invite = (
    await request('POST', '/invites', admin.accessToken, {
      email: 'invitee@example.test',
      roleId: 'reader',
    })
  ).json();
  assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/);
  const accept = '/invites/' + invite.token + '/accept';
  for (const [tenant, email] of [
    [foreign.tenantId, 'invitee@example.test'],
    [tenantId, 'other@example.test'],
  ]) {
    const { enrollmentToken } = (await login(tenant, 'new-user', email)).json();
    assert.equal((await request('POST', accept, undefined, { enrollmentToken })).statusCode, 404);
  }
  const first = (await login(tenantId, 'new-user', 'INVITEE@example.test')).json();
  const second = (await login(tenantId, 'new-user', 'invitee@example.test')).json();
  assert.equal(first.status, 'enrollment_required');
  const replies = await Promise.all(
    [first, second].map(({ enrollmentToken }) =>
      request('POST', accept, undefined, { enrollmentToken }),
    ),
  );
  assert.deepEqual(replies.map(({ statusCode }) => statusCode).sort(), [200, 404]);
  const session = replies.find(({ statusCode }) => statusCode === 200)!.json();
  assert.equal((await request('GET', '/me', session.accessToken)).json().role, 'reader');
  assert.ok(!(await request('GET', '/members', admin.accessToken)).body.includes(invite.token));
});

test('only a stepped-up platform operator can provision, suspend or resume a tenant', async (t) => {
  const { request, signIn, login, services, verifyIdentity } = await setup(t);
  const admin = await signIn(tenantId, 'tenant-admin', true);
  const operatorWithoutMfa = await signIn(tenantId, 'platform-operator');
  const platformOperator = await signIn(tenantId, 'platform-operator', true);
  const provision = {
    name: 'Synthetic Distributor',
    region: 'ca-central-1',
    plan: { addOns: ['procurement'] },
    adminEmail: 'first-admin@example.test',
  };
  for (const token of [admin.accessToken, operatorWithoutMfa.accessToken]) {
    assert.equal((await request('POST', '/tenants', token, provision)).statusCode, 403);
  }
  const create = await request('POST', '/tenants', platformOperator.accessToken, provision);
  assert.equal(create.statusCode, 201, create.body);
  const { tenant, adminInvite } = create.json();
  assert.equal(tenant.status, 'active');
  const pending = await login(tenant.id, 'first-admin', provision.adminEmail, true);
  const { enrollmentToken } = pending.json();
  const accepted = await request('POST', '/invites/' + adminInvite.token + '/accept', undefined, {
    enrollmentToken,
  });
  assert.equal(accepted.statusCode, 200);
  const newAdmin = accepted.json();
  assert.equal((await request('GET', '/me', newAdmin.accessToken)).json().tenant.id, tenant.id);
  assert.deepEqual((await request('GET', '/billing/plan', newAdmin.accessToken)).json().addOns, [
    'procurement',
  ]);
  const capabilities = (await request('GET', '/capabilities', newAdmin.accessToken)).json();
  assert.ok(capabilities.length > 1);
  assert.ok(
    capabilities.every(
      ({ binding }: { binding: { mode: string; region: string } }) =>
        binding.mode === 'native' && binding.region === tenant.region,
    ),
  );
  const modules = (await request('GET', '/modules', newAdmin.accessToken)).json();
  assert.deepEqual(
    modules
      .filter(({ enabled }: { enabled: boolean }) => enabled)
      .map(({ moduleId }: { moduleId: string }) => moduleId),
    ['records', 'procurement'],
  );
  const identity = await verifyIdentity(newAdmin.accessToken);
  assert.ok(identity);
  assert.equal((await services.directory.requestExport(identity)).tenantId, tenant.id);
  assert.equal(
    (await request('POST', '/tenants/' + tenant.id + '/suspend', newAdmin.accessToken)).statusCode,
    403,
  );
  assert.equal(
    (
      await request('POST', '/tenants/' + tenant.id + '/suspend', platformOperator.accessToken)
    ).json().status,
    'suspended',
  );
  assert.equal(await verifyIdentity(newAdmin.accessToken), undefined);
  assert.equal((await login(tenant.id, 'first-admin', provision.adminEmail)).statusCode, 403);
  assert.equal((await request('GET', '/members', newAdmin.accessToken)).statusCode, 401);
  assert.equal(
    (
      await request('POST', '/tenants/' + tenant.id + '/resume', platformOperator.accessToken)
    ).json().status,
    'active',
  );
  assert.equal((await request('GET', '/me', newAdmin.accessToken)).statusCode, 401);
  assert.equal(
    (await request('POST', '/auth/refresh', undefined, { refreshToken: newAdmin.refreshToken }))
      .statusCode,
    403,
  );
  assert.ok((await signIn(tenant.id, 'first-admin')).accessToken);
});
