import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createFixtureBotsBackend } from '../../src/bots/fixture.ts';
import { botsPlugin, type BotRole } from '../../src/bots/index.ts';

async function fixture() {
  const app = Fastify();
  await app.register(botsPlugin, {
    backend: createFixtureBotsBackend(),
    resolveIdentity(request) {
      const token = request.headers.authorization;
      const actors: Record<string, [string, BotRole, string?]> = {
        'Bearer operator': ['actor-operator', 'operator'],
        'Bearer approver': ['actor-approver', 'approver'],
        'Bearer admin': ['actor-admin', 'admin'],
        'Bearer reader': ['actor-reader', 'reader'],
        'Bearer foreign': ['actor-operator-2', 'operator', 'tenant-spoolharbour'],
      };
      const actor = token && Object.hasOwn(actors, token) ? actors[token] : undefined;
      if (actor)
        return {
          tenantId: actor[2] ?? 'tenant-rivetquay',
          actor: { id: actor[0], kind: 'person' },
          role: actor[1],
        };
    },
  });

  return {
    app,
    request(
      method: 'GET' | 'POST' | 'PUT',
      path: string,
      token?: string,
      payload?: object,
      key?: string,
    ) {
      return app.inject({
        method,
        url: '/v1/bots' + path,
        payload,
        headers: {
          ...(token ? { authorization: 'Bearer ' + token } : {}),
          ...(key ? { 'idempotency-key': key } : {}),
        },
      });
    },
  };
}

test('bot plugin scopes policy, runs, and business records to verified identity', async (t) => {
  const { app, request } = await fixture();
  t.after(() => app.close());

  assert.equal((await request('GET', '/policies')).statusCode, 401);
  assert.equal((await request('GET', '/policies', 'operator')).statusCode, 403);
  const catalog = (await request('GET', '/definitions', 'reader')).json();
  assert.deepEqual(
    catalog.map((bot: { id: string; version: number }) => [bot.id, bot.version]),
    [
      ['collections', 1],
      ['pr-to-po', 1],
    ],
  );
  const { version, ...policies } = (await request('GET', '/policies', 'admin')).json();
  assert.equal(
    (await request('PUT', '/policies', 'admin', { ...policies, expectedVersion: version })).json()
      .version,
    version + 1,
  );
  assert.equal(
    (await request('PUT', '/policies', 'admin', { ...policies, expectedVersion: version }))
      .statusCode,
    409,
  );
  const body = { text: 'Draft pr-001', source: 'chat', sourceId: 'api-req' };
  assert.equal((await request('POST', '/procurement/requests', 'operator', body)).statusCode, 400);
  assert.equal(
    (
      await request(
        'POST',
        '/procurement/requests',
        'operator',
        { ...body, role: 'admin' },
        'spoof',
      )
    ).statusCode,
    400,
  );
  const started = await request('POST', '/procurement/requests', 'operator', body, 'purchase');
  assert.equal(started.statusCode, 202);
  const run = started.json();
  assert.equal(run.status, 'pending_approval', started.body);
  const replay = await request('POST', '/procurement/requests', 'operator', body, 'purchase');
  assert.deepEqual(replay.json(), run);
  assert.equal(
    (
      await request(
        'POST',
        '/procurement/requests',
        'operator',
        { ...body, text: 'changed' },
        'purchase',
      )
    ).statusCode,
    409,
  );
  assert.equal((await request('GET', '/runs/' + run.id, 'foreign')).statusCode, 404);
  const purchase = await request('POST', '/runs/' + run.id + '/resume', 'approver', {
    approvalId: run.pending.approval.id,
  });
  assert.equal(purchase.json().status, 'completed', purchase.body);
  const orderId = purchase.json().result.output.id;
  const receipt = await request(
    'POST',
    '/procurement/orders/' + orderId + '/receipts',
    'operator',
    {
      id: 'api-receipt',
      lines: [{ skuId: 'sku-001', quantity: 15 }],
    },
  );
  assert.equal(receipt.json().state, 'partial');
  const invoice = await request('POST', '/procurement/orders/' + orderId + '/matches', 'operator', {
    id: 'api-bill',
    vendorId: 'vendor-002',
    currency: 'CAD',
    lines: [{ skuId: 'sku-001', quantity: 20, unitCostCents: 420 }],
  });
  assert.deepEqual(invoice.json().reasons, ['insufficient_receipts:sku-001']);
  assert.deepEqual((await request('GET', '/procurement/exceptions', 'reader')).json(), [
    invoice.json(),
  ]);
  assert.equal(
    (await request('GET', '/procurement/orders/' + orderId + '/matches', 'foreign')).statusCode,
    404,
  );
});

test('collections dispatches only simulated approved contacts and blocks queued outreach after STOP', async (t) => {
  const { app, request } = await fixture();
  t.after(() => app.close());
  const invoiceId = 'inv-001';
  const dunning = '/collections/dunning';
  const started = await request('POST', dunning, 'operator', { invoiceId }, 'email');
  assert.equal(started.json().status, 'pending_approval', started.body);
  assert.equal(started.json().pending.previews[0].channel, 'email');
  assert.match(started.json().pending.previews[0].body, /contact Rivetquay/i);

  const { version, ...policy } = (await request('GET', '/policies', 'admin')).json();
  policy.collections.cadence['1-30'].channels = ['sms', 'voice'];
  const update = (expectedVersion: number) =>
    request('PUT', '/policies', 'admin', { ...policy, expectedVersion });

  assert.equal((await update(version)).statusCode, 200);
  const disabled = await request('POST', dunning, 'operator', { invoiceId }, 'phones-disabled');
  assert.equal(disabled.json().result.output.reason, 'channels_disabled');

  policy.collections.channelEnabled.sms = true;
  policy.collections.channelEnabled.voice = true;
  assert.equal((await update(version + 1)).statusCode, 200);
  const simulated = (await request('POST', dunning, 'operator', { invoiceId }, 'sms')).json();
  assert.equal(simulated.status, 'pending_approval');
  assert.equal(simulated.pending.previews[0].channel, 'sms');
  assert.match(simulated.pending.previews[0].body, /Reply STOP to opt out\./);
  const queued = (await request('POST', dunning, 'operator', { invoiceId }, 'queued')).json();
  assert.equal(queued.status, 'pending_approval');
  assert.notEqual(simulated.pending.approval.id, queued.pending.approval.id);

  const resume = (run: typeof simulated) =>
    request('POST', '/runs/' + run.id + '/resume', 'approver', {
      approvalId: run.pending.approval.id,
    });
  const delivered = await resume(simulated);
  assert.equal(delivered.json().status, 'completed', delivered.body);
  assert.equal(delivered.json().result.output.status, 'simulated');
  assert.equal(delivered.json().result.output.providerId, 'fixture-sms');
  assert.deepEqual((await resume(simulated)).json(), delivered.json());

  const reply = await request(
    'POST',
    '/collections/replies',
    'operator',
    {
      invoiceId,
      replyId: 'stop-1',
      text: 'STOP',
    },
    'stop',
  );
  assert.equal(reply.json().result.output.reason, 'opt_out');
  const held = await resume(queued);
  assert.equal(held.json().status, 'denied', held.body);
  assert.equal(
    (await request('POST', dunning, 'operator', { invoiceId }, 'after-stop')).json().result.output
      .reason,
    'opt_out',
  );
  const timeline = await request('GET', '/collections/accounts/cust-002/timeline', 'reader');
  assert.deepEqual(
    timeline.json().map((event: { kind: string }) => event.kind),
    ['contact_attempt', 'opt_out'],
  );
  assert.equal(
    (await request('GET', '/collections/accounts/cust-002/timeline', 'foreign')).statusCode,
    404,
  );
});

test('approved plans stop reminders and remain visible on the invoice and timeline', async (t) => {
  const { app, request } = await fixture();
  t.after(() => app.close());
  const invoiceId = 'inv-001';
  const plan = await request(
    'POST',
    '/collections/payment-plans',
    'operator',
    {
      invoiceId,
      installments: 3,
      firstDueOn: '2026-12-01',
      intervalDays: 14,
    },
    'plan',
  );
  assert.equal(plan.json().result.output.state, 'pending_approval');
  const path = '/collections/invoices/' + invoiceId + '/payment-plan';
  const approvalId = plan.json().result.output.id;
  assert.equal(
    (await request('POST', path + '/approve', 'operator', { approvalId })).statusCode,
    403,
  );
  assert.equal(
    (await request('POST', path + '/approve', 'approver', { approvalId })).json().state,
    'approved',
  );
  assert.equal((await request('GET', path, 'reader')).json().state, 'approved');
  const held = await request(
    'POST',
    '/collections/dunning',
    'operator',
    { invoiceId },
    'approved-plan',
  );
  assert.equal(held.json().result.output.reason, 'approved_payment_plan');
});
