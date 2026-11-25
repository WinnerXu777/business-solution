import type { ToolCall, ToolResult, UsageCounterEvent } from '@bs/contracts';
import { catalogPriceVersion } from './billing-catalog.ts';
import type { BillingUsage, OutcomeUsage, ProviderPrice } from './billing-usage.ts';

export const fixtureByoPrice: ProviderPrice = {
  version: 'fixture-byo-v1',
  providerId: 'fixture-byo',
  unit: 'tokens',
  mode: 'byo',
  chargeMode: 'informational',
};

/** Only translate counters whose successful output carries evidence for the SKU meter. */
export function rateableGatewayUsage(
  request: ToolCall,
  result: ToolResult,
  counter: UsageCounterEvent,
): BillingUsage | undefined {
  if (result.state !== 'ok' || counter.unit !== 'actions' || counter.quantity !== 1) return;
  const { output } = result;
  const identity = { occurredAt: counter.occurredAt, outcomeId: counter.outcomeId };
  const common = {
    ...identity,
    kind: 'outcome',
    quantity: 1,
    priceVersion: catalogPriceVersion,
  } as const;
  const monthlyOutcome = (id: string) => counter.occurredAt.slice(0, 7) + ':' + id;
  switch (request.tool) {
    case 'purchase.order.approve':
      if ('draft' in output && 'approvalId' in output)
        return {
          ...common,
          skuId: 'procurement',
          unit: 'requisitions',
          outcomeId: output.draft.requestId,
        };
      return;
    case 'collections.email.send':
      if ('channel' in output && output.channel === 'email' && 'providerId' in output)
        return { ...common, skuId: 'collections-email', unit: 'messages', outcomeId: output.id };
      return;
    case 'workflow.template.run':
      if ('receipts' in output && output.receipts.length && request.input.mode === 'run')
        return { ...common, skuId: 'workflows', unit: 'runs', outcomeId: output.runId };
      return;
    case 'fraud.score':
      if ('rule' in output)
        return {
          ...common,
          skuId: 'fraud',
          unit: 'orders',
          outcomeId: monthlyOutcome(output.orderId),
        };
      return;
    case 'chat.run':
      if ('sessionId' in output && !request.input.audioFixtureId)
        return {
          ...common,
          skuId: 'inbound-chat',
          unit: 'conversations',
          outcomeId: monthlyOutcome(output.sessionId),
        };
      return;
    case 'llm.complete': {
      if (!('inputTokens' in output)) return;
      const quantity = output.inputTokens + output.outputTokens;
      if (!quantity) return;
      const tokens: OutcomeUsage = { ...common, skuId: 'platform', unit: 'tokens', quantity };
      if (output.route.kind === 'native') return tokens;
      if (output.route.providerId === fixtureByoPrice.providerId && output.route.fixtureMode)
        return {
          ...tokens,
          kind: 'provider',
          providerId: fixtureByoPrice.providerId,
          priceVersion: fixtureByoPrice.version,
          attemptId: counter.id,
          region: 'ca-central-1',
          mode: 'byo',
        };
      return;
    }
  }
}
