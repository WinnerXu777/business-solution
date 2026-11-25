import type { TenantDirectory } from '../../../../packages/core/src/platform/index.ts';
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
  return (token) => structuredClone(bindings.get(token));
}
