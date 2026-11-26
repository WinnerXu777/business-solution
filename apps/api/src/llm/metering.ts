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

import { randomUUID } from 'node:crypto';

export type Reservation = { id: string; amount: number; window: number; expiresAt: number };
export interface LimitRepository {
  request(tenantId: string, window: number, cap: number): boolean | Promise<boolean>;
  reserve(
    tenantId: string,
    reservation: Reservation,
    cap: number,
    now: number,
  ): 'reserved' | 'exhausted' | 'blocked' | Promise<'reserved' | 'exhausted' | 'blocked'>;
  settle(tenantId: string, id: string, window: number, tokens: number): void | Promise<void>;
  block(tenantId: string): void | Promise<void>;
}

type Window = { requests: number; tokens: number };
export class MemoryLimitRepository implements LimitRepository {
  private readonly windows = new Map<string, Map<number, Window>>();
  private readonly holds = new Map<string, Map<string, Reservation>>();
  private readonly blocked = new Set<string>();

  private counter(tenantId: string, window: number) {
    const tenant = this.windows.get(tenantId) ?? new Map<number, Window>();
    const value = tenant.get(window) ?? { requests: 0, tokens: 0 };
    tenant.set(window, value);
    this.windows.set(tenantId, tenant);
    return value;
  }

  request(tenantId: string, window: number, cap: number) {
    const counter = this.counter(tenantId, window);
    if (counter.requests >= cap) return false;
    counter.requests++;
    return true;
  }

  reserve(tenantId: string, reservation: Reservation, cap: number, now: number) {
    if (this.blocked.has(tenantId)) return 'blocked';
    const holds = this.holds.get(tenantId) ?? new Map<string, Reservation>();
    let outstanding = 0;
    for (const hold of holds.values()) {
      if (hold.expiresAt > now && hold.window !== reservation.window) outstanding += hold.amount;
    }
    const counter = this.counter(tenantId, reservation.window);
    if (counter.tokens + outstanding + reservation.amount > cap) return 'exhausted';
    counter.tokens += reservation.amount;
    holds.set(reservation.id, reservation);
    this.holds.set(tenantId, holds);
    return 'reserved';
  }

  settle(tenantId: string, id: string, window: number, tokens: number) {
    const holds = this.holds.get(tenantId);
    const hold = holds?.get(id);
    if (!hold) return;
    this.counter(tenantId, hold.window).tokens -= hold.amount;
    this.counter(tenantId, window).tokens += tokens;
    holds!.delete(id);
  }

  block(tenantId: string) {
    this.blocked.add(tenantId);
  }
}

export function createLimits(
  limits: Limits,
  now: () => number,
  repository: LimitRepository,
  holdMs: number,
) {
  const window = (at: number) => at - (at % limits.windowMs);
  const meterFailures = new Set<string>();

  return {
    async request(tenantId: string) {
      if (!(await repository.request(tenantId, window(now()), limits.requests)))
        throw new ApiError(429, 'rate_limit_exceeded');
    },
    async failMeter(tenantId: string) {
      meterFailures.add(tenantId);
      await repository.block(tenantId);
    },
    async reserve(tenantId: string, amount: number) {
      if (meterFailures.has(tenantId)) throw new ApiError(503, 'meter_unavailable');
      if (!Number.isSafeInteger(amount) || amount < 0) {
        throw new ApiError(503, 'meter_unavailable');
      }
      const at = now();
      const reservation = { id: randomUUID(), amount, window: window(at), expiresAt: at + holdMs };
      const status = await repository.reserve(tenantId, reservation, limits.tokens, at);
      if (status === 'blocked') throw new ApiError(503, 'meter_unavailable');
      if (status === 'exhausted') throw new ApiError(429, 'token_budget_exceeded');
      return async (actual: Usage | undefined) => {
        const spent = actual ? actual.inputTokens + actual.outputTokens : amount;
        await repository.settle(tenantId, reservation.id, window(now()), spent);
        return spent;
      };
    },
  };
}
