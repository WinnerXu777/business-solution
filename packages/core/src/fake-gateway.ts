import { createHash } from 'node:crypto';
import { createFakeProviders, type ProviderAdapters } from '@bs/adapters';
import { createFixtureRecords, MemoryRecordRepository } from '@bs/business';
import {
  loadDemoFixtures,
  toolModules,
  type Approval,
  type ApprovalAction,
  type AuditEntry,
  type CallEnvelope,
  type DemoFixtures,
  type Denied,
  type MessageChannel,
  type MessagePreview,
  type PurchaseOrderDraft,
  type ToolCall,
  type ToolResult,
  type ToolResultMap,
  type UsageCounterEvent,
} from '@bs/contracts';
import type { ToolGateway } from './index.ts';
import { createFixtureScoringAdapter } from '../../adapters/src/scoring/fixture.ts';
import {
  dispatchRecordTool,
  isReadTool,
  reviewTools,
  visibleDrafts,
  type StoredReview,
} from './governance/records.ts';
import { unavailable } from './governance/results.ts';

const policyVersion = 'fixture-policy-v1';
const approverId = 'actor-approver';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left === right ? 0 : 1,
    );
    return (
      '{' +
      fields.map(([key, field]) => JSON.stringify(key) + ':' + canonical(field)).join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function ok<Output>(output: Output) {
  return { state: 'ok' as const, output };
}

function denied(code: Denied['code']): Denied {
  return { state: 'denied', code, message: code.replaceAll('_', ' ') };
}

function lookup<Output>(output: Output | undefined) {
  return output === undefined ? denied('not_found') : ok(output);
}

function retryableFailure(result: ToolResult) {
  return result.state === 'failed' && result.retryable;
}

type Options = {
  fixtures?: DemoFixtures;
  providers?: ProviderAdapters;
  now?: () => string;
};

/** Deterministic fixture double. Its caller supplies the fixture identity a transport would resolve. */
export class FakeGateway implements ToolGateway {
  private readonly fixtures;
  private readonly records;
  private readonly catalogRecords;
  private readonly reviews = new Map<string, StoredReview>();
  private readonly providers;
  private readonly now;
  private readonly calls = new Map<string, { fingerprint: string; result: ToolResult }>();
  private readonly drafts = new Map<string, PurchaseOrderDraft>();
  private readonly approvedDrafts = new Set<string>();
  private readonly previews = new Map<string, MessagePreview>();
  private readonly approvals = new Map<string, Approval>();
  private readonly auditEntries: AuditEntry[] = [];
  private readonly usageEvents: UsageCounterEvent[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: Options = {}) {
    this.fixtures = structuredClone(options.fixtures ?? loadDemoFixtures());
    this.records = createFixtureRecords(this.fixtures);
    this.catalogRecords = new MemoryRecordRepository(this.fixtures);
    const defaults = createFakeProviders();
    this.providers = options.providers ?? {
      ...defaults,
      scoring: { ...defaults.scoring, forecast: createFixtureScoringAdapter().forecast },
    };
    this.now = options.now ?? (() => this.fixtures.asOf);
  }

  audit(): AuditEntry[] {
    return structuredClone(this.auditEntries);
  }

  usage(): UsageCounterEvent[] {
    return structuredClone(this.usageEvents);
  }

  private role(envelope: CallEnvelope) {
    return this.fixtures.grants.find(
      (grant) =>
        grant.tenantId === envelope.tenantId &&
        grant.actor.id === envelope.actor.id &&
        grant.actor.kind === envelope.actor.kind,
    )?.role;
  }

  // Let lane tests advance a prepared non-PO approval without implementing an approval endpoint.
  approveFixture(envelope: CallEnvelope, approvalId: string): Approval | Denied {
    const approval = this.approvals.get(approvalId);
    if (
      !approval ||
      approval.tool === 'purchase.order.approve' ||
      approval.state !== 'pending' ||
      approval.tenantId !== envelope.tenantId ||
      approval.approverId !== envelope.actor.id ||
      approval.requestedBy === envelope.actor.id ||
      approval.policyVersion !== policyVersion ||
      this.role(envelope) !== 'approver' ||
      Date.parse(approval.expiresAt) <= Date.parse(this.now())
    ) {
      return denied('invalid_approval');
    }
    approval.state = 'approved';
    return structuredClone(approval);
  }

  call<Request extends ToolCall>(request: Request): Promise<ToolResultMap[Request['tool']]>;
  call(request: ToolCall): Promise<ToolResult> {
    const copy = structuredClone(request);
    const result = this.queue.then(() => this.execute(copy));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async execute(request: ToolCall): Promise<ToolResult> {
    const { envelope, tool, input } = request;
    const { tenantId, actor, source, traceId, correlationId, idempotencyKey } = envelope;
    const actionId = hash([tenantId, actor, tool, idempotencyKey]);
    const fingerprint = hash(input);
    const cached = this.calls.get(actionId);
    if (cached?.fingerprint === fingerprint && !retryableFailure(cached.result))
      return structuredClone(cached.result);

    const occurredAt = this.now();
    const module = toolModules[tool];
    const entitlement = this.fixtures.entitlements.find(
      (grant) =>
        grant.tenantId === tenantId &&
        grant.flag.module === module &&
        grant.unit === 'actions' &&
        Date.parse(grant.windowStart) <= Date.parse(occurredAt) &&
        Date.parse(occurredAt) < Date.parse(grant.windowEnd),
    );
    const role = this.role(envelope);
    let result: ToolResult;
    if (cached && cached.fingerprint !== fingerprint) {
      result = denied('idempotency_conflict');
    } else if (
      !role ||
      role === 'admin' ||
      (role === 'reader' && module !== 'records' && !isReadTool(tool)) ||
      (reviewTools.has(tool) && role !== 'approver')
    ) {
      result = denied('forbidden');
    } else if (!entitlement?.flag.enabled) {
      result = denied('module_disabled');
    } else if (
      this.usageEvents.filter(
        (event) =>
          event.tenantId === tenantId &&
          event.module === module &&
          Date.parse(event.occurredAt) >= Date.parse(entitlement.windowStart) &&
          Date.parse(event.occurredAt) < Date.parse(entitlement.windowEnd),
      ).length >= entitlement.allowance
    ) {
      result = denied('quota_exceeded');
    } else {
      result = await this.dispatch(request, actionId);
    }
    if (!cached || cached.fingerprint === fingerprint)
      this.calls.set(actionId, { fingerprint, result: structuredClone(result) });
    this.auditEntries.push({
      id: 'audit-' + (this.auditEntries.length + 1),
      tenantId,
      actor: { ...actor },
      source,
      tool,
      traceId,
      correlationId,
      actionId,
      policyVersion,
      state: result.state,
      occurredAt,
    });
    if (result.state === 'ok') {
      this.usageEvents.push({
        id: 'usage-' + actionId,
        tenantId,
        module,
        outcomeId: actionId,
        unit: 'actions',
        quantity: 1,
        occurredAt,
      });
    }
    return structuredClone(result);
  }

  private prepareApproval(
    envelope: CallEnvelope,
    tool: ApprovalAction,
    subjectId: string,
    material: unknown,
    sourceVersion: number,
  ): Approval {
    const materialHash = hash(material);
    const requestedBy = envelope.actor.id;
    const id =
      'approval-' +
      hash([envelope.tenantId, requestedBy, tool, subjectId, sourceVersion, materialHash]);
    const prior = this.approvals.get(id);
    if (prior) return prior;

    const approval: Approval = {
      id,
      tenantId: envelope.tenantId,
      requestedBy,
      approverId,
      tool,
      subjectId,
      materialHash,
      sourceVersion,
      policyVersion,
      expiresAt: new Date(Date.parse(this.now()) + 60 * 60 * 1000).toISOString(),
      state: 'pending',
    };
    this.approvals.set(id, approval);
    return approval;
  }

  private verifyApproval(
    envelope: CallEnvelope,
    tool: ApprovalAction,
    subjectId: string,
    material: unknown,
    sourceVersion: number,
    approvalId: string,
    isPo: boolean,
  ): Approval | undefined {
    const approval = this.approvals.get(approvalId);
    if (
      approval?.state !== (isPo ? 'pending' : 'approved') ||
      approval.tenantId !== envelope.tenantId ||
      approval.tool !== tool ||
      approval.subjectId !== subjectId ||
      approval.sourceVersion !== sourceVersion ||
      approval.materialHash !== hash(material) ||
      approval.policyVersion !== policyVersion ||
      Date.parse(approval.expiresAt) <= Date.parse(this.now())
    ) {
      return;
    }
    if (
      isPo ? approval.approverId === envelope.actor.id : approval.requestedBy === envelope.actor.id
    ) {
      return approval;
    }
  }

  private preview(tenantId: string, invoiceId: string, channel: MessageChannel) {
    const invoice = this.records.invoice(tenantId, invoiceId);
    if (!invoice) return denied('not_found');
    const customer = this.records.customer(tenantId, invoice.customerId);
    if (!customer?.outreachAllowed || !invoice.balanceCents || invoice.status !== 'overdue')
      return denied('suppressed');
    const preview: MessagePreview = {
      id: 'preview-' + hash([tenantId, channel, invoice.id, invoice.version, customer.version]),
      tenantId,
      channel,
      customerId: customer.id,
      customerVersion: customer.version,
      recipient: channel === 'email' ? customer.email : customer.phone,
      sourceId: invoice.id,
      sourceVersion: invoice.version,
      subject: channel === 'email' ? 'Fixture invoice reminder' : null,
      body:
        channel === 'email'
          ? 'Test reminder for invoice ' + invoice.id + '. Check the fictional account portal.'
          : 'This is a simulation. Check the fictional account portal for a message.',
    };
    this.previews.set(preview.id, preview);
    return ok(preview);
  }

  private async send(
    envelope: CallEnvelope,
    tool: 'collections.email.send' | 'collections.voice.send' | 'collections.sms.send',
    channel: MessageChannel,
    previewId: string,
    approvalId: string | null,
    actionId: string,
  ): Promise<ToolResult> {
    const stored = this.previews.get(previewId);
    if (!stored || stored.tenantId !== envelope.tenantId || stored.channel !== channel)
      return denied('not_found');
    const current = this.preview(envelope.tenantId, stored.sourceId, channel);
    if (current.state !== 'ok') return current;
    const preview = current.output;
    if (preview.id !== previewId) return denied('invalid_approval');
    if (!approvalId) {
      const approval = this.prepareApproval(
        envelope,
        tool,
        previewId,
        preview,
        preview.sourceVersion,
      );
      return approval.state === 'consumed'
        ? denied('invalid_approval')
        : { state: 'pending_approval', approval };
    }

    const approval = this.verifyApproval(
      envelope,
      tool,
      previewId,
      preview,
      preview.sourceVersion,
      approvalId,
      false,
    );
    if (!approval) return denied('invalid_approval');
    approval.state = 'consumed';
    const result = await this.deliver(preview, actionId);
    return 'state' in result ? result : ok(result);
  }

  private async deliver(preview: MessagePreview, actionId: string) {
    try {
      return await this.providers.messages[preview.channel].send(
        structuredClone(preview),
        actionId,
      );
    } catch {
      return { state: 'unknown' as const, actionId, message: 'Delivery needs reconciliation.' };
    }
  }

  private async dispatch(request: ToolCall, actionId: string): Promise<ToolResult> {
    const { envelope, tool, input } = request;
    const { tenantId } = envelope;
    switch (tool) {
      case 'order.read':
        return lookup(this.records.order(tenantId, input.orderId));
      case 'customer.read':
        return lookup(this.records.customer(tenantId, input.customerId));
      case 'invoice.read':
        return lookup(this.records.invoice(tenantId, input.invoiceId));
      case 'purchase.request.read':
        return lookup(this.records.purchaseRequest(tenantId, input.requestId));
      case 'purchase.order.drafts.list':
        return ok(
          visibleDrafts(envelope, this.now(), this.approvals.values(), (id) => this.drafts.get(id)),
        );
      case 'purchase.order.draft': {
        const record = this.records.purchaseRequest(tenantId, input.requestId);
        if (!record) return denied('not_found');
        const { id: requestId, version: sourceVersion, ...material } = record;
        const draft = {
          ...material,
          id: 'draft-' + hash([tenantId, requestId, sourceVersion]),
          requestId,
          sourceVersion,
        };
        const approval = this.prepareApproval(
          envelope,
          'purchase.order.approve',
          draft.id,
          draft,
          sourceVersion,
        );
        this.drafts.set(draft.id, draft);
        return ok({ draft, approval });
      }
      case 'purchase.order.approve': {
        const draft = this.drafts.get(input.draftId);
        if (!draft || draft.tenantId !== tenantId) return denied('not_found');
        const current = this.records.purchaseRequest(tenantId, draft.requestId);
        if (current?.version !== draft.sourceVersion) return denied('invalid_approval');
        const approval = this.verifyApproval(
          envelope,
          tool,
          draft.id,
          draft,
          draft.sourceVersion,
          input.approvalId,
          true,
        );
        if (
          !approval ||
          approval.requestedBy === envelope.actor.id ||
          this.approvedDrafts.has(draft.id)
        ) {
          return denied('invalid_approval');
        }
        const order = {
          id: 'po-' + hash([tenantId, draft.id]),
          draft,
          approvalId: approval.id,
          status: 'approved' as const,
        };
        if (!(await this.catalogRecords.createPurchaseOrder(order)))
          return denied('invalid_approval');
        approval.state = 'consumed';
        this.approvedDrafts.add(draft.id);
        return ok(order);
      }
      case 'collections.email.draft':
        return this.preview(tenantId, input.invoiceId, 'email');
      case 'message.preview':
        return this.preview(tenantId, input.invoiceId, input.channel);
      case 'collections.email.send':
        return this.send(envelope, tool, 'email', input.previewId, input.approvalId, actionId);
      case 'collections.voice.send':
        return this.send(envelope, tool, 'voice', input.previewId, input.approvalId, actionId);
      case 'collections.sms.send':
        return this.send(envelope, tool, 'sms', input.previewId, input.approvalId, actionId);
      case 'workflow.template.run': {
        const previews = this.records
          .customers(tenantId)
          .filter((customer) => customer.lastOrderOn < '2026-06-01' && customer.outreachAllowed)
          .map(
            (customer): MessagePreview => ({
              id: 'win-back-' + hash([tenantId, customer.id, customer.version]),
              tenantId,
              channel: 'email',
              customerId: customer.id,
              customerVersion: customer.version,
              recipient: customer.email,
              sourceId: customer.id,
              sourceVersion: customer.version,
              subject: 'Fixture win-back',
              body: 'Test message from Rivetquay.',
            }),
          );
        const runId = 'run-' + actionId;
        const templateId = input.templateId;
        if (input.mode === 'preview')
          return ok({ runId, templateId, status: 'previewed' as const, previews, receipts: [] });
        if (!input.approvalId) {
          const approval = this.prepareApproval(envelope, tool, templateId, previews, 1);
          return approval.state === 'consumed'
            ? denied('invalid_approval')
            : { state: 'pending_approval', approval };
        }
        const approval = this.verifyApproval(
          envelope,
          tool,
          templateId,
          previews,
          1,
          input.approvalId,
          false,
        );
        if (!approval) return denied('invalid_approval');
        approval.state = 'consumed';
        const receipts = [];
        for (const [index, preview] of previews.entries()) {
          const result = await this.deliver(preview, actionId + '-' + index);
          if ('state' in result) {
            if (index === 0 && result.state === 'failed') {
              if (retryableFailure(result)) approval.state = 'approved';
              return result;
            }
            return {
              state: 'unknown',
              actionId,
              message: 'Workflow delivery needs reconciliation.',
            };
          }
          receipts.push(result);
        }
        return ok({ runId, templateId, status: 'simulated' as const, previews, receipts });
      }
      case 'fraud.score': {
        const order = this.records.order(tenantId, input.orderId);
        return order
          ? ok(await this.providers.scoring.fraud(structuredClone(order)))
          : denied('not_found');
      }
      case 'forecast.run': {
        const isDemand = input.series === 'sku_demand';
        if (isDemand && input.skuId === null) {
          return {
            state: 'failed',
            code: 'invalid_input',
            message: 'SKU is required for SKU demand.',
            retryable: false,
          };
        }
        if (input.skuId !== null && !this.records.sku(tenantId, input.skuId))
          return denied('not_found');
        return ok(await this.providers.scoring.forecast(input, tenantId));
      }
      case 'profile.run': {
        const customer = this.records.customer(tenantId, input.customerId);
        return customer
          ? ok(await this.providers.scoring.profile(structuredClone(customer)))
          : denied('not_found');
      }
      case 'chat.run': {
        if (!this.acceptsRoute(input.route)) return denied('forbidden');
        const audio = this.fixtures.audio.find((fixture) => fixture.id === input.audioFixtureId);
        if (input.audioFixtureId && !audio) return denied('not_found');
        if (input.orderId && audio && input.orderId !== audio.orderId) {
          return {
            state: 'failed',
            code: 'invalid_input',
            message: 'Fixture order mismatch.',
            retryable: false,
          };
        }
        const orderId = input.orderId ?? audio?.orderId;
        const order = orderId ? this.records.order(tenantId, orderId) : null;
        if (order === undefined) return denied('not_found');
        const llm = await this.providers.llm.complete({
          model: 'fixture-chat',
          turns: input.turns,
          maxOutputTokens: 24,
          route: input.route,
        });
        return ok({ sessionId: input.sessionId, reply: llm.text, order, handoff: order === null });
      }
      case 'llm.complete':
        return this.acceptsRoute(input.route)
          ? ok(await this.providers.llm.complete(input))
          : denied('forbidden');
      default:
        return (
          (await dispatchRecordTool(
            request,
            this.catalogRecords,
            this.reviews,
            this.providers.scoring,
          )) ?? unavailable()
        );
    }
  }

  private acceptsRoute(route: DemoFixtures['llmRoutes'][number]) {
    return (
      route.fixtureMode === true &&
      this.fixtures.llmRoutes.some(
        (allowed) => allowed.kind === route.kind && allowed.providerId === route.providerId,
      )
    );
  }
}
