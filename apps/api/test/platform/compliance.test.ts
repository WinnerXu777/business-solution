import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDemoFixtures } from '@bs/contracts';
import Fastify, { type HTTPMethods } from 'fastify';
import {
  createPlatformServices,
  fixtureAdmin,
  type PlatformIdentity,
} from '../../../../packages/core/src/platform/index.ts';
import { createPlatformFixtureIdentityVerifier, platformRoutes } from '../../src/platform/index.ts';

test('compliance endpoints enforce permissions, tenant scopes, payloads and output boundaries', async (t) => {
  let at = Date.parse('2026-11-25T15:00:00Z');
  const tenantId = fixtureAdmin.tenantId;
  const services = createPlatformServices({
    now: () => new Date(at).toISOString(),
    vaultMasterKey: Buffer.alloc(32, 0x34),
    webhookTransport: async () => ({ status: 503 }),
    privacy: {
      verifyIdentity: async (tenant, subject, _request, proofRef) =>
        tenant === tenantId && subject === 'synthetic-subject' && proofRef === 'verified-fixture',
      records: { list: async () => [], delete: async () => 0 },
    },
  });
  const reader = loadDemoFixtures().grants[2];
  const directory = services.directory;
  const { tenant: other, adminInvite } = await directory.provision({
    name: 'Synthetic second tenant',
    region: 'ca-central-1',
    plan: { addOns: [] },
    adminEmail: 'other@spoolharbour.example',
  });
  const member = await directory.acceptInvite(other.id, adminInvite.token, {
    issuer: 'https://issuer.example',
    subject: 'foreign-admin',
    verifiedEmail: 'other@spoolharbour.example',
  });
  const verifyIdentity = createPlatformFixtureIdentityVerifier(
    new Map<string, PlatformIdentity>([
      ['admin', fixtureAdmin],
      ['reader', reader],
      ['other', { tenantId: other.id, actor: member.user.actor }],
    ]),
    directory,
  );
  const app = Fastify();
  t.after(() => app.close());
  await app.register(platformRoutes, { services, verifyIdentity });
  function request(
    method: HTTPMethods,
    path: string,
    payload?: object,
    token: string | null = 'admin',
  ) {
    return app.inject({
      method,
      url: '/platform/v1' + path,
      payload,
      headers: token ? { authorization: 'Bearer ' + token } : {},
    });
  }

  const contact = { contactId: 'cust-002', channel: 'email', purpose: 'marketing' };
  const consentBody = {
    ...contact,
    basis: 'express',
    source: 'fixture-form',
    evidenceRef: 'synthetic-ref',
  };
  assert.equal((await request('GET', '/consents', undefined, null)).statusCode, 401);
  assert.equal((await request('POST', '/consents', consentBody, 'reader')).statusCode, 403);
  assert.equal((await request('POST', '/consents', { ...consentBody, tenantId })).statusCode, 400);
  const created = await request('POST', '/consents', consentBody);
  assert.equal(created.statusCode, 201, created.body);
  const consent = created.json();
  assert.equal((await request('GET', '/consents')).json()[0].unsubscribeToken, undefined);
  assert.deepEqual((await request('GET', '/consents', undefined, 'other')).json(), []);
  assert.equal((await request('POST', '/contact-check', contact)).json().allow, true);
  assert.equal(
    (await request('POST', '/consents/' + consent.id + '/withdraw', undefined, 'other')).statusCode,
    404,
  );
  assert.equal((await request('POST', '/consents/' + consent.id + '/withdraw')).statusCode, 200);
  assert.deepEqual((await request('POST', '/contact-check', contact)).json().reasons, [
    'withdrawn',
  ]);
  assert.equal(
    (
      await request(
        'POST',
        '/consents/unsubscribe',
        { tenantId, consentId: consent.id, token: consent.unsubscribeToken },
        null,
      )
    ).statusCode,
    204,
  );
  assert.equal((await request('GET', '/suppressions')).json()[0].reason, 'opt_out');
  assert.equal((await request('GET', '/suppressions?scope=platform')).statusCode, 403);
  assert.equal(
    (
      await request('POST', '/suppressions?scope=platform', {
        channel: 'voice',
        destination: '+14165550101',
        reason: 'policy',
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await request('POST', '/suppressions', {
        channel: 'voice',
        destination: '+14165550101',
        reason: 'policy',
      })
    ).statusCode,
    201,
  );

  const privacy = await request('POST', '/privacy-requests', {
    kind: 'export',
    subjectId: 'synthetic-subject',
  });
  assert.equal(privacy.statusCode, 201, privacy.body);
  const privacyPath = '/privacy-requests/' + privacy.json().id;
  assert.equal((await request('GET', '/privacy-requests')).json().length, 1);
  assert.equal((await request('POST', privacyPath + '/complete')).statusCode, 403);
  assert.equal(
    (await request('POST', privacyPath + '/verify', { proofRef: 'verified-fixture' }, 'other'))
      .statusCode,
    404,
  );
  assert.equal(
    (await request('POST', privacyPath + '/verify', { proofRef: 'wrong-fixture' })).statusCode,
    403,
  );
  assert.equal(
    (await request('POST', privacyPath + '/verify', { proofRef: 'verified-fixture' })).json()
      .status,
    'verified',
  );
  assert.deepEqual((await request('POST', privacyPath + '/complete')).json().bundle.records, []);
  assert.equal((await request('GET', '/retention/policies')).json().length, 5);
  assert.deepEqual((await request('POST', '/retention/dry-run')).json().items, []);
  assert.equal(
    (await request('POST', '/retention/dry-run', { asOf: 'not-an-instant' })).statusCode,
    400,
  );

  const webhook = await request('POST', '/webhooks', {
    url: 'https://demo.example/events',
    events: ['consent.withdrawn'],
  });
  assert.equal(webhook.statusCode, 201, webhook.body);
  const hook = webhook.json();
  assert.ok(hook.signingSecret);
  assert.equal((await request('GET', '/webhooks')).json()[0].signingSecret, undefined);
  const webhookPath = '/webhooks/' + hook.id;
  assert.equal(
    (await request('GET', webhookPath + '/deliveries', undefined, 'other')).statusCode,
    404,
  );
  assert.equal((await request('POST', webhookPath + '/test')).statusCode, 202);
  await services.events.deliverDue(tenantId);
  at += 30_000;
  await services.events.deliverDue(tenantId);
  at += 120_000;
  await services.events.deliverDue(tenantId);
  const delivery = (await request('GET', webhookPath + '/deliveries')).json()[0];
  assert.equal(delivery.status, 'dead');
  assert.equal(
    (await request('POST', '/webhooks/deliveries/' + delivery.id + '/replay')).statusCode,
    202,
  );

  await services.events.publish(
    tenantId,
    {
      id: 'notice-demo',
      type: 'approval.requested',
      data: { approvalId: 'approval-demo' },
      occurredAt: new Date(at).toISOString(),
    },
    [reader.actor.id],
  );
  assert.deepEqual((await request('GET', '/notifications')).json(), []);
  assert.equal((await request('POST', '/notifications/notice-demo/read')).statusCode, 404);
  assert.equal(
    (await request('GET', '/notifications', undefined, 'reader')).json()[0].readAt,
    undefined,
  );
  assert.ok(
    (await request('POST', '/notifications/notice-demo/read', undefined, 'reader')).json().readAt,
  );
});
