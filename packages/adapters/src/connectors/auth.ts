import { createHash, randomBytes } from 'node:crypto';
import { ConnectorError, keyOf, type BindingRef, type Clock, type Credential } from './sdk.ts';

export interface CredentialStore {
  get(binding: BindingRef): Promise<Credential | undefined>;
  put(binding: BindingRef, credential: Credential): Promise<void>;
  delete(binding: BindingRef): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  private readonly entries = new Map<string, Credential>();

  async get(binding: BindingRef) {
    return structuredClone(this.entries.get(keyOf(binding.tenantId, binding.connectionId)));
  }

  async put(binding: BindingRef, credential: Credential) {
    this.entries.set(keyOf(binding.tenantId, binding.connectionId), structuredClone(credential));
  }

  async delete(binding: BindingRef) {
    this.entries.delete(keyOf(binding.tenantId, binding.connectionId));
  }
}

export interface HttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export type HttpClient = (request: HttpRequest) => Promise<{
  status: number;
  headers?: Readonly<Record<string, string>>;
  body: unknown;
}>;

export async function requestHttp(client: HttpClient, request: HttpRequest) {
  let response: Awaited<ReturnType<HttpClient>>;
  try {
    response = await client(request);
  } catch {
    throw new ConnectorError('provider_unavailable');
  }
  if (response.status >= 200 && response.status < 300) return response.body;
  if ([400, 401].includes(response.status)) throw new ConnectorError('auth_required');
  if (response.status === 403) throw new ConnectorError('permission_denied');
  if (response.status === 409) throw new ConnectorError('conflict');
  if (response.status === 429) {
    const header = response.headers?.['retry-after'];
    const delay =
      header && /^\d+$/.test(header)
        ? Number(header) * 1000
        : Date.parse(header ?? '') - Date.now();
    throw new ConnectorError(
      'rate_limited',
      Number.isSafeInteger(delay) ? Math.max(0, delay) : undefined,
    );
  }
  throw new ConnectorError('provider_unavailable');
}

export interface OAuthConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
}

export interface OAuthSubject extends BindingRef {
  actorId: string;
}

interface OAuthAttempt {
  subject: OAuthSubject;
  registration: string;
  verifier: string;
  expiresAt: number;
}

export interface OAuthStateStore {
  save(state: string, attempt: OAuthAttempt): Promise<void>;
  find(state: string, now: number): Promise<OAuthAttempt | undefined>;
  /** Atomically consumes an unexpired attempt for the matching subject and registration. */
  consume(
    state: string,
    subject: OAuthSubject,
    registration: string,
    now: number,
  ): Promise<OAuthAttempt | undefined>;
}

export class MemoryOAuthStateStore implements OAuthStateStore {
  private readonly attempts = new Map<string, OAuthAttempt>();

  async save(state: string, attempt: OAuthAttempt) {
    const now = attempt.expiresAt - stateLifetimeMs;
    for (const [state, pending] of this.attempts) {
      if (pending.expiresAt <= now) this.attempts.delete(state);
    }
    this.attempts.set(state, structuredClone(attempt));
  }

  async consume(state: string, subject: OAuthSubject, registration: string, now: number) {
    const attempt = this.lookup(state, now);
    if (!attempt) return;
    if (
      attempt.registration !== registration ||
      attempt.subject.tenantId !== subject.tenantId ||
      attempt.subject.connectionId !== subject.connectionId ||
      attempt.subject.actorId !== subject.actorId
    ) {
      return;
    }
    this.attempts.delete(state);
    return attempt;
  }

  async find(state: string, now: number) {
    return structuredClone(this.lookup(state, now));
  }

  private lookup(state: string, now: number) {
    const attempt = this.attempts.get(state);
    if (attempt && attempt.expiresAt > now) return attempt;
    this.attempts.delete(state);
  }
}

type OAuthCredential = Extract<Credential, { type: 'oauth2-pkce' }>;
const stateLifetimeMs = 10 * 60 * 1000;

export class OAuthPkce {
  private readonly config: OAuthConfig;
  private readonly registration: string;
  private readonly http: HttpClient;
  private readonly state: OAuthStateStore;
  private readonly clock: Clock;

  constructor(
    config: OAuthConfig,
    http: HttpClient,
    state: OAuthStateStore,
    clock: Clock = Date.now,
  ) {
    this.http = http;
    this.state = state;
    this.clock = clock;
    for (const endpoint of [
      config.authorizationEndpoint,
      config.tokenEndpoint,
      config.revocationEndpoint,
      config.redirectUri,
    ]) {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
        throw new ConnectorError('validation_failed');
      }
    }
    this.config = structuredClone(config);
    this.registration = keyOf(
      config.authorizationEndpoint,
      config.tokenEndpoint,
      config.clientId,
      config.redirectUri,
    );
  }

  async start(subject: OAuthSubject): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const url = new URL(this.config.authorizationEndpoint);
    const fields = {
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes.join(' '),
      state,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    };
    for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
    await this.state.save(state, {
      subject,
      registration: this.registration,
      verifier,
      expiresAt: this.clock() + stateLifetimeMs,
    });
    return url.href;
  }

  async exchange(subject: OAuthSubject, state: string, code: string): Promise<OAuthCredential> {
    const attempt = await this.state.consume(state, subject, this.registration, this.clock());
    if (!attempt || !code) throw new ConnectorError('auth_required');
    return this.token({
      grant_type: 'authorization_code',
      code,
      code_verifier: attempt.verifier,
      redirect_uri: this.config.redirectUri,
    });
  }

  async subject(state: string, caller: Omit<OAuthSubject, 'connectionId'>) {
    const attempt = await this.state.find(state, this.clock());
    if (
      attempt?.registration === this.registration &&
      attempt.subject.tenantId === caller.tenantId &&
      attempt.subject.actorId === caller.actorId
    )
      return attempt.subject;
  }

  async refresh(current: OAuthCredential): Promise<OAuthCredential> {
    if (!current.refreshToken) throw new ConnectorError('auth_required');
    return this.token(
      { grant_type: 'refresh_token', refresh_token: current.refreshToken },
      current,
    );
  }

  async revoke(current: OAuthCredential): Promise<void> {
    if (current.refreshToken) {
      await this.post(this.config.revocationEndpoint, {
        token: current.refreshToken,
        token_type_hint: 'refresh_token',
      });
    }
    await this.post(this.config.revocationEndpoint, {
      token: current.accessToken,
      token_type_hint: 'access_token',
    });
  }

  private post(url: string, fields: Record<string, string>) {
    return requestHttp(this.http, {
      method: 'POST',
      url,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, client_id: this.config.clientId }).toString(),
    });
  }

  private async token(fields: Record<string, string>, previous?: OAuthCredential) {
    const value = await this.post(this.config.tokenEndpoint, fields);
    if (!value || typeof value !== 'object') throw new ConnectorError('auth_required');
    const { access_token, refresh_token, token_type, expires_in, scope } = value as Record<
      string,
      unknown
    >;
    if (
      typeof access_token !== 'string' ||
      !access_token ||
      typeof token_type !== 'string' ||
      token_type.toLowerCase() !== 'bearer' ||
      typeof expires_in !== 'number' ||
      !Number.isSafeInteger(expires_in * 1000) ||
      expires_in <= 0 ||
      (refresh_token !== undefined && (typeof refresh_token !== 'string' || !refresh_token)) ||
      (scope !== undefined && typeof scope !== 'string')
    ) {
      throw new ConnectorError('auth_required');
    }
    const allowed = previous?.scopes ?? this.config.scopes;
    const scopes = typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : [...allowed];
    if (scopes.some((item) => !allowed.includes(item)))
      throw new ConnectorError('permission_denied');
    return {
      type: 'oauth2-pkce' as const,
      accessToken: access_token,
      refreshToken: refresh_token ?? previous?.refreshToken,
      expiresAt: this.clock() + expires_in * 1000,
      scopes,
    };
  }
}
