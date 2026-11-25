import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDemoFixtures, type CompleteLlmRequest } from '@bs/contracts';
import { createFakeProviders } from '@bs/adapters';
import { GovernedGateway } from '../../src/governance/index.ts';
import {
  catalogPriceVersion,
  createPlatformServices,
  fixtureAdmin,
} from '../../src/platform/index.ts';
import type { BillingUsage, OutcomeUsage } from '../../src/platform/billing-usage.ts';

const fixtures = loadDemoFixtures();
const admin = { ...fixtureAdmin, source: 'rest', traceId: 'trace', correlationId: 'corr' } as const;
const tenant = admin.tenantId;
const other = { ...admin, tenantId: 'tenant-spoolharbour' };
const midMonth = '2026-11-16T00:00:00Z';
const nextMonth = '2026-12-01T00:00:00Z';

function setup() {
  let now = midMonth;
  let settlements = 0;
  const services = createPlatformServices({
    now: () => now,
    billing: {
      providerPrices: [
        {
          version: 'p1',
          providerId: 'fixture-premium',
          unit: 'tokens',
          mode: 'premium',
          chargeMode: 'pass_through',
        },
        {
          version: 'p2',
          providerId: 'fixture-premium',
          unit: 'tokens',
          mode: 'premium',
          chargeMode: 'uplift',
          upliftUnitCents: 2,
        },
        {
          version: 'b1',
          providerId: 'fixture-external',
          unit: 'tokens',
          mode: 'byo',
          chargeMode: 'informational',
        },
        {
          version: 'b2',
          providerId: 'fixture-external',
          unit: 'tokens',
          mode: 'byo',
          chargeMode: 'uplift',
          upliftUnitCents: 3,
        },
        {
          version: 'invalid',
          providerId: 'fixture-external',
          unit: 'tokens',
          mode: 'byo',
          chargeMode: 'pass_through',
        },
      ],
      overagePrices: [{ skuId: 'procurement', unit: 'requisitions', unitCents: 3 }],
      settlement: {
        simulate() {
          return { status: 'simulated', reference: 'fixture-settlement-' + ++settlements };
        },
      },
    },
  });
  return {
    ...services,
    setTime(value: string) {
      now = value;
    },
    settlements: () => settlements,
  };
}

test('prorates SKU price and allowance across multiple revisions, then resets the billing window', async () => {
  const { billing, setTime } = setup();
  assert.equal(billing.skus().length, 12);
  assert.equal(
    billing.skus().reduce((total, item) => total + item.monthlyCents, 0),
    460_000,
  );

  const initial = await billing.plan(tenant);
  assert.equal(initial.monthlyCents, 65_000);
  const added = await billing.changePlan(admin, { addOns: ['procurement', 'inbound-voice'] });
  assert.equal(added.monthlyCents, 135_000);
  assert.equal(added.allowances.find(({ skuId }) => skuId === 'inbound-voice')?.included, 30_000);
  assert.deepEqual(
    await billing.changePlan(admin, { addOns: ['inbound-voice', 'procurement'] }),
    added,
  );
  setTime('2026-11-21T00:00:00Z');
  await billing.changePlan(admin, { addOns: ['inbound-voice'] });
  const {
    items: [draft],
  } = await billing.invoices(tenant);
  assert.equal(draft.subtotalCents, 90_000);
  assert.deepEqual(draft.tax, {
    region: 'ON',
    code: 'HST',
    basisPoints: 1300,
    amountCents: 11_700,
  });
  assert.equal(draft.totalCents, 101_700);
  assert.equal(
    (await billing.plan(tenant)).allowances.find(({ skuId }) => skuId === 'procurement')?.included,
    17,
  );
  setTime(nextMonth);
  const renewed = await billing.plan(tenant);
  assert.equal(renewed.windowStart, '2026-12-01T00:00:00.000Z');
  assert.deepEqual(
    renewed.allowances.map(({ included }) => included),
    [1_000_000, 60_000],
  );
  assert.deepEqual((await billing.plan(other.tenantId)).addOns, []);
});

test('rates versioned attempts, keeps vendor BYO spend informational and caps native overages', async () => {
  const { billing } = setup();
  const usage: OutcomeUsage = {
    kind: 'outcome',
    skuId: 'procurement',
    outcomeId: 'requisition-1',
    unit: 'requisitions',
    quantity: 53,
    occurredAt: midMonth,
    priceVersion: catalogPriceVersion,
  };
  await assert.rejects(billing.recordUsage(admin, usage), { code: 'module_disabled' });
  await billing.changePlan(admin, { addOns: ['procurement'], overageLimitCents: 7 });
  const rated = await billing.recordUsage(admin, usage);
  assert.deepEqual(
    await billing.recordUsage(admin, { ...usage, occurredAt: '2026-11-16T00:00:00.000Z' }),
    rated,
  );
  await assert.rejects(billing.recordUsage(admin, { ...usage, quantity: 54 }), {
    code: 'idempotency_conflict',
  });

  const attempt = {
    kind: 'provider',
    skuId: 'platform',
    outcomeId: 'completion-1',
    attemptId: 'attempt-1',
    unit: 'tokens',
    quantity: 5,
    occurredAt: midMonth,
    priceVersion: 'p1',
    mode: 'premium',
    providerId: 'fixture-premium',
    accountRef: 'fixture-account',
    region: 'ca-central-1',
    vendorCostCents: 21,
  } satisfies BillingUsage;
  assert.equal((await billing.recordUsage(admin, attempt))?.amountCents, 21);
  assert.equal(
    (await billing.recordUsage(admin, { ...attempt, attemptId: 'attempt-2', priceVersion: 'p2' }))
      ?.amountCents,
    10,
  );
  const byo = {
    ...attempt,
    mode: 'byo',
    providerId: 'fixture-external',
    priceVersion: 'b1',
  } as const;
  assert.equal((await billing.recordUsage(admin, byo))?.amountCents, 0);
  assert.equal(
    (await billing.recordUsage(admin, { ...byo, attemptId: 'attempt-2', priceVersion: 'b2' }))
      ?.amountCents,
    15,
  );
  await assert.rejects(
    billing.recordUsage(admin, { ...byo, attemptId: 'attempt-3', priceVersion: 'invalid' }),
    { code: 'forbidden' },
  );

  const plan = await billing.plan(tenant);
  assert.deepEqual(
    plan.allowances.find(({ skuId }) => skuId === 'procurement'),
    {
      skuId: 'procurement',
      unit: 'requisitions',
      included: 50,
      used: 53,
      overage: 3,
    },
  );
  assert.equal(plan.allowances.find(({ skuId }) => skuId === 'platform')?.used, 0);
  const {
    items: [invoice],
  } = await billing.invoices(tenant);
  assert.deepEqual(
    invoice.lines.filter(({ kind }) => kind === 'provider').map(({ amountCents }) => amountCents),
    [21, 10, 0, 15],
  );
  assert.equal(invoice.lines.find(({ kind }) => kind === 'overage')?.amountCents, 6);
  assert.equal(invoice.subtotalCents, 80_052);
  assert.equal(invoice.tax.amountCents, 10_407);
});

test('finalization is tenant-scoped and idempotent, and credit notes reverse the pinned invoice amounts', async () => {
  const { billing, setTime, settlements, queries } = setup();
  const {
    items: [{ id }],
  } = await billing.invoices(tenant);
  await assert.rejects(billing.finalize(admin, id), { code: 'forbidden' });
  await assert.rejects(billing.invoice(other.tenantId, id), { code: 'not_found' });
  setTime(nextMonth);
  const [first, replay] = await Promise.all([
    billing.finalize(admin, id),
    billing.finalize(admin, id),
  ]);
  assert.equal(first.status, 'finalized');
  assert.deepEqual(first, replay);
  assert.equal(settlements(), 1);
  assert.deepEqual(await billing.invoice(tenant, id), first);
  await assert.rejects(billing.finalize(other, id), { code: 'not_found' });
  await assert.rejects(
    billing.recordUsage(admin, {
      kind: 'outcome',
      skuId: 'platform',
      outcomeId: 'late',
      unit: 'tokens',
      quantity: 1,
      occurredAt: midMonth,
      priceVersion: catalogPriceVersion,
    }),
    { code: 'idempotency_conflict' },
  );

  const credit = await billing.credit(admin, id, 'dispute-1');
  assert.equal(credit.totalCents, -first.totalCents);
  assert.equal(credit.tax.amountCents, -first.tax.amountCents);
  assert.deepEqual(await billing.credit(admin, id, 'dispute-1'), credit);
  await assert.rejects(billing.credit(admin, id, 'dispute-2'), { code: 'idempotency_conflict' });
  assert.deepEqual((await billing.invoices(tenant)).creditNotes, [credit]);
  assert.deepEqual((await billing.invoices(other.tenantId)).creditNotes, []);
  const audit = await queries.audit(tenant, { tool: 'platform.billing.invoice.finalize' });
  assert.equal(audit.items.length, 1);
});

test('configurable tax and real fixture gateway counters flow into the billing ledger once', async () => {
  const now = () => fixtures.asOf;
  const { billing, gateway } = createPlatformServices({
    now,
    gateway: new GovernedGateway({ now, providers: createFakeProviders() }),
    billing: {
      taxRegion: () => 'fixture-region',
      taxTable: { 'fixture-region': { code: 'FIXTURE', basisPoints: 500 } },
    },
  });
  const operator = fixtures.grants[0];
  const request: CompleteLlmRequest = {
    tool: 'llm.complete',
    envelope: {
      tenantId: operator.tenantId,
      actor: operator.actor,
      source: 'rest',
      version: 'v1',
      traceId: 'one',
      correlationId: 'one',
      idempotencyKey: 'one',
    },
    input: {
      model: 'fixture-model',
      turns: [{ role: 'user', content: 'Fixture prompt' }],
      maxOutputTokens: 24,
      route: { kind: 'native', providerId: 'fixture-native', fixtureMode: true },
    },
  };
  const result = await gateway.call(request);
  assert.equal(result.state, 'ok');
  await gateway.call(request);
  const plan = await billing.plan(tenant);
  assert.equal(plan.allowances[0].used, result.output.inputTokens + result.output.outputTokens);
  const {
    items: [invoice],
  } = await billing.invoices(tenant);
  assert.deepEqual(invoice.tax, {
    region: 'fixture-region',
    code: 'FIXTURE',
    basisPoints: 500,
    amountCents: 3250,
  });
});
