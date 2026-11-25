import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Scope } from '../../../../packages/core/src/conversations/index.ts';

export class ChannelHttpError extends Error {
  readonly status: number;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

type Claims = Scope & {
  origin: string;
  customerId: string;
  kind: 'web' | 'voice';
  expiresAt: number;
};
const unauthenticated = () => new ChannelHttpError(401, 'invalid_session');
export const invalid = () => new ChannelHttpError(400, 'invalid_input');

export function bearer(header?: string) {
  return /^Bearer ([^\s,]{1,4096})$/i.exec(header ?? '')?.[1];
}

export function visitorTokens(secret: string, now: () => number, ttlMs: number) {
  if (
    Buffer.byteLength(secret) < 32 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs <= 0 ||
    ttlMs > 15 * 60_000
  ) {
    throw new Error('Invalid channel token configuration');
  }
  const mac = (payload: string) => createHmac('sha256', secret).update(payload).digest();
  return {
    issue(input: Omit<Claims, 'expiresAt'>) {
      const expiresAt = now() + ttlMs;
      const payload = Buffer.from(JSON.stringify({ ...input, expiresAt })).toString('base64url');
      return {
        token: payload + '.' + mac(payload).toString('base64url'),
        conversationId: input.conversationId,
        expiresAt,
      };
    },
    read(
      token: string | undefined,
      tenantId: string,
      origin: string,
      kind: Claims['kind'],
    ): Claims {
      const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token ?? '');
      if (!parts || !timingSafeEqual(mac(parts[1]), Buffer.from(parts[2], 'base64url')))
        throw unauthenticated();
      let claims: Claims;
      try {
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch {
        throw unauthenticated();
      }
      if (
        claims.tenantId !== tenantId ||
        claims.origin !== origin ||
        claims.kind !== kind ||
        claims.expiresAt <= now()
      ) {
        throw unauthenticated();
      }
      return claims;
    },
  };
}

export class ChannelLimits {
  private readonly counters = new Map<string, { count: number; until: number }>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  take(key: unknown[], limit: number) {
    const id = JSON.stringify(key);
    const at = this.now();
    let window = this.counters.get(id);
    if (!window || window.until <= at) {
      if (this.counters.size >= 10_000) this.sweep();
      if (this.counters.size >= 10_000) throw new ChannelHttpError(429, 'rate_limited');
      window = { count: 0, until: at + 60_000 };
      this.counters.set(id, window);
    }
    if (window.count >= limit) throw new ChannelHttpError(429, 'rate_limited');
    window.count += 1;
  }

  sweep() {
    const at = this.now();
    for (const [key, { until }] of this.counters) if (until <= at) this.counters.delete(key);
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}

export function field(value: unknown, max = 128) {
  if (typeof value !== 'string' || value.length > max || !value.trim()) throw invalid();
  return value;
}
