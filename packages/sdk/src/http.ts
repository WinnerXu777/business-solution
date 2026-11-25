import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError, responseError } from './errors.ts';

export type Fetch = (input: URL, init: RequestInit) => Promise<Response>;
export type Auth =
  | { apiKey: string; bearerToken?: never }
  | { bearerToken: string; apiKey?: never };
export type ClientOptions = {
  baseUrl: string;
  auth: Auth;
  fetch?: Fetch;
  maxRetries?: number;
  retryBaseMs?: number;
  maxRetryDelayMs?: number;
};
export type CallOptions = { signal?: AbortSignal; idempotencyKey?: string };
type RequestOptions = CallOptions & {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: HeadersInit;
  auth?: 'omit';
  retry?: 'keyed' | 'safe' | 'never';
};

const idempotentMethods = new Set(['GET', 'HEAD']);
const retryStatuses = new Set([408, 429, 502, 503, 504]);

export function pathSegment(value: string): string {
  if (!value || value === '.' || value === '..') throw new TypeError('Invalid path segment');
  return encodeURIComponent(value);
}

function delayHeader(value: string | null): number | undefined {
  if (!value) return;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const time = Date.parse(value);
  if (Number.isFinite(time)) return Math.max(0, time - Date.now());
}

export function apiBaseUrl(input: string): URL {
  const url = new URL(input);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new TypeError('Expected an HTTP(S) API URL without credentials, query or fragment');
  }
  return url;
}

export class HttpClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetch: Fetch;
  private readonly retries: number;
  private readonly baseDelay: number;
  private readonly maxDelay: number;

  constructor(options: ClientOptions) {
    this.base = apiBaseUrl(options.baseUrl).href.replace(/\/+$/, '');
    this.token = options.auth.apiKey ?? options.auth.bearerToken;
    if (!this.token || /\s/.test(this.token)) throw new TypeError('Invalid bearer credential');
    this.fetch = options.fetch ?? globalThis.fetch;
    this.retries = options.maxRetries ?? 2;
    this.baseDelay = options.retryBaseMs ?? 250;
    this.maxDelay = options.maxRetryDelayMs ?? 5_000;
    if (
      ![this.retries, this.baseDelay, this.maxDelay].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) ||
      this.retries > 10 ||
      this.maxDelay > 2_147_483_647
    ) {
      throw new RangeError('Invalid retry configuration');
    }
  }

  async send(path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const method = options.method ?? 'GET';
    const headers = new Headers(options.headers);
    if (!headers.has('accept')) headers.set('accept', 'application/json');
    if (options.auth !== 'omit') headers.set('authorization', 'Bearer ' + this.token);
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const safe = idempotentMethods.has(method);
    const key = options.idempotencyKey ?? (safe ? undefined : randomUUID());
    if (key !== undefined) {
      if (!key || key.trim() !== key) throw new TypeError('Invalid Idempotency-Key');
      headers.set('idempotency-key', key);
    }
    const canRetry =
      options.retry !== 'never' &&
      (safe || options.retry === 'safe' || (options.retry === 'keyed' && key !== undefined));
    const { signal } = options;
    const init: RequestInit = { method, headers, body, signal, redirect: 'error' };

    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      let response: Response | undefined;
      let transportError: unknown;
      try {
        response = await this.fetch(url, init);
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        transportError = error;
      }
      const retryAfterMs = delayHeader(response?.headers.get('retry-after') ?? null);
      const backoff = Math.min(this.maxDelay, this.baseDelay * 2 ** attempt);
      if (
        canRetry &&
        attempt < this.retries &&
        (!response || retryStatuses.has(response.status)) &&
        (retryAfterMs === undefined || retryAfterMs <= this.maxDelay)
      ) {
        await response?.body?.cancel().catch(() => {});
        await sleep(Math.max(backoff, retryAfterMs ?? 0), undefined, { signal });
        continue;
      }
      if (response) return response;
      throw new Error('API transport failed', { cause: transportError });
    }
  }

  async requireOk(response: Response): Promise<Response> {
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => undefined);
      throw responseError(response, payload, delayHeader(response.headers.get('retry-after')));
    }
    return response;
  }

  async json<T>(path: string, options?: RequestOptions): Promise<T> {
    const response = await this.requireOk(await this.send(path, options));
    if (response.status === 204 || response.status === 205) return undefined as T;
    return response.json().catch(() => {
      throw new ApiError(
        'invalid_json',
        response.status,
        response.headers.get('x-request-id') ?? undefined,
      );
    }) as Promise<T>;
  }
}
