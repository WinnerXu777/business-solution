import type {
  CallEnvelope,
  CompleteLlmInput,
  Denied,
  ToolCall,
  ToolResult,
  UsageCounterEvent,
} from '@bs/contracts';
import type { BillingLedger, ResolvedBinding, SkuId } from '../platform/index.ts';
import { PlatformError, catalogPriceVersion } from '../platform/index.ts';
import { rateableGatewayUsage } from '../platform/billing-gateway.ts';
import { usageKey, type BillingUsage, type OutcomeUsage } from '../platform/billing-usage.ts';
import { denied } from './results.ts';
import type { Effect, GovernanceStore, TenantState } from './store.ts';

export interface BillingEntry {
  envelope: CallEnvelope;
  event: BillingUsage;
  status: 'pending' | 'posted' | 'unsubscribed';
}

export interface Reservation {
  skuId: SkuId;
  unit: string;
  quantity: number;
  outcomeId: string;
  occurredAt: string;
}

export const simulatedLlmPrices = (
  ['openai', 'anthropic', 'amazon-bedrock', 'cohere-vault'] as const
).map((providerId) => ({
  version: 'simulation-v1',
  providerId,
  unit: 'tokens',
  mode:
    providerId === 'amazon-bedrock' || providerId === 'cohere-vault'
      ? ('premium' as const)
      : ('byo' as const),
  chargeMode: 'informational' as const,
}));

export function inputTokens(turns: CompleteLlmInput['turns']) {
  return turns.reduce((total, turn) => total + (turn.content.match(/\S+/g)?.length ?? 0), 0);
}

export function billableOutcome(
  request: ToolCall,
  occurredAt: string,
  actionId: string,
  effect?: Effect,
): Reservation | undefined {
  const monthly = (id: string) => occurredAt.slice(0, 7) + ':' + id;
  const meter = (skuId: SkuId, unit: string, outcomeId: string) => ({
    skuId,
    unit,
    outcomeId,
    occurredAt,
    quantity: 1,
  });
  if (effect?.kind === 'purchase')
    return meter('procurement', 'requisitions', effect.order.draft.requestId);
  if (effect?.kind === 'message' && effect.preview.channel === 'email')
    return meter('collections-email', 'messages', 'receipt-' + actionId);
  if (effect?.kind === 'workflow' && effect.previews.length)
    return meter('workflows', 'runs', 'run-' + actionId);
  if (request.tool === 'fraud.score')
    return meter('fraud', 'orders', monthly(request.input.orderId));
  if (request.tool === 'chat.run' && !request.input.audioFixtureId)
    return meter('inbound-chat', 'conversations', monthly(request.input.sessionId));
}

function outcome(reservation: Reservation): OutcomeUsage {
  return { ...reservation, kind: 'outcome', priceVersion: catalogPriceVersion };
}

export class GovernanceBilling {
  private readonly ledger: () => Pick<BillingLedger, 'plan' | 'recordUsage'>;
  private readonly store: GovernanceStore;

  constructor(ledger: GovernanceBilling['ledger'], store: GovernanceStore) {
    this.ledger = ledger;
    this.store = store;
  }

  async reserve(state: TenantState, tenantId: string, reservation: Reservation, actionId: string) {
    if (state.rows.billing_event.get(usageKey(outcome(reservation)))?.status === 'posted') return;
    const plan = await this.ledger().plan(tenantId);
    const meter = plan.allowances.find(
      ({ skuId, unit }) => skuId === reservation.skuId && unit === reservation.unit,
    );
    // Fixture operational grants exist independently of optional billing subscriptions.
    if (!meter) return;
    const pending = [...state.rows.billing_event.values()].some(
      ({ status }) => status === 'pending',
    );
    if (pending) throw new Error('Billing usage is awaiting ingestion.');
    const outstanding = [...state.rows.outbox.values()]
      .filter((job) => job.id !== actionId && (job.status === 'running' || job.unresolved))
      .map(({ billingReservation }) => billingReservation)
      .filter(
        (item): item is Reservation =>
          item?.skuId === meter.skuId &&
          item.unit === meter.unit &&
          item.occurredAt >= plan.windowStart &&
          item.occurredAt < plan.windowEnd,
      )
      .reduce((units, item) => units + item.quantity, 0);
    if (meter.used + outstanding + reservation.quantity > meter.included)
      return denied('quota_exceeded');
  }

  outcome(state: TenantState, request: ToolCall, result: ToolResult, counter: UsageCounterEvent) {
    if (request.tool === 'llm.complete') return;
    const event = rateableGatewayUsage(request, result, counter);
    if (event) this.enqueue(state, request.envelope, event);
  }

  inference(
    state: TenantState,
    envelope: CallEnvelope,
    reservation: Reservation,
    binding: ResolvedBinding,
    routeKind: 'native' | 'byo',
  ) {
    if (!reservation.quantity) return;
    const event = outcome(reservation);
    this.enqueue(state, envelope, event);
    if (routeKind === 'native') return;
    const { provider, region } = binding;
    const fixtureByo = provider.mode === 'native';
    this.enqueue(state, envelope, {
      ...event,
      kind: 'provider',
      attemptId: event.outcomeId,
      providerId: fixtureByo ? 'fixture-byo' : provider.providerId,
      mode: provider.mode === 'premium' ? 'premium' : 'byo',
      priceVersion: fixtureByo ? 'fixture-byo-v1' : 'simulation-v1',
      region,
    });
  }

  private enqueue(state: TenantState, envelope: CallEnvelope, event: BillingUsage) {
    const key = usageKey(event);
    const prior = state.rows.billing_event.get(key);
    if (!prior || prior.status === 'unsubscribed') {
      state.rows.billing_event.set(key, { envelope, event, status: 'pending' });
    }
  }

  async flush(tenantId: string) {
    await this.store.transact(tenantId, async ({ rows }) => {
      for (const entry of rows.billing_event.values()) {
        if (entry.status !== 'pending') continue;
        try {
          await this.ledger().recordUsage(entry.envelope, entry.event);
          entry.status = 'posted';
        } catch (error) {
          if (!(error instanceof PlatformError && error.code === 'module_disabled')) throw error;
          entry.status = 'unsubscribed';
        }
      }
    });
  }
}

export function spendAllowed(
  binding: ResolvedBinding,
  routeKind: 'native' | 'byo',
): Denied | undefined {
  // Only explicitly priced, zero-cost simulations fit the demo spend reservation.
  if (routeKind === 'native' || binding.provider.mode === 'native') return;
  if (
    !simulatedLlmPrices.some(
      ({ providerId, mode }) =>
        binding.provider.providerId === providerId && binding.provider.mode === mode,
    )
  )
    return denied('quota_exceeded');
}
