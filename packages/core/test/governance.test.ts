import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakeProviders } from '@bs/adapters';
import {
  loadDemoFixtures,
  type ActorGrant,
  type CallEnvelope,
  type ToolInputMap,
  type ToolName,
  type ToolRequestMap,
} from '@bs/contracts';
import { MemoryRecordRepository } from '../../business/src/persistence/index.ts';
import { GovernedGateway } from '../src/governance/index.ts';

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
