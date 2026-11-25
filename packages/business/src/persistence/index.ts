import { isDeepStrictEqual } from 'node:util';
import {
  loadDemoFixtures,
  type Customer,
  type DemoFixtures,
  type Invoice,
  type Order,
  type PurchaseOrder,
  type PurchaseRequest,
  type Sku,
  type Vendor,
} from '@bs/contracts';

interface Records {
  orders: Order;
  customers: Customer;
  invoices: Invoice;
  skus: Sku;
  vendors: Vendor;
  purchaseRequests: PurchaseRequest;
  purchaseOrders: PurchaseOrder;
}

export type RecordKind = keyof Records;

export interface RecordRepository {
  get<Kind extends RecordKind>(
    kind: Kind,
    tenantId: string,
    id: string,
  ): Promise<Records[Kind] | undefined>;
  listCustomers(tenantId: string): Promise<Customer[]>;
  // Insert once per tenant and ID if the authoritative purchase request still matches the draft.
  createPurchaseOrder(order: PurchaseOrder): Promise<boolean>;
}

function requestFromOrder({ draft }: PurchaseOrder): PurchaseRequest {
  const { id: _draftId, requestId, sourceVersion, ...fields } = draft;
  return { ...fields, id: requestId, version: sourceVersion };
}

export class MemoryRecordRepository implements RecordRepository {
  private readonly records: { [Kind in RecordKind]: Records[Kind][] };

  constructor(fixtures: DemoFixtures = loadDemoFixtures()) {
    const { orders, customers, invoices, skus, vendors, purchaseRequests } =
      structuredClone(fixtures);
    this.records = {
      orders,
      customers,
      invoices,
      skus,
      vendors,
      purchaseRequests,
      purchaseOrders: [],
    };
  }

  async get<Kind extends RecordKind>(kind: Kind, tenantId: string, id: string) {
    return structuredClone(
      this.records[kind].find(
        (row) => row.id === id && ('draft' in row ? row.draft.tenantId : row.tenantId) === tenantId,
      ),
    );
  }

  async listCustomers(tenantId: string) {
    return structuredClone(
      this.records.customers.filter((customer) => customer.tenantId === tenantId),
    );
  }

  async createPurchaseOrder(order: PurchaseOrder) {
    const expected = requestFromOrder(order);
    const current = this.records.purchaseRequests.find(
      (row) => row.tenantId === expected.tenantId && row.id === expected.id,
    );
    if (!isDeepStrictEqual(current, expected)) return false;
    if (
      this.records.purchaseOrders.some(
        (row) => row.id === order.id && row.draft.tenantId === order.draft.tenantId,
      )
    )
      return false;
    this.records.purchaseOrders.push(structuredClone(order));
    return true;
  }
}

// Compatible with a PostgreSQL pool or client. The caller owns the connection lifecycle.
export interface PostgresExecutor {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

const tables = {
  orders: 'sales_order',
  customers: 'customer',
  invoices: 'invoice',
  skus: 'sku',
  vendors: 'vendor',
  purchaseRequests: 'purchase_request',
  purchaseOrders: 'purchase_order',
} satisfies Record<RecordKind, string>;

export class PostgresRecordRepository implements RecordRepository {
  private readonly db: PostgresExecutor;

  constructor(db: PostgresExecutor) {
    this.db = db;
  }

  /** Run after applying the shared seed SQL in a local demo database. */
  async initializePurchaseOrders() {
    await this.db.query(
      'CREATE TABLE IF NOT EXISTS demo_fixture.purchase_order (' +
        'tenant_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, ' +
        'PRIMARY KEY (tenant_id, id))',
    );
  }

  async get<Kind extends RecordKind>(kind: Kind, tenantId: string, id: string) {
    const { rows } = await this.db.query<{ payload: Records[Kind] }>(
      'SELECT payload FROM demo_fixture.' + tables[kind] + ' WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return rows[0]?.payload;
  }

  async listCustomers(tenantId: string) {
    const { rows } = await this.db.query<{ payload: Customer }>(
      'SELECT payload FROM demo_fixture.customer WHERE tenant_id = $1 ORDER BY id',
      [tenantId],
    );
    return rows.map((row) => row.payload);
  }

  async createPurchaseOrder(order: PurchaseOrder) {
    const expected = requestFromOrder(order);
    const { rows } = await this.db.query<{ id: string }>(
      'INSERT INTO demo_fixture.purchase_order (tenant_id, id, payload) ' +
        'SELECT $1, $2, $3::jsonb FROM demo_fixture.purchase_request ' +
        'WHERE tenant_id = $1 AND id = $4 AND payload = $5::jsonb FOR SHARE ' +
        'ON CONFLICT (tenant_id, id) DO NOTHING RETURNING id',
      [expected.tenantId, order.id, JSON.stringify(order), expected.id, JSON.stringify(expected)],
    );
    return rows.length === 1;
  }
}
