import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Versioned<Row> {
  row: Row;
  version: string;
}

export class RepositoryConflict extends Error {
  readonly code = 'idempotency_conflict';

  constructor() {
    super('Platform record changed concurrently or already exists.');
  }
}

export interface TenantRepository<Row> {
  get(tenantId: string, id: string): Promise<Row | undefined>;
  list(tenantId: string): Promise<Row[]>;
  put(tenantId: string, id: string, row: Row): Promise<void>;
  delete(tenantId: string, id: string): Promise<void>;
}

export interface VersionedTenantRepository<Row> extends TenantRepository<Row> {
  read(tenantId: string, id: string): Promise<Versioned<Row> | undefined>;
  write(tenantId: string, id: string, row: Row, expected: string | null): Promise<void>;
  lock(tenantId: string, id: string, skipLocked?: boolean): Promise<Row | undefined>;
}

export interface PlatformPersistence {
  repository<Row>(collection: string): VersionedTenantRepository<Row>;
  transaction<Result>(tenantId: string, run: () => Promise<Result>): Promise<Result>;
  claim?<Result>(tenantId: string, run: () => Promise<Result>): Promise<Result>;
}

type Rows = Map<string, Versioned<unknown>>;

export class MemoryTenantRepository<Row> implements VersionedTenantRepository<Row> {
  private readonly collection: string;
  private readonly rows: (tenantId: string) => Rows;

  constructor(collection = '', rows?: (tenantId: string) => Rows) {
    const tenants = new Map<string, Rows>();
    this.collection = collection;
    this.rows =
      rows ??
      ((tenantId) => {
        if (!tenants.has(tenantId)) tenants.set(tenantId, new Map());
        return tenants.get(tenantId)!;
      });
  }

  private key(id: string) {
    return JSON.stringify([this.collection, id]);
  }

  async read(tenantId: string, id: string) {
    return structuredClone(this.rows(tenantId).get(this.key(id))) as Versioned<Row> | undefined;
  }

  async get(tenantId: string, id: string) {
    return (await this.read(tenantId, id))?.row;
  }

  lock(tenantId: string, id: string) {
    return this.get(tenantId, id);
  }

  async list(tenantId: string) {
    const prefix = this.key('').slice(0, -3);
    return structuredClone(
      [...this.rows(tenantId).entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, entry]) => entry.row as Row),
    );
  }

  async write(tenantId: string, id: string, row: Row, expected: string | null) {
    const rows = this.rows(tenantId);
    const key = this.key(id);
    const current = rows.get(key);
    if ((current?.version ?? null) !== expected || (this.collection === 'audit' && current)) {
      throw new RepositoryConflict();
    }
    rows.set(key, { row: structuredClone(row), version: randomUUID() });
  }

  async put(tenantId: string, id: string, row: Row) {
    const current = await this.read(tenantId, id);
    await this.write(tenantId, id, row, current?.version ?? null);
  }

  async delete(tenantId: string, id: string) {
    if (this.collection === 'audit') throw new Error('Platform audit entries are append-only.');
    this.rows(tenantId).delete(this.key(id));
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

export class MemoryPlatformPersistence implements PlatformPersistence {
  private readonly tenants = new Map<string, Rows>();
  private readonly queue = new PlatformQueue();
  private readonly scope = new AsyncLocalStorage<{
    tenantId: string;
    rows: Rows;
    active: boolean;
  }>();

  private rows(tenantId: string) {
    const scope = this.scope.getStore();
    if (!scope) {
      if (!this.tenants.has(tenantId)) this.tenants.set(tenantId, new Map());
      return this.tenants.get(tenantId)!;
    }
    if (!scope.active || scope.tenantId !== tenantId)
      throw new Error('Invalid platform transaction scope.');
    return scope.rows;
  }

  repository<Row>(collection: string) {
    const rows = new MemoryTenantRepository<Row>(collection, (tenantId) => this.rows(tenantId));
    return {
      get: (tenantId, id) => this.transaction(tenantId, () => rows.get(tenantId, id)),
      read: (tenantId, id) => this.transaction(tenantId, () => rows.read(tenantId, id)),
      list: (tenantId) => this.transaction(tenantId, () => rows.list(tenantId)),
      write: (tenantId, id, row, expected) =>
        this.transaction(tenantId, () => rows.write(tenantId, id, row, expected)),
      put: (tenantId, id, row) => this.transaction(tenantId, () => rows.put(tenantId, id, row)),
      delete: (tenantId, id) => this.transaction(tenantId, () => rows.delete(tenantId, id)),
      lock: (tenantId, id) => {
        if (!this.scope.getStore()) throw new Error('Claim requires a platform transaction.');
        return rows.lock(tenantId, id);
      },
    } satisfies VersionedTenantRepository<Row>;
  }

  async transaction<Result>(tenantId: string, run: () => Promise<Result>): Promise<Result> {
    if (this.scope.getStore()) {
      this.rows(tenantId);
      return run();
    }
    return this.queue.run(async () => {
      const scope = { tenantId, rows: structuredClone(this.rows(tenantId)), active: true };
      try {
        const result = await this.scope.run(scope, run);
        this.tenants.set(tenantId, scope.rows);
        return result;
      } finally {
        scope.active = false;
      }
    });
  }
}
