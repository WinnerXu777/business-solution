import type { RunForecastInput, RunForecastOutput } from '@bs/contracts';
import type { ScoringAdapter as GatewayScoringAdapter } from '../index.ts';

/** Standalone scoring without an authorized workspace has no forecast history. */
export interface ScoringAdapter extends GatewayScoringAdapter {
  forecast(
    input: RunForecastInput,
    tenantId?: string,
  ): RunForecastOutput | Promise<RunForecastOutput>;
}
export { createFixtureScoringAdapter } from './fixture.ts';
export { createWorkerScoringAdapter } from './worker.ts';
