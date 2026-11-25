import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeProviders } from '@bs/adapters';
import { MemoryRecordRepository } from '@bs/business';
import {
  loadDemoFixtures,
  type ActorGrant,
  type CallEnvelope,
  type ToolInputMap,
  type ToolName,
  type ToolRequestMap,
} from '@bs/contracts';
import { GovernedGateway } from '../src/governance/index.ts';
import { verifyAuditExport } from '../src/governance/audit.ts';
import {
  MemoryGovernanceStore,
  type GovernanceStore,
  type TenantState,
} from '../src/governance/store.ts';

const fixtures = loadDemoFixtures();
const [operator, approver, reader, worker, isolation] = fixtures.grants;
const clock = () => fixtures.asOf;

function envelope(key: string, { tenantId, actor }: ActorGrant): CallEnvelope {
  return {
    version: 'v1',
    tenantId,
    actor,
    source: 'worker',
    traceId: 'trace',
    correlationId: 'scenario',
    idempotencyKey: key,
  };
}

function call<Tool extends ToolName>(
  gateway: GovernedGateway,
  tool: Tool,
  input: ToolInputMap[Tool],
  key: string,
  grant = operator,
) {
  return gateway.call({ tool, input, envelope: envelope(key, grant) } as ToolRequestMap[Tool]);
}

function code(result: { state: string; code?: string }) {
  return result.code;
}

async function draftOrder(gateway: GovernedGateway) {
  const result = await call(gateway, 'purchase.order.draft', { requestId: 'pr-001' }, 'draft');
  assert.equal(result.state, 'ok');
  return result.output;
}

test('governed PO approval is single-use and concurrent retries meter exactly once', async () => {
  const records = new MemoryRecordRepository();
  const gateway = new GovernedGateway({ records, now: clock });
  const { approval, draft } = await draftOrder(gateway);
  assert.equal(draft.vendorId, 'vendor-002');
  assert.match(approval.materialHash, /^[a-f0-9]{64}$/);
  assert.equal(approval.sourceVersion, draft.sourceVersion);
  assert.equal(approval.expiresAt, '2026-11-25T16:00:00.000Z');
  assert.equal(approval.requestedBy, operator.actor.id);
  assert.equal(approval.approverId, approver.actor.id);
  const input = { draftId: draft.id, approvalId: approval.id };
  assert.equal(code(await call(gateway, 'purchase.order.approve', input, 'approve')), 'forbidden');
  const [approved, retry] = await Promise.all([
    call(gateway, 'purchase.order.approve', input, 'approve', approver),
    call(
      gateway,
      'purchase.order.approve',
      { approvalId: input.approvalId, draftId: input.draftId },
      'approve',
      approver,
    ),
  ]);
  assert.equal(approved.state, 'ok');
  assert.deepEqual(retry, approved);
  assert.deepEqual(
    await records.get('purchaseOrders', operator.tenantId, approved.output.id),
    approved.output,
  );
  assert.equal(
    code(await call(gateway, 'purchase.order.approve', input, 'new-key', approver)),
    'invalid_approval',
  );
  assert.equal(
    code(
      await call(
        gateway,
        'purchase.order.approve',
        { ...input, approvalId: 'other' },
        'approve',
        approver,
      ),
    ),
    'idempotency_conflict',
  );
  const approvedAudit = gateway
    .audit()
    .filter((entry) => entry.tool === 'purchase.order.approve' && entry.state === 'ok');
  assert.equal(approvedAudit.length, 2);
  assert.equal(
    gateway.usage().filter((event) => event.outcomeId === approvedAudit[0].actionId).length,
    1,
  );
  assert.equal(gateway.usage().length, 2);
});

for (const change of ['material', 'source version', 'policy version', 'expiry'] as const) {
  test(`PO approval rejects changed ${change}`, async () => {
    let now = fixtures.asOf;
    let policyVersion = 'policy-v1';
    const repository = new MemoryRecordRepository();
    let changed = false;
    const get = repository.get.bind(repository);
    repository.get = async (kind, tenant, id) => {
      const row = await get(kind, tenant, id);
      if (changed && kind === 'purchaseRequests' && row && 'costCentre' in row) {
        if (change === 'material') row.costCentre = 'changed';
        if (change === 'source version') row.version++;
      }
      return row;
    };
    const gateway = new GovernedGateway({
      records: repository,
      now: () => now,
      policyVersion: () => policyVersion,
    });
    const { draft, approval } = await draftOrder(gateway);
    changed = true;
    if (change === 'policy version') policyVersion = 'policy-v2';
    if (change === 'expiry') now = approval.expiresAt;
    const denied = await call(
      gateway,
      'purchase.order.approve',
      { draftId: draft.id, approvalId: approval.id },
      'approve',
      approver,
    );
    assert.equal(code(denied), 'invalid_approval');
    assert.equal(gateway.usage().length, 1);
    assert.deepEqual(await gateway.listApprovals(operator.tenantId, 'pending'), []);
    assert.equal((await gateway.listApprovals(operator.tenantId, 'denied'))[0].id, approval.id);
  });
}

test('roles, tenant scope, module flags and quota govern new work', async () => {
  const local = loadDemoFixtures();
  for (const entry of local.entitlements) {
    if (entry.flag.module === 'insights') entry.flag.enabled = false;
    if (entry.flag.module === 'records') entry.allowance = 1;
  }
  const gateway = new GovernedGateway({ fixtures: local, now: clock });
  const foreign = await call(
    gateway,
    'order.read',
    { orderId: 'ord-isolation' },
    'foreign',
    reader,
  );
  assert.deepEqual(
    foreign,
    await call(gateway, 'order.read', { orderId: 'ord-absent' }, 'missing', reader),
  );
  assert.equal(code(foreign), 'not_found');
  const [first, exhausted] = await Promise.all([
    call(gateway, 'order.read', { orderId: 'ord-001' }, 'read', reader),
    call(gateway, 'order.read', { orderId: 'ord-001' }, 'read', worker),
  ]);
  assert.equal(first.state, 'ok');
  assert.equal(code(exhausted), 'quota_exceeded');
  assert.deepEqual(
    await call(gateway, 'order.read', { orderId: 'ord-001' }, 'read', reader),
    first,
  );
  assert.equal(
    (await call(gateway, 'order.read', { orderId: 'ord-isolation' }, 'read', isolation)).state,
    'ok',
  );
  assert.equal(
    (await call(gateway, 'purchase.request.read', { requestId: 'pr-001' }, 'read', reader)).state,
    'ok',
  );
  assert.equal(
    code(await call(gateway, 'purchase.order.draft', { requestId: 'pr-001' }, 'draft', reader)),
    'forbidden',
  );
  assert.equal(
    code(await call(gateway, 'fraud.score', { orderId: 'ord-003' }, 'disabled')),
    'module_disabled',
  );
});

async function prepareEmail(gateway: GovernedGateway) {
  const preview = await call(
    gateway,
    'message.preview',
    { invoiceId: 'inv-001', channel: 'email' },
    'preview',
  );
  assert.equal(preview.state, 'ok');
  const previewId = preview.output.id;
  const pending = await call(
    gateway,
    'collections.email.send',
    { previewId, approvalId: null },
    'prepare',
  );
  assert.equal(pending.state, 'pending_approval');
  return { previewId, approvalId: pending.approval.id };
}

test('only the designated tenant approver can reject and rejection stays in the inbox history', async () => {
  const gateway = new GovernedGateway({ now: clock });
  const { previewId, approvalId } = await prepareEmail(gateway);
  const reason = 'Synthetic reason for inv-001';
  assert.deepEqual(await gateway.listApprovals(isolation.tenantId), []);
  assert.equal(
    code(await gateway.reject(envelope('reject', operator), approvalId, reason)),
    'forbidden',
  );
  const scope = envelope('reject', approver);
  const rejected = await gateway.reject(scope, approvalId, reason);
  assert.equal(rejected.state, 'denied');
  assert.ok(!('code' in rejected));
  assert.deepEqual(await gateway.reject(scope, approvalId, reason), rejected);
  assert.deepEqual(await gateway.listApprovals(operator.tenantId, 'pending'), []);
  assert.deepEqual(await gateway.listApprovals(operator.tenantId, 'denied'), [rejected]);
  assert.equal(code(await gateway.signApproval(scope, approvalId)), 'invalid_approval');
  for (const key of ['prepare', 'new-prepare']) {
    assert.equal(
      code(await call(gateway, 'collections.email.send', { previewId, approvalId: null }, key)),
      'invalid_approval',
    );
  }
  const audit = await gateway.exportAudit(operator.tenantId);
  const { valid, head } = verifyAuditExport(audit);
  assert.ok(valid && head);
  assert.doesNotMatch(audit, /Synthetic reason|inv-001/);
  assert.equal(verifyAuditExport(audit.replace('approval.reject', 'approval.sign')).valid, false);
  const truncated = audit.trimEnd().split('\n').slice(0, -1).join('\n');
  assert.equal(verifyAuditExport(truncated, head).valid, false);
  assert.equal(await gateway.exportAudit(isolation.tenantId), '');
});

test('a failed intent transaction rolls back approval consumption, audit, and queue together', async () => {
  const memory = new MemoryGovernanceStore();
  const store: GovernanceStore = {
    transact<T>(tenantId: string, operation: (state: TenantState) => T | Promise<T>) {
      return memory.transact(tenantId, async (state) => {
        const result = await operation(state);
        if (state.rows.outbox.size) throw new Error('Simulated transaction failure');
        return result;
      });
    },
  };
  const providers = createFakeProviders();
  let sends = 0;
  providers.messages.email = {
    send() {
      sends++;
      throw new Error('Unexpected send');
    },
  };
  const gateway = new GovernedGateway({ store, providers, now: clock });
  const input = await prepareEmail(gateway);
  await gateway.signApproval(envelope('sign', approver), input.approvalId);
  const audit = await gateway.exportAudit(operator.tenantId);
  const result = await call(gateway, 'collections.email.send', input, 'send');
  assert.equal(result.state, 'failed');
  assert.equal(sends, 0);
  const [{ rows }] = memory.snapshot();
  assert.equal(rows.outbox.size, 0);
  assert.equal(rows.intent.size, 0);
  assert.equal(rows.approval.get(input.approvalId)?.grant.state, 'approved');
  assert.equal(await gateway.exportAudit(operator.tenantId), audit);
});

for (const reconciliation of ['applied', 'not_applied', 'unknown', 'changed_policy'] as const) {
  test(`outbox recovery after a gateway restart handles ${reconciliation} without a duplicate write`, async () => {
    const providers = createFakeProviders();
    const memory = new MemoryGovernanceStore();
    const simulated = {
      channel: 'email',
      status: 'simulated',
      providerId: 'fixture-email',
    } as const;
    let workerTime = 0;
    let policyVersion = 'policy-v1';
    const sendKeys: string[] = [];
    const reconciliationKeys: string[] = [];
    providers.messages.email = {
      send(_preview, key) {
        sendKeys.push(key);
        const [{ rows, audit }] = memory.snapshot();
        assert.equal(rows.outbox.get(key)?.status, 'running');
        assert.ok(rows.intent.has(key));
        assert.equal(rows.outcome.get(key)?.result.state, 'unknown');
        assert.ok(audit.some((entry) => entry.actionId === key && entry.state === 'unknown'));
        if (sendKeys.length === 1) throw new Error('Lost provider response');
        return { ...simulated, id: 'receipt-' + key };
      },
      reconcile(key) {
        reconciliationKeys.push(key);
        if (reconciliation === 'applied') return { ...simulated, id: 'receipt-' + key };
        return reconciliation === 'unknown' ? 'unknown' : 'not_applied';
      },
    };
    const options = {
      store: memory,
      providers,
      now: clock,
      policyVersion: () => policyVersion,
      workerClock: () => workerTime,
    };
    const original = new GovernedGateway(options);
    const input = await prepareEmail(original);
    await original.signApproval(envelope('sign', approver), input.approvalId);
    const first = await call(original, 'collections.email.send', input, 'send');
    assert.equal(first.state, 'unknown');
    const gateway = new GovernedGateway(options);
    assert.deepEqual(await call(gateway, 'collections.email.send', input, 'send'), first);
    assert.deepEqual(sendKeys, [first.actionId]);
    if (reconciliation === 'changed_policy') policyVersion = 'policy-v2';
    for (const seconds of [5, 10, 15]) {
      workerTime = seconds * 1000;
      await gateway.dispatchOutbox(operator.tenantId);
    }
    const outcome = await call(gateway, 'collections.email.send', input, 'send');
    const queue = await gateway.listDeadLetters(operator.tenantId);
    assert.deepEqual(await gateway.listDeadLetters(isolation.tenantId), []);
    if (reconciliation === 'unknown') {
      assert.deepEqual(outcome, first);
      assert.equal(queue[0].reason, 'reconciliation_required');
      assert.equal(queue[0].unresolved, true);
      assert.deepEqual(reconciliationKeys, Array(3).fill(first.actionId));
      assert.deepEqual(sendKeys, [first.actionId]);
    } else {
      assert.deepEqual(queue, []);
      assert.deepEqual(reconciliationKeys, [first.actionId]);
      assert.deepEqual(
        sendKeys,
        Array(reconciliation === 'not_applied' ? 2 : 1).fill(first.actionId),
      );
      assert.equal(outcome.state, reconciliation === 'changed_policy' ? 'denied' : 'ok');
      assert.equal(
        gateway.usage().filter((event) => event.outcomeId === first.actionId).length,
        reconciliation === 'changed_policy' ? 0 : 1,
      );
    }
  });
}

test('an expired claim reconciles a write whose settlement transaction was lost', async () => {
  const memory = new MemoryGovernanceStore();
  let loseSettlement = true;
  let workerTime = 0;
  let sends = 0;
  const store: GovernanceStore = {
    transact<T>(tenantId: string, operation: (state: TenantState) => T | Promise<T>) {
      return memory.transact(tenantId, async (state) => {
        const result = await operation(state);
        if (
          loseSettlement &&
          [...state.rows.outbox.values()].some(({ status }) => status === 'completed')
        ) {
          loseSettlement = false;
          throw new Error('Simulated crash before settlement');
        }
        return result;
      });
    },
  };
  const providers = createFakeProviders();
  const receipt = (id: string) =>
    ({ id, channel: 'email', status: 'simulated', providerId: 'fixture-email' }) as const;
  providers.messages.email = {
    send(_preview, id) {
      sends++;
      return receipt(id);
    },
    reconcile: receipt,
  };
  const options = { store, providers, now: clock, workerClock: () => workerTime };
  const gateway = new GovernedGateway(options);
  const input = await prepareEmail(gateway);
  await gateway.signApproval(envelope('sign', approver), input.approvalId);
  const first = await call(gateway, 'collections.email.send', input, 'send');
  assert.equal(first.state, 'unknown');
  assert.equal(memory.snapshot()[0].rows.outbox.get(first.actionId)?.status, 'running');
  const restarted = new GovernedGateway(options);
  workerTime = 60_000;
  await restarted.dispatchOutbox(operator.tenantId);
  const outcome = await call(restarted, 'collections.email.send', input, 'send');
  assert.deepEqual(outcome, { state: 'ok', output: receipt(first.actionId) });
  assert.equal(sends, 1);
  assert.equal(
    (await restarted.listUsage(operator.tenantId)).filter(
      ({ outcomeId }) => outcomeId === first.actionId,
    ).length,
    1,
  );
});

test('a same-key read retries a repository outage and meters the recovered result once', async () => {
  const records = new MemoryRecordRepository();
  const get = records.get.bind(records);
  let attempts = 0;
  records.get = async (kind, tenantId, id) => {
    if (++attempts === 1) throw new Error('Temporary repository outage');
    return get(kind, tenantId, id);
  };
  const gateway = new GovernedGateway({ records, now: clock });
  const read = (orderId = 'ord-001', key = 'read') =>
    call(gateway, 'order.read', { orderId }, key, reader);

  assert.equal(code(await read()), 'unavailable');
  assert.equal(gateway.usage().length, 0);
  const recovered = await read();
  assert.equal(recovered.state, 'ok');
  assert.deepEqual(await read(), recovered);

  const missing = await read('ord-absent', 'missing');
  assert.equal(code(missing), 'not_found');
  assert.deepEqual(await read('ord-absent', 'missing'), missing);
  assert.equal(code(await read('ord-001', 'missing')), 'idempotency_conflict');
  assert.equal(attempts, 3);
  assert.equal(gateway.usage().length, 1);
});

for (const denial of ['quota_exceeded', 'module_disabled'] as const) {
  test(`a same-key read recovers from ${denial} in the next entitlement window`, async () => {
    const local = loadDemoFixtures();
    const current = local.entitlements.find(
      (entry) => entry.tenantId === reader.tenantId && entry.flag.module === 'records',
    )!;
    current.allowance = 1;
    current.flag.enabled = denial !== 'module_disabled';
    local.entitlements.push({
      ...current,
      flag: { ...current.flag, enabled: true },
      windowStart: current.windowEnd,
      windowEnd: '2027-01-01T00:00:00Z',
    });
    let now = local.asOf;
    const gateway = new GovernedGateway({ fixtures: local, now: () => now });
    const read = (key: string) => call(gateway, 'order.read', { orderId: 'ord-001' }, key, reader);
    if (denial === 'quota_exceeded') assert.equal((await read('use-quota')).state, 'ok');
    assert.equal(code(await read('retry')), denial);

    now = current.windowEnd;
    const recovered = await read('retry');
    assert.equal(recovered.state, 'ok');
    assert.deepEqual(await read('retry'), recovered);
    assert.equal(gateway.usage().filter((event) => event.occurredAt === now).length, 1);
  });
}

test('a retryable provider failure keeps the approved action eligible for the same-key retry', async () => {
  const providers = createFakeProviders();
  const email = providers.messages.email;
  const actionIds: string[] = [];
  providers.messages.email = {
    send(preview, actionId) {
      actionIds.push(actionId);
      if (actionIds.length === 1) {
        return {
          state: 'failed',
          code: 'provider_error',
          message: 'Retry later.',
          retryable: true,
        };
      }
      return email.send(preview, actionId);
    },
  };
  const gateway = new GovernedGateway({ providers, now: clock });
  const preview = await call(
    gateway,
    'message.preview',
    { invoiceId: 'inv-001', channel: 'email' },
    'preview',
  );
  assert.equal(preview.state, 'ok');
  const previewId = preview.output.id;
  const prepare = () =>
    call(gateway, 'collections.email.send', { previewId, approvalId: null }, 'prepare');
  const pending = await prepare();
  assert.equal(pending.state, 'pending_approval');
  const approvalId = pending.approval.id;
  const signed = await gateway.signApproval(envelope('sign', approver), approvalId);
  assert.ok('state' in signed && signed.state === 'approved');
  assert.deepEqual(await prepare(), pending);

  const send = (key = 'send') =>
    call(gateway, 'collections.email.send', { previewId, approvalId }, key);
  assert.equal(code(await send()), 'provider_error');
  const recovered = await send();
  assert.equal(recovered.state, 'ok');
  assert.deepEqual(await send(), recovered);
  assert.equal(code(await send('new-key')), 'invalid_approval');
  assert.deepEqual(actionIds, [actionIds[0], actionIds[0]]);
  assert.equal(gateway.usage().filter((event) => event.outcomeId === actionIds[0]).length, 1);
});

test('unknown delivery stays on hold across retry keys and audit snapshots redact material', async () => {
  const providers = createFakeProviders();
  let attempts = 0;
  providers.messages.email = {
    send() {
      attempts++;
      throw new Error('Sensitive provider payload: orders1@rivetquay.example');
    },
  };
  const gateway = new GovernedGateway({ providers, now: clock });
  const preview = await call(
    gateway,
    'message.preview',
    { invoiceId: 'inv-001', channel: 'email' },
    'preview',
  );
  assert.equal(preview.state, 'ok');
  const previewId = preview.output.id;
  const pending = await call(
    gateway,
    'collections.email.send',
    { previewId, approvalId: null },
    'prepare',
  );
  assert.equal(pending.state, 'pending_approval');
  const approvalId = pending.approval.id;
  assert.equal(
    code(await gateway.signApproval(envelope('sign', operator), approvalId)),
    'forbidden',
  );
  const signed = await gateway.signApproval(envelope('sign', approver), approvalId);
  assert.ok('state' in signed && signed.state === 'approved');
  const first = await call(gateway, 'collections.email.send', { previewId, approvalId }, 'send');
  assert.equal(first.state, 'unknown');
  assert.deepEqual(
    await call(gateway, 'collections.email.send', { previewId, approvalId }, 'send'),
    first,
  );
  assert.deepEqual(
    await call(gateway, 'collections.email.send', { previewId, approvalId: null }, 'prepare-again'),
    first,
  );
  assert.equal(attempts, 1);
  assert.equal(gateway.usage().length, 1);
  const audit = gateway.audit();
  assert.ok(audit.some((entry) => entry.state === 'unknown'));
  assert.doesNotMatch(
    JSON.stringify({ audit, first }),
    /rivetquay\.example|inv-001|materialHash|recipient|Sensitive/,
  );
  audit.pop();
  assert.equal(gateway.audit().length, audit.length + 1);
});
