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
  type CompleteLlmInput,
  type DemoFixtures,
  type Entitlement,
  type ModuleId,
  type ToolCall,
  type ToolName,
  type ToolResult,
  type ToolResultMap,
} from '@bs/contracts';
import type { ToolGateway } from '../index.ts';
import { PlatformError, type BillingLedger, type ResolvedBinding } from '../platform/index.ts';
import { GovernanceBilling, billableOutcome, inputTokens, spendAllowed } from './billing.ts';
import { ApprovalLedger, matchesBinding } from './approvals.ts';
import { OutboxWorker } from './outbox.ts';
import { denied, digest, invalidInput, isRetryableOutcome, ok, unavailable } from './results.ts';
import {
  MemoryGovernanceStore,
  type GovernanceStore,
  type StoredApproval,
  type TenantState,
} from './store.ts';
import { createToolHandlers } from './tools.ts';
import { isReadTool, reviewEvidenceTools, reviewTools } from './records.ts';

type GovernancePermission = 'records.read' | 'actions.request' | 'approvals.decide';

export interface GovernedGatewayOptions {
  fixtures?: DemoFixtures;
  records?: RecordRepository;
  providers?: Partial<ProviderAdapters>;
  store?: GovernanceStore;
  now?: () => string;
  policyVersion?: () => string;
  workerClock?: () => number;
  resolveLlmBinding?: (tenantId: string) => Promise<ResolvedBinding>;
  billing?: () => Pick<BillingLedger, 'plan' | 'recordUsage'>;
  onBillingError?: (error: unknown) => void;
  moduleOverride?: (tenantId: string, module: ModuleId) => Promise<boolean | undefined>;
  entitlement?: (tenantId: string, module: ModuleId) => Promise<Entitlement | undefined>;
  identity?: {
    allows(
      scope: Pick<CallEnvelope, 'tenantId' | 'actor'>,
      permission: GovernancePermission,
    ): boolean;
    actors(tenantId: string): CallEnvelope['actor'][];
  };
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
  private readonly billing?: GovernanceBilling;
  private readonly options: GovernedGatewayOptions;
  private readonly moduleOverride: GovernedGatewayOptions['moduleOverride'];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: GovernedGatewayOptions = {}) {
    this.options = options;
    this.fixtures = structuredClone(options.fixtures ?? loadDemoFixtures());
    const startedAt = performance.now();
    const fixtureEpoch = Date.parse(this.fixtures.asOf);
    this.now =
      options.now ?? (() => new Date(fixtureEpoch + performance.now() - startedAt).toISOString());
    this.policyVersion = options.policyVersion ?? (() => 'fixture-policy-v1');
    this.moduleOverride = options.moduleOverride;
    this.store = options.store ?? new MemoryGovernanceStore();
    if (options.billing) this.billing = new GovernanceBilling(options.billing, this.store);
    const records = options.records ?? new MemoryRecordRepository(this.fixtures);
    this.handlers = createToolHandlers(records, this.fixtures, options.providers);
    this.worker = new OutboxWorker({
      store: this.store,
      quote: this.billing
        ? (intent) => billableOutcome(intent.request, this.now(), intent.id, intent.effect)
        : undefined,
      records,
      providers: options.providers,
      clock: options.workerClock,
      authorize: async (state, intent) => {
        const {
          request: { tool, envelope },
          approvalId,
        } = intent;
        const row = state.rows.approval.get(approvalId);
        if (!this.canCall(envelope, tool)) return denied('forbidden');
        if (!row || row.grant.state !== 'consumed' || !(await this.current(row))) {
          if (row) row.grant.state = 'denied';
          return denied('invalid_approval');
        }
        const blocked = await this.checkEntitlement(
          state,
          envelope.tenantId,
          toolModules[tool],
          this.now(),
          intent.id,
        );
        if (blocked || !this.billing) return blocked;
        const reservation = state.rows.outbox.get(intent.id)?.billingReservation;
        if (!reservation) return;
        const billingBlock = await this.billing.reserve(
          state,
          envelope.tenantId,
          reservation,
          intent.id,
        );
        if (billingBlock) return billingBlock;
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
        if (result.state === 'ok') {
          const occurredAt =
            state.rows.outbox.get(intent.id)?.billingReservation?.occurredAt ?? now;
          this.meter(state, intent.request, result, intent.id, occurredAt);
        }
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

  reportingSnapshot(tenantId: string) {
    return this.serialize(() =>
      this.store.transact(tenantId, ({ audit, rows }) => ({
        audit: audit.map(({ hash: _hash, previousHash: _previousHash, ...entry }) => entry),
        usage: [...rows.usage.values()],
      })),
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
    return this.serialize(async () => {
      await this.flushBilling(tenantId);
      await this.worker.drain(tenantId);
      await this.flushBilling(tenantId);
    });
  }

  call<Request extends ToolCall>(request: Request): Promise<ToolResultMap[Request['tool']]>;
  call(request: ToolCall): Promise<ToolResult> {
    const snapshot = structuredClone(request);
    return this.serialize(async () => {
      await this.flushBilling(snapshot.envelope.tenantId);
      const result = await this.execute(snapshot);
      await this.flushBilling(snapshot.envelope.tenantId);
      return result;
    });
  }

  listApprovals(tenantId: string, state?: Approval['state']) {
    return this.store.transact(tenantId, async (stored) => {
      const approvals = new ApprovalLedger(stored.rows.approval);
      const result: (Approval & { materialPreview?: object })[] = [];
      for (const row of approvals.list()) {
        await this.refresh(row);
        const effective = row.rejectionReason !== undefined ? 'rejected' : row.grant.state;
        // Preserve the filter used by callers from before the terminal states were added.
        const visible =
          state === 'denied' && (effective === 'expired' || effective === 'rejected')
            ? 'denied'
            : effective;
        if (state === undefined || state === visible) {
          const grant = { ...row.grant, state: visible };
          const intent =
            visible === 'pending' && grant.tool === 'workflow.template.run'
              ? await this.handlers.currentIntent(tenantId, grant.tool, row.target)
              : undefined;
          const materialPreview =
            intent && matchesBinding(row, intent, this.policyVersion(), this.now())
              ? {
                  subjectId: grant.subjectId,
                  sourceVersion: grant.sourceVersion,
                  ...(Array.isArray(intent.material) && { recipientCount: intent.material.length }),
                }
              : undefined;
          result.push({ ...grant, ...(materialPreview && { materialPreview }) });
        }
      }
      return result;
    });
  }

  approvalPreviews(tenantId: string, approvalId: string) {
    return this.store.transact(tenantId, async (state) => {
      const row = state.rows.approval.get(approvalId);
      if (!row || row.grant.tool !== 'workflow.template.run' || row.grant.state !== 'pending')
        return;
      const intent = await this.handlers.currentIntent(tenantId, row.grant.tool, row.target);
      if (intent && matchesBinding(row, intent, this.policyVersion(), this.now()))
        return intent.material as import('@bs/contracts').MessagePreview[];
    });
  }

  /** PO approval signs and queues creation in the same call. */
  signApproval(envelope: CallEnvelope, id: string) {
    return this.decide(envelope, id, 'approval.sign', async (row, state) => {
      if (
        row.grant.tool === 'purchase.order.approve' ||
        (row.grant.state !== 'pending' && row.grant.state !== 'approved')
      )
        return denied('invalid_approval');
      const blocked = await this.checkEntitlement(
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

  rejectApproval(envelope: CallEnvelope, id: string, reason: string) {
    const trimmed = reason.trim();
    return this.decide(envelope, id, 'approval.reject', (row) => {
      if (!trimmed || trimmed.length > 500)
        return invalidInput('A rejection reason of 1 to 500 characters is required.');
      if (row.rejectionReason === trimmed) return { ...row.grant, state: 'rejected' };
      if (row.grant.state !== 'pending' && row.grant.state !== 'approved')
        return denied('invalid_approval');
      row.rejectionReason = trimmed;
      row.grant.state = 'rejected';
      return row.grant;
    });
  }

  async reject(envelope: CallEnvelope, id: string, reason: string) {
    const result = await this.rejectApproval(envelope, id, reason);
    return 'code' in result ? result : { ...result, state: 'denied' as const };
  }

  private decide<
    Result extends Approval | ReturnType<typeof denied> | ReturnType<typeof invalidInput>,
  >(
    envelope: CallEnvelope,
    id: string,
    action: string,
    decision: (row: StoredApproval, state: TenantState) => Result | Promise<Result>,
  ) {
    const snapshot = structuredClone(envelope);
    return this.serialize(() =>
      this.store.transact(snapshot.tenantId, async (state) => {
        const approvals = new ApprovalLedger(state.rows.approval);
        const row = approvals.get(id);
        let result;
        if (!this.allows(snapshot, 'approvals.decide')) {
          result = denied('forbidden');
        } else if (!row || !approvals.canDecide(snapshot, row.grant)) {
          result = denied('invalid_approval');
        } else {
          await this.refresh(row);
          result = await decision(row, state);
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
      this.actors(grant.tenantId).some(
        (actor) =>
          actor.id === grant.approverId &&
          actor.kind === 'person' &&
          this.allows({ tenantId: grant.tenantId, actor }, 'approvals.decide'),
      ) &&
      this.actors(grant.tenantId).some(
        (actor) =>
          actor.id === grant.requestedBy &&
          this.allows({ tenantId: grant.tenantId, actor }, 'actions.request'),
      )
    );
  }

  private async refresh(row: StoredApproval) {
    if (
      (row.grant.state === 'pending' || row.grant.state === 'approved') &&
      !(await this.current(row))
    ) {
      row.grant.state =
        Date.parse(row.grant.expiresAt) <= Date.parse(this.now()) ? 'expired' : 'denied';
    }
  }

  private serialize<Result>(operation: () => Result | Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private actors(tenantId: string) {
    return (
      this.options.identity?.actors(tenantId) ??
      this.fixtures.grants.filter((grant) => grant.tenantId === tenantId).map(({ actor }) => actor)
    );
  }

  private canCall(scope: CallEnvelope, tool: ToolName) {
    if (reviewTools.has(tool)) return this.allows(scope, 'approvals.decide');
    if (isReadTool(tool)) return this.allows(scope, 'records.read');
    return (
      this.allows(scope, 'actions.request') ||
      (reviewEvidenceTools.has(tool) && this.allows(scope, 'approvals.decide'))
    );
  }

  private allows(
    scope: Pick<CallEnvelope, 'tenantId' | 'actor'>,
    permission: GovernancePermission,
  ) {
    if (this.options.identity) return this.options.identity.allows(scope, permission);
    const { tenantId, actor } = scope;
    const role: ActorGrant['role'] | undefined = this.fixtures.grants.find(
      (grant) =>
        grant.tenantId === tenantId &&
        grant.actor.id === actor.id &&
        grant.actor.kind === actor.kind,
    )?.role;
    if (permission === 'approvals.decide') return role === 'approver';
    if (permission === 'actions.request') return role === 'operator';
    return role !== undefined && role !== 'admin';
  }

  private async checkEntitlement(
    state: TenantState,
    tenantId: string,
    module: ModuleId,
    now: string,
    excludeJob?: string,
  ) {
    const instant = Date.parse(now);
    const entitlement = this.options.entitlement
      ? await this.options.entitlement(tenantId, module)
      : this.fixtures.entitlements.find(
          (row) =>
            row.tenantId === tenantId &&
            row.flag.module === module &&
            row.unit === 'actions' &&
            Date.parse(row.windowStart) <= instant &&
            instant < Date.parse(row.windowEnd),
        );
    const override = await this.moduleOverride?.(tenantId, module);
    if (!entitlement || !(override ?? entitlement.flag.enabled)) return denied('module_disabled');
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

  private async flushBilling(tenantId: string) {
    await this.billing
      ?.flush(tenantId)
      .catch((error: unknown) => this.options.onBillingError?.(error));
  }

  private async complete(
    state: TenantState,
    envelope: CallEnvelope,
    actionId: string,
    occurredAt: string,
    input: CompleteLlmInput,
    tool: ToolName,
    onBinding: (pin: { providerId: string; bindingVersion: number }) => void,
  ): Promise<ToolResult> {
    const adapter = this.options.providers?.llm;
    if (!adapter) return unavailable();
    if (!this.options.resolveLlmBinding) return ok(await adapter.complete(input));
    let binding: ResolvedBinding;
    try {
      binding = await this.options.resolveLlmBinding(envelope.tenantId);
    } catch (error) {
      if (error instanceof PlatformError && error.code === 'forbidden') return denied('forbidden');
      return unavailable();
    }
    const routeKind =
      binding.version === 1
        ? input.route.kind
        : binding.provider.mode === 'native'
          ? 'native'
          : 'byo';
    const route = this.fixtures.llmRoutes.find(({ kind }) => kind === routeKind);
    if (!route) return unavailable();
    const spendBlock = spendAllowed(binding, routeKind);
    if (spendBlock) return spendBlock;
    const reservation = {
      skuId: 'platform' as const,
      unit: 'tokens',
      outcomeId: actionId,
      quantity: inputTokens(input.turns) + input.maxOutputTokens,
      occurredAt,
    };
    const blocked = await this.billing?.reserve(state, envelope.tenantId, reservation, actionId);
    if (blocked) return blocked;
    const entitlementBlock = await this.checkEntitlement(
      state,
      envelope.tenantId,
      toolModules[tool],
      this.now(),
    );
    if (entitlementBlock) return entitlementBlock;
    onBinding({
      providerId: binding.version === 1 ? route.providerId : binding.provider.providerId,
      bindingVersion: binding.version,
    });
    const completion = await adapter.complete({ ...input, route });
    const quantity = completion.inputTokens + completion.outputTokens;
    if (quantity > reservation.quantity) throw new Error('Fixture exceeded reserved token units.');
    this.billing?.inference(state, envelope, { ...reservation, quantity }, binding, routeKind);
    return ok({
      ...completion,
      route: {
        ...completion.route,
        providerId: binding.version === 1 ? route.providerId : binding.provider.providerId,
      },
    });
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
        let llmBinding: { providerId: string; bindingVersion: number } | undefined;
        if (!this.canCall(envelope, tool)) {
          result = denied('forbidden');
        } else if (cached) {
          if (cached.fingerprint !== fingerprint) {
            result = denied('idempotency_conflict');
          } else {
            result = cached.result;
            const approval =
              result.state === 'pending_approval'
                ? result.approval
                : result.state === 'ok' &&
                    result.output &&
                    typeof result.output === 'object' &&
                    'approval' in result.output
                  ? result.output.approval
                  : undefined;
            if (approval) {
              const row = state.rows.approval.get(approval.id);
              if (row) await this.refresh(row);
              if (row && ['denied', 'rejected', 'expired'].includes(row.grant.state)) {
                result = denied('invalid_approval');
              }
            }
            const job = state.rows.outbox.get(actionId);
            dispatch = job?.status === 'queued' || job?.status === 'retryable';
          }
        } else {
          const entitlementBlock = await this.checkEntitlement(
            state,
            tenantId,
            toolModules[tool],
            occurredAt,
          );
          const reservation = billableOutcome(request, occurredAt, actionId);
          const blocked =
            entitlementBlock ??
            (reservation && (await this.billing?.reserve(state, tenantId, reservation, actionId)));
          result =
            blocked ??
            (await this.handlers.dispatch(
              request,
              {
                envelope,
                actionId,
                policyVersion,
                now: occurredAt,
                approverId: this.actors(tenantId).find(
                  (candidate) =>
                    candidate.kind === 'person' &&
                    candidate.id !== actor.id &&
                    this.allows({ tenantId, actor: candidate }, 'approvals.decide'),
                )?.id,
                complete: (input) =>
                  this.complete(state, envelope, actionId, occurredAt, input, tool, (binding) => {
                    llmBinding = binding;
                  }),
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
          if (result.state === 'ok') this.meter(state, request, result, actionId, occurredAt);
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
        this.appendAudit(
          state,
          envelope,
          tool,
          actionId,
          policyVersion,
          result.state,
          occurredAt,
          llmBinding,
        );
        return { result, dispatch };
      })
      .catch(() => ({ result: unavailable(), dispatch: false }));
    if (!dispatch) return result;
    return (await this.worker.process(tenantId, actionId, true).catch(() => undefined)) ?? result;
  }

  private meter(
    state: TenantState,
    request: ToolCall,
    result: ToolResult,
    actionId: string,
    occurredAt: string,
  ) {
    const { envelope, tool } = request;
    const id = 'usage-' + actionId;
    const counter = {
      id,
      tenantId: envelope.tenantId,
      module: toolModules[tool],
      outcomeId: actionId,
      unit: 'actions' as const,
      quantity: 1,
      occurredAt,
    };
    state.rows.usage.set(id, counter);
    this.billing?.outcome(state, request, result, counter);
  }

  private appendAudit(
    state: TenantState,
    { tenantId, actor, source, traceId, correlationId }: CallEnvelope,
    tool: string,
    actionId: string,
    policyVersion: string,
    result: AuditEntry['state'],
    occurredAt: string,
    llmBinding?: { providerId: string; bindingVersion: number },
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
      ...llmBinding,
    };
    state.audit.push({ ...entry, hash: digest(entry) });
  }
}
