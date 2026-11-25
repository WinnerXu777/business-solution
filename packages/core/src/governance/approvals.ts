import { randomUUID } from 'node:crypto';
import type { Approval, ApprovalAction, CallEnvelope, Denied, Unknown } from '@bs/contracts';
import { denied, digest } from './results.ts';

export interface ApprovalIntent {
  tool: ApprovalAction;
  subjectId: string;
  sourceVersion: number;
  material: unknown;
}

export class ApprovalLedger {
  private readonly grants = new Map<string, Approval>();
  private readonly byIntent = new Map<string, string>();
  private readonly holds = new Map<string, Unknown>();

  prepare(
    envelope: CallEnvelope,
    intent: ApprovalIntent,
    approverId: string,
    policyVersion: string,
    now: string,
  ): Approval | Denied {
    const { tenantId, actor } = envelope;
    const { tool, subjectId, sourceVersion, material } = intent;
    const materialHash = digest(material);
    const signature = digest([
      tenantId,
      actor.id,
      approverId,
      tool,
      subjectId,
      materialHash,
      sourceVersion,
      policyVersion,
    ]);
    const prior = this.grants.get(this.byIntent.get(signature) ?? '');
    if (prior?.state === 'consumed') return denied('invalid_approval');
    if (prior && this.isCurrent(prior, policyVersion, now)) return structuredClone(prior);

    const grant: Approval = {
      id: 'approval-' + randomUUID(),
      tenantId,
      requestedBy: actor.id,
      approverId,
      tool,
      subjectId,
      materialHash,
      sourceVersion,
      policyVersion,
      expiresAt: new Date(Date.parse(now) + 60 * 60 * 1000).toISOString(),
      state: 'pending',
    };
    this.grants.set(grant.id, grant);
    this.byIntent.set(signature, grant.id);
    return structuredClone(grant);
  }

  get(id: string): Approval | undefined {
    return structuredClone(this.grants.get(id));
  }

  sign(envelope: CallEnvelope, id: string, policyVersion: string, now: string): Approval | Denied {
    const grant = this.grants.get(id);
    if (
      grant?.state !== 'pending' ||
      grant.tenantId !== envelope.tenantId ||
      grant.approverId !== envelope.actor.id ||
      grant.requestedBy === envelope.actor.id ||
      grant.tool === 'purchase.order.approve' ||
      !this.isCurrent(grant, policyVersion, now)
    )
      return denied('invalid_approval');
    grant.state = 'approved';
    return structuredClone(grant);
  }

  consume(
    envelope: CallEnvelope,
    intent: ApprovalIntent,
    id: string,
    policyVersion: string,
    now: string,
  ): boolean {
    const grant = this.grants.get(id);
    const isPo = intent.tool === 'purchase.order.approve';
    if (
      !grant ||
      grant.tenantId !== envelope.tenantId ||
      grant.tool !== intent.tool ||
      grant.subjectId !== intent.subjectId ||
      grant.sourceVersion !== intent.sourceVersion ||
      grant.materialHash !== digest(intent.material) ||
      !this.isCurrent(grant, policyVersion, now)
    )
      return false;
    const actorId = envelope.actor.id;
    const authorized = isPo
      ? grant.state === 'pending' && grant.approverId === actorId && grant.requestedBy !== actorId
      : grant.state === 'approved' && grant.requestedBy === actorId;
    if (!authorized) return false;
    grant.state = 'consumed';
    return true;
  }

  getHold(tenantId: string, tool: ApprovalAction, target: string) {
    return this.holds.get(digest([tenantId, tool, target]));
  }

  hold(tenantId: string, tool: ApprovalAction, target: string, outcome: Unknown) {
    this.holds.set(digest([tenantId, tool, target]), outcome);
  }

  private isCurrent(grant: Approval, policyVersion: string, now: string) {
    return grant.policyVersion === policyVersion && Date.parse(grant.expiresAt) > Date.parse(now);
  }
}
