export interface TenantRepository<Row> {
  get(tenantId: string, id: string): Promise<Row | undefined>;
  list(tenantId: string): Promise<Row[]>;
  put(tenantId: string, id: string, row: Row): Promise<void>;
  delete(tenantId: string, id: string): Promise<void>;
}

export class MemoryTenantRepository<Row> implements TenantRepository<Row> {
  private readonly tenants = new Map<string, Map<string, Row>>();

  async get(tenantId: string, id: string) {
    return structuredClone(this.tenants.get(tenantId)?.get(id));
  }

  async list(tenantId: string) {
    return structuredClone([...(this.tenants.get(tenantId)?.values() ?? [])]);
  }

  async put(tenantId: string, id: string, row: Row) {
    const rows = this.tenants.get(tenantId) ?? new Map<string, Row>();
    rows.set(id, structuredClone(row));
    this.tenants.set(tenantId, rows);
  }

  async delete(tenantId: string, id: string) {
    this.tenants.get(tenantId)?.delete(id);
  }
}

export class PlatformQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<Result>(operation: () => Promise<Result>) {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
