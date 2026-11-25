import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDemoFixtures, type PurchaseOrder } from '@bs/contracts';
import {
  MemoryRecordRepository,
  PostgresRecordRepository,
  type PostgresExecutor,
} from '../src/persistence/index.ts';

const fixtures = loadDemoFixtures();
const tenantId = 'tenant-rivetquay';
const { id: requestId, version: sourceVersion, ...draftFields } = fixtures.purchaseRequests[0];
const po: PurchaseOrder = {
  id: 'po-fixture-test',
  draft: { id: 'draft-fixture-test', requestId, sourceVersion, ...draftFields },
  approvalId: 'approval-fixture-test',
  status: 'approved',
};

test('memory repository scopes all seed records and inserts a PO once from the current request', async () => {
  const repository = new MemoryRecordRepository(fixtures);
  for (const kind of [
    'orders',
    'customers',
    'invoices',
    'skus',
    'vendors',
    'purchaseRequests',
  ] as const) {
    const seed = fixtures[kind][0];
    assert.deepEqual(await repository.get(kind, seed.tenantId, seed.id), seed);
    assert.equal(await repository.get(kind, 'tenant-spoolharbour', seed.id), undefined);
  }
  const stale = { ...po, draft: { ...po.draft, sourceVersion: sourceVersion + 1 } };
  assert.equal(await repository.createPurchaseOrder(stale), false);
  assert.deepEqual(
    await Promise.all([repository.createPurchaseOrder(po), repository.createPurchaseOrder(po)]),
    [true, false],
  );
  const found = await repository.get('purchaseOrders', tenantId, po.id);
  assert.deepEqual(found, po);
  found.draft.vendorId = 'modified';
  assert.deepEqual(await repository.get('purchaseOrders', tenantId, po.id), po);
  assert.equal(await repository.get('purchaseOrders', 'tenant-spoolharbour', po.id), undefined);
  assert.ok(
    (await repository.listCustomers(tenantId)).every((customer) => customer.tenantId === tenantId),
  );
});

test('Postgres repository uses seeded tables, bound tenant keys and a conditional PO insert', async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const sources = [
    'sales_order',
    'customer',
    'invoice',
    'sku',
    'vendor',
    'purchase_request',
    'purchase_order',
  ];
  const repository = new PostgresRecordRepository({
    async query<Row extends Record<string, unknown>>(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      const rows = sql.startsWith('INSERT') ? [{ id: po.id }] : [];
      return { rows: rows as unknown as Row[] };
    },
  } satisfies PostgresExecutor);
  await repository.initializePurchaseOrders();
  for (const kind of [
    'orders',
    'customers',
    'invoices',
    'skus',
    'vendors',
    'purchaseRequests',
    'purchaseOrders',
  ] as const) {
    assert.equal(await repository.get(kind, tenantId, "missing'"), undefined);
  }
  await repository.listCustomers(tenantId);
  assert.equal(await repository.createPurchaseOrder(po), true);
  assert.match(calls[0].sql, /CREATE TABLE IF NOT EXISTS demo_fixture\.purchase_order/);
  for (const [index, table] of sources.entries()) {
    assert.deepEqual(calls[index + 1], {
      sql: 'SELECT payload FROM demo_fixture.' + table + ' WHERE tenant_id = $1 AND id = $2',
      values: [tenantId, "missing'"],
    });
  }
  assert.deepEqual(calls[8].values, [tenantId]);
  assert.match(
    calls[9].sql,
    /WHERE tenant_id = \$1 AND id = \$4 AND payload = \$5::jsonb FOR SHARE/,
  );
  assert.match(calls[9].sql, /ON CONFLICT \(tenant_id, id\) DO NOTHING RETURNING id/);
  assert.deepEqual(calls[9].values, [
    tenantId,
    po.id,
    JSON.stringify(po),
    requestId,
    JSON.stringify({ ...draftFields, id: requestId, version: sourceVersion }),
  ]);
});
