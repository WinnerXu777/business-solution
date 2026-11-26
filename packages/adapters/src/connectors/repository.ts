import { keyOf, SerialQueue, type BindingRef } from './sdk.ts';

export type ConnectorCollection = 'installation' | 'sync' | 'webhook' | 'writes';

export interface ConnectorRepository {
  get<T>(tenantId: string, collection: ConnectorCollection, id: string): T | undefined;
  list<T>(tenantId: string, collection: ConnectorCollection): T[];
  put<T>(tenantId: string, collection: ConnectorCollection, id: string, value: T): void;
  resolveConnection(connectionId: string): BindingRef | undefined;
  lease<T>(tenantId: string, key: string, work: () => Promise<T>): Promise<T>;
}

export class MemoryConnectorRepository implements ConnectorRepository {
  private readonly state = new Map<string, Map<ConnectorCollection, Map<string, unknown>>>();
  private readonly queue = new SerialQueue();

  get<T>(tenantId: string, collection: ConnectorCollection, id: string) {
    return structuredClone(this.state.get(tenantId)?.get(collection)?.get(id)) as T | undefined;
  }

  list<T>(tenantId: string, collection: ConnectorCollection) {
    return structuredClone([...(this.state.get(tenantId)?.get(collection)?.values() ?? [])]) as T[];
  }

  put<T>(tenantId: string, collection: ConnectorCollection, id: string, value: T) {
    const tenant = this.state.get(tenantId) ?? new Map();
    const records = tenant.get(collection) ?? new Map();
    records.set(id, structuredClone(value));
    tenant.set(collection, records);
    this.state.set(tenantId, tenant);
  }

  resolveConnection(connectionId: string) {
    for (const [tenantId, tenant] of this.state) {
      if (tenant.get('installation')?.has(connectionId)) return { tenantId, connectionId };
    }
  }

  lease<T>(tenantId: string, key: string, work: () => Promise<T>) {
    return this.queue.run(keyOf(tenantId, key), work);
  }
}

export interface ConnectorExecutor {
  /** Execute a statement in a transaction with app.tenant_id set locally. */
  query(
    tenantId: string,
    sql: string,
    values: readonly unknown[],
  ): {
    rows: Record<string, unknown>[];
  };
  /** Hold a session lease across independently committed statements. */
  lease<T>(tenantId: string, key: string, work: () => Promise<T>): Promise<T>;
}

export class PostgresConnectorRepository implements ConnectorRepository {
  private readonly executor: ConnectorExecutor;
  private readonly tenants: () => Iterable<string>;

  constructor(executor: ConnectorExecutor, tenants: () => Iterable<string>) {
    this.executor = executor;
    this.tenants = tenants;
  }

  get<T>(tenantId: string, collection: ConnectorCollection, id: string) {
    return this.executor.query(
      tenantId,
      'SELECT body FROM runtime.connector_state WHERE tenant_id = $1 AND collection = $2 AND id = $3',
      [tenantId, collection, id],
    ).rows[0]?.body as T | undefined;
  }

  list<T>(tenantId: string, collection: ConnectorCollection) {
    return this.executor
      .query(
        tenantId,
        'SELECT body FROM runtime.connector_state WHERE tenant_id = $1 AND collection = $2 ORDER BY id',
        [tenantId, collection],
      )
      .rows.map(({ body }) => body as T);
  }

  put<T>(tenantId: string, collection: ConnectorCollection, id: string, value: T) {
    this.executor.query(
      tenantId,
      `INSERT INTO runtime.connector_state (tenant_id, collection, id, body) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (tenant_id, collection, id) DO UPDATE SET body = EXCLUDED.body`,
      [tenantId, collection, id, JSON.stringify(value)],
    );
  }

  resolveConnection(connectionId: string) {
    // The host supplies the configured tenants for provider ingress without a user identity.
    for (const tenantId of this.tenants()) {
      if (this.get(tenantId, 'installation', connectionId)) return { tenantId, connectionId };
    }
  }

  lease<T>(tenantId: string, key: string, work: () => Promise<T>) {
    return this.executor.lease(tenantId, keyOf('connectors', key), work);
  }
}
