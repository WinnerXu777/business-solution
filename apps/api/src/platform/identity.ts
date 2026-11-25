import type {
  PlatformAuth,
  TenantDirectory,
} from '../../../../packages/core/src/platform/index.ts';
import type { IdentityVerifier, VerifiedIdentity } from '../governance/identity.ts';

/** The host provisions tokens, and the directory resolves roles from verified identities. */
export function createPlatformFixtureIdentityVerifier(
  tokens: ReadonlyMap<string, VerifiedIdentity>,
  directory: TenantDirectory,
): IdentityVerifier {
  const bindings = new Map<string, VerifiedIdentity>();
  for (const [token, identity] of tokens) {
    if (!token || !directory.resolve(identity))
      throw new Error('Invalid platform fixture identity binding.');
    bindings.set(token, { tenantId: identity.tenantId, actor: { ...identity.actor } });
  }
  return (token) => {
    const identity = bindings.get(token);
    return identity && directory.resolve(identity) ? structuredClone(identity) : undefined;
  };
}

/** Shared REST/MCP bootstrap can use this without knowing the platform session format. */
export function createPlatformSessionIdentityVerifier(auth: PlatformAuth): IdentityVerifier {
  return (token) => auth.sessions.verify(token)?.identity;
}
