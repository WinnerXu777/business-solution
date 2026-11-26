import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPlatformServices,
  fixtureAdmin,
  MemoryPlatformPersistence,
  PlatformSessions,
  PostgresPlatformPersistence,
  RepositoryConflict,
  type PlatformPersistence,
} from '../../src/platform/index.ts';
import type { QueryPool, TransactionClient } from '../../src/platform/postgres.ts';

type Row = { id: string; body: unknown; version: string };

class FakePool implements QueryPool {
  readonly calls: string[] = [];
  private committed = new Map<string, Row>();
  private version = 0;
  failCollection?: string;
  conflictCollection?: string;
  skipClaims = false;

  async query(): Promise<never> {
    throw new Error('All queries must use a checked-out, tenant-scoped client.');
  }

  async connect(): Promise<TransactionClient> {
    const pending = structuredClone(this.committed);
    let scopedTenant: unknown;
    let roleSet = false;
    let started = false;
    let dirty = false;
    return {
      query: async (sql, values = []) => {
        this.calls.push(sql);
        const [tenant, collection, id, body, expected] = values;
        const key = JSON.stringify([tenant, collection, id]);
        const prefix = JSON.stringify([tenant, collection]).slice(0, -1) + ',';
        const current = pending.get(key);
        if (sql === 'BEGIN') started = true;
        else if (sql === 'SET LOCAL ROLE platform_app') {
          assert.ok(started);
          roleSet = true;
        } else if (sql.includes('set_config')) {
          assert.ok(roleSet);
          scopedTenant = tenant;
        } else if (sql === 'COMMIT') {
          if (dirty) this.committed = pending;
        } else if (sql !== 'ROLLBACK' && !sql.includes('pg_advisory_xact_lock')) {
          assert.equal(tenant, scopedTenant);
          assert.ok(roleSet && scopedTenant);
          if (sql.startsWith('SELECT id, body')) {
            if (sql.endsWith('FOR UPDATE SKIP LOCKED') && this.skipClaims) return { rows: [] };
            const rows =
              id === undefined
                ? [...pending.entries()]
                    .filter(([key]) => key.startsWith(prefix))
                    .map(([, entry]) => entry)
                : current
                  ? [current]
                  : [];
            return {
              rows: structuredClone(rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))),
            };
          }
          if (collection === this.failCollection) throw new Error('Fixture SQL failure.');
          if (sql.startsWith('DELETE')) {
            if (!current || current.version !== body) return { rows: [] };
            dirty = true;
            pending.delete(key);
            return { rows: [{ id }] };
          }
          assert.ok(sql.startsWith('INSERT') || sql.startsWith('UPDATE'));
          if (
            collection === this.conflictCollection ||
            (sql.startsWith('INSERT') ? current : current?.version !== expected)
          )
            return { rows: [] };
          const version = String(++this.version);
          pending.set(key, { id: String(id), version, body: JSON.parse(String(body)) });
          dirty = true;
          return { rows: [{ version }] };
        }
        return { rows: [] };
      },
      release: () => this.calls.push('RELEASE'),
    };
  }
}

const context = {
  ...fixtureAdmin,
  source: 'rest',
  traceId: 'pg-trace',
  correlationId: 'pg-corr',
} as const;
const now = () => '2026-11-25T15:00:00Z';
const tenant = context.tenantId;
const other = 'tenant-spoolharbour';

function repositoryContract(name: string, make: () => PlatformPersistence) {
  test(name + ' repository contract covers tenant keys, versions and atomic rollback', async () => {
    const store = make();
    const key = "fixture-'--";
    const collections = [
      'tenants',
      'workspaces',
      'users',
      'memberships',
      'roles',
      'invites',
      'oidc_subjects',
      'session_revocations',
      'refresh_families',
      'refresh_tokens',
      'connections',
      'bindings',
      'credential_keys',
      'credentials',
      'entitlements',
      'billing_plans',
      'billing_usage',
      'billing_invoices',
      'billing_credits',
      'consents',
      'suppressions',
      'contact_attempts',
      'privacy_requests',
      'retention_policies',
      'retention_holds',
      'platform_events',
      'webhooks',
      'webhook_deliveries',
      'notifications',
    ];
    for (const collection of collections) {
      const rows = store.repository<{ value: number }>(collection);
      await rows.write(tenant, key, { value: 1 }, null);
      await assert.rejects(rows.write(tenant, key, { value: 3 }, null), RepositoryConflict);
      assert.equal(await rows.get(other, key), undefined);
      await rows.put(other, key, { value: 2 });
      assert.deepEqual(await rows.list(other), [{ value: 2 }]);
      const first = (await rows.read(tenant, key))!;
      first.row.value = 9;
      assert.deepEqual(await rows.get(tenant, key), { value: 1 });
      await rows.write(tenant, key, { value: 3 }, first.version);
      await assert.rejects(
        rows.write(tenant, key, { value: 4 }, first.version),
        RepositoryConflict,
      );
      await rows.delete(tenant, key);
      await rows.write(tenant, key, { value: 5 }, null);
      await assert.rejects(
        rows.write(tenant, key, { value: 4 }, first.version),
        RepositoryConflict,
      );
      assert.deepEqual(await rows.list(tenant), [{ value: 5 }]);
    }
    const audit = store.repository('audit');
    const invites = store.repository('invites');
    await assert.rejects(
      store.transaction(tenant, async () => {
        await audit.put(tenant, 'audit-1', {});
        await store.transaction(tenant, () => invites.put(tenant, 'invite-1', {}));
        await invites.get(other, 'invite-1');
      }),
      /scope/,
    );
    assert.equal(await audit.get(tenant, 'audit-1'), undefined);
    assert.equal(await invites.get(tenant, 'invite-1'), undefined);
    await audit.put(tenant, 'audit-1', { sample: true });
    await assert.rejects(audit.put(tenant, 'audit-1', {}), RepositoryConflict);
    await assert.rejects(audit.delete(tenant, 'audit-1'), /append-only/);
  });
}

repositoryContract('Memory', () => new MemoryPlatformPersistence());
repositoryContract('Postgres', () => new PostgresPlatformPersistence(new FakePool()));

test('Postgres rolls back state and audit together on SQL errors and optimistic conflicts', async () => {
  const pool = new FakePool();
  const persistence = new PostgresPlatformPersistence(pool);
  const services = createPlatformServices({ persistence, now });
  pool.failCollection = 'billing_plans';
  await assert.rejects(
    services.billing.changePlan(context, { addOns: ['erp'] }),
    /Fixture SQL failure/,
  );
  assert.deepEqual(pool.calls.slice(0, 3), [
    'BEGIN',
    'SET LOCAL ROLE platform_app',
    "SELECT set_config('app.tenant_id', $1, true)",
  ]);
  assert.match(pool.calls[3], /pg_advisory_xact_lock/);
  assert.deepEqual(pool.calls.slice(-2), ['ROLLBACK', 'RELEASE']);
  assert.deepEqual((await services.queries.audit(tenant)).items, []);
  assert.deepEqual((await services.billing.plan(tenant)).addOns, []);

  pool.failCollection = undefined;
  await services.billing.changePlan(context, { addOns: ['erp'] });
  assert.deepEqual(pool.calls.slice(-2), ['COMMIT', 'RELEASE']);
  pool.conflictCollection = 'billing_plans';
  await assert.rejects(services.billing.changePlan(context, { addOns: [] }), RepositoryConflict);
  assert.deepEqual(pool.calls.slice(-2), ['ROLLBACK', 'RELEASE']);
  const reopened = createPlatformServices({
    persistence: new PostgresPlatformPersistence(pool),
    now,
  });
  assert.deepEqual((await reopened.billing.plan(tenant)).addOns, ['erp']);
  assert.deepEqual(
    (await reopened.queries.audit(tenant)).items.map(({ tool }) => tool),
    ['platform.billing.plan.change'],
  );
  assert.deepEqual((await reopened.queries.audit(other)).items, []);
});

test('Postgres reopens identity and rotated sessions, and claims webhook rows with SKIP LOCKED', async () => {
  const pool = new FakePool();
  let dispatched = 0;
  const open = () =>
    createPlatformServices({
      persistence: new PostgresPlatformPersistence(pool),
      now,
      vaultMasterKey: Buffer.alloc(32, 5),
      webhookTransport: async () => {
        dispatched++;
        return { status: 200 };
      },
    });
  const options = { now: () => Date.parse(now()), signingKey: Buffer.alloc(32, 7) };
  const first = open();
  const { tenant: provisioned, adminInvite } = await first.directory.provision({
    name: 'Synthetic tenant',
    region: 'ca-central-1',
    plan: { addOns: ['erp'] },
    adminEmail: 'synthetic@tenant.example',
  });
  const second = open();
  const principal = {
    issuer: 'https://issuer.example',
    subject: 'synthetic',
    verifiedEmail: 'synthetic@tenant.example',
  };
  const member = await second.directory.acceptInvite(provisioned.id, adminInvite.token, principal);
  const identity = { tenantId: provisioned.id, actor: member.user.actor };
  await assert.rejects(first.directory.acceptInvite(provisioned.id, adminInvite.token, principal), {
    code: 'not_found',
  });
  const sessions = new PlatformSessions(second.directory, options);
  const original = await sessions.issue(identity, { platformOperator: false });
  const reopened = new PlatformSessions(first.directory, options);
  assert.deepEqual((await reopened.verify(original.accessToken))?.identity, identity);
  const rotated = await reopened.refresh(original.refreshToken);
  await assert.rejects(sessions.refresh(original.refreshToken), { code: 'forbidden' });
  assert.equal(await sessions.logout(rotated.refreshToken), true);
  assert.equal(await reopened.verify(original.accessToken), undefined);

  const hook = await first.events.createWebhook(context, {
    url: 'https://hooks.example/demo',
    events: ['record.changed'],
  });
  await first.events.publish(
    tenant,
    {
      id: 'synthetic-event',
      type: 'record.changed',
      occurredAt: now(),
      data: { recordType: 'order', recordId: 'synthetic-order', change: 'created' },
    },
    [context.actor.id],
  );
  pool.skipClaims = true;
  assert.equal(await second.events.deliverDue(tenant), 0);
  assert.equal(dispatched, 0);
  assert.ok(pool.calls.some((sql) => sql.endsWith('FOR UPDATE SKIP LOCKED')));
  pool.skipClaims = false;
  assert.equal(await second.events.deliverDue(tenant), 1);
  assert.equal(dispatched, 1);
  assert.equal((await first.events.deliveries(tenant, hook.id))[0].status, 'delivered');
  await second.events.markRead(context, 'synthetic-event');
  assert.equal((await open().events.notifications(tenant, context.actor.id))[0].readAt, now());
});
