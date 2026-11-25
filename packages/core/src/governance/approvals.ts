import { randomUUID } from 'node:crypto';
import type { Approval, ApprovalAction, CallEnvelope, Denied } from '@bs/contracts';
import { denied, digest } from './results.ts';
import type { StoredApproval } from './store.ts';

export interface ApprovalIntent {
  tool: ApprovalAction;
  subjectId: string;
  target: string;
  sourceVersion: number;
  material: unknown;
}

export function matchesBinding(
  { grant, target }: StoredApproval,
  intent: ApprovalIntent | undefined,
  policyVersion: string,
  now: string,
) {
  return (
    intent !== undefined &&
    target === intent.target &&
    grant.tool === intent.tool &&
    grant.subjectId === intent.subjectId &&
    grant.sourceVersion === intent.sourceVersion &&
    grant.materialHash === digest(intent.material) &&
    grant.policyVersion === policyVersion &&
    Date.parse(grant.expiresAt) > Date.parse(now)
  );
}

export class ApprovalLedger {
  private readonly rows: Map<string, StoredApproval>;

  constructor(rows: Map<string, StoredApproval>) {
    this.rows = rows;
  }

  get(id: string) {
    return this.rows.get(id);
  }

  list() {
    return [...this.rows.values()];
  }

  prepare(
    envelope: CallEnvelope,
    intent: ApprovalIntent,
    approverId: string,
    policyVersion: string,
    now: string,
  ): Approval | Denied {
    const { tenantId, actor } = envelope;
    const { tool, subjectId, target, sourceVersion, material } = intent;
    for (const row of this.rows.values()) {
      const { grant } = row;
      if (grant.tool !== tool || row.target !== target || grant.requestedBy !== actor.id) continue;
      const current =
        grant.approverId === approverId && matchesBinding(row, intent, policyVersion, now);
      if (current) {
        if (grant.state === 'consumed' || row.rejectionReason !== undefined)
          return denied('invalid_approval');
        if (grant.state !== 'denied') return grant;
      } else if (grant.state === 'pending' || grant.state === 'approved') {
        grant.state = 'denied';
      }
    }

    const grant: Approval = {
      id: 'approval-' + randomUUID(),
      tenantId,
      requestedBy: actor.id,
      approverId,
      tool,
      subjectId,
      materialHash: digest(material),
      sourceVersion,
      policyVersion,
      expiresAt: new Date(Date.parse(now) + 60 * 60 * 1000).toISOString(),
      state: 'pending',
    };
    this.rows.set(grant.id, { grant, target });
    return grant;
  }

  canDecide(envelope: CallEnvelope, grant: Approval) {
    return (
      grant.tenantId === envelope.tenantId &&
      grant.approverId === envelope.actor.id &&
      grant.requestedBy !== envelope.actor.id
    );
  }

  consume(
    envelope: CallEnvelope,
    intent: ApprovalIntent,
    id: string,
    policyVersion: string,
    now: string,
  ) {
    const row = this.rows.get(id);
    if (!row || row.grant.tenantId !== envelope.tenantId) return false;
    const { grant } = row;
    const authorized =
      intent.tool === 'purchase.order.approve'
        ? grant.state === 'pending' && this.canDecide(envelope, grant)
        : grant.state === 'approved' && grant.requestedBy === envelope.actor.id;
    if (!authorized || grant.tool !== intent.tool || row.target !== intent.target) return false;
    if (!matchesBinding(row, intent, policyVersion, now)) {
      grant.state = 'denied';
      return false;
    }
    grant.state = 'consumed';
    return true;
  }
}
