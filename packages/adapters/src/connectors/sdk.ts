import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Fields = { [key: string]: Json };
export type Capability = 'accounting' | 'crm' | (string & {});
export type AuthType = 'oauth2-pkce' | 'api-key';
export type Operation = 'read' | 'snapshot' | 'listChangedSince' | 'write' | 'reconcile';

export interface ConnectorManifest {
  id: string;
  version: string;
  edition: string;
  environment: 'fixture' | 'sandbox' | 'production';
  capability: Capability;
  recordClasses: readonly string[];
  authoritativeFor: readonly string[];
  authType: AuthType;
  scopes: Readonly<Partial<Record<Operation, readonly string[]>>>;
  rateLimit: { requests: number; windowMs: number };
  webhook: false | { recordClasses: readonly string[] };
  dataClasses: readonly string[];
  region: string;
}

export type ConnectorFailure =
  | 'not_found'
  | 'auth_required'
  | 'permission_denied'
  | 'rate_limited'
  | 'conflict'
  | 'validation_failed'
  | 'unsupported'
  | 'provider_unavailable'
  | 'approval_required'
  | 'outcome_unknown'
  | 'write_frozen';

export class ConnectorError extends Error {
  readonly code: ConnectorFailure;
  readonly retryAfterMs?: number;

  constructor(code: ConnectorFailure, retryAfterMs?: number) {
    super(code);
    this.name = 'ConnectorError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface BindingRef {
  tenantId: string;
  connectionId: string;
}

export interface RecordKey {
  recordClass: string;
  externalId: string;
}

export interface ProviderRecord extends RecordKey {
  version: string;
  updatedAt: string;
  occurredAt?: string;
  sourceTimezone?: string;
  currency?: string;
  deleted?: true;
  fields: Fields;
}

export interface Snapshot {
  records: readonly ProviderRecord[];
  checkpoint: string;
}

export interface ChangePage extends Snapshot {
  hasMore: boolean;
}

export type Credential =
  | { type: 'api-key'; key: string }
  | {
      type: 'oauth2-pkce';
      accessToken: string;
      refreshToken?: string;
      expiresAt: number;
      scopes: readonly string[];
    };

export interface ConnectorContext extends BindingRef {
  accountId: string;
  credential: Credential;
}

export interface WriteIntent extends RecordKey {
  expectedVersion: string;
  fields: Fields;
  idempotencyKey: string;
}

export interface WriteRequest extends WriteIntent {
  effectId: string;
}

export interface EffectResolution {
  status: 'applied' | 'not_applied' | 'unknown';
  effectId: string;
  providerEffectId?: string;
}

export interface Connector {
  manifest: ConnectorManifest;
  verifyAccount(credential: Credential): Promise<string>;
  read(context: ConnectorContext, key: RecordKey): Promise<ProviderRecord | null>;
  snapshot(context: ConnectorContext): Promise<Snapshot>;
  listChangedSince(context: ConnectorContext, checkpoint: string | null): Promise<ChangePage>;
  write?(context: ConnectorContext, request: WriteRequest): Promise<EffectResolution>;
  reconcile?(context: ConnectorContext, effectId: string): Promise<EffectResolution>;
}

export type Clock = () => number;

export function keyOf(...parts: readonly string[]): string {
  return JSON.stringify(parts);
}

export function stableId(...parts: readonly string[]): string {
  return createHash('sha256')
    .update(keyOf(...parts))
    .digest('hex');
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

/** Serializes process-local work by key and releases each key even on failure. */
export class SerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key);
    const result = (prior ?? Promise.resolve()).then(work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
