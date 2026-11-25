import { createHash } from 'node:crypto';
import { loadDemoFixtures } from '@bs/contracts';
import { canonicalJson } from '../../../../packages/core/src/workflows/definition.ts';
import type { Effect, EffectResult, Relay } from './worker.ts';

export const fixtureConnector = ['fixture-records', 'lookup'] as const;
type Approved = {
  id: string;
  material: string;
  approverId: string;
  expiresAt: number;
};
type LocalRecord = {
  tenantId: string;
  recordType: string;
  subject: string;
  summary: string;
  version: number;
};

function digest(value: unknown) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

// Fixture-only implementations for operations outside the shared tool catalog.
export function fixtureWorkflowEffects(now: () => number) {
  const data = loadDemoFixtures();
  const approvals = new Map<string, 'signed' | 'consumed'>();
  const outcomes = new Map<string, { approvalId: string; id: string; stamp: string }>();
  const records = new Map<string, LocalRecord>();
  const receipts: { id: string; tenantId: string; channel: string; recipientId: string }[] = [];

  function currentMaterial(effect: Effect) {
    const { scope, input, kind } = effect;
    const tenant = scope.tenantId;
    const role = data.grants.find(
      (grant) =>
        grant.tenantId === tenant &&
        grant.actor.id === scope.actor.id &&
        grant.actor.kind === scope.actor.kind,
    )?.role;
    if (role !== 'operator' && role !== 'admin') return;
    const sourceId = String(
      kind === 'message'
        ? input.sourceId
        : kind === 'create-record'
          ? input.subjectId
          : input.recordId,
    );
    const seeded = [
      ...data.orders,
      ...data.invoices,
      ...data.customers,
      ...data.skus,
      ...data.purchaseRequests,
    ].find((record) => record.tenantId === tenant && record.id === sourceId);
    const local = records.get(sourceId);
    if (
      kind === 'http' &&
      (input.connector !== fixtureConnector[0] || input.operation !== fixtureConnector[1])
    )
      return;
    if (
      kind === 'update-record' &&
      (local?.tenantId !== tenant || local.recordType !== input.recordType)
    )
      return;
    if (
      kind === 'create-record' &&
      (!seeded ||
        (input.recordType === 'order-hold' && !data.orders.some((record) => record === seeded)))
    )
      return;
    if (kind === 'http' && !seeded && local?.tenantId !== tenant) return;
    let customerVersion: number | undefined;
    if (kind === 'message') {
      const customer = data.customers.find(
        (record) => record.tenantId === tenant && record.id === input.recipientId,
      );
      if (
        !customer?.outreachAllowed ||
        typeof input.body !== 'string' ||
        !input.body.trim() ||
        input.purpose === 'collections' ||
        !['email', 'sms', 'voice'].includes(String(input.channel))
      )
        return;
      const isRelevant =
        (seeded &&
          (seeded.id === customer.id ||
            ('customerId' in seeded && seeded.customerId === customer.id))) ||
        (tenant === 'tenant-rivetquay' &&
          customer.id === 'cust-008' &&
          (sourceId === 'quote-fixture-001' || sourceId === 'sku-001'));
      if (!isRelevant || !(input.channel === 'email' ? customer.email : customer.phone)) return;
      customerVersion = customer.version;
    }
    return digest([
      tenant,
      scope.actor,
      kind,
      input,
      seeded ?? local?.version,
      customerVersion,
      'fixture-v1',
    ]);
  }

  const relay: Relay = (effect, signal): EffectResult => {
    signal.throwIfAborted();
    const { phase, scope, kind, decision, approvalId, input } = effect;
    if (kind === 'llm-draft') return { state: 'denied' };
    const action = digest([scope.tenantId, scope.actor, scope.idempotencyKey]);
    const stamp = digest([kind, input]);
    if (phase === 'execute') {
      const outcome = outcomes.get(action);
      if (outcome)
        return outcome.approvalId === approvalId && outcome.stamp === stamp
          ? { state: 'ok', id: outcome.id }
          : { state: 'denied' };
    }
    const material = currentMaterial(effect);
    const approver = data.grants.find(
      (grant) =>
        grant.tenantId === scope.tenantId &&
        grant.role === 'approver' &&
        grant.actor.kind === 'person' &&
        grant.actor.id !== scope.actor.id,
    );
    if (!material || !approver) return { state: 'denied' };
    if (phase === 'prepare') {
      const approval = {
        id: digest([action, material]),
        approverId: approver.actor.id,
        expiresAt: now() + 3_600_000,
      };
      const binding: Approved = { ...approval, material };
      return { state: 'pending_approval', approval, binding };
    }
    const binding = effect.binding as Approved | undefined;
    if (
      !approvalId ||
      !binding ||
      binding.id !== approvalId ||
      binding.material !== material ||
      binding.approverId !== approver.actor.id ||
      now() >= binding.expiresAt ||
      approvals.get(approvalId) === 'consumed'
    )
      return { state: 'denied' };
    if (phase === 'sign') {
      if (
        decision?.tenantId !== scope.tenantId ||
        decision.actor.kind !== 'person' ||
        decision.actor.id !== approver.actor.id
      )
        return { state: 'denied' };
      approvals.set(approvalId, 'signed');
      return { state: 'ok' };
    }
    if (phase !== 'execute' || approvals.get(approvalId) !== 'signed') return { state: 'denied' };
    const id =
      kind === 'update-record' || kind === 'http' ? String(input.recordId) : 'fixture-' + action;
    if (kind === 'message')
      receipts.push({
        id,
        tenantId: scope.tenantId,
        channel: String(input.channel),
        recipientId: String(input.recipientId),
      });
    if (kind === 'create-record' || kind === 'update-record') {
      const prior = records.get(id);
      records.set(id, {
        tenantId: scope.tenantId,
        recordType: String(input.recordType),
        subject: prior?.subject ?? String(input.subjectId),
        summary: String(input.summary),
        version: (prior?.version ?? 0) + 1,
      });
    }
    approvals.set(approvalId, 'consumed');
    outcomes.set(action, { approvalId, id, stamp });
    return { state: 'ok', id };
  };

  return {
    relay,
    receipts: () => structuredClone(receipts),
    records: () => structuredClone([...records.values()]),
  };
}
