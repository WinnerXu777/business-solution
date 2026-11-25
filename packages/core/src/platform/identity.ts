import { loadDemoFixtures, type Actor, type ActorGrant, type DemoFixtures } from '@bs/contracts';

export type PlatformRole = ActorGrant['role'] | 'admin';
export interface PlatformIdentity {
  tenantId: string;
  actor: Actor;
}

export const fixtureAdmin = {
  tenantId: 'tenant-rivetquay',
  actor: { id: 'actor-admin', kind: 'person' },
  role: 'admin',
} as const;

const displayNames: Record<string, string> = {
  'actor-admin': 'Fixture Admin',
  'actor-operator': 'Fixture Operator',
  'actor-approver': 'Fixture Approver',
  'actor-reader': 'Fixture Reader',
  'actor-worker': 'Fixture Worker',
  'actor-isolation': 'Spoolharbour Operator',
};

export class TenantDirectory {
  private readonly fixtures: DemoFixtures;
  private readonly grants: (PlatformIdentity & { role: PlatformRole })[];

  constructor(fixtures = loadDemoFixtures()) {
    this.fixtures = structuredClone(fixtures);
    this.grants = [...this.fixtures.grants];
    if (this.fixtures.workspaces.some(({ id }) => id === fixtureAdmin.tenantId)) {
      this.grants.push(fixtureAdmin);
    }
  }

  workspaces(tenantId: string) {
    return this.fixtures.workspaces
      .filter(({ id }) => id === tenantId)
      .map(({ id, name }) => ({ id, name }));
  }

  resolve({ tenantId, actor }: PlatformIdentity) {
    const tenant = this.workspaces(tenantId)[0];
    const grant = this.grants.find(
      (row) =>
        row.tenantId === tenantId && row.actor.id === actor.id && row.actor.kind === actor.kind,
    );
    if (!tenant || !grant) return;
    return {
      tenant,
      actor: { ...grant.actor, displayName: displayNames[grant.actor.id] ?? grant.actor.id },
      role: grant.role,
      workspaces: this.workspaces(tenantId),
    };
  }
}
