import { AsyncLocalStorage } from 'node:async_hooks';
import type { ToolCall } from '@bs/contracts';
import { FakeGateway, type ToolGateway } from '@bs/core';
import { createFakeProviders } from '../../../../packages/adapters/src/fake-providers.ts';
import {
  createFixtureScoringAdapter,
  type ScoringAdapter,
} from '../../../../packages/adapters/src/scoring/index.ts';

/** Carry workspace scope across the existing fake gateway's forecast adapter call. */
export function createFixtureInsightsGateway(
  scoring: ScoringAdapter = createFixtureScoringAdapter(),
  providers = createFakeProviders(),
) {
  const forecastScope = new AsyncLocalStorage<string>();
  const gateway = new FakeGateway({
    providers: {
      ...providers,
      scoring: {
        ...scoring,
        forecast: (input) => scoring.forecast(input, forecastScope.getStore()),
      },
    },
  });
  return {
    call<Request extends ToolCall>(request: Request) {
      return forecastScope.run(request.envelope.tenantId, () => gateway.call(request));
    },
    audit: () => gateway.audit(),
    usage: () => gateway.usage(),
  } satisfies ToolGateway & Pick<FakeGateway, 'audit' | 'usage'>;
}
