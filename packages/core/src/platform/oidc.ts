import { createPublicKey, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto';
import { PlatformError } from './audit.ts';
import { decodeBase64Url, isObject, jsonObject, randomToken, tokenDigest } from './auth-crypto.ts';

export interface OidcHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Returns decoded JSON for successful responses and throws for transport or HTTP failures. */
export type OidcHttpClient = (request: OidcHttpRequest) => Promise<unknown>;

export interface OidcOptions {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  http: OidcHttpClient;
  now?: () => number;
  mfaAcrValues?: readonly string[];
  allowInsecureLoopback?: boolean;
}

export interface OidcPrincipal {
  issuer: string;
  subject: string;
  verifiedEmail?: string;
  mfaAt?: number;
}

interface LoginAttempt {
  tenantId: string;
  nonce: string;
  verifier: string;
  browserDigest: string;
  expiresAt: number;
  startedAt: number;
  stepUp: boolean;
}

interface Discovery {
  authorization: URL;
  token: URL;
  jwks: URL;
  logout?: URL;
}

const loginLifetimeMs = 5 * 60_000;
const statePattern = /^[A-Za-z0-9_-]{43}$/;

function endpoint(value: unknown, allowLoopback: boolean) {
  if (typeof value !== 'string') throw new Error('Missing OIDC endpoint.');
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(allowLoopback && loopback && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('Invalid OIDC endpoint.');
  return url;
}

function clientCredential(value: string) {
  return new URLSearchParams({ value }).toString().slice('value='.length);
}

export class OidcRelyingParty {
  private readonly attempts = new Map<string, LoginAttempt>();
  private readonly now: () => number;
  private readonly issuer: URL;
  private readonly options: OidcOptions;
  private metadata?: Promise<Discovery>;

  constructor(options: OidcOptions) {
    this.issuer = endpoint(options.issuer, options.allowInsecureLoopback ?? false);
    endpoint(options.redirectUri, options.allowInsecureLoopback ?? false);
    if (this.issuer.search || !options.clientId) throw new Error('Invalid OIDC configuration.');
    this.options = { ...options, mfaAcrValues: [...(options.mfaAcrValues ?? [])] };
    this.now = options.now ?? Date.now;
  }

  private discover() {
    this.metadata ??= this.fetchDiscovery().catch((error: unknown) => {
      this.metadata = undefined;
      throw error;
    });
    return this.metadata;
  }

  private async fetchDiscovery(): Promise<Discovery> {
    const discovery = await this.options.http({
      method: 'GET',
      url: this.options.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration',
    });
    if (!isObject(discovery) || discovery.issuer !== this.options.issuer)
      throw new Error('OIDC issuer mismatch.');
    const checked = (value: unknown) => {
      const url = endpoint(value, this.options.allowInsecureLoopback ?? false);
      if (url.origin !== this.issuer.origin) throw new Error('Unexpected OIDC endpoint origin.');
      return url;
    };
    return {
      authorization: checked(discovery.authorization_endpoint),
      token: checked(discovery.token_endpoint),
      jwks: checked(discovery.jwks_uri),
      logout:
        discovery.end_session_endpoint === undefined
          ? undefined
          : checked(discovery.end_session_endpoint),
    };
  }

  async login(tenantId: string, stepUp = false) {
    const metadata = await this.discover().catch(() => {
      throw new PlatformError('unavailable');
    });
    const instant = this.now();
    for (const [state, attempt] of this.attempts) {
      if (attempt.expiresAt <= instant) this.attempts.delete(state);
    }
    if (this.attempts.size >= 1000) throw new PlatformError('unavailable');
    const state = randomToken();
    const browserToken = randomToken();
    const attempt: LoginAttempt = {
      tenantId,
      nonce: randomToken(),
      verifier: randomToken(),
      browserDigest: tokenDigest(browserToken),
      expiresAt: instant + loginLifetimeMs,
      startedAt: instant,
      stepUp,
    };
    const url = new URL(metadata.authorization);
    const params = {
      response_type: 'code',
      scope: 'openid email',
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      state,
      nonce: attempt.nonce,
      code_challenge: tokenDigest(attempt.verifier),
      code_challenge_method: 'S256',
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (stepUp) {
      url.searchParams.set('prompt', 'login');
      url.searchParams.set('max_age', '0');
      const acrValues = this.options.mfaAcrValues ?? [];
      if (acrValues.length) url.searchParams.set('acr_values', acrValues.join(' '));
    }
    this.attempts.set(state, attempt);
    return { authorizeUrl: url.href, browserToken, maxAgeSeconds: loginLifetimeMs / 1000 };
  }

  async callback(state: string, code: string, browserToken: string | undefined) {
    if (!statePattern.test(state) || !browserToken || !statePattern.test(browserToken))
      throw new PlatformError('forbidden');
    const attempt = this.attempts.get(state);
    if (
      !attempt ||
      attempt.expiresAt <= this.now() ||
      !timingSafeEqual(Buffer.from(attempt.browserDigest), Buffer.from(tokenDigest(browserToken)))
    )
      throw new PlatformError('forbidden');
    this.attempts.delete(state);

    try {
      const metadata = await this.discover();
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.options.redirectUri,
        code_verifier: attempt.verifier,
      });
      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      };
      const { clientId, clientSecret } = this.options;
      if (clientSecret === undefined) form.set('client_id', clientId);
      else
        headers.authorization =
          'Basic ' +
          Buffer.from(clientCredential(clientId) + ':' + clientCredential(clientSecret)).toString(
            'base64',
          );
      const tokens = await this.options.http({
        method: 'POST',
        url: metadata.token.href,
        headers,
        body: form.toString(),
      });
      if (!isObject(tokens) || typeof tokens.id_token !== 'string')
        throw new Error('Missing OIDC ID token.');
      const principal = await this.validateIdToken(tokens.id_token, attempt, metadata.jwks);
      return { tenantId: attempt.tenantId, principal };
    } catch {
      throw new PlatformError('forbidden');
    }
  }

  private async validateIdToken(
    token: string,
    attempt: LoginAttempt,
    jwks: URL,
  ): Promise<OidcPrincipal> {
    const [header, payload, signature, ...extra] = token.split('.');
    if (!header || !payload || !signature || extra.length || token.length > 16_384)
      throw new Error('Invalid ID token.');
    const { alg, kid, crit } = jsonObject(header);
    if (alg !== 'RS256' || typeof kid !== 'string' || !kid || crit !== undefined)
      throw new Error('Unsupported ID token header.');
    const keySet = await this.options.http({ method: 'GET', url: jwks.href });
    const keys =
      isObject(keySet) && Array.isArray(keySet.keys)
        ? keySet.keys.filter(
            (key): key is JsonWebKey =>
              isObject(key) &&
              key.kty === 'RSA' &&
              key.kid === kid &&
              (key.alg === undefined || key.alg === alg) &&
              (key.use === undefined || key.use === 'sig') &&
              (key.key_ops === undefined ||
                (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))),
          )
        : [];
    if (keys.length !== 1) throw new Error('Unrecognized signing key.');
    const publicKey = createPublicKey({ key: keys[0], format: 'jwk' });
    if (
      (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      !verify(
        'RSA-SHA256',
        Buffer.from(header + '.' + payload),
        publicKey,
        decodeBase64Url(signature),
      )
    )
      throw new Error('Invalid ID token signature.');

    const claims = jsonObject(payload);
    const { iss, sub, aud, azp, exp, iat, nbf, nonce, acr, amr, auth_time: authTime } = claims;
    const now = Math.floor(this.now() / 1000);
    const audience = typeof aud === 'string' ? [aud] : aud;
    if (
      iss !== this.options.issuer ||
      typeof sub !== 'string' ||
      !sub ||
      sub.length > 255 ||
      !Array.isArray(audience) ||
      audience.some((id) => typeof id !== 'string') ||
      !audience.includes(this.options.clientId) ||
      ((audience.length > 1 || azp !== undefined) && azp !== this.options.clientId) ||
      !integerTime(exp) ||
      exp <= now ||
      !integerTime(iat) ||
      iat > now ||
      iat >= exp ||
      (nbf !== undefined && (!integerTime(nbf) || nbf > now)) ||
      nonce !== attempt.nonce
    )
      throw new Error('Invalid ID token claims.');

    const mfa =
      (Array.isArray(amr) && amr.includes('mfa')) ||
      (typeof acr === 'string' && this.options.mfaAcrValues?.includes(acr));
    const mfaAt = mfa && integerTime(authTime) && authTime <= iat ? authTime * 1000 : undefined;
    if (
      attempt.stepUp &&
      (mfaAt === undefined || mfaAt < Math.floor(attempt.startedAt / 1000) * 1000)
    )
      throw new Error('Fresh MFA is required.');
    return {
      issuer: iss,
      subject: sub,
      verifiedEmail:
        claims.email_verified === true && typeof claims.email === 'string'
          ? claims.email
          : undefined,
      mfaAt,
    };
  }

  async logoutUrl() {
    const { logout } = await this.discover();
    if (!logout) return undefined;
    const url = new URL(logout);
    url.searchParams.set('client_id', this.options.clientId);
    return url.href;
  }
}

function integerTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
