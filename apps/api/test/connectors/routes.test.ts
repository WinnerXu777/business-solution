import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  ConnectorError,
  ConnectorLifecycle,
  ConnectorSync,
  MemoryCredentialStore,
  WebhookIngestor,
  createFixtureConnectors,
  fixtureAccounts,
  signWebhook,
} from '../../../../packages/adapters/src/connectors/index.ts';
import { connectorsPlugin } from '../../src/connectors/index.ts';

test('connector plugin isolates identity and handles the full fixture setup and sync', async (t) => {
  const now = Date.parse('2026-11-25T15:00:00Z');
  const clock = () => now;
  const fixtures = createFixtureConnectors(clock);
  const lifecycle = new ConnectorLifecycle(
    fixtures.registrations,
    new MemoryCredentialStore(),
    clock,
  );
  const sync = new ConnectorSync(lifecycle, clock);
  const webhooks = new WebhookIngestor(
    lifecycle,
    {
      async get({ tenantId }) {
        return tenantId === 'fixture-a' ? 'api-webhook-secret' : undefined;
      },
    },
    (ref, event) => sync.hydrate(ref, event),
    clock,
  );
  const app = Fastify();
  t.after(() => app.close());
  await app.register(connectorsPlugin, {
    lifecycle,
    sync,
    webhooks,
    async identify(request, permission) {
      switch (request.headers.authorization) {
        case 'Bearer fixture-a':
          return { tenantId: 'fixture-a', actorId: 'operator-a' };
        case 'Bearer fixture-b':
          return { tenantId: 'fixture-b', actorId: 'operator-b' };
        case 'Bearer fixture-reader':
          if (permission === 'connectors:read')
            return { tenantId: 'fixture-a', actorId: 'reader-a' };
          throw new ConnectorError('permission_denied');
        default:
          throw new ConnectorError('auth_required');
      }
    },
  });
  const headers = { authorization: 'Bearer fixture-a' };
  const list = await app.inject({ url: '/connectors', headers });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(
    list.json().connectors.map((item: { id: string }) => item.id),
    ['quickbooks-fixture', 'hubspot-fixture'],
  );
  assert.equal((await app.inject('/connectors')).statusCode, 401);
  const install = await app.inject({
    method: 'POST',
    url: '/connectors/install',
    headers,
    payload: {
      connectorId: 'quickbooks-fixture',
      accountId: fixtureAccounts.accounting,
      tenantId: 'fixture-b',
    },
  });
  assert.equal(install.statusCode, 201, install.body);
  assert.equal(install.json().tenantId, 'fixture-a');
  const id = install.json().connectionId;
  const prefix = `/connectors/${id}`;
  const other = { authorization: 'Bearer fixture-b' };
  const reader = { authorization: 'Bearer fixture-reader' };
  assert.equal((await app.inject({ url: prefix + '/status', headers: other })).statusCode, 404);
  assert.equal(
    (await app.inject({ method: 'POST', url: prefix + '/oauth/start', headers: reader }))
      .statusCode,
    403,
  );

  const start = await app.inject({ method: 'POST', url: prefix + '/oauth/start', headers });
  assert.equal(start.statusCode, 200, start.body);
  assert.equal(start.headers['cache-control'], 'no-store');
  const { authorizeUrl } = start.json();
  const { pathname } = new URL(new URL(authorizeUrl).searchParams.get('redirect_uri')!);
  const callback = pathname + '?' + new URLSearchParams(fixtures.consent(authorizeUrl));
  assert.equal((await app.inject({ url: callback, headers: other })).statusCode, 401);
  const active = await app.inject({ url: callback, headers });
  assert.equal(active.statusCode, 200, active.body);
  assert.equal(active.json().status, 'active');
  assert.equal(active.json().connectionId, id);
  assert.equal(active.body.includes('synthetic-access'), false);
  assert.equal((await app.inject({ url: callback, headers })).statusCode, 401);
  assert.equal(
    (await app.inject({ url: prefix + '/status', headers: reader })).json().sync.checkpoint,
    null,
  );

  const snapshot = await app.inject({
    method: 'POST',
    url: prefix + '/sync',
    headers,
    payload: { mode: 'snapshot' },
  });
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  assert.equal(snapshot.json().added.length, 3);
  const poll = await app.inject({
    method: 'POST',
    url: prefix + '/sync',
    headers,
    payload: { mode: 'poll' },
  });
  assert.equal(poll.statusCode, 200, poll.body);
  assert.equal(poll.json().checkpoint, '3');
  const report = await app.inject({ url: prefix + '/reconciliation', headers: reader });
  assert.deepEqual(report.json().report.changed, []);
  const invalid = await app.inject({
    method: 'POST',
    url: prefix + '/sync',
    headers,
    payload: { mode: 'garbage' },
  });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { error: 'validation_failed' });

  const timestamp = String(now / 1000);
  const payload =
    ' ' +
    JSON.stringify({
      schemaVersion: 1,
      accountId: fixtureAccounts.accounting,
      eventId: 'updated-invoice',
      sequence: 1,
      recordClass: 'invoice',
      externalId: 'qb-invoice-1',
      occurredAt: new Date(now).toISOString(),
    }) +
    '\n';
  const deliver = (body: string) =>
    app.inject({
      method: 'POST',
      url: prefix + '/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-connector-timestamp': timestamp,
        'x-connector-signature': signWebhook('api-webhook-secret', timestamp, Buffer.from(payload)),
      },
      payload: body,
    });
  assert.equal((await deliver(payload.trim())).statusCode, 401);
  const delivery = await deliver(payload);
  assert.equal(delivery.statusCode, 202, delivery.body);
  assert.deepEqual(delivery.json(), { status: 'accepted' });
  assert.deepEqual((await deliver(payload)).json(), { status: 'duplicate' });
  assert.deepEqual((await app.inject({ url: prefix + '/dead-letters', headers })).json(), {
    events: [],
  });

  const crmInstall = await app.inject({
    method: 'POST',
    url: '/connectors/install',
    headers,
    payload: { connectorId: 'hubspot-fixture', accountId: fixtureAccounts.crm },
  });
  const keyResult = await app.inject({
    method: 'POST',
    url: `/connectors/${crmInstall.json().connectionId}/api-key`,
    headers,
    payload: { key: fixtureAccounts.crmKey },
  });
  assert.equal(keyResult.statusCode, 200, keyResult.body);
  assert.equal(keyResult.json().status, 'active');
  assert.equal(keyResult.body.includes(fixtureAccounts.crmKey), false);
  const revoke = await app.inject({ method: 'POST', url: prefix + '/revoke', headers });
  assert.equal(revoke.json().status, 'revoked');
});
