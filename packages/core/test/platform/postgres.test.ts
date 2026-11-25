import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPlatformServices,
  fixtureAdmin,
  PostgresPlatformPersistence,
} from '../../src/platform/index.ts';
import type { QueryPool, TransactionClient } from '../../src/platform/postgres.ts';

class FakePool implements QueryPool {
  readonly calls: string[] = [];
  private committed = new Map<string, unknown>();
  failCollection?: string;

  private execute(rows: Map<string, unknown>, sql: string, values: unknown[] = []) {
    this.calls.push(sql);
    const [tenant, collection, id, body] = values;
    const key = JSON.stringify([tenant, collection, id]);
    if (sql.startsWith('INSERT')) {
      if (collection === this.failCollection) throw new Error('Fixture SQL failure.');
      rows.set(key, JSON.parse(String(body)));
    } else if (sql.startsWith('DELETE')) {
      rows.delete(key);
    } else if (sql.startsWith('SELECT body')) {
      const prefix = JSON.stringify([tenant, collection]).slice(0, -1) + ',';
      const matching =
        id === undefined
          ? [...rows].filter(([key]) => key.startsWith(prefix)).map(([, body]) => body)
          : rows.has(key)
            ? [rows.get(key)]
            : [];
      return { rows: structuredClone(matching.map((body) => ({ body }))) };
    }
    return { rows: [] };
  }

  async query(sql: string, values?: unknown[]) {
    return this.execute(this.committed, sql, values);
  }

  async connect(): Promise<TransactionClient> {
    const pending = structuredClone(this.committed);
    return {
      query: async (sql, values) => {
        if (sql === 'COMMIT') this.committed = pending;
        return this.execute(pending, sql, values);
      },
      release: () => this.calls.push('RELEASE'),
    };
  }
}

test('Postgres repository scopes parameters by tenant and commits or rolls back audit with state', async () => {
  const pool = new FakePool();
  const persistence = new PostgresPlatformPersistence(pool);
  const context = {
    ...fixtureAdmin,
    source: 'rest',
    traceId: 'pg-trace',
    correlationId: 'pg-corr',
  } as const;
  const services = createPlatformServices({
    persistence,
    now: () => '2026-11-25T15:00:00Z',
  });
  const roles = persistence.repository<number>('sample');
  const key = "fixture-'--";
  await roles.put(context.tenantId, key, 1);
  assert.equal(await roles.get(context.tenantId, key), 1);
  assert.equal(await roles.get('tenant-spoolharbour', key), undefined);
  assert.ok(pool.calls.every((sql) => !sql.includes(key)));
  await roles.delete(context.tenantId, key);
  assert.deepEqual(await roles.list(context.tenantId), []);
  await assert.rejects(
    persistence.repository('audit').delete(context.tenantId, key),
    /append-only/,
  );

  pool.calls.length = 0;
  pool.failCollection = 'billing_plans';
  await assert.rejects(
    services.billing.changePlan(context, { addOns: ['erp'] }),
    /Fixture SQL failure/,
  );
  assert.equal(pool.calls[0], 'BEGIN');
  assert.match(pool.calls[1], /pg_advisory_xact_lock/);
  assert.ok(pool.calls.some((sql) => sql.startsWith('INSERT') && !sql.includes('ON CONFLICT')));
  assert.deepEqual(pool.calls.slice(-2), ['ROLLBACK', 'RELEASE']);
  assert.deepEqual((await services.queries.audit(context.tenantId)).items, []);
  assert.deepEqual((await services.billing.plan(context.tenantId)).addOns, []);

  pool.failCollection = undefined;
  await services.billing.changePlan(context, { addOns: ['erp'] });
  assert.deepEqual(pool.calls.slice(-2), ['COMMIT', 'RELEASE']);
  const reopened = createPlatformServices({ persistence, now: () => '2026-11-25T15:01:00Z' });
  assert.deepEqual((await reopened.billing.plan(context.tenantId)).addOns, ['erp']);
  assert.equal(
    (await reopened.queries.audit(context.tenantId)).items[0].tool,
    'platform.billing.plan.change',
  );
  assert.deepEqual((await reopened.queries.audit('tenant-spoolharbour')).items, []);
});
