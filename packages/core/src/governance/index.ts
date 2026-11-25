import { randomUUID } from 'node:crypto';
import type { ProviderAdapters } from '@bs/adapters';
import { MemoryRecordRepository, type RecordRepository } from '@bs/business';
import {
  loadDemoFixtures,
  toolModules,
  type ActorGrant,
  type AuditEntry,
  type CallEnvelope,
  type DemoFixtures,
  type ModuleId,
  type ToolCall,
  type ToolName,
  type ToolResult,
  type ToolResultMap,
  type UsageCounterEvent,
} from '@bs/contracts';
import type { ToolGateway } from '../index.ts';
import { ApprovalLedger } from './approvals.ts';
import { denied, digest, isRetryableOutcome, unavailable } from './results.ts';
import { createToolHandlers } from './tools.ts';

export interface GovernedGatewayOptions {
  fixtures?: DemoFixtures;
  records?: RecordRepository;
  providers?: Partial<ProviderAdapters>;
  now?: () => string;
  policyVersion?: () => string;
}

function allows(role: ActorGrant['role'] | undefined, tool: ToolName) {
  if (tool === 'purchase.order.approve') return role === 'approver';
  return role !== undefined && (tool.endsWith('.read') || role === 'operator');
}

export class GovernedGateway implements ToolGateway {
  private readonly fixtures: DemoFixtures;
  private readonly now: () => string;
  private readonly policyVersion: () => string;
  private readonly dispatch: ReturnType<typeof createToolHandlers>;
  private readonly approvals = new ApprovalLedger();
  private readonly outcomes = new Map<string, { fingerprint: string; result: ToolResult }>();
  private readonly entries: AuditEntry[] = [];
  private readonly events: UsageCounterEvent[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: GovernedGatewayOptions = {}) {
    this.fixtures = structuredClone(options.fixtures ?? loadDemoFixtures());
    const startedAt = performance.now();
    const fixtureEpoch = Date.parse(this.fixtures.asOf);
    this.now =
      options.now ?? (() => new Date(fixtureEpoch + performance.now() - startedAt).toISOString());
    this.policyVersion = options.policyVersion ?? (() => 'fixture-policy-v1');
    this.dispatch = createToolHandlers(
      options.records ?? new MemoryRecordRepository(this.fixtures),
      this.approvals,
      this.fixtures,
      options.providers,
    );
  }

  audit(): AuditEntry[] {
    return structuredClone(this.entries);
  }

  usage(): UsageCounterEvent[] {
    return structuredClone(this.events);
  }

  call<Request extends ToolCall>(request: Request): Promise<ToolResultMap[Request['tool']]>;
  call(request: ToolCall): Promise<ToolResult> {
    const snapshot = structuredClone(request);
    return this.serialize(() => this.execute(snapshot));
  }

  /** Signs a non-PO grant using a trusted approver identity. PO approval signs and creates in one call. */
  signApproval(envelope: CallEnvelope, approvalId: string) {
    const snapshot = structuredClone(envelope);
    return this.serialize(() => {
      const grant = this.approvals.get(approvalId);
      const occurredAt = this.now();
      const policyVersion = this.policyVersion();
      const result =
        this.role(snapshot) !== 'approver'
          ? denied('forbidden')
          : !grant || grant.tenantId !== snapshot.tenantId
            ? denied('invalid_approval')
            : (this.checkEntitlement(snapshot.tenantId, toolModules[grant.tool], occurredAt) ??
              this.approvals.sign(snapshot, approvalId, policyVersion, occurredAt));
      this.appendAudit(
        snapshot,
        'approval.sign',
        digest([snapshot.tenantId, snapshot.actor, 'approval.sign', snapshot.idempotencyKey]),
        policyVersion,
        'code' in result ? 'denied' : 'ok',
        occurredAt,
      );
      return result;
    });
  }

  private serialize<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    // Keep quota checks, grant consumption and outcome publication in one process-wide sequence.
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private role({ tenantId, actor }: CallEnvelope) {
    return this.fixtures.grants.find(
      (grant) =>
        grant.tenantId === tenantId &&
        grant.actor.id === actor.id &&
        grant.actor.kind === actor.kind,
    )?.role;
  }

  private checkEntitlement(tenantId: string, module: ModuleId, now: string) {
    const instant = Date.parse(now);
    const entitlement = this.fixtures.entitlements.find(
      (row) =>
        row.tenantId === tenantId &&
        row.flag.module === module &&
        row.unit === 'actions' &&
        Date.parse(row.windowStart) <= instant &&
        instant < Date.parse(row.windowEnd),
    );
    if (!entitlement?.flag.enabled) return denied('module_disabled');
    const used = this.events.filter(
      (event) =>
        event.tenantId === tenantId &&
        event.module === module &&
        Date.parse(entitlement.windowStart) <= Date.parse(event.occurredAt) &&
        Date.parse(event.occurredAt) < Date.parse(entitlement.windowEnd),
    ).length;
    if (used >= entitlement.allowance) return denied('quota_exceeded');
  }

  private async execute(request: ToolCall): Promise<ToolResult> {
    const { tool, envelope, input } = request;
    const { tenantId, actor, idempotencyKey } = envelope;
    const actionId = digest([tenantId, actor.id, actor.kind, tool, idempotencyKey]);
    const fingerprint = digest(input);
    const occurredAt = this.now();
    const policyVersion = this.policyVersion();
    const module = toolModules[tool];
    const cached = this.outcomes.get(actionId);
    let result: ToolResult;
    if (!allows(this.role(envelope), tool)) {
      result = denied('forbidden');
    } else if (cached) {
      result = cached.fingerprint === fingerprint ? cached.result : denied('idempotency_conflict');
    } else {
      const blocked = this.checkEntitlement(tenantId, module, occurredAt);
      result =
        blocked ??
        (await this.dispatch(request, {
          envelope,
          actionId,
          policyVersion,
          now: this.now,
          approverId: this.fixtures.grants.find(
            (grant) =>
              grant.tenantId === tenantId &&
              grant.role === 'approver' &&
              grant.actor.id !== actor.id,
          )?.actor.id,
          authorizeEffect: () =>
            this.policyVersion() !== policyVersion
              ? denied('invalid_approval')
              : this.checkEntitlement(tenantId, module, this.now()),
        }).catch(() => unavailable()));
      if (!isRetryableOutcome(result)) {
        this.outcomes.set(actionId, { fingerprint, result: structuredClone(result) });
      }
      if (result.state === 'ok') {
        this.events.push({
          id: 'usage-' + actionId,
          tenantId,
          module,
          outcomeId: actionId,
          unit: 'actions',
          quantity: 1,
          occurredAt,
        });
      }
    }
    this.appendAudit(envelope, tool, actionId, policyVersion, result.state, occurredAt);
    return structuredClone(result);
  }

  private appendAudit(
    { tenantId, actor, source, traceId, correlationId }: CallEnvelope,
    tool: string,
    actionId: string,
    policyVersion: string,
    state: AuditEntry['state'],
    occurredAt: string,
  ) {
    this.entries.push({
      id: 'audit-' + randomUUID(),
      tenantId,
      actor: { id: actor.id, kind: actor.kind },
      source,
      tool,
      traceId,
      correlationId,
      actionId,
      policyVersion,
      state,
      occurredAt,
    });
  }
}
