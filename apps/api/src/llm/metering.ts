import type {
  ChatInput,
  EmbeddingInput,
  ModelAdapter,
  Usage,
} from '../../../../packages/adapters/src/llm/index.ts';
import { ApiError } from './validation.ts';

export type Capability = 'llm' | 'embeddings';
export type ChargeMode = 'native' | 'byo';
export type Route = Readonly<{
  routeId: string;
  priceVersion: string;
  chargeMode: ChargeMode;
  adapter: ModelAdapter;
  /** Own aliases only. Values are pinned upstream model IDs. */
  models: Readonly<Record<string, string>>;
  /** Return an upper bound for the full upstream prompt, including framing and tools. */
  estimateInputTokens: (input: ChatInput | EmbeddingInput) => number;
}>;

export type Binding = Readonly<{
  version: string;
  primary: Route;
  /** Presence means the tenant opted in and the resolver approved both routes for the same policy. */
  inferenceFallback?: Route;
}>;

export type UsageRecord = {
  eventId: string;
  requestId: string;
  attempt: number;
  tenantId: string;
  capability: Capability;
  bindingVersion: string;
  model: string;
  provider: string;
  route: string;
  priceVersion: string;
  chargeMode: ChargeMode;
  outcome: 'succeeded' | 'failed' | 'cancelled';
  inputTokens: number | null;
  outputTokens: number | null;
  budgetTokens: number;
};

export type Limits = {
  windowMs: number;
  requests: number;
  tokens: number;
};

type Window = { endsAt: number; requests: number; tokens: number };

export function createLimits(limits: Limits, now: () => number) {
  const windows = new Map<string, Window>();
  const pending = new Map<string, number>();
  const meterFailures = new Set<string>();
  let nextSweep = 0;

  function window(tenantId: string) {
    const time = now();
    if (time >= nextSweep) {
      for (const [id, value] of windows) {
        if (value.endsAt <= time) windows.delete(id);
      }
      nextSweep = time + limits.windowMs;
    }
    const current = windows.get(tenantId);
    if (current && current.endsAt > time) return current;
    const value = { endsAt: time + limits.windowMs, requests: 0, tokens: 0 };
    windows.set(tenantId, value);
    return value;
  }

  return {
    request(tenantId: string) {
      const current = window(tenantId);
      if (current.requests >= limits.requests) throw new ApiError(429, 'rate_limit_exceeded');
      current.requests++;
    },
    failMeter(tenantId: string) {
      meterFailures.add(tenantId);
    },
    reserve(tenantId: string, amount: number) {
      if (meterFailures.has(tenantId)) throw new ApiError(503, 'meter_unavailable');
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new ApiError(503, 'meter_unavailable');
      }
      const current = window(tenantId);
      const outstanding = pending.get(tenantId) ?? 0;
      if (amount > limits.tokens - current.tokens - outstanding) {
        throw new ApiError(429, 'token_budget_exceeded');
      }
      pending.set(tenantId, outstanding + amount);
      return (actual: Usage | undefined) => {
        const left = (pending.get(tenantId) ?? 0) - amount;
        if (left) pending.set(tenantId, left);
        else pending.delete(tenantId);
        const spent = actual ? actual.inputTokens + actual.outputTokens : amount;
        window(tenantId).tokens += spent;
        return spent;
      };
    },
  };
}
