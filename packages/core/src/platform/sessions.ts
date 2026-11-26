import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { PlatformError, type MutationContext } from './audit.ts';
import {
  decodeBase64Url,
  jsonObject,
  randomToken,
  routedToken,
  tokenDigest,
  tokenTenant,
} from './auth-crypto.ts';
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
const tokenPrefix = 'ps2';

export class PlatformSessions {
  private readonly directory: TenantDirectory;
  private readonly key: Buffer;

  private readonly now: () => number;
  private readonly refreshes;
  private readonly families;
  private readonly revoked;

  constructor(directory: TenantDirectory, options: SessionOptions) {
    if (options.signingKey.byteLength < 32)
      throw new Error('Session signing key must be at least 32 bytes.');
    this.key = Buffer.from(options.signingKey);
    this.directory = directory;
    this.refreshes = directory.persistence.repository<{ familyId: string }>('refresh_tokens');
    this.families = directory.persistence.repository<Session & { refreshDigest: string }>(
      'refresh_families',
    );
    this.revoked = directory.persistence.repository<{ id: string; expiresAt: number }>(
      'session_revocations',
    );
    this.now = options.now ?? Date.now;
  }

  issue(identity: PlatformIdentity, assurance: { mfaAt?: number; platformOperator: boolean }) {
    return this.directory.persistence.transaction(identity.tenantId, async () => {
      const stamp = await this.directory.sessionStamp(identity);
      if (!stamp) throw new PlatformError('forbidden');
      await this.prune(identity.tenantId);
      return this.tokens(
        {
          id: randomToken(),
          identity: structuredClone(identity),
          ...stamp,
          ...assurance,
          refreshExpiresAt: this.now() + refreshLifetime,
        },
        'issue',
      );
    });
  }
  private sign(encoded: string) {
    return createHmac('sha256', this.key)
      .update(tokenPrefix + '.' + encoded)
      .digest();
  }

  private async tokens(session: Session, action: 'issue' | 'refresh') {
    const expiresAt = Math.min(this.now() + accessLifetime, session.refreshExpiresAt);
    const encoded = Buffer.from(
      JSON.stringify({ ...session, expiresAt, jti: randomToken() }),
    ).toString('base64url');
    const accessToken = [tokenPrefix, encoded, this.sign(encoded).toString('base64url')].join('.');
    const { tenantId } = session.identity;
    const refreshToken = routedToken(tenantId);
    const refreshDigest = tokenDigest(refreshToken);
    await this.refreshes.write(tenantId, refreshDigest, { familyId: session.id }, null);
    await this.families.put(tenantId, session.id, { ...session, refreshDigest });
    await this.record(session, action);
    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(expiresAt).toISOString(),
      refreshExpiresAt: new Date(session.refreshExpiresAt).toISOString(),
    };
  }

  private async live(session: Session) {
    const stamp = await this.directory.sessionStamp(session.identity);
    return (
      session.refreshExpiresAt > this.now() &&
      !(await this.revoked.get(session.identity.tenantId, session.id)) &&
      stamp?.membershipVersion === session.membershipVersion &&
      stamp?.tenantVersion === session.tenantVersion
    );
  }

  async verify(token: string) {
    let session: Session;
    let expiresAt: unknown;
    try {
      if (token.length > 4096) return;
      const [prefix, encoded, signature, ...extra] = token.split('.');
      if (prefix !== tokenPrefix || !encoded || !signature || extra.length) return;
      const provided = decodeBase64Url(signature);
      const expected = this.sign(encoded);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return;
      // Only this service can sign the payload and uses a versioned token prefix.
      const { expiresAt: expiration, ...claims } = jsonObject(encoded);
      expiresAt = expiration;
      session = claims as unknown as Session;
    } catch {
      return;
    }
    const now = this.now();
    if (typeof expiresAt !== 'number' || expiresAt <= now) return;
    return this.directory.persistence.transaction(session.identity.tenantId, async () => {
      if (
        !(await this.families.get(session.identity.tenantId, session.id)) ||
        !(await this.live(session))
      )
        return;
      return {
        identity: session.identity,
        platformOperator: session.platformOperator,
        steppedUp:
          session.mfaAt !== undefined && session.mfaAt <= now && now - session.mfaAt < mfaLifetime,
      };
    });
  }

  private record(session: Session, action: string) {
    const context: MutationContext = {
      ...session.identity,
      source: 'rest',
      traceId: randomUUID(),
      correlationId: randomUUID(),
    };
    return this.directory.sessionAudit.record(context, 'platform.session.' + action);
  }

  private async family(tenantId: string, digest: string) {
    const token = await this.refreshes.get(tenantId, digest);
    if (!token) return;
    const family = await this.families.get(tenantId, token.familyId);
    if (family?.refreshDigest === digest) return family;
  }

  async refresh(token: string) {
    const tenantId = tokenTenant(token);
    if (!tenantId) throw new PlatformError('forbidden');
    const digest = tokenDigest(token);
    return this.directory.persistence.transaction(tenantId, async () => {
      const family = await this.family(tenantId, digest);
      if (!family || !(await this.live(family))) throw new PlatformError('forbidden');
      const { refreshDigest, ...session } = family;
      await this.refreshes.delete(tenantId, refreshDigest);
      return this.tokens(session, 'refresh');
    });
  }

  async logout(token: string) {
    const tenantId = tokenTenant(token);
    if (!tenantId) return false;
    const digest = tokenDigest(token);
    return this.directory.persistence.transaction(tenantId, async () => {
      const family = await this.family(tenantId, digest);
      if (!family || family.refreshExpiresAt <= this.now()) return false;
      await this.refreshes.delete(tenantId, digest);
      await this.families.delete(tenantId, family.id);
      await this.revoked.write(
        tenantId,
        family.id,
        { id: family.id, expiresAt: family.refreshExpiresAt },
        null,
      );
      await this.record(family, 'logout');
      return true;
    });
  }

  private async prune(tenantId: string) {
    const now = this.now();
    for (const { id, refreshDigest, refreshExpiresAt } of await this.families.list(tenantId)) {
      if (refreshExpiresAt > now) continue;
      await this.refreshes.delete(tenantId, refreshDigest);
      await this.families.delete(tenantId, id);
    }
    for (const { id, expiresAt } of await this.revoked.list(tenantId)) {
      if (expiresAt <= now) await this.revoked.delete(tenantId, id);
    }
  }
}
