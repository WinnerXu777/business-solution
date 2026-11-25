import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cron,
  eventMatches,
  minute,
  receiptKey,
  scheduleDue,
  verifyWebhook,
} from '../../src/workflows/triggers.ts';

const toronto = 'America/Toronto';
const at = Date.parse;
const iso = (slots: number[]) => slots.map((slot) => new Date(slot).toISOString());

test('Toronto spring gap is skipped and fall fold has two distinct occurrences', () => {
  const spring = scheduleDue(
    cron('30 2 * * *', toronto),
    at('2026-03-08T00:00Z'),
    at('2026-03-08T12:00Z'),
    'run-all',
  );
  assert.deepEqual(spring.slots, []);
  assert.equal(cron('30 2 * * *', toronto)(at('2026-03-09T06:30Z')), true);
  const autumn = scheduleDue(
    cron('30 1 * * *', toronto),
    at('2026-11-01T00:00Z'),
    at('2026-11-01T12:00Z'),
    'run-all',
  );
  assert.deepEqual(iso(autumn.slots), ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  assert.notEqual(receiptKey('daily', autumn.slots[0]), receiptKey('daily', autumn.slots[1]));
  assert.equal(cron('0 9 1 * 0', 'UTC')(at('2026-11-08T09:00Z')), true);
  assert.equal(cron('0 9 1 * 0', 'UTC')(at('2026-12-01T09:00Z')), true);
  assert.equal(cron('0 9 1 * 0', 'UTC')(at('2026-12-02T09:00Z')), false);
  assert.throws(() => cron('60 * * * *', toronto));
  assert.throws(() => cron('* * * * *', 'Canada/Fictional'));
});

test('schedule catch-up keeps the latest bounded missed slots and separates current work', () => {
  const now = 20 * minute;
  const match = cron('*/2 * * * *', 'UTC');
  assert.deepEqual(scheduleDue(match, minute, now, 'skip').slots, [20 * minute]);
  assert.deepEqual(
    scheduleDue(match, minute, now, 'run-once').slots,
    [18, 20].map((m) => m * minute),
  );
  assert.deepEqual(
    scheduleDue(match, minute, now, 'run-all', 3).slots,
    [14, 16, 18, 20].map((m) => m * minute),
  );
  assert.deepEqual(scheduleDue(match, now, now + 10, 'run-all'), { cursor: now, slots: [] });
  let examined = 0;
  scheduleDue(
    () => {
      examined++;
      return false;
    },
    0,
    15 * 24 * 60 * minute,
    'run-once',
  );
  assert.equal(examined, 7 * 24 * 60 + 1);
});

test('record events detect threshold crossings with tenant-independent event semantics', () => {
  const aging = {
    id: 'evt-1',
    name: 'invoice.overdue' as const,
    recordId: 'inv-001',
    beforeDays: 5,
    days: 8,
  };
  assert.equal(eventMatches('invoice.overdue', aging, 7), true);
  assert.equal(eventMatches('invoice.overdue', { ...aging, beforeDays: 7 }, 7), false);
  assert.equal(eventMatches('invoice.overdue', aging, 9), false);
  assert.equal(eventMatches('customer.inactive', { ...aging, name: 'customer.inactive' }, 7), true);
  const stock = {
    id: 'evt-2',
    name: 'stock.below_reorder' as const,
    recordId: 'sku-001',
    beforeQuantity: 5,
    quantity: 3,
    reorderPoint: 4,
  };
  assert.equal(eventMatches(stock.name, stock), true);
  assert.equal(eventMatches(stock.name, { ...stock, beforeQuantity: 2 }), false);
  assert.equal(eventMatches('order.created', { ...stock, name: 'order.created' }), true);
  assert.equal(eventMatches('approval.decided', { ...stock, name: 'approval.decided' }), true);
});

test('webhook HMAC binds audience, timestamp and raw bytes', () => {
  const now = at('2026-11-25T15:00Z');
  const timestamp = String(now / 1000);
  const secret = 'synthetic-signing-key';
  const tenant = 'tenant-rivetquay';
  const trigger = 'fixture-hook';
  const raw = Buffer.from('{ "id":"evt-1", "values":{} }');
  const signature =
    'sha256=' +
    createHmac('sha256', secret)
      .update(JSON.stringify([tenant, trigger, timestamp]) + '.')
      .update(raw)
      .digest('hex');
  assert.equal(verifyWebhook(secret, tenant, trigger, timestamp, signature, raw, now), true);
  assert.equal(
    verifyWebhook(secret, tenant, trigger, timestamp, signature, raw, now + 5 * minute + 1),
    false,
  );
  assert.equal(verifyWebhook(secret, tenant, 'other', timestamp, signature, raw, now), false);
  assert.equal(
    verifyWebhook(secret, 'tenant-spoolharbour', trigger, timestamp, signature, raw, now),
    false,
  );
  assert.equal(
    verifyWebhook(
      secret,
      tenant,
      trigger,
      timestamp,
      signature,
      Buffer.from(raw.toString().trim() + '\n'),
      now,
    ),
    false,
  );
});
