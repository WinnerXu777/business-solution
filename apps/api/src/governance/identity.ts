import { loadDemoFixtures, type Actor, type CallEnvelope, type DemoFixtures } from '@bs/contracts';

export interface VerifiedIdentity {
  tenantId: string;
  actor: Actor;
}

export type IdentityVerifier = (
  token: string,
) => VerifiedIdentity | undefined | Promise<VerifiedIdentity | undefined>;

/** Token bindings are provisioned by the fixture host. Token text carries no identity claims. */
export function createFixtureIdentityVerifier(
  tokens: ReadonlyMap<string, VerifiedIdentity>,
  fixtures: DemoFixtures = loadDemoFixtures(),
): IdentityVerifier {
  const verifiedTokens = new Map<string, VerifiedIdentity>();
  for (const [token, identity] of tokens) {
    if (!token || !fixtures.grants.some((grant) => matchesIdentity(grant, identity))) {
      throw new Error('Invalid fixture identity binding.');
    }
    verifiedTokens.set(token, structuredClone(identity));
  }
  return (token) => structuredClone(verifiedTokens.get(token));
}

export function matchesIdentity(claim: VerifiedIdentity, identity: VerifiedIdentity) {
  return (
    claim.tenantId === identity.tenantId &&
    claim.actor.id === identity.actor.id &&
    claim.actor.kind === identity.actor.kind
  );
}

export function verifiedEnvelope(
  claim: CallEnvelope,
  identity: VerifiedIdentity,
  source: CallEnvelope['source'],
): CallEnvelope {
  return { ...claim, tenantId: identity.tenantId, actor: identity.actor, source };
}
