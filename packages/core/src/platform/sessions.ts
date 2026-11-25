import { createHmac, timingSafeEqual } from 'node:crypto';
import { PlatformError } from './audit.ts';
import { decodeBase64Url, jsonObject, randomToken, tokenDigest } from './auth-crypto.ts';
import type { PlatformIdentity, TenantDirectory } from './identity.ts';

export interface SessionOptions {
  signingKey: Uint8Array;
  now?: () => number;
}

interface SessionStamp {
  membershipVersion: number;
  tenantVersion: number;
}

interface Session extends SessionStamp {
  id: string;
  identity: PlatformIdentity;
  refreshExpiresAt: number;
  mfaAt?: number;
  platformOperator: boolean;
}

const accessLifetime = 5 * 60_000;
const refreshLifetime = 8 * 60 * 60_000;
const mfaLifetime = 10 * 60_000;
const tokenPrefix = 'ps1';

export class PlatformSessions {
  private readonly directory: TenantDirectory;
  private readonly key: Buffer;
  private readonly instance = randomToken();
  private readonly now: () => number;
  private readonly refreshes = new Map<string, Session>();
  private readonly revoked = new Map<string, number>();

  constructor(directory: TenantDirectory, options: SessionOptions) {
    if (options.signingKey.byteLength < 32)
      throw new Error('Session signing key must be at least 32 bytes.');
    this.key = Buffer.from(options.signingKey);
    this.directory = directory;
    this.now = options.now ?? Date.now;
  }

  issue(identity: PlatformIdentity, assurance: { mfaAt?: number; platformOperator: boolean }) {
    const stamp = this.directory.sessionStamp(identity);
    if (!stamp) throw new PlatformError('forbidden');
    this.prune();
    return this.tokens({
      id: randomToken(),
      identity: structuredClone(identity),
      ...stamp,
      ...assurance,
      refreshExpiresAt: this.now() + refreshLifetime,
    });
  }

  private sign(encoded: string) {
    return createHmac('sha256', this.key)
      .update(this.instance + '.' + tokenPrefix + '.' + encoded)
      .digest();
  }

  private tokens(session: Session) {
    const expiresAt = Math.min(this.now() + accessLifetime, session.refreshExpiresAt);
    const encoded = Buffer.from(
      JSON.stringify({ ...session, expiresAt, jti: randomToken() }),
    ).toString('base64url');
    const accessToken = [tokenPrefix, encoded, this.sign(encoded).toString('base64url')].join('.');
    const refreshToken = randomToken();
    this.refreshes.set(tokenDigest(refreshToken), session);
    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(expiresAt).toISOString(),
      refreshExpiresAt: new Date(session.refreshExpiresAt).toISOString(),
    };
  }

  private live(session: Session) {
    const stamp = this.directory.sessionStamp(session.identity);
    return (
      session.refreshExpiresAt > this.now() &&
      !this.revoked.has(session.id) &&
      stamp?.membershipVersion === session.membershipVersion &&
      stamp?.tenantVersion === session.tenantVersion
    );
  }

  verify(token: string) {
    try {
      if (token.length > 4096) return;
      const [prefix, encoded, signature, ...extra] = token.split('.');
      if (prefix !== tokenPrefix || !encoded || !signature || extra.length) return;
      const provided = decodeBase64Url(signature);
      const expected = this.sign(encoded);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return;
      // Only this service can sign the payload and uses a versioned token prefix.
      const { expiresAt, ...claims } = jsonObject(encoded);
      const session = claims as unknown as Session;
      const now = this.now();
      if (typeof expiresAt !== 'number' || expiresAt <= now || !this.live(session)) return;
      return {
        identity: session.identity,
        platformOperator: session.platformOperator,
        steppedUp:
          session.mfaAt !== undefined && session.mfaAt <= now && now - session.mfaAt < mfaLifetime,
      };
    } catch {
      return undefined;
    }
  }

  refresh(token: string) {
    this.prune();
    const digest = tokenDigest(token);
    const session = this.refreshes.get(digest);
    if (!session || !this.live(session)) throw new PlatformError('forbidden');
    this.refreshes.delete(digest);
    return this.tokens(session);
  }

  logout(token: string) {
    this.prune();
    const digest = tokenDigest(token);
    const session = this.refreshes.get(digest);
    if (!session) return false;
    this.refreshes.delete(digest);
    this.revoked.set(session.id, session.refreshExpiresAt);
    return true;
  }

  private prune() {
    const now = this.now();
    for (const [digest, session] of this.refreshes) {
      if (session.refreshExpiresAt <= now) this.refreshes.delete(digest);
    }
    for (const [id, expiresAt] of this.revoked) {
      if (expiresAt <= now) this.revoked.delete(id);
    }
  }
}
