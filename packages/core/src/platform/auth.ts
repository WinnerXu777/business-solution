import type { Actor } from '@bs/contracts';
import { PlatformError } from './audit.ts';
import { randomToken, tokenDigest } from './auth-crypto.ts';
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
  tenantId: string;
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
  private readonly enrollments = new Map<string, Enrollment>();

  constructor(directory: TenantDirectory, options: PlatformAuthOptions) {
    this.directory = directory;
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
    const user = this.directory.userFor(principal);
    if (user && this.directory.sessionStamp({ tenantId, actor: user.actor })) {
      return { status: 'authenticated' as const, ...this.issue(tenantId, user.actor, principal) };
    }
    const tenantVersion = this.directory.activeVersion(tenantId);
    if (!principal.verifiedEmail || tenantVersion === undefined)
      throw new PlatformError('forbidden');
    const now = this.now();
    for (const [digest, entry] of this.enrollments) {
      if (entry.expiresAt <= now) this.enrollments.delete(digest);
    }
    if (this.enrollments.size >= 1000) throw new PlatformError('unavailable');
    const enrollmentToken = randomToken();
    const expiresAt = now + 5 * 60_000;
    this.enrollments.set(tokenDigest(enrollmentToken), {
      tenantId,
      tenantVersion,
      principal,
      expiresAt,
    });
    return {
      status: 'enrollment_required' as const,
      enrollmentToken,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  acceptInvite(inviteToken: string, enrollmentToken: string) {
    const digest = tokenDigest(enrollmentToken);
    const enrollment = this.enrollments.get(digest);
    if (
      !enrollment ||
      enrollment.expiresAt <= this.now() ||
      this.directory.activeVersion(enrollment.tenantId) !== enrollment.tenantVersion
    )
      throw new PlatformError('forbidden');
    const { tenantId, principal } = enrollment;
    const member = this.directory.acceptInvite(tenantId, inviteToken, principal);
    this.enrollments.delete(digest);
    return this.issue(tenantId, member.user.actor, principal);
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
    if (!this.sessions.logout(refreshToken)) return {};
    const logoutUrl = await this.oidc.logoutUrl().catch(() => undefined);
    return logoutUrl ? { logoutUrl } : {};
  }
}
