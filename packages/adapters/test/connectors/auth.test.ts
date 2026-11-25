import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  ConnectorLifecycle,
  MemoryCredentialStore,
  MemoryOAuthStateStore,
  OAuthPkce,
  createFixtureConnectors,
  fixtureAccounts,
  type HttpRequest,
} from '../../src/connectors/index.ts';

const time = Date.parse('2026-11-25T15:00:00Z');
const subject = { tenantId: 'workspace-a', connectionId: 'connection-1', actorId: 'operator-a' };
const endpoint = 'https://provider.fixture.example';

test('PKCE sends S256 and exchanges only the matching, live, one-use state', async () => {
  let now = time;
  const requests: HttpRequest[] = [];
  const oauth = new OAuthPkce(
    {
      authorizationEndpoint: endpoint + '/authorize',
      tokenEndpoint: endpoint + '/token',
      revocationEndpoint: endpoint + '/revoke',
      clientId: 'demo-client',
      redirectUri: 'https://platform.fixture.example/connectors/oauth/callback',
      scopes: ['read.fixture'],
    },
    async (request) => {
      requests.push(request);
      if (new URLSearchParams(request.body).get('code') === 'transport-failure') {
        throw new Error('fixture transport leaked a synthetic authorization code');
      }
      return {
        status: 200,
        body: { access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 60 },
      };
    },
    new MemoryOAuthStateStore(),
    () => now,
  );
  const url = new URL(await oauth.start(subject));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.has('code_verifier'), false);
  const state = url.searchParams.get('state')!;
  await assert.rejects(oauth.exchange({ ...subject, actorId: 'different' }, state, 'code'), {
    code: 'auth_required',
  });
  assert.equal(requests.length, 0);
  const accepted = await Promise.allSettled([
    oauth.exchange(subject, state, 'code'),
    oauth.exchange(subject, state, 'code'),
  ]);
  assert.deepEqual(
    accepted.map((result) => result.status),
    ['fulfilled', 'rejected'],
  );
  assert.equal(requests.length, 1);
  const form = new URLSearchParams(requests[0].body);
  const verifier = form.get('code_verifier')!;
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    createHash('sha256').update(verifier).digest('base64url'),
    url.searchParams.get('code_challenge'),
  );
  assert.equal(form.get('redirect_uri'), url.searchParams.get('redirect_uri'));
  assert.equal(form.get('grant_type'), 'authorization_code');
  const failed = new URL(await oauth.start(subject)).searchParams.get('state')!;
  await assert.rejects(oauth.exchange(subject, failed, 'transport-failure'), {
    message: 'provider_unavailable',
  });
  const expired = new URL(await oauth.start(subject)).searchParams.get('state')!;
  now += 600_000;
  await assert.rejects(oauth.exchange(subject, expired, 'code-again'), { code: 'auth_required' });
});

test('OAuth rotates a stored credential once for concurrent reads and revokes it', async () => {
  let now = time;
  const clock = () => now;
  const fixtures = createFixtureConnectors(clock);
  const store = new MemoryCredentialStore();
  const lifecycle = new ConnectorLifecycle(fixtures.registrations, store, clock);
  const binding = lifecycle.install(
    subject.tenantId,
    'quickbooks-fixture',
    fixtureAccounts.accounting,
  );
  const operator = { ...binding, actorId: subject.actorId };
  const { state, code } = fixtures.consent(await lifecycle.startOAuth(operator));
  await assert.rejects(
    lifecycle.completeOAuth({ ...operator, tenantId: 'workspace-b' }, state, code),
    { code: 'auth_required' },
  );
  assert.equal((await lifecycle.completeOAuth(operator, state, code)).status, 'authorized');
  await assert.rejects(lifecycle.activate(binding), { code: 'conflict' });
  await lifecycle.verifyAccount(binding);
  await lifecycle.activate(binding);
  const first = await store.get(binding);
  assert.equal(first?.type, 'oauth2-pkce');
  now += 60_000;
  const snapshots = await Promise.all(
    [1, 2].map(() =>
      lifecycle.withActive(binding, 'snapshot', ({ connector, context }) =>
        connector.snapshot(context),
      ),
    ),
  );
  assert.deepEqual(snapshots[0], snapshots[1]);
  assert.equal(snapshots[0].records.length, 3);
  const rotation = await store.get(binding);
  assert.equal(rotation?.type, 'oauth2-pkce');
  assert.notEqual(rotation.refreshToken, first.refreshToken);
  assert.equal(rotation.expiresAt, now + 60_000);
  assert.equal((await lifecycle.revoke(binding)).status, 'revoked');
  assert.equal(await store.get(binding), undefined);
  await assert.rejects(
    lifecycle.withActive(binding, 'read', async () => null),
    { code: 'auth_required' },
  );
  await assert.rejects(fixtures.registrations[0].connector.verifyAccount(rotation), {
    code: 'auth_required',
  });
});

test('API keys are tenant-bound and authority requires the verified account', async () => {
  const { registrations } = createFixtureConnectors();
  const lifecycle = new ConnectorLifecycle(registrations, new MemoryCredentialStore());
  const wrong = lifecycle.install(subject.tenantId, 'hubspot-fixture', 'different-portal');
  await lifecycle.authorizeApiKey(wrong, fixtureAccounts.crmKey);
  await assert.rejects(lifecycle.verifyAccount(wrong), { code: 'permission_denied' });
  const first = lifecycle.install(subject.tenantId, 'hubspot-fixture', fixtureAccounts.crm);
  const second = lifecycle.install(subject.tenantId, 'hubspot-fixture', fixtureAccounts.crm);
  for (const ref of [first, second]) {
    await lifecycle.authorizeApiKey(ref, fixtureAccounts.crmKey);
    await lifecycle.verifyAccount(ref);
  }
  await lifecycle.activate(first);
  await lifecycle.pause(first);
  await assert.rejects(lifecycle.activate(second), { code: 'conflict' });
  assert.throws(() => lifecycle.get({ ...first, tenantId: 'workspace-b' }), { code: 'not_found' });
  await lifecycle.revoke(first);
  assert.equal((await lifecycle.activate(second)).status, 'active');
});
