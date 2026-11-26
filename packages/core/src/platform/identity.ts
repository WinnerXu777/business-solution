import { randomUUID } from 'node:crypto';
import { loadDemoFixtures, type Actor, type ActorGrant, type AuditEntry } from '@bs/contracts';
import { PlatformAudit, PlatformError, type MutationContext } from './audit.ts';
import { MemoryPlatformPersistence, type PlatformPersistence } from './repository.ts';
import { randomToken, tokenDigest } from './auth-crypto.ts';
import type { PlanInput } from './billing.ts';
import { isSku } from './billing-catalog.ts';
import type { OidcPrincipal } from './oidc.ts';
import {
  builtInRoles,
  hasPermissions,
  permissions,
  type Permission,
  type RoleDefinition,
} from './permissions.ts';

export type PlatformRole = ActorGrant['role'] | 'admin';
export interface PlatformIdentity {
  tenantId: string;
  actor: Actor;
}

export interface User {
  actor: Actor;
  displayName: string;
}

export interface Membership {
  id: string;
  role: string;
  version: number;
  user: User;
}

export const nativeTenantRegion = 'ca-central-1';

export interface TenantInput {
  name: string;
  region: typeof nativeTenantRegion;
  plan: PlanInput;
  adminEmail: string;
}

export interface Tenant {
  id: string;
  name: string;
  region: typeof nativeTenantRegion;
  status: 'active' | 'suspended';
  createdAt: string;
}

interface TenantState {
  tenant: Tenant;
  sessionVersion: number;
  plan?: PlanInput;
}

interface Invite {
  digest: string;
  roleId: string;
  email: string;
  expiresAt: number;
}

interface ExportRequest {
  id: string;
  tenantId: string;
  requestedBy: string;
  requestedAt: string;
  status: 'requested';
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
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const inviteLifetime = 24 * 60 * 60_000;

export function oidcKey(issuer: string, subject: string) {
  return JSON.stringify([issuer, subject]);
}

function emailAddress(email: string) {
  if (email.length > 254 || !emailPattern.test(email)) throw new PlatformError('forbidden');
  return email.toLowerCase();
}

interface Workspace {
  id: string;
  name: string;
}

type StoredUser = User & { principal?: string };
type StoredMembership = Omit<Membership, 'user'>;

function evidence(identity: PlatformIdentity, context?: MutationContext): MutationContext {
  const supplied = context ?? ('source' in identity ? (identity as MutationContext) : undefined);
  return supplied
    ? { ...supplied, ...identity }
    : { ...identity, source: 'rest', traceId: randomUUID(), correlationId: randomUUID() };
}

export class TenantDirectory {
  readonly persistence: PlatformPersistence;
  private readonly tenants;
  private readonly workspaceRows;
  private readonly users;
  private readonly subjects;
  private readonly memberships;
  private readonly roleRows;
  private readonly invites;
  private readonly exports;
  readonly sessionAudit: PlatformAudit;
  private readonly fixtures;
  private readonly now: () => string;

  constructor(
    fixtures = loadDemoFixtures(),
    now = () => new Date().toISOString(),
    persistence: PlatformPersistence = new MemoryPlatformPersistence(),
    audit?: PlatformAudit,
  ) {
    this.persistence = persistence;
    this.fixtures = structuredClone(fixtures);
    this.now = now;
    this.tenants = persistence.repository<TenantState>('tenants');
    this.workspaceRows = persistence.repository<Workspace>('workspaces');
    this.users = persistence.repository<StoredUser>('users');
    this.subjects = persistence.repository<{ actorId: string }>('oidc_subjects');
    this.memberships = persistence.repository<StoredMembership>('memberships');
    this.roleRows = persistence.repository<RoleDefinition>('roles');
    this.invites = persistence.repository<Invite>('invites');
    this.exports = persistence.repository<ExportRequest>('tenant_exports');
    const entries = persistence.repository<AuditEntry>('audit');
    this.sessionAudit =
      audit ??
      new PlatformAudit(
        { append: (entry) => entries.put(entry.tenantId, entry.id, entry) },
        now,
        persistence,
      );
  }

  private async initialize(id: string, name: string, createdAt: string, plan?: PlanInput) {
    const tenant: Tenant = { id, name, region: nativeTenantRegion, status: 'active', createdAt };
    const state = { tenant, plan, sessionVersion: 1 };
    await this.tenants.write(id, id, state, null);
    await this.workspaceRows.write(id, id, { id, name }, null);
    for (const role of builtInRoles()) await this.roleRows.write(id, role.id, role, null);
    return state;
  }

  private async state(tenantId: string) {
    const stored = await this.tenants.get(tenantId, tenantId);
    if (stored) return stored;
    const workspace = this.fixtures.workspaces.find(({ id }) => id === tenantId);
    if (!workspace) return;
    return this.persistence.transaction(tenantId, async () => {
      const current = await this.tenants.get(tenantId, tenantId);
      if (current) return current;
      const state = await this.initialize(tenantId, workspace.name, this.fixtures.asOf);
      const grants =
        tenantId === fixtureAdmin.tenantId
          ? [...this.fixtures.grants, fixtureAdmin]
          : this.fixtures.grants;
      for (const { tenantId: grantTenant, actor, role } of grants) {
        if (grantTenant !== tenantId) continue;
        await this.users.write(
          tenantId,
          actor.id,
          { actor, displayName: displayNames[actor.id] ?? actor.id },
          null,
        );
        await this.memberships.write(tenantId, actor.id, { id: actor.id, role, version: 1 }, null);
      }
      return state;
    });
  }

  private async tenantState(tenantId: string, active = true) {
    const state = await this.state(tenantId);
    if (!state || (active && state.tenant.status !== 'active'))
      throw new PlatformError('not_found');
    return state;
  }

  private async membership(tenantId: string, id: string): Promise<Membership | undefined> {
    const member = await this.memberships.get(tenantId, id);
    const user = member && (await this.users.get(tenantId, id));
    if (member && user)
      return { ...member, user: { actor: user.actor, displayName: user.displayName } };
  }

  private async member({ tenantId, actor }: PlatformIdentity) {
    const state = await this.state(tenantId);
    if (state?.tenant.status !== 'active') return;
    const member = await this.membership(tenantId, actor.id);
    return member?.user.actor.kind === actor.kind ? member : undefined;
  }

  async workspaces(tenantId: string) {
    if ((await this.state(tenantId))?.tenant.status !== 'active') return [];
    return this.workspaceRows.list(tenantId);
  }

  resolve(identity: PlatformIdentity) {
    return this.persistence.transaction(identity.tenantId, async () => {
      const member = await this.member(identity);
      if (!member) return;
      const workspaces = await this.workspaces(identity.tenantId);
      return {
        tenant: workspaces[0],
        actor: { ...member.user.actor, displayName: member.user.displayName },
        role: member.role,
        workspaces,
      };
    });
  }

  sessionStamp(identity: PlatformIdentity) {
    return this.persistence.transaction(identity.tenantId, async () => {
      const member = await this.member(identity);
      if (member)
        return {
          membershipVersion: member.version,
          tenantVersion: (await this.tenantState(identity.tenantId)).sessionVersion,
        };
    });
  }

  async activeVersion(tenantId: string) {
    const state = await this.state(tenantId);
    return state?.tenant.status === 'active' ? state.sessionVersion : undefined;
  }

  allows(identity: PlatformIdentity, permission: Permission) {
    return this.persistence.transaction(identity.tenantId, async () => {
      const member = await this.member(identity);
      return member
        ? hasPermissions(await this.roleRows.get(identity.tenantId, member.role), permission)
        : false;
    });
  }

  linkUser(tenantId: string, actorId: string, issuer: string, subject: string) {
    return this.persistence.transaction(tenantId, async () => {
      await this.tenantState(tenantId);
      const key = tokenDigest(oidcKey(issuer, subject));
      const user = await this.users.get(tenantId, actorId);
      const linked = await this.subjects.get(tenantId, key);
      if (
        user?.actor.kind !== 'person' ||
        (linked && linked.actorId !== actorId) ||
        (user.principal && user.principal !== key)
      )
        throw new PlatformError('forbidden');
      if (linked) return;
      await this.subjects.write(tenantId, key, { actorId }, null);
      await this.users.put(tenantId, actorId, { ...user, principal: key });
      await this.sessionAudit.record(
        evidence({ tenantId, actor: user.actor }),
        'platform.user.link',
        'ok',
        actorId,
      );
    });
  }

  async userFor(tenantId: string, { issuer, subject }: OidcPrincipal) {
    const linked = await this.subjects.get(tenantId, tokenDigest(oidcKey(issuer, subject)));
    const user = linked && (await this.users.get(tenantId, linked.actorId));
    if (user) return { actor: user.actor, displayName: user.displayName };
  }

  async members(tenantId: string) {
    await this.tenantState(tenantId);
    const members = await this.memberships.list(tenantId);
    return (await Promise.all(members.map(({ id }) => this.membership(tenantId, id)))).filter(
      (member) => member !== undefined,
    );
  }

  async roles(tenantId: string) {
    await this.tenantState(tenantId);
    return this.roleRows.list(tenantId);
  }

  createRole(
    context: PlatformIdentity,
    input: { id: string; name: string; permissions: Permission[] },
  ) {
    return this.persistence.transaction(context.tenantId, async () => {
      const { tenantId } = context;
      await this.tenantState(tenantId);
      const name = input.name.trim();
      const member = await this.member(context);
      const allowed = await Promise.all(
        input.permissions.map(
          async (permission) =>
            permissions.includes(permission) &&
            (member?.role === 'admin' || (await this.allows(context, permission))),
        ),
      );
      if (
        !(await this.allows(context, 'roles.manage')) ||
        !idPattern.test(input.id) ||
        (await this.roleRows.get(tenantId, input.id)) ||
        !name ||
        name.length > 120 ||
        !allowed.length ||
        allowed.includes(false)
      )
        throw new PlatformError('forbidden');
      const role = {
        id: input.id,
        name,
        permissions: [...new Set(input.permissions)],
        builtIn: false,
      };
      await this.roleRows.write(tenantId, role.id, role, null);
      await this.sessionAudit.record(evidence(context), 'platform.role.create', 'ok', role.id);
      return role;
    });
  }

  private async delegable(context: PlatformIdentity, roleId: string) {
    await this.tenantState(context.tenantId);
    const role = await this.roleRows.get(context.tenantId, roleId);
    if (!role) throw new PlatformError('not_found');
    if (
      !(await this.allows(context, 'members.manage')) ||
      ((await this.member(context))?.role !== 'admin' &&
        (role.id === 'admin' ||
          (
            await Promise.all(
              role.permissions.map((permission) => this.allows(context, permission)),
            )
          ).includes(false)))
    )
      throw new PlatformError('forbidden');
  }

  private async target(context: PlatformIdentity, id: string) {
    await this.tenantState(context.tenantId);
    const member = await this.membership(context.tenantId, id);
    if (!member) throw new PlatformError('not_found');
    await this.delegable(context, member.role);
    return member;
  }

  private async checkAdminRemains(tenantId: string, member: Membership) {
    if (
      member.role === 'admin' &&
      !(await this.memberships.list(tenantId)).some(
        ({ id, role }) => id !== member.id && role === 'admin',
      )
    )
      throw new PlatformError('forbidden');
  }

  assignRole(context: PlatformIdentity, id: string, roleId: string) {
    return this.persistence.transaction(context.tenantId, async () => {
      const member = await this.target(context, id);
      await this.delegable(context, roleId);
      if (member.role === roleId) return member;
      await this.checkAdminRemains(context.tenantId, member);
      const next = { id, role: roleId, version: member.version + 1 };
      await this.memberships.put(context.tenantId, id, next);
      await this.sessionAudit.record(evidence(context), 'platform.member.assign', 'ok', id);
      return { ...next, user: member.user };
    });
  }

  removeMember(context: PlatformIdentity, id: string) {
    return this.persistence.transaction(context.tenantId, async () => {
      const member = await this.target(context, id);
      await this.checkAdminRemains(context.tenantId, member);
      // Keep the last membership epoch after deletion so re-enrollment cannot revive old sessions.
      await this.persistence
        .repository<number>('membership_epochs')
        .put(context.tenantId, id, member.version);
      await this.memberships.delete(context.tenantId, id);
      await this.sessionAudit.record(evidence(context), 'platform.member.remove', 'ok', id);
    });
  }

  createInvite(context: PlatformIdentity, email: string, roleId: string) {
    return this.persistence.transaction(context.tenantId, async () => {
      await this.delegable(context, roleId);
      const invite = await this.invite(context.tenantId, emailAddress(email), roleId);
      await this.sessionAudit.record(evidence(context), 'platform.invite.create');
      return invite;
    });
  }

  private async invite(tenantId: string, email: string, roleId: string) {
    const token = randomToken();
    const instant = Date.parse(this.now());
    const expiresAt = instant + inviteLifetime;
    for (const invite of await this.invites.list(tenantId)) {
      if (invite.expiresAt <= instant) await this.invites.delete(tenantId, invite.digest);
    }
    const digest = tokenDigest(token);
    await this.invites.write(tenantId, digest, { digest, roleId, email, expiresAt }, null);
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  acceptInvite(tenantId: string, token: string, principal: OidcPrincipal) {
    return this.persistence.transaction(tenantId, async () => {
      await this.tenantState(tenantId);
      const key = tokenDigest(token);
      const invite = await this.invites.get(tenantId, key);
      if (
        !invite ||
        invite.expiresAt <= Date.parse(this.now()) ||
        principal.verifiedEmail?.toLowerCase() !== invite.email
      )
        throw new PlatformError('not_found');
      let user = await this.userFor(tenantId, principal);
      if (user && (await this.memberships.get(tenantId, user.actor.id)))
        throw new PlatformError('forbidden');
      if (!user) {
        const id = 'actor-' + randomUUID();
        user = { actor: { id, kind: 'person' }, displayName: id };
        await this.users.write(tenantId, id, user, null);
        await this.linkUser(tenantId, id, principal.issuer, principal.subject);
      }
      const id = user.actor.id;
      const prior = await this.persistence
        .repository<number>('membership_epochs')
        .get(tenantId, id);
      const member = { id, role: invite.roleId, version: (prior ?? 0) + 1 };
      await this.memberships.write(tenantId, id, member, null);
      await this.invites.delete(tenantId, key);
      await this.sessionAudit.record(
        evidence({ tenantId, actor: user.actor }),
        'platform.invite.accept',
        'ok',
        id,
      );
      return { ...member, user };
    });
  }

  async provision(input: TenantInput, context?: MutationContext) {
    const name = input.name.trim();
    const email = emailAddress(input.adminEmail);
    const { addOns, overageLimitCents = 0 } = input.plan;
    if (
      !name ||
      name.length > 120 ||
      input.region !== nativeTenantRegion ||
      addOns.some((id) => !isSku(id) || String(id) === 'platform') ||
      !Number.isSafeInteger(overageLimitCents) ||
      overageLimitCents < 0
    )
      throw new PlatformError('forbidden');
    const id = 'tenant-' + randomUUID();
    return this.persistence.transaction(id, async () => {
      const { tenant } = await this.initialize(id, name, this.now(), {
        addOns: [...new Set(addOns)].sort(),
        overageLimitCents,
      });
      const adminInvite = await this.invite(id, email, 'admin');
      await this.sessionAudit.record(
        evidence({ tenantId: id, actor: context?.actor ?? fixtureAdmin.actor }, context),
        'platform.tenant.provision',
        'ok',
        id,
      );
      return { tenant, adminInvite };
    });
  }

  async initialPlan(tenantId: string) {
    const state = await this.tenants.get(tenantId, tenantId);
    return state?.plan ? { ...state.plan, createdAt: state.tenant.createdAt } : undefined;
  }

  setTenantStatus(tenantId: string, status: Tenant['status'], context?: MutationContext) {
    return this.persistence.transaction(tenantId, async () => {
      const state = await this.tenantState(tenantId, false);
      if (state.tenant.status !== status) {
        state.tenant.status = status;
        state.sessionVersion++;
        await this.tenants.put(tenantId, tenantId, state);
        await this.sessionAudit.record(
          evidence({ tenantId, actor: context?.actor ?? fixtureAdmin.actor }, context),
          'platform.tenant.' + status,
          'ok',
          tenantId,
        );
      }
      return state.tenant;
    });
  }

  requestExport(context: PlatformIdentity) {
    return this.persistence.transaction(context.tenantId, async () => {
      if (!(await this.allows(context, 'exports.request'))) throw new PlatformError('forbidden');
      const { tenantId, actor } = context;
      const record: ExportRequest = {
        id: 'export-' + randomUUID(),
        tenantId,
        requestedBy: actor.id,
        requestedAt: this.now(),
        status: 'requested',
      };
      await this.exports.write(tenantId, record.id, record, null);
      await this.sessionAudit.record(evidence(context), 'platform.tenant.export', 'ok', record.id);
      return record;
    });
  }

  async exportRequests(context: PlatformIdentity) {
    if (!(await this.allows(context, 'exports.request'))) throw new PlatformError('forbidden');
    return this.exports.list(context.tenantId);
  }
}
