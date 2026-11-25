import { loadDemoFixtures, type DemoFixtures } from '@bs/contracts';

export {
  MemoryRecordRepository,
  PostgresRecordRepository,
  type RecordRepository,
} from './persistence/index.ts';

function byId<Record extends { tenantId: string; id: string }>(
  rows: Record[],
  tenantId: string,
  id: string,
): Record | undefined {
  return rows.find((row) => row.tenantId === tenantId && row.id === id);
}

export function createFixtureRecords(fixtures: DemoFixtures = loadDemoFixtures()) {
  const records = structuredClone(fixtures);
  return {
    order: (tenantId: string, id: string) => byId(records.orders, tenantId, id),
    customer: (tenantId: string, id: string) => byId(records.customers, tenantId, id),
    invoice: (tenantId: string, id: string) => byId(records.invoices, tenantId, id),
    sku: (tenantId: string, id: string) => byId(records.skus, tenantId, id),
    purchaseRequest: (tenantId: string, id: string) => byId(records.purchaseRequests, tenantId, id),
    customers: (tenantId: string) => records.customers.filter((row) => row.tenantId === tenantId),
  };
}
