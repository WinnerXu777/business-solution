import { createFakeProviders } from '../fake-providers.ts';
import { supportingOrders } from './evidence.ts';
import type { ScoringAdapter } from './index.ts';

export function createFixtureScoringAdapter(): ScoringAdapter {
  const fixture = createFakeProviders().scoring;
  return {
    fraud: fixture.fraud,
    forecast(input, tenantId) {
      const hasHistory =
        tenantId === 'tenant-rivetquay' &&
        (input.skuId === 'sku-001' || (input.series === 'weekly_sales' && input.skuId === null));
      if (hasHistory) return fixture.forecast(input, tenantId);
      return {
        status: 'insufficient_history',
        unit: input.series === 'weekly_sales' ? 'cents' : 'items',
        artifactId: 'fixture-forecast-v1',
        points: [],
      };
    },
    async profile(customer) {
      const result = await fixture.profile(customer);
      return {
        ...result,
        segment:
          result.segment === 'win_back' && !customer.outreachAllowed ? 'abstain' : result.segment,
        evidenceIds: [customer.id, ...supportingOrders(customer)],
      };
    },
  };
}
