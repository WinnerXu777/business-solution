import type { ModuleId } from '@bs/contracts';
import type { CapabilityId, RequestJson } from '../platform-client.ts';

const root = '/platform/v1';

export interface Member {
  id: string;
  name: string;
  email: string;
  roleId: string;
}

export interface InviteInput {
  email: string;
  roleId: string;
}

export interface Invitation {
  url: string;
  expiresAt: string;
}

export interface NamedPermission {
  id: string;
  label: string;
}

export interface TeamRole {
  id: string;
  name: string;
  builtIn: boolean;
  permissions: string[];
}

export interface RoleInput {
  name: string;
  permissions: string[];
}

export interface TenantProvision {
  name: string;
  region: string;
  plan: string;
  modules: ModuleId[];
  nativeBindings: { capability: CapabilityId; providerId: string }[];
}

export interface Tenant extends TenantProvision {
  id: string;
  status: 'active' | 'suspended';
}

export interface TenantOptions {
  regions: NamedPermission[];
  plans: NamedPermission[];
  modules: { id: ModuleId; label: string; default: boolean }[];
  nativeBindings: (TenantProvision['nativeBindings'][number] & {
    label: string;
    default: boolean;
  })[];
}

export type SetupStep =
  | 'import_records'
  | 'connect_accounting'
  | 'choose_providers'
  | 'invite_team'
  | 'publish_workflow';
export interface SetupProgress {
  completed: SetupStep[];
}

export interface AccessClient {
  listMembers(): Promise<Member[]>;
  invite(input: InviteInput): Promise<Invitation>;
  changeRole(id: string, roleId: string): Promise<void>;
  removeMember(id: string): Promise<void>;
  listRoles(): Promise<TeamRole[]>;
  listPermissions(): Promise<NamedPermission[]>;
  saveRole(input: RoleInput, id?: string): Promise<void>;
  deleteRole(id: string): Promise<void>;
  listTenants(): Promise<Tenant[]>;
  tenantOptions(): Promise<TenantOptions>;
  provision(input: TenantProvision, key: string): Promise<Tenant>;
  setTenantStatus(id: string, status: Tenant['status']): Promise<void>;
  setupProgress(): Promise<SetupProgress>;
}

export class HttpAccessClient implements AccessClient {
  private readonly request: RequestJson;

  constructor(request: RequestJson) {
    this.request = request;
  }

  listMembers() {
    return this.request<Member[]>(root + '/members');
  }
  invite(input: InviteInput) {
    return this.request<Invitation>(root + '/members/invitations', 'POST', input);
  }
  changeRole(id: string, roleId: string) {
    return this.request<void>(
      root + '/members/' + encodeURIComponent(id),
      'PATCH',
      { roleId },
      undefined,
      false,
    );
  }
  removeMember(id: string) {
    return this.request<void>(
      root + '/members/' + encodeURIComponent(id),
      'DELETE',
      undefined,
      undefined,
      false,
    );
  }
  listRoles() {
    return this.request<TeamRole[]>(root + '/roles');
  }
  listPermissions() {
    return this.request<NamedPermission[]>(root + '/permissions');
  }
  saveRole(input: RoleInput, id?: string) {
    const path = root + '/roles';
    return this.request<void>(
      id ? path + '/' + encodeURIComponent(id) : path,
      id ? 'PATCH' : 'POST',
      input,
      undefined,
      false,
    );
  }
  deleteRole(id: string) {
    return this.request<void>(
      root + '/roles/' + encodeURIComponent(id),
      'DELETE',
      undefined,
      undefined,
      false,
    );
  }
  listTenants() {
    return this.request<Tenant[]>(root + '/tenants');
  }
  tenantOptions() {
    return this.request<TenantOptions>(root + '/tenants/options');
  }
  provision(input: TenantProvision, key: string) {
    return this.request<Tenant>(root + '/tenants', 'POST', input, { 'Idempotency-Key': key });
  }
  setTenantStatus(id: string, status: Tenant['status']) {
    return this.request<void>(
      root + '/tenants/' + encodeURIComponent(id),
      'PATCH',
      { status },
      undefined,
      false,
    );
  }
  setupProgress() {
    return this.request<SetupProgress>(root + '/onboarding');
  }
}

export interface Session {
  expiresAt?: string;
}

export interface AuthClient {
  login(returnTo: string, stepUp?: boolean): Promise<{ authorizeUrl: string }>;
  callback(code: string, state: string): Promise<Session>;
  refresh(): Promise<Session>;
  logout(): Promise<void>;
}

export class HttpAuthClient implements AuthClient {
  private readonly request: RequestJson;

  constructor(request: RequestJson) {
    this.request = request;
  }

  login(returnTo: string, stepUp = false) {
    const query = new URLSearchParams({ returnTo });
    if (stepUp) query.set('stepUp', 'true');
    return this.request<{ authorizeUrl: string }>(root + '/auth/login?' + query);
  }
  callback(code: string, state: string) {
    const query = new URLSearchParams({ code, state });
    return this.request<Session>(root + '/auth/callback?' + query);
  }
  refresh() {
    return this.request<Session>(root + '/auth/refresh', 'POST');
  }
  logout() {
    return this.request<void>(root + '/auth/logout', 'POST', undefined, undefined, false);
  }
}

export function followAuthorization(url: string) {
  const target = new URL(url, window.location.href);
  if (
    target.username ||
    target.password ||
    (target.protocol !== 'https:' &&
      !(target.protocol === 'http:' && target.origin === window.location.origin))
  ) {
    throw new Error('Invalid sign-in URL');
  }
  window.location.assign(target.href);
}
