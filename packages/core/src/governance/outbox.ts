import { randomUUID } from 'node:crypto';
import type { ProviderAdapters } from '@bs/adapters';
import type { RecordRepository } from '@bs/business';
import type { DeliveryReceipt, Denied, ToolResult } from '@bs/contracts';
import { digest, denied, isRetryableOutcome, ok, unavailable, unknownOutcome } from './results.ts';
import type { Effect, GovernanceStore, OutboxJob, StoredIntent, TenantState } from './store.ts';

interface WorkerOptions {
  store: GovernanceStore;
  records: RecordRepository;
  providers?: Partial<ProviderAdapters>;
  authorize(state: TenantState, intent: StoredIntent): Promise<Denied | undefined>;
  settle(state: TenantState, intent: StoredIntent, result: ToolResult): void;
  clock?: () => number;
}

const maxAttempts = 3;
const retryDelay = 5_000;
const claimTimeout = 60_000;
const unresolved = 'unknown' as const;
const notApplied = 'not_applied' as const;

type Reconciliation = ToolResult | typeof unresolved | typeof notApplied;

export class OutboxWorker {
  private readonly options: WorkerOptions;
  private readonly now: () => number;

  constructor(options: WorkerOptions) {
    this.options = options;
    this.now = options.clock ?? Date.now;
  }

  async drain(tenantId: string) {
    const jobs = await this.options.store.transact(tenantId, ({ rows }) =>
      [...rows.outbox.values()]
        .filter(
          (job) =>
            job.status !== 'completed' &&
            job.status !== 'dead_letter' &&
            job.nextAttemptAt <= this.now(),
        )
        .map((job) => job.id),
    );
    for (const id of jobs) await this.process(tenantId, id, false);
  }

  async process(tenantId: string, id: string, immediate: boolean): Promise<ToolResult | undefined> {
    const { store } = this.options;
    const claim = randomUUID();
    const claimed = await store.transact(tenantId, ({ rows }) => {
      const job = rows.outbox.get(id);
      if (!job || job.status === 'completed' || job.status === 'dead_letter') return false;
      const ready = job.nextAttemptAt <= this.now();
      if (!ready && !(immediate && job.status === 'retryable')) return false;
      if (immediate && (job.status === 'running' || job.status === 'unknown')) return false;

      // An expired claim may have made its external write before losing its transaction.
      job.unresolved = job.status === 'running' || job.status === 'unknown';
      job.status = 'running';
      job.claim = claim;
      job.nextAttemptAt = this.now() + claimTimeout;
      return true;
    });
    if (!claimed) return;

    return store.transact(tenantId, async (state) => {
      const job = state.rows.outbox.get(id);
      if (job?.claim !== claim) return;
      const intent = state.rows.intent.get(id);
      if (!intent) throw new Error('Outbox intent missing.');
      let result: ToolResult;
      if (job.unresolved) {
        job.checks++;
        const reconciliation = await this.reconcile(tenantId, intent).catch(() => unresolved);
        if (reconciliation === unresolved) {
          result = unknownOutcome(job.id);
          return this.finish(state, job, intent, result);
        }
        job.unresolved = false;
        if (reconciliation !== notApplied) return this.finish(state, job, intent, reconciliation);
      }

      const blocked = await this.options.authorize(state, intent);
      if (blocked) return this.finish(state, job, intent, blocked);
      if (job.attempts >= maxAttempts) {
        job.reviewReason = 'attempts_exhausted';
        return this.finish(state, job, intent, unavailable());
      }
      job.attempts++;
      // The store lock covers this claim until settlement. A lost transaction leaves
      // the committed running marker behind for a later reconciliation pass.
      result = await this.dispatch(intent).catch(() => unknownOutcome(job.id));
      if (result.state === 'unknown') result = unknownOutcome(job.id);
      return this.finish(state, job, intent, result);
    });
  }

  private finish(state: TenantState, job: OutboxJob, intent: StoredIntent, result: ToolResult) {
    delete job.claim;
    job.nextAttemptAt = this.now() + retryDelay;
    job.unresolved = result.state === 'unknown';
    if (job.unresolved) {
      job.status = job.checks < maxAttempts ? 'unknown' : 'dead_letter';
      if (job.status === 'dead_letter') job.reviewReason = 'reconciliation_required';
    } else if (isRetryableOutcome(result) && job.attempts < maxAttempts && !job.reviewReason) {
      job.status = 'retryable';
    } else if (result.state === 'failed') {
      job.status = 'dead_letter';
      job.reviewReason ??= result.retryable ? 'attempts_exhausted' : 'dispatch_failed';
      result = { ...result, retryable: false };
    } else {
      job.status = 'completed';
    }
    this.options.settle(state, intent, result);
    return result;
  }

  private workflowResult(
    intent: StoredIntent,
    effect: Extract<Effect, { kind: 'workflow' }>,
    receipts: DeliveryReceipt[],
  ) {
    return ok({
      runId: 'run-' + intent.id,
      templateId: effect.templateId,
      status: 'simulated' as const,
      previews: effect.previews,
      receipts,
    });
  }

  private async dispatch(intent: StoredIntent): Promise<ToolResult> {
    const { records, providers } = this.options;
    const { effect, id } = intent;
    if (effect.kind === 'purchase') {
      return (await records.createPurchaseOrder(structuredClone(effect.order)))
        ? ok(effect.order)
        : denied('invalid_approval');
    }
    if (effect.kind === 'message') {
      const adapter = providers?.messages?.[effect.preview.channel];
      if (!adapter) return unavailable();
      const result = await adapter.send(structuredClone(effect.preview), id);
      return 'state' in result ? result : ok(result);
    }
    const adapter = providers?.messages?.email;
    if (!adapter) return unavailable();
    const receipts: DeliveryReceipt[] = [];
    for (const preview of effect.previews) {
      const result = await adapter.send(structuredClone(preview), messageKey(id, preview.id));
      if ('state' in result) return receipts.length === 0 ? result : unknownOutcome(id);
      receipts.push(result);
    }
    return this.workflowResult(intent, effect, receipts);
  }

  private async reconcile(tenantId: string, intent: StoredIntent): Promise<Reconciliation> {
    const { records, providers } = this.options;
    const { effect, id } = intent;
    if (effect.kind === 'purchase') {
      const order = await records.get('purchaseOrders', tenantId, effect.order.id);
      if (!order) return notApplied;
      return digest(order) === digest(effect.order) ? ok(order) : denied('invalid_approval');
    }
    if (effect.kind === 'message') {
      const result = await providers?.messages?.[effect.preview.channel]?.reconcile?.(id);
      return typeof result === 'object' ? ok(result) : (result ?? unresolved);
    }
    const adapter = providers?.messages?.email;
    const receipts: DeliveryReceipt[] = [];
    for (const preview of effect.previews) {
      const result = await adapter?.reconcile?.(messageKey(id, preview.id));
      if (result === notApplied) continue;
      if (!result || result === unresolved) return unresolved;
      receipts.push(result);
    }
    if (receipts.length === effect.previews.length)
      return this.workflowResult(intent, effect, receipts);
    // A partially delivered run goes to review. Replaying the whole batch would resend.
    return receipts.length === 0 ? notApplied : unresolved;
  }
}

function messageKey(actionId: string, previewId: string) {
  return digest([actionId, previewId]);
}
