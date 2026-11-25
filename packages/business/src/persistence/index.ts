import { isDeepStrictEqual } from 'node:util';
import {
  loadDemoFixtures,
  type Contact,
  type Customer,
  type Deal,
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
  contacts: Contact;
  deals: Deal;
}

export type RecordKind = keyof Records;

export interface RecordQuery {
  after: string;
  limit: number;
  query?: string;
  customerId?: string;
}

export interface ConnectedRecords {
  contacts(tenantId: string): Contact[];
  deals(tenantId: string): Deal[];
}

export interface RecordRepository {
  get<Kind extends RecordKind>(
    kind: Kind,
    tenantId: string,
    id: string,
  ): Promise<Records[Kind] | undefined>;
  list<Kind extends RecordKind>(
    kind: Kind,
    tenantId: string,
    query: RecordQuery,
  ): Promise<Records[Kind][]>;
  listCustomers(tenantId: string): Promise<Customer[]>;
  // Insert once per tenant and ID if the authoritative purchase request still matches the draft.
  createPurchaseOrder(order: PurchaseOrder): Promise<boolean>;
}

function requestFromOrder({ draft }: PurchaseOrder): PurchaseRequest {
  const { id: _draftId, requestId, sourceVersion, ...fields } = draft;
  return { ...fields, id: requestId, version: sourceVersion };
}

function matching<Row extends Records[RecordKind]>(rows: Row[], query: RecordQuery) {
  return rows
    .filter((row) => {
      if (row.id <= query.after) return false;
      if (query.customerId && (!('customerId' in row) || row.customerId !== query.customerId))
        return false;
      if (!query.query) return true;
      const fields = 'draft' in row ? { ...row.draft, ...row } : row;
      return Object.entries(fields).some(
        ([key, value]) =>
          key !== 'tenantId' &&
          typeof value === 'string' &&
          value.toLowerCase().includes(query.query!),
      );
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .slice(0, query.limit);
}

type NativeKind = Exclude<RecordKind, keyof ConnectedRecords>;

function isNative(kind: RecordKind): kind is NativeKind {
  return kind !== 'contacts' && kind !== 'deals';
}

const dealStages = ['lead', 'qualified', 'proposal', 'won', 'lost'] as const;

function supplementalRecords(
  kind: keyof ConnectedRecords,
  customers: Customer[],
  connected: ConnectedRecords | undefined,
  tenantId: string,
) {
  if (kind === 'contacts') {
    return [
      ...customers.map(({ id, name, email, phone }) => ({
        id: 'contact-' + id,
        customerId: id,
        name: name + ' purchasing',
        email,
        phone,
      })),
      ...(connected?.contacts(tenantId) ?? []),
    ];
  }
  return [
    ...customers.slice(0, dealStages.length).map(({ id, name }, index) => ({
      id: 'deal-' + id,
      customerId: id,
      title: name + ' supply renewal',
      stage: dealStages[index],
      valueCents: 180_000 + 35_000 * index,
    })),
    ...(connected?.deals(tenantId) ?? []),
  ];
}

export class MemoryRecordRepository implements RecordRepository {
  private readonly records: { [Kind in NativeKind]: Records[Kind][] };
  private readonly connected?: ConnectedRecords;

  constructor(fixtures: DemoFixtures = loadDemoFixtures(), connected?: ConnectedRecords) {
    this.connected = connected;
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

  async get<Kind extends RecordKind>(
    kind: Kind,
    tenantId: string,
    id: string,
  ): Promise<Records[Kind] | undefined> {
    if (!isNative(kind)) {
      return (await this.supplemental(kind, tenantId)).find((row) => row.id === id) as
        | Records[Kind]
        | undefined;
    }
    return structuredClone(
      this.records[kind].find(
        (row) => row.id === id && ('draft' in row ? row.draft.tenantId : row.tenantId) === tenantId,
      ),
    ) as Records[Kind] | undefined;
  }

  private async supplemental(kind: keyof ConnectedRecords, tenantId: string) {
    return supplementalRecords(kind, await this.listCustomers(tenantId), this.connected, tenantId);
  }

  async list<Kind extends RecordKind>(kind: Kind, tenantId: string, query: RecordQuery) {
    const rows = isNative(kind)
      ? this.records[kind].filter(
          (row) => ('draft' in row ? row.draft.tenantId : row.tenantId) === tenantId,
        )
      : await this.supplemental(kind, tenantId);
    return structuredClone(matching<Records[RecordKind]>(rows, query)) as Records[Kind][];
  }

  async listCustomers(tenantId: string) {
    return structuredClone(
      this.records.customers
        .filter((customer) => customer.tenantId === tenantId)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
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
} satisfies Record<NativeKind, string>;

export class PostgresRecordRepository implements RecordRepository {
  private readonly db: PostgresExecutor;
  private readonly connected?: ConnectedRecords;

  constructor(db: PostgresExecutor, connected?: ConnectedRecords) {
    this.db = db;
    this.connected = connected;
  }

  /** Run after applying the shared seed SQL in a local demo database. */
  async initializePurchaseOrders() {
    await this.db.query(
      'CREATE TABLE IF NOT EXISTS demo_fixture.purchase_order (' +
        'tenant_id text NOT NULL, id text NOT NULL, payload jsonb NOT NULL, ' +
        'PRIMARY KEY (tenant_id, id))',
    );
  }

  async get<Kind extends RecordKind>(
    kind: Kind,
    tenantId: string,
    id: string,
  ): Promise<Records[Kind] | undefined> {
    if (!isNative(kind)) {
      return (await this.supplemental(kind, tenantId)).find((row) => row.id === id) as
        | Records[Kind]
        | undefined;
    }
    const { rows } = await this.db.query<{ payload: Records[Kind] }>(
      'SELECT payload FROM demo_fixture.' + tables[kind] + ' WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return rows[0]?.payload;
  }

  private async supplemental(kind: keyof ConnectedRecords, tenantId: string) {
    return supplementalRecords(kind, await this.listCustomers(tenantId), this.connected, tenantId);
  }

  async list<Kind extends RecordKind>(kind: Kind, tenantId: string, query: RecordQuery) {
    if (!isNative(kind)) {
      return matching<Records[RecordKind]>(
        await this.supplemental(kind, tenantId),
        query,
      ) as Records[Kind][];
    }
    const fields = kind === 'purchaseOrders' ? "(payload->'draft') || payload" : 'payload';
    const { rows } = await this.db.query<{ payload: Records[Kind] }>(
      'SELECT payload FROM demo_fixture.' +
        tables[kind] +
        ' WHERE tenant_id = $1 AND id COLLATE "C" > $2 ' +
        "AND ($3::text IS NULL OR payload->>'customerId' = $3) " +
        'AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM jsonb_each(' +
        fields +
        ") AS field(k, v) WHERE k <> 'tenantId' AND jsonb_typeof(v) = 'string' " +
        'AND strpos(lower(v #>> \'{}\'), $4) > 0)) ORDER BY id COLLATE "C" LIMIT $5',
      [tenantId, query.after, query.customerId ?? null, query.query ?? null, query.limit],
    );
    return rows.map(({ payload }) => payload);
  }

  async listCustomers(tenantId: string) {
    const { rows } = await this.db.query<{ payload: Customer }>(
      'SELECT payload FROM demo_fixture.customer WHERE tenant_id = $1 ORDER BY id COLLATE "C"',
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
