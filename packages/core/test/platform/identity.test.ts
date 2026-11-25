import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDemoFixtures } from '@bs/contracts';
import {
  fixtureAdmin,
  OidcRelyingParty,
  PlatformSessions,
  TenantDirectory,
} from '../../src/platform/index.ts';
import { mayDecideApproval } from '../../src/platform/permissions.ts';
import { fakeOidc } from './fake-oidc.ts';

const fixtures = loadDemoFixtures();
const [operator, approver, reader, , other] = fixtures.grants;
const tenantId = fixtureAdmin.tenantId;

function clock() {
  let instant = Date.parse(fixtures.asOf);
  return {
    now: () => instant,
    advance(ms: number) {
      instant += ms;
    },
  };
}

test('OIDC uses one-time state, a browser-bound cookie, and S256 PKCE through the fake HTTP issuer', async () => {
  const { now, advance } = clock();
  const fake = fakeOidc(now);
  const oidc = new OidcRelyingParty(fake.config);
  const login = await oidc.login(tenantId);
  const url = new URL(login.authorizeUrl);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.match(url.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(url.searchParams.has('code_verifier'), false);
  const { code, state } = fake.authorize(login.authorizeUrl);
  await assert.rejects(oidc.callback(state, code, undefined), { code: 'forbidden' });
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(await oidc.callback(state, code, login.browserToken), {
    tenantId,
    principal: {
      issuer: fake.config.issuer,
      subject: 'fixture-subject',
      verifiedEmail: 'fixture@example.test',
      mfaAt: undefined,
    },
  });
  await assert.rejects(oidc.callback(state, code, login.browserToken), { code: 'forbidden' });
  const changed = await oidc.login(tenantId);
  const swapped = new URL(changed.authorizeUrl);
  swapped.searchParams.set('code_challenge', 'other-challenge');
  const bad = fake.authorize(swapped.href);
  await assert.rejects(oidc.callback(bad.state, bad.code, changed.browserToken), {
    code: 'forbidden',
  });
  const expired = await oidc.login(tenantId);
  const late = fake.authorize(expired.authorizeUrl);
  advance(5 * 60_000);
  await assert.rejects(oidc.callback(late.state, late.code, expired.browserToken), {
    code: 'forbidden',
  });
  assert.equal(fake.calls.filter((url) => url.endsWith('/keys')).length, 1);
});

test('OIDC rejects invalid signatures and invalid issuer, audience, expiry and nonce claims', async () => {
  const { now } = clock();
  const fake = fakeOidc(now);
  const oidc = new OidcRelyingParty(fake.config);
  const instant = Math.floor(now() / 1000);
  for (const [name, options] of Object.entries({
    signature: { badSignature: true },
    issuer: { claims: { iss: 'https://other-issuer.example' } },
    audience: { claims: { aud: ['different-client'] } },
    authorizedParty: { claims: { aud: [fake.config.clientId, 'second'], azp: 'second' } },
    expiry: { claims: { iat: instant - 10, exp: instant } },
    nonce: { claims: { nonce: 'substituted-nonce' } },
  })) {
    const login = await oidc.login(tenantId);
    const { code, state } = fake.authorize(login.authorizeUrl, options);
    await assert.rejects(
      oidc.callback(state, code, login.browserToken),
      { code: 'forbidden' },
      name,
    );
  }
});

test('OIDC step-up requires fresh MFA from a signed auth_time and AMR or configured ACR', async () => {
  const { now } = clock();
  const fake = fakeOidc(now);
  const oidc = new OidcRelyingParty(fake.config);
  for (const claims of [{ amr: ['pwd'] }, { amr: ['mfa'], auth_time: now() / 1000 - 120 }]) {
    const login = await oidc.login(tenantId, true);
    const { code, state } = fake.authorize(login.authorizeUrl, { claims });
    await assert.rejects(oidc.callback(state, code, login.browserToken), { code: 'forbidden' });
  }
  const login = await oidc.login(tenantId, true);
  assert.equal(new URL(login.authorizeUrl).searchParams.get('max_age'), '0');
  assert.equal(new URL(login.authorizeUrl).searchParams.get('acr_values'), 'urn:fixture:mfa');
  const { code, state } = fake.authorize(login.authorizeUrl, {
    claims: { acr: 'urn:fixture:mfa', auth_time: now() / 1000 },
  });
  assert.equal((await oidc.callback(state, code, login.browserToken)).principal.mfaAt, now());
});

test('sessions expire, rotate refresh, revoke whole families and check current membership versions', () => {
  const { now, advance } = clock();
  const directory = new TenantDirectory();
  const options = { signingKey: Buffer.alloc(32, 7), now };
  const sessions = new PlatformSessions(directory, options);
  assert.throws(() => new PlatformSessions(directory, { signingKey: Buffer.alloc(31) }));
  const assurance = { platformOperator: false, mfaAt: now() };
  const first = sessions.issue(reader, assurance);
  assert.equal(sessions.verify(first.accessToken)?.identity.actor.id, reader.actor.id);
  assert.equal(sessions.verify(first.accessToken + 'a'), undefined);
  assert.equal(new PlatformSessions(directory, options).verify(first.accessToken), undefined);
  const second = sessions.refresh(first.refreshToken);
  assert.notEqual(first.accessToken, second.accessToken);
  assert.throws(() => sessions.refresh(first.refreshToken), { code: 'forbidden' });
  assert.equal(sessions.logout(second.refreshToken), true);
  for (const token of [first.accessToken, second.accessToken])
    assert.equal(sessions.verify(token), undefined);
  assert.throws(() => sessions.refresh(second.refreshToken), { code: 'forbidden' });
  const expiring = sessions.issue(reader, assurance);
  advance(5 * 60_000);
  assert.equal(sessions.verify(expiring.accessToken), undefined);
  advance(5 * 60_000);
  const refreshed = sessions.refresh(expiring.refreshToken);
  assert.equal(sessions.verify(refreshed.accessToken)?.steppedUp, false);
  directory.assignRole(fixtureAdmin, reader.actor.id, 'operator');
  assert.equal(sessions.verify(refreshed.accessToken), undefined);
  assert.throws(() => sessions.refresh(refreshed.refreshToken), { code: 'forbidden' });
  const long = sessions.issue(reader, assurance);
  advance(8 * 60 * 60_000);
  assert.throws(() => sessions.refresh(long.refreshToken), { code: 'forbidden' });
});

test('invite redemption is tenant scoped, single-use, expiring and bound to a verified address', () => {
  const { now, advance } = clock();
  const directory = new TenantDirectory(fixtures, () => new Date(now()).toISOString());
  const principal = {
    issuer: 'https://dex.example',
    subject: 'new',
    verifiedEmail: 'reader@example.test',
  };
  const first = directory.createInvite(fixtureAdmin, 'Reader@example.test', 'reader');
  assert.throws(() => directory.acceptInvite(other.tenantId, first.token, principal), {
    code: 'not_found',
  });
  assert.throws(
    () => directory.acceptInvite(tenantId, first.token, { ...principal, verifiedEmail: undefined }),
    { code: 'not_found' },
  );
  const joined = directory.acceptInvite(tenantId, first.token, principal);
  assert.equal(joined.role, 'reader');
  assert.equal(directory.userFor(principal)?.actor.id, joined.id);
  assert.throws(() => directory.acceptInvite(tenantId, first.token, principal), {
    code: 'not_found',
  });
  const second = directory.createInvite(fixtureAdmin, 'reader@example.test', 'reader');
  advance(24 * 60 * 60_000);
  assert.throws(
    () => directory.acceptInvite(tenantId, second.token, { ...principal, subject: 'late' }),
    { code: 'not_found' },
  );
});

test('built-in and tenant-local custom permissions preserve approval separation and admin access', () => {
  const directory = new TenantDirectory();
  assert.deepEqual(
    [reader, operator, approver, fixtureAdmin].map((identity) => [
      directory.allows(identity, 'records.read'),
      directory.allows(identity, 'actions.request'),
      directory.allows(identity, 'approvals.decide'),
      directory.allows(identity, 'members.manage'),
    ]),
    [
      [true, false, false, false],
      [true, true, false, false],
      [true, false, true, false],
      [true, false, false, true],
    ],
  );
  const review = {
    id: 'review',
    name: 'Review work',
    permissions: ['actions.request', 'approvals.decide'],
  } as const;
  directory.createRole(fixtureAdmin, { ...review, permissions: [...review.permissions] });
  directory.assignRole(fixtureAdmin, reader.actor.id, review.id);
  assert.equal(directory.allows(reader, 'approvals.decide'), true);
  assert.equal(directory.allows(reader, 'members.manage'), false);
  assert.equal(
    directory.roles(other.tenantId).some(({ id }) => id === review.id),
    false,
  );
  assert.throws(() => directory.assignRole(fixtureAdmin, other.actor.id, review.id), {
    code: 'not_found',
  });
  assert.throws(() => directory.removeMember(fixtureAdmin, fixtureAdmin.actor.id), {
    code: 'forbidden',
  });
  const ownRequest = { requestedBy: reader.actor.id, approverId: reader.actor.id };
  assert.equal(mayDecideApproval(true, reader.actor.id, ownRequest), false);
  assert.equal(
    mayDecideApproval(true, reader.actor.id, { ...ownRequest, requestedBy: operator.actor.id }),
    true,
  );
  const record = directory.requestExport(fixtureAdmin);
  assert.equal(record.status, 'requested');
  assert.deepEqual(directory.exportRequests(fixtureAdmin), [record]);
  assert.throws(() => directory.requestExport(operator), { code: 'forbidden' });
});
