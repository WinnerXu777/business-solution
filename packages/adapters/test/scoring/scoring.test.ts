import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDemoFixtures } from '@bs/contracts';
import {
  createFixtureScoringAdapter,
  createWorkerScoringAdapter,
} from '../../src/scoring/index.ts';

test('fixture scorer returns wire-compatible results with workspace-scoped evidence and history', async () => {
  const adapter = createFixtureScoringAdapter();
  const fixtures = loadDemoFixtures();
  for (const id of ['ord-003', 'ord-004']) {
    const order = fixtures.orders.find((candidate) => candidate.id === id);
    assert.ok(order);
    const output = await adapter.fraud(order);
    assert.equal(output.orderId, id);
    assert.deepEqual(output.rule.reasons, order.signals);
    assert.notEqual(output.rule.score, output.model.score);
  }

  const customer = fixtures.customers.find((candidate) => candidate.id === 'cust-008');
  assert.ok(customer);
  assert.deepEqual((await adapter.profile(customer)).evidenceIds, ['cust-008', 'ord-008']);
  const foreign = { ...customer, tenantId: 'tenant-spoolharbour' };
  assert.deepEqual((await adapter.profile(foreign)).evidenceIds, ['cust-008']);
  assert.equal((await adapter.profile({ ...customer, outreachAllowed: false })).segment, 'abstain');

  const input = { series: 'weekly_sales', skuId: null, horizonWeeks: 2 } as const;
  assert.equal((await adapter.forecast(input, customer.tenantId)).points.length, 2);
  assert.deepEqual((await adapter.forecast(input)).points, []);
  assert.deepEqual((await adapter.forecast(input, foreign.tenantId)).points, []);
});

test('an unavailable local worker returns a sanitized error', async () => {
  const adapter = createWorkerScoringAdapter({ python: './missing-lane-c-python' });
  await assert.rejects(
    Promise.resolve(adapter.forecast({ series: 'weekly_sales', skuId: null, horizonWeeks: 1 })),
    { message: 'Local scoring worker unavailable.' },
  );
});
