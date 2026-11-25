import { randomUUID } from 'node:crypto';
import {
  toolModules,
  type Approval,
  type CallEnvelope,
  type Denied,
  type ToolCall,
  type ToolResult,
  type ToolResultMap,
} from '@bs/contracts';
import type { GovernedGateway } from '../governance/index.ts';
import { PlatformAudit, PlatformError, type MutationContext } from './audit.ts';
import type { EntitlementStore } from './entitlements.ts';
import type { TenantDirectory } from './identity.ts';
import { PlatformQueue } from './repository.ts';

export type PlatformApproval = Omit<Approval, 'state'> & {
  state: Exclude<Approval['state'], 'denied'> | 'rejected' | 'expired';
};

function deny(code: Denied['code']): Denied {
  return { state: 'denied', code, message: code.replaceAll('_', ' ') };
}

function requestKey({ tool, envelope }: ToolCall) {
  const { tenantId, actor, idempotencyKey } = envelope;
  return JSON.stringify([tenantId, actor.id, actor.kind, tool, idempotencyKey]);
}

/**
 * Fixture bridge until the governance ledger exposes list/reject and reads platform
 * entitlements directly. All transports in a fixture session must use this instance.
 */
export class PlatformGateway {
  private readonly gateway: Pick<GovernedGateway, 'call' | 'signApproval' | 'audit' | 'usage'>;
  private readonly directory: TenantDirectory;
  private readonly entitlements: EntitlementStore;
  private readonly auditSink: PlatformAudit;
  private readonly now: () => string;
  private readonly queue = new PlatformQueue();
  private readonly seen = new Set<string>();
  private readonly grants = new Map<string, PlatformApproval>();

  constructor(
    gateway: PlatformGateway['gateway'],
    directory: TenantDirectory,
    entitlements: EntitlementStore,
    audit: PlatformAudit,
    now: () => string,
  ) {
    this.gateway = gateway;
    this.directory = directory;
    this.entitlements = entitlements;
    this.auditSink = audit;
    this.now = now;
  }

  audit() {
    return this.gateway.audit();
  }

  usage() {
    return this.gateway.usage();
  }

  setModule(context: MutationContext, module: string, enabled: boolean) {
    return this.queue.run(() =>
      this.entitlements.setEnabled(context, module, enabled, this.usage()),
    );
  }

  call<Request extends ToolCall>(request: Request): Promise<ToolResultMap[Request['tool']]>;
  call(request: ToolCall): Promise<ToolResult> {
    const snapshot = structuredClone(request);
    return this.queue.run(() => this.execute(snapshot));
  }

  private grant(tenantId: string, id: string) {
    const grant = this.grants.get(id);
    return grant?.tenantId === tenantId ? grant : undefined;
  }

  private effective(grant: PlatformApproval): PlatformApproval {
    const expires = grant.state === 'pending' || grant.state === 'approved';
    return {
      ...grant,
      state:
        expires && Date.parse(grant.expiresAt) <= Date.parse(this.now()) ? 'expired' : grant.state,
    };
  }

  private remember(grant: Approval) {
    const prior = this.grants.get(grant.id);
    if (prior?.state === 'consumed' || prior?.state === 'rejected') return;
    if (prior?.state === 'approved' && grant.state === 'pending') return;
    this.grants.set(grant.id, {
      ...grant,
      state: grant.state === 'denied' ? 'rejected' : grant.state,
    });
  }

  private async execute(request: ToolCall): Promise<ToolResult> {
    const { envelope, tool, input } = request;
    const role = this.directory.resolve(envelope)?.role;
    const allowed =
      tool === 'purchase.order.approve'
        ? role === 'approver'
        : role !== undefined && role !== 'admin' && (tool.endsWith('.read') || role === 'operator');
    const key = requestKey(request);
    const disabled =
      allowed &&
      !this.seen.has(key) &&
      (await this.entitlements.override(envelope.tenantId, toolModules[tool])) === false;
    const approvalId = 'approvalId' in input ? input.approvalId : null;
    const grant = approvalId ? this.grant(envelope.tenantId, approvalId) : undefined;
    if (allowed && (disabled || grant?.state === 'rejected')) {
      await this.auditSink.record(envelope, tool, 'denied');
      return deny(disabled ? 'module_disabled' : 'invalid_approval');
    }

    const result = await this.gateway.call(request);
    if (allowed) this.seen.add(key);
    const prepared =
      result.state === 'pending_approval'
        ? result.approval
        : result.state === 'ok' && 'approval' in result.output
          ? result.output.approval
          : undefined;
    if (prepared) {
      if (this.grant(envelope.tenantId, prepared.id)?.state === 'rejected') {
        await this.auditSink.record(envelope, tool, 'denied');
        return deny('invalid_approval');
      }
      this.remember(prepared);
    }
    const uncertainConsumption =
      result.state === 'unknown' && this.audit().at(-1)?.actionId === result.actionId;
    if (grant && tool === grant.tool && (result.state === 'ok' || uncertainConsumption)) {
      grant.state = 'consumed';
    }
    return result;
  }

  async listApprovals(tenantId: string, state?: PlatformApproval['state']) {
    return [...this.grants.values()]
      .filter((grant) => grant.tenantId === tenantId)
      .map((grant) => this.effective(grant))
      .filter((grant) => state === undefined || grant.state === state);
  }

  sign(context: MutationContext, id: string) {
    return this.queue.run(async () => {
      const grant = await this.pendingFor(context, id, 'sign');
      const envelope: CallEnvelope = {
        ...context,
        version: 'v1',
        idempotencyKey: 'sign-' + randomUUID(),
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
        return this.effective(grant);
      }
      const result = await this.signThroughGovernance(envelope, id);
      if ('code' in result) {
        throw new PlatformError(result.code === 'suppressed' ? 'invalid_approval' : result.code);
      }
      return this.effective({ ...result, state: 'approved' });
    });
  }

  // Keep the governed REST transport's existing signing entry point when it uses this bridge.
  signApproval(envelope: CallEnvelope, id: string) {
    const snapshot = structuredClone(envelope);
    return this.queue.run(() => this.signThroughGovernance(snapshot, id));
  }

  private async signThroughGovernance(envelope: CallEnvelope, id: string) {
    const grant = this.grant(envelope.tenantId, id);
    if (
      grant &&
      this.directory.resolve(envelope)?.role === 'approver' &&
      grant.approverId === envelope.actor.id
    ) {
      const blocked =
        grant.state === 'rejected'
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
    if (!('code' in result)) this.remember(result);
    return result;
  }

  reject(context: MutationContext, id: string, reason: string) {
    return this.queue.run(async () => {
      if (!reason.trim() || reason.length > 500) throw new PlatformError('forbidden');
      const grant = await this.pendingFor(context, id, 'reject');
      await this.auditSink.record(context, 'approval.reject');
      grant.state = 'rejected';
      return this.effective(grant);
    });
  }

  private async pendingFor(context: MutationContext, id: string, operation: 'sign' | 'reject') {
    const role = this.directory.resolve(context)?.role;
    const grant = this.grant(context.tenantId, id);
    if (
      role !== 'approver' ||
      !grant ||
      this.effective(grant).state !== 'pending' ||
      grant.approverId !== context.actor.id ||
      grant.requestedBy === context.actor.id
    ) {
      await this.auditSink.record(context, 'approval.' + operation, 'denied');
      throw new PlatformError(role === 'approver' ? 'invalid_approval' : 'forbidden');
    }
    return grant;
  }
}
