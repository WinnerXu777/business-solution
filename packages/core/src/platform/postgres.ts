import { AsyncLocalStorage } from 'node:async_hooks';
import {
  RepositoryConflict,
  type PlatformPersistence,
  type VersionedTenantRepository,
} from './repository.ts';

export interface QueryExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface TransactionClient extends QueryExecutor {
  release(error?: Error): void;
}

export interface QueryPool extends QueryExecutor {
  connect(): Promise<TransactionClient>;
}

interface Scope {
  tenantId: string;
  client: TransactionClient;
  active: boolean;
  versions: Map<string, string | null>;
}

export class PostgresPlatformPersistence implements PlatformPersistence {
  private readonly scope = new AsyncLocalStorage<Scope>();

  private readonly pool: QueryPool;

  constructor(pool: QueryPool) {
    this.pool = pool;
  }

  private current(tenantId: string) {
    const scope = this.scope.getStore();
    if (scope && (!scope.active || scope.tenantId !== tenantId)) {
      throw new Error('Invalid platform transaction scope.');
    }
    return scope;
  }

  async transaction<Result>(tenantId: string, run: () => Promise<Result>): Promise<Result> {
    return this.scoped(tenantId, true, run);
  }

  private async scoped<Result>(tenantId: string, serialize: boolean, run: () => Promise<Result>) {
    if (this.current(tenantId)) return run();
    if (!tenantId) throw new Error('Platform tenant is required.');
    const client = await this.pool.connect();
    const scope = { tenantId, client, active: true, versions: new Map<string, string | null>() };
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE platform_app');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      if (serialize) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          'platform:' + tenantId,
        ]);
      }
      const result = await this.scope.run(scope, run);
      scope.active = false;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      scope.active = false;
      try {
        await client.query('ROLLBACK');
      } catch {
        releaseError = new Error('Platform transaction rollback failed.');
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  private query<Result>(tenantId: string, run: (scope: Scope) => Promise<Result>) {
    return this.scoped(tenantId, false, () => run(this.current(tenantId)!));
  }

  repository<Row>(collection: string): VersionedTenantRepository<Row> {
    const key = (id: string) => JSON.stringify([collection, id]);
    const audit = collection === 'audit';
    const select =
      'SELECT id, body, version::text FROM platform.tenant_state WHERE tenant_id = $1 AND collection = $2';
    const read = (tenantId: string, id: string, lock?: 'wait' | 'skip') =>
      this.query(tenantId, async ({ client, versions }) => {
        const {
          rows: [entry],
        } = await client.query(
          select +
            ' AND id = $3' +
            (lock === 'skip' ? ' FOR UPDATE SKIP LOCKED' : lock === 'wait' ? ' FOR UPDATE' : ''),
          [tenantId, collection, id],
        );
        if (entry || !lock) versions.set(key(id), (entry?.version as string | undefined) ?? null);
        return entry && { row: entry.body as Row, version: entry.version as string };
      });

    const write = (tenantId: string, id: string, row: Row, expected: string | null) =>
      this.query(tenantId, async ({ client, versions }) => {
        if (audit && expected !== null) throw new RepositoryConflict();
        const values = [tenantId, collection, id, JSON.stringify(row)];
        const result =
          expected === null
            ? await client.query(
                'INSERT INTO platform.tenant_state (tenant_id, collection, id, body) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING RETURNING version::text',
                values,
              )
            : await client.query(
                "UPDATE platform.tenant_state SET body = $4::jsonb, version = nextval('platform.tenant_state_version') WHERE tenant_id = $1 AND collection = $2 AND id = $3 AND version = $5::bigint RETURNING version::text",
                [...values, expected],
              );
        if (!result.rows.length) throw new RepositoryConflict();
        versions.set(key(id), result.rows[0].version as string);
      });

    return {
      read,
      write,
      get: async (tenantId, id) => (await read(tenantId, id))?.row,
      lock: async (tenantId, id, skipLocked = true) => {
        if (!this.current(tenantId)) throw new Error('Claim requires a platform transaction.');
        return (await read(tenantId, id, skipLocked ? 'skip' : 'wait'))?.row;
      },
      list: (tenantId) =>
        this.query(tenantId, async ({ client, versions }) => {
          const { rows } = await client.query(select + ' ORDER BY id COLLATE "C"', [
            tenantId,
            collection,
          ]);
          return rows.map(({ id, body, version }) => {
            versions.set(key(id as string), version as string);
            return body as Row;
          });
        }),
      put: (tenantId, id, row) =>
        this.query(tenantId, async ({ versions }) => {
          if (!versions.has(key(id))) await read(tenantId, id);
          await write(tenantId, id, row, versions.get(key(id))!);
        }),
      delete: (tenantId, id) =>
        this.query(tenantId, async ({ client, versions }) => {
          if (audit) throw new Error('Platform audit entries are append-only.');
          if (!versions.has(key(id))) await read(tenantId, id);
          const expected = versions.get(key(id));
          if (expected === null) return;
          const result = await client.query(
            'DELETE FROM platform.tenant_state WHERE tenant_id = $1 AND collection = $2 AND id = $3 AND version = $4::bigint RETURNING id',
            [tenantId, collection, id, expected],
          );
          if (!result.rows.length) throw new RepositoryConflict();
          versions.set(key(id), null);
        }),
    };
  }

  /** Unlike business mutations, a claim must be able to skip a locked event row. */
  claim<Result>(tenantId: string, run: () => Promise<Result>) {
    return this.scoped(tenantId, false, run);
  }
}
