import { randomUUID } from 'node:crypto';
import { loadDemoFixtures, type Actor, type ActorGrant } from '@bs/contracts';
import { PlatformError } from './audit.ts';
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
  members: Map<string, Membership>;
  roles: Map<string, RoleDefinition>;
  invites: Map<string, Invite>;
  exports: Map<string, ExportRequest>;
}

interface Invite {
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

/** Synchronous process-local identity store. Mutation methods require a trusted caller. */
export class TenantDirectory {
  private readonly tenants = new Map<string, TenantState>();
  private readonly users = new Map<string, User>();
  private readonly subjects = new Map<string, string>();
  private readonly linkedActors = new Map<string, string>();
  private readonly now: () => string;
  private nextVersion = 1;

  constructor(fixtures = loadDemoFixtures(), now = () => new Date().toISOString()) {
    this.now = now;
    for (const { id, name } of fixtures.workspaces) this.addTenant(id, name, fixtures.asOf);
    const grants = this.tenants.has(fixtureAdmin.tenantId)
      ? [...fixtures.grants, fixtureAdmin]
      : fixtures.grants;
    for (const { tenantId, actor, role } of grants) {
      const displayName = displayNames[actor.id] ?? actor.id;
      this.users.set(actor.id, { actor: { ...actor }, displayName });
      this.addMember(this.tenantState(tenantId), actor.id, role);
    }
  }

  private addTenant(id: string, name: string, createdAt: string, plan?: PlanInput): TenantState {
    const state: TenantState = {
      tenant: { id, name, region: nativeTenantRegion, status: 'active', createdAt },
      plan,
      sessionVersion: 1,
      members: new Map(),
      roles: new Map(builtInRoles().map((role) => [role.id, role])),
      invites: new Map(),
      exports: new Map(),
    };
    this.tenants.set(id, state);
    return state;
  }

  private tenantState(tenantId: string, active = true) {
    const state = this.tenants.get(tenantId);
    if (!state || (active && state.tenant.status !== 'active'))
      throw new PlatformError('not_found');
    return state;
  }

  private addMember(state: TenantState, actorId: string, role: string) {
    const member = {
      id: actorId,
      role,
      user: this.users.get(actorId)!,
      version: this.nextVersion++,
    };
    state.members.set(actorId, member);
    return member;
  }

  workspaces(tenantId: string) {
    const tenant = this.tenants.get(tenantId)?.tenant;
    return tenant?.status === 'active' ? [{ id: tenant.id, name: tenant.name }] : [];
  }

  resolve(identity: PlatformIdentity) {
    const member = this.member(identity);
    if (!member) return;
    const workspaces = this.workspaces(identity.tenantId);
    return {
      tenant: workspaces[0],
      actor: { ...member.user.actor, displayName: member.user.displayName },
      role: member.role,
      workspaces,
    };
  }

  private member({ tenantId, actor }: PlatformIdentity) {
    const state = this.tenants.get(tenantId);
    const member = state?.members.get(actor.id);
    if (state?.tenant.status === 'active' && member?.user.actor.kind === actor.kind) return member;
  }

  sessionStamp(identity: PlatformIdentity) {
    const member = this.member(identity);
    if (member)
      return {
        membershipVersion: member.version,
        tenantVersion: this.tenantState(identity.tenantId).sessionVersion,
      };
  }

  activeVersion(tenantId: string) {
    const state = this.tenants.get(tenantId);
    return state?.tenant.status === 'active' ? state.sessionVersion : undefined;
  }

  allows(identity: PlatformIdentity, permission: Permission) {
    const member = this.member(identity);
    return member
      ? hasPermissions(this.tenantState(identity.tenantId).roles.get(member.role), permission)
      : false;
  }

  linkUser(actorId: string, issuer: string, subject: string) {
    const key = oidcKey(issuer, subject);
    if (
      !this.users.has(actorId) ||
      this.users.get(actorId)?.actor.kind !== 'person' ||
      (this.subjects.has(key) && this.subjects.get(key) !== actorId) ||
      (this.linkedActors.has(actorId) && this.linkedActors.get(actorId) !== key)
    )
      throw new PlatformError('forbidden');
    this.subjects.set(key, actorId);
    this.linkedActors.set(actorId, key);
  }

  userFor({ issuer, subject }: OidcPrincipal) {
    const id = this.subjects.get(oidcKey(issuer, subject));
    return id ? structuredClone(this.users.get(id)) : undefined;
  }

  members(tenantId: string) {
    return structuredClone([...this.tenantState(tenantId).members.values()]);
  }

  roles(tenantId: string) {
    return structuredClone([...this.tenantState(tenantId).roles.values()]);
  }

  createRole(
    context: PlatformIdentity,
    input: { id: string; name: string; permissions: Permission[] },
  ) {
    const state = this.tenantState(context.tenantId);
    const name = input.name.trim();
    if (
      !this.allows(context, 'roles.manage') ||
      !idPattern.test(input.id) ||
      state.roles.has(input.id) ||
      !name ||
      name.length > 120 ||
      input.permissions.length === 0 ||
      input.permissions.some(
        (permission) =>
          !permissions.includes(permission) ||
          (this.member(context)?.role !== 'admin' && !this.allows(context, permission)),
      )
    )
      throw new PlatformError('forbidden');
    const role = {
      id: input.id,
      name,
      permissions: [...new Set(input.permissions)],
      builtIn: false,
    };
    state.roles.set(role.id, role);
    return structuredClone(role);
  }

  private delegable(context: PlatformIdentity, roleId: string) {
    const role = this.tenantState(context.tenantId).roles.get(roleId);
    if (!role) throw new PlatformError('not_found');
    if (
      !this.allows(context, 'members.manage') ||
      (this.member(context)?.role !== 'admin' &&
        (role.id === 'admin' ||
          role.permissions.some((permission) => !this.allows(context, permission))))
    )
      throw new PlatformError('forbidden');
    return role;
  }

  private target(context: PlatformIdentity, id: string) {
    const state = this.tenantState(context.tenantId);
    const member = state.members.get(id);
    if (!member) throw new PlatformError('not_found');
    this.delegable(context, member.role);
    return { state, member };
  }

  private checkAdminRemains(state: TenantState, member: Membership) {
    if (
      member.role === 'admin' &&
      ![...state.members.values()].some(({ id, role }) => id !== member.id && role === 'admin')
    )
      throw new PlatformError('forbidden');
  }

  assignRole(context: PlatformIdentity, id: string, roleId: string) {
    const { state, member } = this.target(context, id);
    this.delegable(context, roleId);
    if (member.role === roleId) return structuredClone(member);
    this.checkAdminRemains(state, member);
    return structuredClone(this.addMember(state, id, roleId));
  }

  removeMember(context: PlatformIdentity, id: string) {
    const { state, member } = this.target(context, id);
    this.checkAdminRemains(state, member);
    state.members.delete(id);
  }

  createInvite(context: PlatformIdentity, email: string, roleId: string) {
    this.delegable(context, roleId);
    return this.invite(this.tenantState(context.tenantId), emailAddress(email), roleId);
  }

  private invite(state: TenantState, email: string, roleId: string) {
    const instant = Date.parse(this.now());
    for (const [key, invite] of state.invites) {
      if (invite.expiresAt <= instant) state.invites.delete(key);
    }
    const token = randomToken();
    const expiresAt = instant + inviteLifetime;
    state.invites.set(tokenDigest(token), { roleId, email, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  acceptInvite(tenantId: string, token: string, principal: OidcPrincipal) {
    const state = this.tenantState(tenantId);
    const key = tokenDigest(token);
    const invite = state.invites.get(key);
    if (
      !invite ||
      invite.expiresAt <= Date.parse(this.now()) ||
      principal.verifiedEmail?.toLowerCase() !== invite.email
    )
      throw new PlatformError('not_found');
    let user = this.userFor(principal);
    if (user && state.members.has(user.actor.id)) throw new PlatformError('forbidden');
    if (!user) {
      const id = 'actor-' + randomUUID();
      user = { actor: { id, kind: 'person' }, displayName: id };
      this.users.set(user.actor.id, user);
      this.linkUser(user.actor.id, principal.issuer, principal.subject);
    }
    state.invites.delete(key);
    return structuredClone(this.addMember(state, user.actor.id, invite.roleId));
  }

  provision(input: TenantInput) {
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
    const state = this.addTenant('tenant-' + randomUUID(), name, this.now(), {
      addOns: [...new Set(addOns)].sort(),
      overageLimitCents,
    });
    return { tenant: { ...state.tenant }, adminInvite: this.invite(state, email, 'admin') };
  }

  initialPlan(tenantId: string) {
    const state = this.tenants.get(tenantId);
    return state?.plan
      ? { ...structuredClone(state.plan), createdAt: state.tenant.createdAt }
      : undefined;
  }

  setTenantStatus(tenantId: string, status: Tenant['status']) {
    const state = this.tenantState(tenantId, false);
    if (state.tenant.status !== status) {
      state.tenant.status = status;
      state.sessionVersion++;
    }
    return { ...state.tenant };
  }

  requestExport(context: PlatformIdentity) {
    if (!this.allows(context, 'exports.request')) throw new PlatformError('forbidden');
    const { tenantId, actor } = context;
    const record: ExportRequest = {
      id: 'export-' + randomUUID(),
      tenantId,
      requestedBy: actor.id,
      requestedAt: this.now(),
      status: 'requested',
    };
    this.tenantState(tenantId).exports.set(record.id, record);
    return { ...record };
  }

  exportRequests(context: PlatformIdentity) {
    if (!this.allows(context, 'exports.request')) throw new PlatformError('forbidden');
    return structuredClone([...this.tenantState(context.tenantId).exports.values()]);
  }
}
