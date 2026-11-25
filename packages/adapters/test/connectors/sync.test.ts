import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConnectorError,
  ConnectorLifecycle,
  ConnectorSync,
  ConnectorWrites,
  MemoryCredentialStore,
  createFixtureConnectors,
  fixtureAccounts,
  type ChangePage,
  type Connector,
  type ProviderRecord,
  type RecordKey,
  type Snapshot,
  type WriteIntent,
} from '../../src/connectors/index.ts';

const clock = () => Date.parse('2026-11-25T15:00:00Z');
const actor = { tenantId: 'workspace-a', actorId: 'operator' };
const crm = () => createFixtureConnectors(clock).registrations[1].connector;
const deal: RecordKey = { recordClass: 'deal', externalId: 'hs-deal-1' };
const company: RecordKey = { recordClass: 'company', externalId: 'hs-company-1' };
const intent: WriteIntent = {
  ...deal,
  idempotencyKey: 'change-stage',
  expectedVersion: '1',
  fields: { dealstage: 'won' },
};

async function install(
  lifecycle: ConnectorLifecycle,
  connectorId = 'hubspot-fixture',
  mode: 'primary' | 'shadow' = 'primary',
) {
  const binding = lifecycle.install(actor.tenantId, connectorId, fixtureAccounts.crm, mode);
  await lifecycle.authorizeApiKey(binding, fixtureAccounts.crmKey);
  await lifecycle.verifyAccount(binding);
  await lifecycle.activate(binding);
  return binding;
}

function record(key: RecordKey, version: number, name: string): ProviderRecord {
  return {
    ...key,
    version: String(version),
    updatedAt: new Date(clock() + version).toISOString(),
    fields: { name },
  };
}

test('snapshot replay and paged poll preserve stable IDs and provenance', async () => {
  const lifecycle = new ConnectorLifecycle(
    [{ connector: crm() }],
    new MemoryCredentialStore(),
    clock,
  );
  const sync = new ConnectorSync(lifecycle, clock);
  const binding = await install(lifecycle);
  const first = await sync.poll(binding, 1);
  assert.equal(first.checkpoint, '2');
  assert.equal(first.hasMore, true);
  assert.equal((await sync.poll(binding)).checkpoint, '3');
  const rows = sync.records(binding);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].source.accountId, fixtureAccounts.crm);
  assert.equal(rows[0].source.observedAt, new Date(clock()).toISOString());
  assert.deepEqual((await sync.importSnapshot(binding)).changed, []);
  assert.deepEqual(sync.records(binding), rows);

  const writes = new ConnectorWrites(lifecycle, async () => {});
  assert.equal((await writes.write(actor, binding, intent)).status, 'applied');
  await sync.poll(binding);
  const updated = sync.records(binding).find((item) => item.externalId === deal.externalId)!;
  const previous = rows.find((item) => item.externalId === deal.externalId)!;
  assert.equal(updated.id, previous.id);
  assert.equal(updated.source.version, '2');
  assert.equal(updated.fields.dealstage, 'won');
  assert.deepEqual(sync.report(binding)?.changed, [deal]);
});

test('a failed poll retains the committed page and retries its checkpoint', async () => {
  const incoming = record(deal, 1, 'Pipe');
  let malformed = true;
  const cursors: (string | null)[] = [];
  const connector: Connector = {
    ...crm(),
    async listChangedSince(_context, checkpoint): Promise<ChangePage> {
      cursors.push(checkpoint);
      if (checkpoint === null)
        return { records: [incoming], checkpoint: 'after-first', hasMore: true };
      return {
        records: [
          malformed
            ? { ...incoming, externalId: '' }
            : {
                ...incoming,
                deleted: true,
                version: '2',
                updatedAt: record(deal, 2, '').updatedAt,
              },
        ],
        checkpoint: 'finished',
        hasMore: false,
      };
    },
  };
  const lifecycle = new ConnectorLifecycle([{ connector }], new MemoryCredentialStore(), clock);
  const sync = new ConnectorSync(lifecycle, clock);
  const binding = await install(lifecycle);
  await assert.rejects(sync.poll(binding), { code: 'validation_failed' });
  assert.equal(sync.status(binding).checkpoint, 'after-first');
  assert.equal(sync.records(binding)[0].presence, 'present');
  malformed = false;
  await sync.poll(binding);
  assert.deepEqual(cursors, [null, 'after-first', 'after-first']);
  assert.equal(sync.records(binding)[0].presence, 'deleted');
  assert.deepEqual(sync.report(binding)?.changed, [deal]);
});

test('reconciliation preserves last known records for missing and conflicting revisions', async () => {
  let snapshot: Snapshot = {
    checkpoint: 'one',
    records: [record(company, 1, 'Frame'), record(deal, 1, 'Pipe')],
  };
  const connector: Connector = {
    ...crm(),
    async snapshot() {
      return snapshot;
    },
  };
  const lifecycle = new ConnectorLifecycle([{ connector }], new MemoryCredentialStore(), clock);
  const sync = new ConnectorSync(lifecycle, clock);
  const binding = await install(lifecycle);
  await sync.importSnapshot(binding);
  const latest = record(deal, 2, 'Updated');
  snapshot = {
    checkpoint: 'two',
    records: [latest, { ...latest, fields: { name: 'Conflicting' } }],
  };
  const first = await sync.importSnapshot(binding);
  assert.deepEqual(first.missing, [company]);
  assert.deepEqual(first.conflicting, [deal]);
  assert.equal(
    sync.records(binding).find((item) => item.externalId === deal.externalId)?.fields.name,
    'Pipe',
  );
  assert.equal(
    sync.records(binding).find((item) => item.externalId === company.externalId)?.presence,
    'missing',
  );
  snapshot = { checkpoint: 'three', records: [record(deal, 3, 'Final')] };
  const resolved = await sync.importSnapshot(binding);
  assert.deepEqual(resolved.conflicting, []);
  assert.deepEqual(resolved.changed, [deal]);
});

test('shadow comparison uses explicit mappings, preserves primary state and denies shadow writes', async () => {
  const partner = { recordClass: 'deal', externalId: 'partner-42' };
  const unmapped = { recordClass: 'deal', externalId: 'partner-43' };
  const primary: Connector = {
    ...crm(),
    async snapshot() {
      return {
        records: [record(company, 1, 'Frame'), record(deal, 1, 'Pipe')],
        checkpoint: 'primary',
      };
    },
  };
  const candidate: Connector = {
    ...crm(),
    manifest: { ...crm().manifest, id: 'candidate' },
    async snapshot() {
      return {
        records: [record(partner, 2, 'Valve'), record(unmapped, 1, 'Spindle')],
        checkpoint: 'candidate',
      };
    },
  };
  const lifecycle = new ConnectorLifecycle(
    [{ connector: primary }, { connector: candidate }],
    new MemoryCredentialStore(),
    clock,
  );
  const sync = new ConnectorSync(lifecycle, clock);
  const live = await install(lifecycle);
  const shadow = await install(lifecycle, 'candidate', 'shadow');
  await sync.importSnapshot(live);
  await sync.importSnapshot(shadow);
  const before = sync.records(live);
  const mappings = [{ primary: deal, candidate: partner }];
  const result = sync.compareShadow(live, shadow, mappings);
  assert.deepEqual(result.changed, [deal]);
  assert.deepEqual(result.missing, [company]);
  assert.deepEqual(result.added, [unmapped]);
  const ambiguous = sync.compareShadow(live, shadow, [
    ...mappings,
    { primary: deal, candidate: unmapped },
  ]);
  assert.deepEqual(ambiguous.conflicting, [deal]);
  assert.deepEqual(sync.records(live), before);
  const writes = new ConnectorWrites(lifecycle, async () => {});
  await assert.rejects(writes.write(actor, shadow, intent), { code: 'write_frozen' });
});

test('manual and unknown-outcome freezes guard new dispatches until reconciled', async () => {
  let calls = 0;
  let reconciliations = 0;
  const fixture = crm();
  const connector: Connector = {
    ...fixture,
    async write(context, request) {
      calls += 1;
      if (calls === 1) throw new Error('fixture lost its response');
      return fixture.write!(context, request);
    },
    async reconcile(_context, effectId) {
      reconciliations += 1;
      return { status: 'not_applied', effectId };
    },
  };
  const lifecycle = new ConnectorLifecycle([{ connector }], new MemoryCredentialStore(), clock);
  const binding = await install(lifecycle);
  const writes = new ConnectorWrites(lifecycle, async ({ actor }) => {
    if (actor.actorId !== 'operator') throw new ConnectorError('approval_required');
  });
  writes.setFrozen(actor.tenantId, 'crm', true);
  await assert.rejects(writes.write(actor, binding, intent), { code: 'write_frozen' });
  assert.equal(calls, 0);
  writes.setFrozen(actor.tenantId, 'crm', false);
  await assert.rejects(writes.write({ ...actor, actorId: 'reader' }, binding, intent), {
    code: 'approval_required',
  });
  const first = await writes.write(actor, binding, intent);
  assert.equal(first.status, 'unknown');
  assert.equal(writes.isFrozen(actor.tenantId, 'crm'), true);
  assert.equal(writes.isFrozen('workspace-b', 'crm'), false);
  assert.equal(writes.isFrozen(actor.tenantId, 'accounting'), false);
  assert.deepEqual(await writes.write(actor, binding, intent), first);
  await assert.rejects(writes.write(actor, binding, { ...intent, fields: {} }), {
    code: 'conflict',
  });
  await assert.rejects(writes.write(actor, binding, { ...intent, idempotencyKey: 'new' }), {
    code: 'write_frozen',
  });
  assert.equal((await writes.reconcile(binding, first.effectId)).status, 'not_applied');
  assert.equal(reconciliations, 1);
  assert.equal(writes.isFrozen(actor.tenantId, 'crm'), false);
  const freshIntent = { ...intent, idempotencyKey: 'approved-recovery' };
  const [a, b] = await Promise.all([
    writes.write(actor, binding, freshIntent),
    writes.write(actor, binding, freshIntent),
  ]);
  assert.equal(a.status, 'applied');
  assert.deepEqual(a, b);
  assert.equal(calls, 2);
});
