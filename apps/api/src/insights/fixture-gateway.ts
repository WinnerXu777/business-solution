import { FakeGateway } from '@bs/core';
import { createFakeProviders } from '../../../../packages/adapters/src/fake-providers.ts';
import {
  createFixtureScoringAdapter,
  type ScoringAdapter,
} from '../../../../packages/adapters/src/scoring/index.ts';

export function createFixtureInsightsGateway(
  scoring: ScoringAdapter = createFixtureScoringAdapter(),
  providers = createFakeProviders(),
) {
  return new FakeGateway({
    providers: { ...providers, scoring },
  });
}
