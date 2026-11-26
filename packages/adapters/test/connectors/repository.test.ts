import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConnectorLifecycle,
  ConnectorSync,
  ConnectorWrites,
  MemoryConnectorRepository,
  MemoryCredentialStore,
  PostgresConnectorRepository,
  WebhookIngestor,
  createFixtureConnectors,
  fixtureAccounts,
  signWebhook,
  type ConnectorExecutor,
  type ConnectorRepository,
} from '../../src/connectors/index.ts';

class FakeConnectorExecutor implements ConnectorExecutor {
  private readonly records = new Map<string, unknown>();
  private readonly locks = new Map<string, Promise<unknown>>();

  query(tenantId: string, sql: string, values: readonly unknown[]) {
    assert.equal(values[0], tenantId);
    const key = JSON.stringify(values.slice(0, 3));
    if (sql.startsWith('INSERT')) {
      this.records.set(key, JSON.parse(String(values[3])));
      return { rows: [] };
    }
    if (sql.includes('AND id =')) {
      const body = this.records.get(key);
      return { rows: body === undefined ? [] : [{ body: structuredClone(body) }] };
    }
    return {
      rows: [...this.records]
        .filter(([key]) => {
          const [tenant, collection] = JSON.parse(key);
          return tenant === tenantId && collection === values[1];
        })
        .map(([, body]) => ({ body: structuredClone(body) })),
    };
  }

  async lease<T>(tenantId: string, key: string, work: () => Promise<T>) {
    const scoped = JSON.stringify([tenantId, key]);
    const next = (this.locks.get(scoped) ?? Promise.resolve()).then(work);
    const tail = next.catch(() => undefined);
    this.locks.set(scoped, tail);
    try {
      return await next;
    } finally {
      if (this.locks.get(scoped) === tail) this.locks.delete(scoped);
    }
  }
}

for (const kind of ['memory', 'postgres']) {
  test(`${kind} connector state survives service recreation and isolates tenants`, async () => {
    const now = Date.parse('2026-11-25T15:00:00Z');
    const clock = () => now;
    const connector = createFixtureConnectors(clock).registrations[1].connector;
    const credentials = new MemoryCredentialStore();
    const memory = new MemoryConnectorRepository();
    const sql = new FakeConnectorExecutor();
    const repository = (): ConnectorRepository =>
      kind === 'memory'
        ? memory
        : new PostgresConnectorRepository(sql, () => ['fictional-a', 'fictional-b']);
    const makeLifecycle = () =>
      new ConnectorLifecycle([{ connector }], credentials, clock, repository());
    const lifecycle = makeLifecycle();
    const binding = lifecycle.install('fictional-a', 'hubspot-fixture', fixtureAccounts.crm);
    await lifecycle.authorizeApiKey(binding, fixtureAccounts.crmKey);
    await lifecycle.verifyAccount(binding);
    await lifecycle.activate(binding);
    const sync = new ConnectorSync(lifecycle, clock);
    assert.equal((await sync.poll(binding, 1)).checkpoint, '2');
    const id = sync.records(binding)[0].id;
    const writes = new ConnectorWrites(lifecycle, async () => {});
    writes.setFrozen(binding.tenantId, connector.manifest.capability, true);
    const apply: string[] = [];
    const secrets = {
      async get() {
        return 'fictional-secret';
      },
    };
    const webhook = new WebhookIngestor(
      lifecycle,
      secrets,
      async (_ref, event) => {
        apply.push(event.eventId);
      },
      clock,
    );
    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        eventId: 'event-1',
        accountId: fixtureAccounts.crm,
        sequence: 1,
        occurredAt: new Date(now).toISOString(),
        recordClass: 'contact',
        externalId: 'contact-1',
      }),
    );
    const timestamp = String(now / 1000);
    const delivery = {
      body,
      timestamp,
      signature: signWebhook('fictional-secret', timestamp, body),
    };
    assert.equal((await webhook.receive(binding.connectionId, delivery)).status, 'accepted');

    const restarted = makeLifecycle();
    const resumed = new ConnectorSync(restarted, clock);
    assert.equal(restarted.get(binding).status, 'active');
    assert.equal(resumed.status(binding).checkpoint, '2');
    assert.equal((await resumed.poll(binding)).checkpoint, '3');
    assert(resumed.records(binding).some((row) => row.id === id));
    const replay = new WebhookIngestor(
      restarted,
      secrets,
      async (_ref, event) => {
        apply.push(event.eventId);
      },
      clock,
    );
    assert.equal((await replay.receive(binding.connectionId, delivery)).status, 'duplicate');
    assert.deepEqual(apply, ['event-1']);
    assert.equal(
      new ConnectorWrites(restarted, async () => {}).isFrozen(
        binding.tenantId,
        connector.manifest.capability,
      ),
      true,
    );
    assert.throws(() => restarted.get({ ...binding, tenantId: 'fictional-b' }), {
      code: 'not_found',
    });
  });
}
