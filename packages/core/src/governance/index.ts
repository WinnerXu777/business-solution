import { randomUUID } from 'node:crypto';
import type { ProviderAdapters } from '@bs/adapters';
import { MemoryRecordRepository, type RecordRepository } from '@bs/business';
import {
  loadDemoFixtures,
  toolModules,
  type ActorGrant,
  type Approval,
  type AuditEntry,
  type CallEnvelope,
  type DemoFixtures,
  type ModuleId,
  type ToolCall,
  type ToolName,
  type ToolResult,
  type ToolResultMap,
} from '@bs/contracts';
import type { ToolGateway } from '../index.ts';
import { ApprovalLedger, matchesBinding } from './approvals.ts';
import { OutboxWorker } from './outbox.ts';
import { denied, digest, invalidInput, isRetryableOutcome, unavailable } from './results.ts';
import {
  MemoryGovernanceStore,
  type GovernanceStore,
  type StoredApproval,
  type TenantState,
} from './store.ts';
import { createToolHandlers } from './tools.ts';

export interface GovernedGatewayOptions {
  fixtures?: DemoFixtures;
  records?: RecordRepository;
  providers?: Partial<ProviderAdapters>;
  store?: GovernanceStore;
  now?: () => string;
  policyVersion?: () => string;
  workerClock?: () => number;
}

function allows(role: ActorGrant['role'] | undefined, tool: ToolName) {
  if (tool === 'purchase.order.approve') return role === 'approver';
  return role !== undefined && (tool.endsWith('.read') || role === 'operator');
}

function actionKey({ tenantId, actor, idempotencyKey }: CallEnvelope, action: string) {
  return digest([tenantId, actor.id, actor.kind, action, idempotencyKey]);
}

export class GovernedGateway implements ToolGateway {
  private readonly fixtures: DemoFixtures;
  private readonly now: () => string;
  private readonly policyVersion: () => string;
  private readonly handlers: ReturnType<typeof createToolHandlers>;
  private readonly store: GovernanceStore;
  private readonly worker: OutboxWorker;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: GovernedGatewayOptions = {}) {
    this.fixtures = structuredClone(options.fixtures ?? loadDemoFixtures());
    const startedAt = performance.now();
    const fixtureEpoch = Date.parse(this.fixtures.asOf);
    this.now =
      options.now ?? (() => new Date(fixtureEpoch + performance.now() - startedAt).toISOString());
    this.policyVersion = options.policyVersion ?? (() => 'fixture-policy-v1');
    this.store = options.store ?? new MemoryGovernanceStore();
    const records = options.records ?? new MemoryRecordRepository(this.fixtures);
    this.handlers = createToolHandlers(records, this.fixtures, options.providers);
    this.worker = new OutboxWorker({
      store: this.store,
      records,
      providers: options.providers,
      clock: options.workerClock,
      authorize: async (state, intent) => {
        const {
          request: { tool, envelope },
          approvalId,
        } = intent;
        const row = state.rows.approval.get(approvalId);
        if (!allows(this.role(envelope), tool)) return denied('forbidden');
        if (!row || row.grant.state !== 'consumed' || !(await this.current(row))) {
          if (row) row.grant.state = 'denied';
          return denied('invalid_approval');
        }
        return this.checkEntitlement(
          state,
          envelope.tenantId,
          toolModules[tool],
          this.now(),
          intent.id,
        );
      },
      settle: (state, intent, result) => {
        const { envelope, tool } = intent.request;
        const outcome = state.rows.outcome.get(intent.id);
        if (!outcome) throw new Error('Outbox outcome missing.');
        outcome.result = result;
        const now = this.now();
        if (result.state === 'ok') this.meter(state, envelope, tool, intent.id, now);
        this.appendAudit(
          state,
          { ...envelope, source: 'worker' },
          tool,
          intent.id,
          this.policyVersion(),
          result.state,
          now,
        );
      },
    });
  }

  private memorySnapshot() {
    if (!(this.store instanceof MemoryGovernanceStore)) {
      throw new Error('Use the tenant-scoped governance readers with durable storage.');
    }
    return this.store.snapshot();
  }

  audit(): AuditEntry[] {
    return this.memorySnapshot().flatMap(({ audit }) =>
      audit.map(({ hash: _hash, previousHash: _previousHash, ...entry }) => entry),
    );
  }

  usage() {
    return this.memorySnapshot().flatMap(({ rows }) => [...rows.usage.values()]);
  }

  exportAudit(tenantId: string) {
    return this.store.transact(tenantId, ({ audit }) =>
      audit.map((entry) => JSON.stringify(entry) + '\n').join(''),
    );
  }

  listUsage(tenantId: string) {
    return this.store.transact(tenantId, ({ rows }) => [...rows.usage.values()]);
  }

  listDeadLetters(tenantId: string) {
    return this.store.transact(tenantId, ({ rows }) =>
      [...rows.outbox.values()]
        .filter((job) => job.status === 'dead_letter')
        .map((job) => {
          const intent = rows.intent.get(job.id)!;
          return {
            actionId: job.id,
            tool: intent.request.tool,
            approvalId: intent.approvalId,
            reason: job.reviewReason,
            attempts: job.attempts,
            reconciliationChecks: job.checks,
            unresolved: job.unresolved === true,
          };
        }),
    );
  }

  dispatchOutbox(tenantId: string) {
    return this.serialize(() => this.worker.drain(tenantId));
  }

  call<Request extends ToolCall>(request: Request): Promise<ToolResultMap[Request['tool']]>;
  call(request: ToolCall): Promise<ToolResult> {
    const snapshot = structuredClone(request);
    return this.serialize(() => this.execute(snapshot));
  }

  listApprovals(tenantId: string, state?: Approval['state']) {
    return this.store.transact(tenantId, async (stored) => {
      const approvals = new ApprovalLedger(stored.rows.approval);
      const result: Approval[] = [];
      for (const row of approvals.list()) {
        await this.refresh(row);
        if (state === undefined || state === row.grant.state) result.push(row.grant);
      }
      return result;
    });
  }

  /** PO approval signs and queues creation in the same call. */
  signApproval(envelope: CallEnvelope, id: string) {
    return this.decide(envelope, id, 'approval.sign', (row, state) => {
      if (row.grant.tool === 'purchase.order.approve' || row.grant.state !== 'pending')
        return denied('invalid_approval');
      const blocked = this.checkEntitlement(
        state,
        row.grant.tenantId,
        toolModules[row.grant.tool],
        this.now(),
      );
      if (blocked) return blocked;
      row.grant.state = 'approved';
      return row.grant;
    });
  }

  reject(envelope: CallEnvelope, id: string, reason: string) {
    const trimmed = reason.trim();
    return this.decide(envelope, id, 'approval.reject', (row) => {
      if (!trimmed || trimmed.length > 500)
        return invalidInput('A rejection reason of 1 to 500 characters is required.');
      if (row.grant.state === 'denied' && row.rejectionReason === trimmed) return row.grant;
      if (row.grant.state !== 'pending' && row.grant.state !== 'approved')
        return denied('invalid_approval');
      row.rejectionReason = trimmed;
      row.grant.state = 'denied';
      return row.grant;
    });
  }

  private decide<
    Result extends Approval | ReturnType<typeof denied> | ReturnType<typeof invalidInput>,
  >(
    envelope: CallEnvelope,
    id: string,
    action: string,
    decision: (row: StoredApproval, state: TenantState) => Result,
  ) {
    const snapshot = structuredClone(envelope);
    return this.serialize(() =>
      this.store.transact(snapshot.tenantId, async (state) => {
        const approvals = new ApprovalLedger(state.rows.approval);
        const row = approvals.get(id);
        let result;
        if (this.role(snapshot) !== 'approver') {
          result = denied('forbidden');
        } else if (!row || !approvals.canDecide(snapshot, row.grant)) {
          result = denied('invalid_approval');
        } else {
          await this.refresh(row);
          result = decision(row, state);
        }
        this.appendAudit(
          state,
          snapshot,
          action,
          actionKey(snapshot, action),
          this.policyVersion(),
          'code' in result ? result.state : 'ok',
          this.now(),
        );
        return result;
      }),
    );
  }

  private async current(row: StoredApproval) {
    const { grant, target } = row;
    const intent = await this.handlers.currentIntent(grant.tenantId, grant.tool, target);
    return (
      matchesBinding(row, intent, this.policyVersion(), this.now()) &&
      this.fixtures.grants.some(
        (identity) =>
          identity.tenantId === grant.tenantId &&
          identity.actor.id === grant.approverId &&
          identity.role === 'approver',
      ) &&
      this.fixtures.grants.some(
        (identity) =>
          identity.tenantId === grant.tenantId &&
          identity.actor.id === grant.requestedBy &&
          identity.role === 'operator',
      )
    );
  }

  private async refresh(row: StoredApproval) {
    if (
      (row.grant.state === 'pending' || row.grant.state === 'approved') &&
      !(await this.current(row))
    ) {
      row.grant.state = 'denied';
    }
  }

  private serialize<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
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

  private checkEntitlement(
    state: TenantState,
    tenantId: string,
    module: ModuleId,
    now: string,
    excludeJob?: string,
  ) {
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
    const inWindow = (time: string) =>
      Date.parse(entitlement.windowStart) <= Date.parse(time) &&
      Date.parse(time) < Date.parse(entitlement.windowEnd);
    const used = [...state.rows.usage.values()].filter(
      (event) => event.module === module && inWindow(event.occurredAt),
    ).length;
    const reserved = [...state.rows.outbox.values()].filter((job) => {
      const intent = state.rows.intent.get(job.id)!;
      return (
        job.id !== excludeJob &&
        toolModules[intent.request.tool] === module &&
        inWindow(intent.acceptedAt) &&
        (job.unresolved || ['queued', 'running'].includes(job.status))
      );
    }).length;
    if (used + reserved >= entitlement.allowance) return denied('quota_exceeded');
  }

  private async execute(request: ToolCall): Promise<ToolResult> {
    const { tool, envelope, input } = request;
    const { tenantId, actor } = envelope;
    const actionId = actionKey(envelope, tool);
    const fingerprint = digest(input);
    const { result, dispatch } = await this.store
      .transact(tenantId, async (state) => {
        const occurredAt = this.now();
        const policyVersion = this.policyVersion();
        const cached = state.rows.outcome.get(actionId);
        let dispatch = false;
        let result: ToolResult;
        if (!allows(this.role(envelope), tool)) {
          result = denied('forbidden');
        } else if (cached) {
          if (cached.fingerprint !== fingerprint) {
            result = denied('idempotency_conflict');
          } else {
            result = cached.result;
            const approval =
              result.state === 'pending_approval'
                ? result.approval
                : result.state === 'ok' && 'approval' in result.output
                  ? result.output.approval
                  : undefined;
            if (approval) {
              const row = state.rows.approval.get(approval.id);
              if (row) await this.refresh(row);
              if (row?.grant.state === 'denied') result = denied('invalid_approval');
            }
            const job = state.rows.outbox.get(actionId);
            dispatch = job?.status === 'queued' || job?.status === 'retryable';
          }
        } else {
          const blocked = this.checkEntitlement(state, tenantId, toolModules[tool], occurredAt);
          result =
            blocked ??
            (await this.handlers.dispatch(
              request,
              {
                envelope,
                actionId,
                policyVersion,
                now: occurredAt,
                approverId: this.fixtures.grants.find(
                  (grant) =>
                    grant.tenantId === tenantId &&
                    grant.role === 'approver' &&
                    grant.actor.id !== actor.id,
                )?.actor.id,
                stage: (target, approvalId, effect) => {
                  dispatch = true;
                  state.rows.intent.set(actionId, {
                    id: actionId,
                    request,
                    target,
                    approvalId,
                    effect,
                    acceptedAt: occurredAt,
                  });
                  state.rows.outbox.set(actionId, {
                    id: actionId,
                    status: 'queued',
                    attempts: 0,
                    checks: 0,
                    nextAttemptAt: 0,
                  });
                },
              },
              state,
            ));
          if (dispatch || (result.state !== 'unknown' && !isRetryableOutcome(result))) {
            state.rows.outcome.set(actionId, { fingerprint, result: structuredClone(result) });
          }
          if (result.state === 'ok') this.meter(state, envelope, tool, actionId, occurredAt);
          if (
            result.state === 'denied' &&
            (result.code === 'invalid_approval' ||
              result.code === 'suppressed' ||
              result.code === 'not_found') &&
            'approvalId' in input &&
            input.approvalId
          ) {
            const row = state.rows.approval.get(input.approvalId);
            if (row?.grant.tool === tool) await this.refresh(row);
          }
        }
        this.appendAudit(state, envelope, tool, actionId, policyVersion, result.state, occurredAt);
        return { result, dispatch };
      })
      .catch(() => ({ result: unavailable(), dispatch: false }));
    if (!dispatch) return result;
    return (await this.worker.process(tenantId, actionId, true).catch(() => undefined)) ?? result;
  }

  private meter(
    state: TenantState,
    envelope: CallEnvelope,
    tool: ToolName,
    actionId: string,
    occurredAt: string,
  ) {
    const id = 'usage-' + actionId;
    state.rows.usage.set(id, {
      id,
      tenantId: envelope.tenantId,
      module: toolModules[tool],
      outcomeId: actionId,
      unit: 'actions',
      quantity: 1,
      occurredAt,
    });
  }

  private appendAudit(
    state: TenantState,
    { tenantId, actor, source, traceId, correlationId }: CallEnvelope,
    tool: string,
    actionId: string,
    policyVersion: string,
    result: AuditEntry['state'],
    occurredAt: string,
  ) {
    const previousHash = state.audit.at(-1)?.hash ?? null;
    const entry = {
      id: 'audit-' + randomUUID(),
      tenantId,
      actor: { id: actor.id, kind: actor.kind },
      source,
      tool,
      traceId,
      correlationId,
      actionId,
      policyVersion,
      state: result,
      occurredAt,
      previousHash,
    };
    state.audit.push({ ...entry, hash: digest(entry) });
  }
}
