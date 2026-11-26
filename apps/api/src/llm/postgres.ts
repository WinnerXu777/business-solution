import type { LimitRepository, Reservation } from './metering.ts';

type Query = (
  sql: string,
  values: readonly unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export interface LimitExecutor {
  /** Run on one connection, with app.tenant_id set locally. */
  transaction<T>(tenantId: string, work: (query: Query) => Promise<T>): Promise<T>;
}

const increment = `INSERT INTO runtime.llm_counters (tenant_id, window_start, requests, tokens)
  VALUES ($1, $2, 0, $3)
  ON CONFLICT (tenant_id, window_start)
  DO UPDATE SET tokens = runtime.llm_counters.tokens + EXCLUDED.tokens`;

export class PostgresLimitRepository implements LimitRepository {
  private readonly executor: LimitExecutor;

  constructor(executor: LimitExecutor) {
    this.executor = executor;
  }

  request(tenantId: string, window: number, cap: number) {
    return this.executor.transaction(tenantId, async (query) => {
      const result = await query(
        `INSERT INTO runtime.llm_counters (tenant_id, window_start, requests, tokens)
         VALUES ($1, $2, 1, 0)
         ON CONFLICT (tenant_id, window_start)
         DO UPDATE SET requests = runtime.llm_counters.requests + 1
         WHERE runtime.llm_counters.requests < $3 RETURNING requests`,
        [tenantId, window, cap],
      );
      return result.rows.length > 0;
    });
  }

  reserve(tenantId: string, hold: Reservation, cap: number, now: number) {
    return this.budget(tenantId, async (query) => {
      const blocked = await query(
        'SELECT tenant_id FROM runtime.llm_meter_blocks WHERE tenant_id = $1',
        [tenantId],
      );
      if (blocked.rows.length) return 'blocked' as const;
      const result = await query(
        `SELECT COALESCE((SELECT tokens FROM runtime.llm_counters
                          WHERE tenant_id = $1 AND window_start = $2), 0)
                + COALESCE((SELECT SUM(amount) FROM runtime.llm_reservations
                            WHERE tenant_id = $1 AND window_start <> $2 AND expires_at > $3), 0)
                AS committed`,
        [tenantId, hold.window, now],
      );
      if (Number(result.rows[0].committed) + hold.amount > cap) return 'exhausted' as const;
      await query(increment, [tenantId, hold.window, hold.amount]);
      await query(
        `INSERT INTO runtime.llm_reservations (tenant_id, id, window_start, amount, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, hold.id, hold.window, hold.amount, hold.expiresAt],
      );
      return 'reserved' as const;
    });
  }

  settle(tenantId: string, id: string, window: number, tokens: number) {
    return this.budget(tenantId, async (query) => {
      const { rows } = await query(
        `DELETE FROM runtime.llm_reservations WHERE tenant_id = $1 AND id = $2
         RETURNING window_start, amount`,
        [tenantId, id],
      );
      if (!rows.length) return;
      await query(
        `UPDATE runtime.llm_counters SET tokens = tokens - $3
         WHERE tenant_id = $1 AND window_start = $2`,
        [tenantId, rows[0].window_start, rows[0].amount],
      );
      await query(increment, [tenantId, window, tokens]);
    });
  }

  block(tenantId: string) {
    return this.budget(tenantId, async (query) => {
      await query(
        'INSERT INTO runtime.llm_meter_blocks (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [tenantId],
      );
    });
  }

  private budget<T>(tenantId: string, work: (query: Query) => Promise<T>) {
    return this.executor.transaction(tenantId, async (query) => {
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        JSON.stringify(['runtime-llm-budget', tenantId]),
      ]);
      return work(query);
    });
  }
}
