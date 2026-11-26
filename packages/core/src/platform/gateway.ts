import {
  toolModules,
  type AuditEntry,
  type UsageCounterEvent,
  type CallEnvelope,
  type Denied,
  type ToolCall,
  type ToolResult,
  type ToolResultMap,
} from '@bs/contracts';
import { tokenDigest } from './auth-crypto.ts';
import { PlatformAudit, PlatformError, type MutationContext } from './audit.ts';
import { rateableGatewayUsage } from './billing-gateway.ts';
import type { BillingLedger } from './billing.ts';
import type { EntitlementStore } from './entitlements.ts';
import type { PlatformEventBus } from './events.ts';
import type { TenantDirectory } from './identity.ts';
import { mayDecideApproval } from './permissions.ts';
import {
  fixtureApprovalAdapter,
  type PlatformApproval,
  type PlatformGovernance,
} from './governance-adapter.ts';
import { PlatformQueue, type TenantRepository } from './repository.ts';

export type { PlatformApproval } from './governance-adapter.ts';

export interface MaterialPreview {
  requestId: string;
  vendorId: string;
  currency: 'CAD';
  lineCount: number;
}

function deny(code: Denied['code']): Denied {
  return { state: 'denied', code, message: code.replaceAll('_', ' ') };
}

function requestKey({ tool, envelope }: ToolCall) {
  const { tenantId, actor, idempotencyKey } = envelope;
  return tokenDigest(JSON.stringify([tenantId, actor.id, actor.kind, tool, idempotencyKey]));
}

export class PlatformGateway {
  private readonly gateway: PlatformGovernance;
  private readonly approvals;
  private readonly directory: TenantDirectory;
  private readonly entitlements: EntitlementStore;
  private readonly auditSink: PlatformAudit;
  private readonly now: () => string;
  private readonly billing?: BillingLedger;
  private readonly events?: PlatformEventBus;
  private readonly queue = new PlatformQueue();
  private readonly seen: TenantRepository<boolean>;
  private readonly previews: TenantRepository<MaterialPreview>;

  constructor(
    gateway: PlatformGateway['gateway'],
    directory: TenantDirectory,
    entitlements: EntitlementStore,
    audit: PlatformAudit,
    now: () => string,
    seen: TenantRepository<boolean>,
    previews: TenantRepository<MaterialPreview>,
    billing?: BillingLedger,
    events?: PlatformEventBus,
  ) {
    this.gateway = gateway;
    this.approvals = fixtureApprovalAdapter(gateway, now);
    this.seen = seen;
    this.previews = previews;
    this.directory = directory;
    this.entitlements = entitlements;
    this.auditSink = audit;
    this.now = now;
    this.billing = billing;
    this.events = events;
  }

  async audit(tenantId: string): Promise<AuditEntry[]> {
    const rows = this.gateway.reportingSnapshot
      ? (await this.gateway.reportingSnapshot(tenantId)).audit
      : (this.gateway.audit?.() ?? []);
    return rows.filter((entry) => entry.tenantId === tenantId);
  }

  async usage(tenantId: string): Promise<UsageCounterEvent[]> {
    const rows = this.gateway.listUsage
      ? await this.gateway.listUsage(tenantId)
      : (this.gateway.usage?.() ?? []);
    return rows.filter((entry) => entry.tenantId === tenantId);
  }

  setModule(context: MutationContext, module: string, enabled: boolean) {
    return this.queue.run(async () =>
      this.entitlements.setEnabled(context, module, enabled, await this.usage(context.tenantId)),
    );
  }

  call<Request extends ToolCall>(request: Request): Promise<ToolResultMap[Request['tool']]>;
  call(request: ToolCall): Promise<ToolResult> {
    const snapshot = structuredClone(request);
    return this.queue.run(() => this.execute(snapshot));
  }

  private async grant(tenantId: string, id: string) {
    return (await this.approvals.list(tenantId)).find(
      (grant): grant is PlatformApproval =>
        grant.tenantId === tenantId && grant.id === id && grant.state !== 'denied',
    );
  }

  private async execute(request: ToolCall): Promise<ToolResult> {
    const { envelope, tool, input } = request;
    const permission =
      tool === 'purchase.order.approve'
        ? 'approvals.decide'
        : tool.endsWith('.read')
          ? 'records.read'
          : 'actions.request';
    if (!(await this.directory.allows(envelope, permission))) {
      await this.auditSink.record(envelope, tool, 'denied');
      return deny('forbidden');
    }
    const key = requestKey(request);
    const disabled =
      !this.gateway.listApprovals &&
      !(await this.seen.get(envelope.tenantId, key)) &&
      (await this.entitlements.override(envelope.tenantId, toolModules[tool])) === false;
    const approvalId = 'approvalId' in input ? input.approvalId : null;
    const grant = approvalId ? await this.grant(envelope.tenantId, approvalId) : undefined;
    const invalidApproval =
      !this.gateway.listApprovals &&
      grant &&
      (grant.state === 'rejected' ||
        (permission === 'approvals.decide' && !mayDecideApproval(true, envelope.actor.id, grant)));
    if (disabled || invalidApproval) {
      await this.auditSink.record(envelope, tool, 'denied');
      return deny(disabled ? 'module_disabled' : 'invalid_approval');
    }

    const result = await this.gateway.call(request);
    if (!this.gateway.listApprovals) await this.seen.put(envelope.tenantId, key, true);
    const prepared =
      result.state === 'pending_approval'
        ? result.approval
        : result.state === 'ok' && 'approval' in result.output
          ? result.output.approval
          : undefined;
    if (prepared) {
      if (
        !this.gateway.listApprovals &&
        (await this.grant(envelope.tenantId, prepared.id))?.state === 'rejected'
      ) {
        await this.auditSink.record(envelope, tool, 'denied');
        return deny('invalid_approval');
      }
      await this.auditSink.transaction(envelope.tenantId, async () => {
        await this.events?.appendInTransaction(
          envelope.tenantId,
          {
            id: 'requested-' + prepared.id,
            type: 'approval.requested',
            occurredAt: new Date(Date.parse(prepared.expiresAt) - 3_600_000).toISOString(),
            data: { approvalId: prepared.id },
          },
          [prepared.approverId],
        );
        if (result.state === 'ok' && 'draft' in result.output && 'approval' in result.output) {
          const { requestId, vendorId, currency, lines } = result.output.draft;
          await this.previews.put(envelope.tenantId, prepared.id, {
            requestId,
            vendorId,
            currency,
            lineCount: lines.length,
          });
        }
      });
    }
    if (result.state === 'ok') {
      const audit = (await this.audit(envelope.tenantId)).findLast(
        (entry) =>
          entry.tenantId === envelope.tenantId &&
          entry.actor.id === envelope.actor.id &&
          entry.traceId === envelope.traceId &&
          entry.tool === tool &&
          entry.state === 'ok',
      );
      const counter =
        audit &&
        (await this.usage(envelope.tenantId)).find(
          (item) => item.tenantId === envelope.tenantId && item.outcomeId === audit.actionId,
        );
      const event = counter && rateableGatewayUsage(request, result, counter);
      if (event) await this.billing?.recordFixtureUsage(envelope, event);
      const output = result.output;
      if (counter && 'draft' in output && 'approvalId' in output) {
        await this.publishApprovalDecision(
          envelope.tenantId,
          output.approvalId,
          'approved',
          counter.occurredAt,
          grant?.requestedBy,
        );
        await this.events?.publish(envelope.tenantId, {
          id: 'created-' + output.id,
          type: 'record.changed',
          occurredAt: counter.occurredAt,
          data: { recordType: 'purchaseOrder', recordId: output.id, change: 'created' },
        });
      }
      if (counter && 'runId' in output && output.status === 'simulated') {
        await this.events?.publish(envelope.tenantId, {
          id: 'settled-' + output.runId,
          type: 'workflow.run.settled',
          occurredAt: counter.occurredAt,
          data: { runId: output.runId, status: 'succeeded' },
        });
      }
    }
    return result;
  }

  async listApprovals(tenantId: string, state?: PlatformApproval['state']) {
    const grants = (await this.approvals.list(tenantId)).filter(
      (grant): grant is PlatformApproval =>
        grant.tenantId === tenantId &&
        grant.state !== 'denied' &&
        (state === undefined || grant.state === state),
    );
    return Promise.all(
      grants.map(async (grant) => {
        const materialPreview = await this.previews.get(tenantId, grant.id);
        return materialPreview ? { ...grant, materialPreview } : grant;
      }),
    );
  }

  sign(context: MutationContext, id: string) {
    return this.queue.run(async () => {
      const grant = await this.approverGrant(context, id, 'sign');
      const envelope: CallEnvelope = {
        ...context,
        version: 'v1',
        idempotencyKey: 'sign-' + id,
      };
      if (grant.tool === 'purchase.order.approve') {
        const result = await this.execute({
          envelope,
          tool: grant.tool,
          input: { draftId: grant.subjectId, approvalId: id },
        });
        if ('code' in result && result.code === 'module_disabled')
          throw new PlatformError(result.code);
        if (result.state !== 'ok') {
          if ('code' in result && result.code === 'quota_exceeded')
            throw new PlatformError(result.code);
          throw new PlatformError(result.state === 'denied' ? 'invalid_approval' : 'unavailable');
        }
        return { ...grant, state: 'consumed' as const };
      }
      const result = await this.signThroughGovernance(envelope, id);
      if ('code' in result) {
        throw new PlatformError(result.code === 'suppressed' ? 'invalid_approval' : result.code);
      }
      return { ...result, state: 'approved' as const };
    });
  }

  // Keep the governed REST transport's existing signing entry point when it uses this bridge.
  signApproval(envelope: CallEnvelope, id: string) {
    const snapshot = structuredClone(envelope);
    return this.queue.run(() => this.signThroughGovernance(snapshot, id));
  }

  private async signThroughGovernance(envelope: CallEnvelope, id: string) {
    const grant = await this.grant(envelope.tenantId, id);
    if (!(await this.directory.allows(envelope, 'approvals.decide'))) {
      await this.auditSink.record(envelope, 'approval.sign', 'denied');
      return deny('forbidden');
    }
    if (grant) {
      const blocked =
        grant.state === 'rejected' || !mayDecideApproval(true, envelope.actor.id, grant)
          ? 'invalid_approval'
          : (await this.entitlements.override(envelope.tenantId, toolModules[grant.tool])) === false
            ? 'module_disabled'
            : undefined;
      if (blocked) {
        await this.auditSink.record(envelope, 'approval.sign', 'denied');
        return deny(blocked);
      }
    }
    const result = await this.gateway.signApproval(envelope, id);
    if (!('code' in result)) {
      await this.publishApprovalDecision(
        envelope.tenantId,
        id,
        'approved',
        this.now(),
        result.requestedBy,
      );
    }
    return result;
  }

  reject(context: MutationContext, id: string, reason: string) {
    return this.queue.run(async () => {
      if (!reason.trim() || reason.length > 500) throw new PlatformError('forbidden');
      const grant = await this.approverGrant(context, id, 'reject');
      const result = await this.approvals.reject(
        { ...context, version: 'v1', idempotencyKey: 'reject-' + id },
        id,
        reason,
      );
      if ('code' in result) {
        throw new PlatformError(
          result.state === 'failed' || result.code === 'suppressed'
            ? 'invalid_approval'
            : result.code,
        );
      }
      await this.publishApprovalDecision(
        context.tenantId,
        id,
        'rejected',
        this.now(),
        grant.requestedBy,
        this.gateway.rejectApproval
          ? undefined
          : () => this.auditSink.record(context, 'approval.reject'),
      );
      return { ...result, state: 'rejected' as const };
    });
  }

  private publishApprovalDecision(
    tenantId: string,
    approvalId: string,
    decision: 'approved' | 'rejected',
    occurredAt: string,
    requester?: string,
    onInsert?: () => Promise<void>,
  ) {
    return this.events?.publishOnce(
      tenantId,
      {
        id: decision + '-' + approvalId,
        type: 'approval.decided',
        occurredAt,
        data: { approvalId, decision },
      },
      requester ? [requester] : [],
      onInsert,
    );
  }

  private async approverGrant(context: MutationContext, id: string, operation: 'sign' | 'reject') {
    const allowed = await this.directory.allows(context, 'approvals.decide');
    const grant = await this.grant(context.tenantId, id);
    const legacy =
      operation === 'sign' ? !this.gateway.listApprovals : !this.gateway.rejectApproval;
    if (
      !grant ||
      (legacy && grant.state !== 'pending') ||
      !mayDecideApproval(allowed, context.actor.id, grant)
    ) {
      await this.auditSink.record(context, 'approval.' + operation, 'denied');
      throw new PlatformError(allowed ? 'invalid_approval' : 'forbidden');
    }
    return grant;
  }
}
