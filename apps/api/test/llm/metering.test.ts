import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MemoryLimitRepository,
  type LimitRepository,
  type Reservation,
} from '../../src/llm/metering.ts';
import { PostgresLimitRepository, type LimitExecutor } from '../../src/llm/postgres.ts';

class FakeLimitExecutor implements LimitExecutor {
  private counters = new Map<string, { requests: number; tokens: number }>();
  private holds = new Map<string, { window: number; amount: number; expires: number }>();
  private blocks = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();

  async transaction<T>(
    tenantId: string,
    work: Parameters<LimitExecutor['transaction']>[1],
  ): Promise<T> {
    const next = this.tail.then(() =>
      work(async (sql, values) => {
        if (sql.includes('pg_advisory')) return { rows: [] };
        assert.equal(values[0], tenantId);
        const key = JSON.stringify([tenantId, values[1]]);
        if (sql.includes('SELECT tenant_id FROM runtime.llm_meter_blocks')) {
          return { rows: this.blocks.has(tenantId) ? [{ tenant_id: tenantId }] : [] };
        }
        if (sql.includes('INSERT INTO runtime.llm_meter_blocks')) {
          this.blocks.add(tenantId);
          return { rows: [] };
        }
        if (sql.includes('SELECT COALESCE')) {
          const counter = this.counters.get(key);
          const outstanding = [...this.holds]
            .filter(
              ([holdKey, hold]) =>
                JSON.parse(holdKey)[0] === tenantId &&
                hold.window !== values[1] &&
                hold.expires > Number(values[2]),
            )
            .reduce((total, [, hold]) => total + hold.amount, 0);
          return { rows: [{ committed: (counter?.tokens ?? 0) + outstanding }] };
        }
        if (sql.includes('DELETE FROM runtime.llm_reservations')) {
          const hold = this.holds.get(key);
          this.holds.delete(key);
          return { rows: hold ? [{ window_start: hold.window, amount: hold.amount }] : [] };
        }
        if (sql.includes('INSERT INTO runtime.llm_reservations')) {
          this.holds.set(key, {
            window: Number(values[2]),
            amount: Number(values[3]),
            expires: Number(values[4]),
          });
          return { rows: [] };
        }
        const counter = this.counters.get(key) ?? { requests: 0, tokens: 0 };
        if (sql.includes('RETURNING requests')) {
          if (counter.requests >= Number(values[2])) return { rows: [] };
          counter.requests++;
        } else if (sql.includes('SET tokens = tokens -')) {
          counter.tokens -= Number(values[2]);
        } else if (sql.includes('INSERT INTO runtime.llm_counters')) {
          counter.tokens += Number(values[2]);
        } else {
          throw new Error('Unexpected query');
        }
        this.counters.set(key, counter);
        return { rows: [{ requests: counter.requests }] };
      }),
    ) as Promise<T>;
    this.tail = next.catch(() => undefined);
    return next;
  }
}

for (const kind of ['memory', 'postgres']) {
  test(`${kind} limit counters preserve reservations and caps across recreation`, async () => {
    const memory = new MemoryLimitRepository();
    const sql = new FakeLimitExecutor();
    const make = (): LimitRepository =>
      kind === 'memory' ? memory : new PostgresLimitRepository(sql);
    const first = make();
    assert.equal(await first.request('fictional-a', 100, 2), true);
    assert.equal(await make().request('fictional-a', 100, 2), true);
    assert.equal(await make().request('fictional-a', 100, 2), false);
    assert.equal(await make().request('fictional-b', 100, 2), true);
    const hold: Reservation = { id: 'attempt-1', amount: 7, window: 100, expiresAt: 300 };
    assert.equal(await first.reserve('fictional-a', hold, 10, 110), 'reserved');
    const second = { id: 'attempt-2', amount: 4, window: 200, expiresAt: 400 };
    assert.equal(await make().reserve('fictional-a', second, 10, 210), 'exhausted');
    await make().settle('fictional-a', hold.id, 200, 3);
    assert.equal(await make().reserve('fictional-a', second, 10, 210), 'reserved');
    assert.equal(await make().reserve('fictional-b', second, 10, 210), 'reserved');
    await make().block('fictional-a');
    assert.equal(
      await make().reserve('fictional-a', { ...second, id: 'attempt-3' }, 10, 210),
      'blocked',
    );
  });
}
