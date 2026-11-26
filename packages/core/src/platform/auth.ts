import type { Actor } from '@bs/contracts';
import { PlatformError } from './audit.ts';
import { routedToken, tokenDigest, tokenTenant } from './auth-crypto.ts';
import { oidcKey, type TenantDirectory } from './identity.ts';
import { OidcRelyingParty, type OidcOptions, type OidcPrincipal } from './oidc.ts';
import { PlatformSessions } from './sessions.ts';

export interface PlatformAuthOptions {
  oidc: OidcOptions;
  signingKey: Uint8Array;
  platformOperators?: readonly { issuer: string; subject: string }[];
  requireStepUp?: boolean;
}

interface Enrollment {
  digest: string;
  tenantVersion: number;
  principal: OidcPrincipal;
  expiresAt: number;
}

export class PlatformAuth {
  readonly directory: TenantDirectory;
  readonly sessions: PlatformSessions;
  readonly requireStepUp: boolean;
  private readonly oidc: OidcRelyingParty;
  private readonly now: () => number;
  private readonly operators: Set<string>;
  private readonly enrollments;

  constructor(directory: TenantDirectory, options: PlatformAuthOptions) {
    this.directory = directory;
    this.enrollments = directory.persistence.repository<Enrollment>('enrollments');
    this.now = options.oidc.now ?? Date.now;
    this.oidc = new OidcRelyingParty(options.oidc);
    this.sessions = new PlatformSessions(directory, {
      signingKey: options.signingKey,
      now: this.now,
    });
    this.operators = new Set(
      options.platformOperators?.map(({ issuer, subject }) => oidcKey(issuer, subject)),
    );
    this.requireStepUp = options.requireStepUp ?? true;
  }

  login(tenantId: string, stepUp: boolean) {
    return this.oidc.login(tenantId, stepUp);
  }

  async callback(state: string, code: string, browserToken: string | undefined) {
    const { tenantId, principal } = await this.oidc.callback(state, code, browserToken);
    return this.directory.persistence.transaction(tenantId, async () => {
      const user = await this.directory.userFor(tenantId, principal);
      if (user && (await this.directory.sessionStamp({ tenantId, actor: user.actor }))) {
        return {
          status: 'authenticated' as const,
          ...(await this.issue(tenantId, user.actor, principal)),
        };
      }
      const tenantVersion = await this.directory.activeVersion(tenantId);
      if (!principal.verifiedEmail || tenantVersion === undefined)
        throw new PlatformError('forbidden');
      const now = this.now();
      const entries = await this.enrollments.list(tenantId);
      let active = 0;
      for (const entry of entries) {
        if (entry.expiresAt <= now) await this.enrollments.delete(tenantId, entry.digest);
        else active++;
      }
      if (active >= 1000) throw new PlatformError('unavailable');
      const enrollmentToken = routedToken(tenantId);
      const digest = tokenDigest(enrollmentToken);
      const expiresAt = now + 5 * 60_000;
      await this.enrollments.write(
        tenantId,
        digest,
        { digest, tenantVersion, principal, expiresAt },
        null,
      );
      return {
        status: 'enrollment_required' as const,
        enrollmentToken,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    });
  }

  async acceptInvite(inviteToken: string, enrollmentToken: string) {
    const tenantId = tokenTenant(enrollmentToken);
    if (!tenantId) throw new PlatformError('forbidden');
    const digest = tokenDigest(enrollmentToken);
    return this.directory.persistence.transaction(tenantId, async () => {
      const enrollment = await this.enrollments.get(tenantId, digest);
      if (
        !enrollment ||
        enrollment.expiresAt <= this.now() ||
        (await this.directory.activeVersion(tenantId)) !== enrollment.tenantVersion
      )
        throw new PlatformError('forbidden');

      const member = await this.directory.acceptInvite(tenantId, inviteToken, enrollment.principal);
      await this.enrollments.delete(tenantId, digest);
      return this.issue(tenantId, member.user.actor, enrollment.principal);
    });
  }
  private issue(tenantId: string, actor: Actor, principal: OidcPrincipal) {
    return this.sessions.issue(
      { tenantId, actor },
      {
        mfaAt: principal.mfaAt,
        platformOperator: this.operators.has(oidcKey(principal.issuer, principal.subject)),
      },
    );
  }

  async logout(refreshToken: string) {
    if (!(await this.sessions.logout(refreshToken))) return {};
    const logoutUrl = await this.oidc.logoutUrl().catch(() => undefined);
    return logoutUrl ? { logoutUrl } : {};
  }
}
