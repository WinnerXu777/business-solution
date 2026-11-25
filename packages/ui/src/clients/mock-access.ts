import { PlatformError, platformRoles } from '../platform-client.ts';
import type { PlatformIdentity } from '../platform-client.ts';
import type {
  AccessClient,
  AuthClient,
  Member,
  SetupStep,
  TeamRole,
  Tenant,
  TenantOptions,
} from './access.ts';

const permissions = [
  { id: 'records.read', label: 'Read records' },
  { id: 'conversations.operate', label: 'Operate conversations' },
  { id: 'approvals.sign', label: 'Sign approvals' },
  { id: 'members.manage', label: 'Manage members' },
  { id: 'roles.manage', label: 'Manage roles' },
  { id: 'llm.keys.manage', label: 'Manage LLM API keys' },
];
const options: TenantOptions = {
  regions: [{ id: 'ca-central-1', label: 'Canada Central' }],
  plans: [
    { id: 'starter', label: 'Starter' },
    { id: 'operations', label: 'Operations' },
  ],
  modules: [
    { id: 'records', label: 'Records', default: true },
    { id: 'ai', label: 'AI', default: true },
    { id: 'workflows', label: 'Workflows', default: false },
  ],
  nativeBindings: [
    {
      capability: 'llm',
      providerId: 'fixture-native',
      label: 'Rivetquay native LLM',
      default: true,
    },
    {
      capability: 'speech-to-text',
      providerId: 'fixture-speech',
      label: 'Fixture transcription',
      default: false,
    },
  ],
};

export function createMockAccess(
  me: PlatformIdentity,
  now: string,
  requiresStepUp: () => boolean,
  completed: Set<SetupStep>,
): AccessClient {
  const roleIds = [
    ['records.read'],
    ['records.read', 'conversations.operate'],
    ['records.read', 'approvals.sign'],
    permissions.map(({ id }) => id),
  ];
  const roles: TeamRole[] = platformRoles.map((id, index) => ({
    id,
    name: id[0].toUpperCase() + id.slice(1),
    builtIn: true,
    permissions: roleIds[index],
  }));
  const members: Member[] = [
    {
      id: me.actor.id,
      name: me.actor.displayName,
      email: 'current@rivetquay.example',
      roleId: me.role,
    },
    ...(me.tenant.id === 'tenant-rivetquay'
      ? [
          {
            id: 'member-tess',
            name: 'Tess Okafor',
            email: 'tess@rivetquay.example',
            roleId: 'operator',
          },
        ]
      : []),
  ];
  const tenants: Tenant[] = [
    {
      id: me.tenant.id,
      name: me.tenant.name,
      status: 'active',
      region: 'ca-central-1',
      plan: 'starter',
      modules: ['records', 'ai'],
      nativeBindings: [{ capability: 'llm', providerId: 'fixture-native' }],
    },
  ];
  const provisionAttempts = new Map<string, { body: string; tenant: Tenant }>();
  const invited = new Set<string>();
  let sequence = 0;
  function admin(sensitive = false) {
    if (me.role !== 'admin') throw new PlatformError('forbidden');
    if (sensitive && requiresStepUp()) throw new PlatformError('step_up_required');
  }
  function operator(sensitive = false) {
    if (!me.platformOperator) throw new PlatformError('forbidden');
    if (sensitive && requiresStepUp()) throw new PlatformError('step_up_required');
  }
  return {
    async listMembers() {
      return structuredClone(members);
    },
    async invite(input) {
      admin(true);
      const email = input.email.trim().toLowerCase();
      if (
        !roles.some(({ id }) => id === input.roleId) ||
        !email ||
        invited.has(email) ||
        members.some((m) => m.email === email)
      ) {
        throw new PlatformError('invalid_input');
      }
      invited.add(email);
      completed.add('invite_team');
      return {
        url: 'https://invite.rivetquay.example/accept/fixture-' + ++sequence,
        expiresAt: new Date(Date.parse(now) + 86_400_000).toISOString(),
      };
    },
    async changeRole(id, roleId) {
      admin(true);
      const member = members.find((m) => m.id === id);
      if (!member) throw new PlatformError('not_found');
      if (id === me.actor.id || !roles.some((role) => role.id === roleId))
        throw new PlatformError('invalid_input');
      member.roleId = roleId;
    },
    async removeMember(id) {
      admin(true);
      const index = members.findIndex((m) => m.id === id);
      if (index < 0) throw new PlatformError('not_found');
      if (id === me.actor.id) throw new PlatformError('forbidden');
      members.splice(index, 1);
    },
    async listRoles() {
      admin();
      return structuredClone(roles);
    },
    async listPermissions() {
      admin();
      return structuredClone(permissions);
    },
    async saveRole(input, id) {
      admin(true);
      if (
        !input.name.trim() ||
        !input.permissions.length ||
        input.permissions.some((value) => !permissions.some((p) => p.id === value))
      ) {
        throw new PlatformError('invalid_input');
      }
      if (
        roles.some(
          (role) => role.id !== id && role.name.toLowerCase() === input.name.trim().toLowerCase(),
        )
      ) {
        throw new PlatformError('idempotency_conflict');
      }
      if (id) {
        const role = roles.find((role) => role.id === id);
        if (!role) throw new PlatformError('not_found');
        if (role.builtIn) throw new PlatformError('forbidden');
        Object.assign(role, structuredClone(input));
      } else {
        roles.push({ ...structuredClone(input), id: 'role-fixture-' + ++sequence, builtIn: false });
      }
    },
    async deleteRole(id) {
      admin(true);
      const index = roles.findIndex((role) => role.id === id);
      if (index < 0) throw new PlatformError('not_found');
      if (roles[index].builtIn || members.some((member) => member.roleId === id))
        throw new PlatformError('forbidden');
      roles.splice(index, 1);
    },
    async listTenants() {
      operator();
      return structuredClone(tenants);
    },
    async tenantOptions() {
      operator();
      return structuredClone(options);
    },
    async provision(input, key) {
      operator(true);
      const body = JSON.stringify(input);
      const previous = provisionAttempts.get(key);
      if (previous) {
        if (previous.body !== body) throw new PlatformError('idempotency_conflict');
        return structuredClone(previous.tenant);
      }
      if (
        !input.name.trim() ||
        !options.regions.some(({ id }) => id === input.region) ||
        !options.plans.some(({ id }) => id === input.plan) ||
        input.modules.some((id) => !options.modules.some((option) => option.id === id)) ||
        new Set(input.nativeBindings.map(({ capability }) => capability)).size !==
          input.nativeBindings.length ||
        input.nativeBindings.some(
          (binding) =>
            !options.nativeBindings.some(
              (option) =>
                option.capability === binding.capability &&
                option.providerId === binding.providerId,
            ),
        )
      ) {
        throw new PlatformError('invalid_input');
      }
      const tenant: Tenant = {
        ...structuredClone(input),
        id: 'tenant-fixture-' + ++sequence,
        status: 'active',
      };
      tenants.push(tenant);
      provisionAttempts.set(key, { body, tenant: structuredClone(tenant) });
      return structuredClone(tenant);
    },
    async setTenantStatus(id, status) {
      operator(true);
      const tenant = tenants.find((tenant) => tenant.id === id);
      if (!tenant) throw new PlatformError('not_found');
      tenant.status = status;
    },
    async setupProgress() {
      return { completed: [...completed] };
    },
  };
}

export class MockAuthClient implements AuthClient {
  signedIn: boolean;
  fresh = false;
  private pending?: { state: string; stepUp: boolean };
  private sequence = 0;

  constructor(signedIn = false) {
    this.signedIn = signedIn;
  }

  async login(returnTo: string, stepUp = false) {
    const url = new URL(returnTo, window.location.origin);
    if (url.origin !== window.location.origin) throw new PlatformError('invalid_input');
    this.pending = { state: 'fixture-' + ++this.sequence, stepUp };
    url.searchParams.set('code', 'fixture-code');
    url.searchParams.set('state', this.pending.state);
    return { authorizeUrl: url.pathname + url.search + url.hash };
  }
  async callback(code: string, state: string) {
    if (code !== 'fixture-code' || !this.pending || state !== this.pending.state)
      throw new PlatformError('forbidden');
    this.fresh = this.pending.stepUp;
    this.pending = undefined;
    this.signedIn = true;
    return {};
  }
  async refresh() {
    if (!this.signedIn) throw new PlatformError('unauthenticated');
    return {};
  }
  async logout() {
    this.fresh = false;
    this.signedIn = false;
    this.pending = undefined;
  }
}
