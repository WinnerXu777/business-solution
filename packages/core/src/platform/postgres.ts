import { AsyncLocalStorage } from 'node:async_hooks';
import type { PlatformPersistence, TenantRepository } from './repository.ts';

export interface QueryExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface TransactionClient extends QueryExecutor {
  release(error?: Error): void;
}

export interface QueryPool extends QueryExecutor {
  connect(): Promise<TransactionClient>;
}

/** Collections are bound parameters. A transaction serializes read/modify/write per tenant. */
export class PostgresPlatformPersistence implements PlatformPersistence {
  private readonly pool: QueryPool;
  private readonly scope = new AsyncLocalStorage<{
    tenantId: string;
    client: TransactionClient;
    active: boolean;
  }>();

  constructor(pool: QueryPool) {
    this.pool = pool;
  }

  private executor(tenantId: string) {
    const transaction = this.scope.getStore();
    if (!transaction) return this.pool;
    if (!transaction.active || transaction.tenantId !== tenantId) {
      throw new Error('Invalid platform transaction scope.');
    }
    return transaction.client;
  }

  async transaction<Result>(tenantId: string, run: () => Promise<Result>): Promise<Result> {
    if (this.scope.getStore()) throw new Error('Nested platform transaction.');
    const client = await this.pool.connect();
    const scope = { tenantId, client, active: true };
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        'platform:' + tenantId,
      ]);
      const result = await this.scope.run(scope, run);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        releaseError = new Error('Platform transaction rollback failed.');
      }
      throw error;
    } finally {
      scope.active = false;
      client.release(releaseError);
    }
  }

  repository<Row>(collection: string): TenantRepository<Row> {
    const audit = collection === 'audit';
    return {
      get: async (tenantId, id) => {
        const result = await this.executor(tenantId).query(
          'SELECT body FROM platform.tenant_state WHERE tenant_id = $1 AND collection = $2 AND id = $3',
          [tenantId, collection, id],
        );
        return result.rows[0]?.body as Row | undefined;
      },
      list: async (tenantId) => {
        const result = await this.executor(tenantId).query(
          'SELECT body FROM platform.tenant_state WHERE tenant_id = $1 AND collection = $2 ORDER BY id',
          [tenantId, collection],
        );
        return result.rows.map(({ body }) => body as Row);
      },
      put: async (tenantId, id, row) => {
        await this.executor(tenantId).query(
          'INSERT INTO platform.tenant_state (tenant_id, collection, id, body) VALUES ($1, $2, $3, $4::jsonb)' +
            (audit
              ? ''
              : ' ON CONFLICT (tenant_id, collection, id) DO UPDATE SET body = EXCLUDED.body'),
          [tenantId, collection, id, JSON.stringify(row)],
        );
      },
      delete: async (tenantId, id) => {
        if (audit) throw new Error('Platform audit entries are append-only.');
        await this.executor(tenantId).query(
          'DELETE FROM platform.tenant_state WHERE tenant_id = $1 AND collection = $2 AND id = $3',
          [tenantId, collection, id],
        );
      },
    };
  }
}
