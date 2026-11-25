import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  createPlatformServices,
  fixtureAdmin,
  type EventInput,
  type MutationContext,
  type WebhookDispatch,
} from '../../src/platform/index.ts';

const context = {
  ...fixtureAdmin,
  source: 'rest',
  traceId: 'events-test',
  correlationId: 'events-test',
} satisfies MutationContext;
const tenant = context.tenantId;
const other = 'tenant-spoolharbour';

test('webhook fanout signs exact bytes, retries, dead-letters, and replays without altering history', async () => {
  const start = Date.parse('2026-11-25T15:00:00Z');
  let time = start;
  const calls: WebhookDispatch[] = [];
  const { events } = createPlatformServices({
    now: () => new Date(time).toISOString(),
    vaultMasterKey: Buffer.alloc(32, 0x34),
    async webhookTransport(request) {
      calls.push(request);
      if (calls.length === 1) throw new Error('private-provider-payload');
      return { status: calls.length <= 3 ? 503 : 204 };
    },
  });
  await assert.rejects(
    events.createWebhook(context, { url: 'https://127.0.0.1/admin', events: ['record.changed'] }),
    { code: 'forbidden' },
  );
  const hook = await events.createWebhook(context, {
    url: 'https://demo.example/events',
    events: ['record.changed'],
  });
  const unrelated = await events.createWebhook(context, {
    url: 'https://demo.example/other',
    events: ['approval.requested'],
  });
  const foreign = await events.createWebhook(
    { ...context, tenantId: other },
    { url: 'https://other.example/events', events: ['record.changed'] },
  );
  const record = {
    id: 'record-event',
    type: 'record.changed',
    occurredAt: '2026-11-25T15:00:00Z',
    data: {
      recordType: 'contact',
      recordId: 'fictional-customer',
      change: 'updated',
      email: 'private@example.test',
    },
  } as const;
  await events.publish(tenant, record);
  await events.publish(tenant, record);
  await assert.rejects(
    events.publish(tenant, { ...record, data: { ...record.data, change: 'deleted' } }),
    { code: 'idempotency_conflict' },
  );
  assert.equal((await events.deliveries(tenant, unrelated.id)).length, 0);
  assert.equal((await events.deliveries(other, foreign.id)).length, 0);
  await assert.rejects(events.deliveries(other, hook.id), { code: 'not_found' });
  assert.ok(!(await events.listWebhooks(tenant)).some((row) => 'signingSecret' in row));

  await Promise.all([events.deliverDue(tenant), events.deliverDue(tenant)]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, hook.url);
  const first = (await events.deliveries(tenant, hook.id))[0];
  const timestamp = String(start / 1000);
  assert.equal(calls[0].headers['x-platform-timestamp'], timestamp);
  assert.equal(calls[0].headers['x-platform-delivery'], first.id);
  assert.equal(
    calls[0].headers['x-platform-signature'],
    'v1=' +
      createHmac('sha256', hook.signingSecret)
        .update(timestamp + '.' + first.id + '.' + calls[0].body)
        .digest('hex'),
  );
  assert.equal(JSON.parse(calls[0].body).tenantId, tenant);
  assert.equal(calls[0].body.includes('private@example.test'), false);
  assert.equal(first.nextAttemptAt, new Date(start + 30_000).toISOString());
  assert.equal(JSON.stringify(first).includes('private-provider-payload'), false);
  time += 29_999;
  assert.equal(await events.deliverDue(tenant), 0);
  time++;
  await events.deliverDue(tenant);
  time += 120_000;
  await events.deliverDue(tenant);
  const dead = (await events.deliveries(tenant, hook.id))[0];
  assert.equal(dead.status, 'dead');
  assert.deepEqual(
    dead.attempts.map(({ outcome }) => outcome),
    ['retry', 'retry', 'dead'],
  );
  assert.equal(calls[2].headers['x-platform-delivery'], first.id);
  await assert.rejects(events.replay({ ...context, tenantId: other }, dead.id), {
    code: 'not_found',
  });

  const replay = await events.replay(context, dead.id);
  assert.notEqual(replay.id, dead.id);
  assert.equal(replay.replayOf, dead.id);
  assert.equal((await events.replay(context, dead.id)).id, replay.id);
  await events.deliverDue(tenant);
  const deliveries = await events.deliveries(tenant, hook.id);
  assert.deepEqual(
    deliveries.map(({ status }) => status),
    ['dead', 'delivered'],
  );
  assert.equal(calls[3].body, calls[0].body);
  assert.equal(calls[3].headers['x-platform-delivery'], replay.id);
});

test('notification read state belongs to an individual user and tenant', async () => {
  const occurredAt = '2026-11-25T15:00:00Z';
  const { events } = createPlatformServices({ now: () => occurredAt });
  const event: EventInput = {
    id: 'notice',
    type: 'approval.requested',
    occurredAt,
    data: { approvalId: 'approval-demo' },
  };
  const users = [context.actor.id, 'actor-reader'];
  await events.publish(tenant, event, users);
  await events.publish(tenant, event, users.toReversed());
  await events.publish(other, event, [context.actor.id]);
  const notice = (await events.notifications(tenant, context.actor.id))[0];
  assert.ok(notice);
  assert.equal(notice.readAt, undefined);
  await assert.rejects(
    events.markRead({ ...context, actor: { id: 'actor-operator', kind: 'person' } }, notice.id),
    { code: 'not_found' },
  );
  assert.ok((await events.markRead(context, notice.id)).readAt);
  assert.equal((await events.notifications(tenant, 'actor-reader'))[0].readAt, undefined);
  assert.equal((await events.notifications(other, context.actor.id))[0].readAt, undefined);
});

test('an expired delivery claim retries and a late worker cannot overwrite the settled attempt', async () => {
  let time = Date.parse('2026-11-25T15:00:00Z');
  const started = Promise.withResolvers<void>();
  const firstResult = Promise.withResolvers<{ status: number }>();
  let attempts = 0;
  const { events } = createPlatformServices({
    now: () => new Date(time).toISOString(),
    vaultMasterKey: Buffer.alloc(32, 0x34),
    async webhookTransport() {
      attempts++;
      if (attempts === 1) {
        started.resolve();
        return firstResult.promise;
      }
      return { status: 204 };
    },
  });
  const hook = await events.createWebhook(context, {
    url: 'https://demo.example/lease',
    events: ['record.changed'],
  });
  await events.testWebhook(context, hook.id);
  const firstWorker = events.deliverDue(tenant);
  await started.promise;
  try {
    time += 30_000;
    await events.deliverDue(tenant);
    time += 30_000;
    await events.deliverDue(tenant);
  } finally {
    firstResult.resolve({ status: 503 });
    await firstWorker;
  }
  const [delivery] = await events.deliveries(tenant, hook.id);
  assert.equal(attempts, 2);
  assert.equal(delivery.status, 'delivered');
  assert.deepEqual(
    delivery.attempts.map(({ outcome }) => outcome),
    ['retry', 'delivered'],
  );
});

test('billing and consent changes publish stable, minimal events', async () => {
  let at = '2026-11-25T15:00:00Z';
  const { events, contacts, billing } = createPlatformServices({
    now: () => at,
    vaultMasterKey: Buffer.alloc(32, 0x34),
  });
  const hook = await events.createWebhook(context, {
    url: 'https://demo.example/events',
    events: ['invoice.finalized', 'consent.withdrawn'],
  });
  const consent = await contacts.grant(context, {
    contactId: 'cust-002',
    channel: 'email',
    purpose: 'marketing',
    basis: 'express',
    source: 'fixture',
    evidenceRef: 'synthetic-agreement',
  });
  await contacts.withdraw(context, consent.id);
  await contacts.withdraw(context, consent.id);
  const invoiceId = (await billing.invoices(tenant)).items[0].id;
  at = '2026-12-01T15:00:00Z';
  await billing.finalize(context, invoiceId);
  await billing.finalize(context, invoiceId);
  assert.deepEqual(
    (await events.deliveries(tenant, hook.id)).map(({ eventId }) => eventId),
    ['withdrawal-' + consent.id, 'finalized-' + invoiceId],
  );
});
