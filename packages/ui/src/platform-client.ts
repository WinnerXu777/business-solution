import type {
  Actor,
  Approval,
  AuditEntry,
  Denied,
  Failed,
  ModuleId,
  UsageCounterEvent,
} from '@bs/contracts';

export const platformRoles = ['reader', 'operator', 'approver', 'admin'] as const;
export type PlatformRole = (typeof platformRoles)[number];

export interface Workspace {
  id: string;
  name: string;
}
export interface PlatformIdentity {
  tenant: Workspace;
  actor: Actor & { displayName: string };
  role: PlatformRole;
  workspaces: Workspace[];
}

export interface PlatformModule {
  moduleId: ModuleId;
  name: string;
  description: string;
  enabled: boolean;
  allowance: number;
  used: number;
  windowStart: string;
  windowEnd: string;
}

export const capabilityIds = [
  'llm',
  'embeddings',
  'chat',
  'contact-centre',
  'telephony',
  'speech-to-text',
  'text-to-speech',
  'email',
  'sms',
  'crm',
  'erp',
  'accounting',
  'ml-scoring',
  'workflow',
] as const;
export type CapabilityId = (typeof capabilityIds)[number];
export type ProviderMode = 'native' | 'byo' | 'premium';

export interface CapabilityBinding {
  providerId: string;
  mode: ProviderMode;
  status: 'active' | 'pending' | 'error';
  region: string;
  dataClasses: string[];
  fallbackProviderId: string | null;
  version: number;
}
export interface Capability {
  capability: CapabilityId;
  label: string;
  binding: CapabilityBinding;
}
export interface Provider {
  providerId: string;
  capability: CapabilityId;
  name: string;
  mode: ProviderMode;
  regions: string[];
  features: string[];
  notes: string;
}
export interface BindingUpdate {
  providerId: string;
  credentialRef?: string;
  fallbackProviderId?: string;
}

export interface AuditQuery {
  tool?: string;
  actorId?: string;
  state?: AuditEntry['state'];
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}
export interface UsageQuery {
  module?: ModuleId;
  from?: string;
  to?: string;
}
export interface UsageTotal {
  module: ModuleId;
  used: number;
  allowance: number;
}
export interface UsagePage {
  items: UsageCounterEvent[];
  totals: UsageTotal[];
}

export type ApprovalState = Exclude<Approval['state'], 'denied'> | 'rejected' | 'expired';
// Older grants can still carry the shared contract's denied state.
export type PlatformApproval = Omit<Approval, 'state'> & { state: ApprovalState | 'denied' };

export interface NewConnection {
  kind: 'api_client' | 'mcp_client';
  name: string;
  scopes: string[];
}
export interface Connection extends NewConnection {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
}
export interface CreatedConnection {
  secret: string;
}
export interface RegistryEntry {
  id: string;
  name: string;
  kind: string;
  status: string;
  module: ModuleId;
}
export interface PlatformHealth {
  status: string;
  version: string;
}

export type PlatformDenialCode =
  | Exclude<Denied['code'], 'suppressed'>
  | Extract<Failed['code'], 'unavailable'>;
export const denialMessages = {
  forbidden: 'You don’t have permission to do this.',
  not_found: 'This item could not be found.',
  module_disabled: 'The required module is disabled.',
  quota_exceeded: 'The allowance for this module has been reached.',
  invalid_approval: 'This approval is no longer valid for this action.',
  idempotency_conflict: 'A conflicting request has already been recorded.',
  unavailable: 'The platform is unavailable. Try again shortly.',
} satisfies Record<PlatformDenialCode, string>;

export class PlatformError extends Error {
  readonly code: PlatformDenialCode;
  constructor(code: PlatformDenialCode) {
    super(denialMessages[code]);
    this.name = 'PlatformError';
    this.code = code;
  }
}

export interface PlatformClient {
  getMe(): Promise<PlatformIdentity>;
  getWorkspaces(): Promise<Workspace[]>;
  getWorkspace(id: string): Promise<Workspace>;
  getModules(): Promise<PlatformModule[]>;
  updateModule(moduleId: ModuleId, enabled: boolean): Promise<void>;
  getCapabilities(): Promise<Capability[]>;
  getProviders(capability: CapabilityId): Promise<Provider[]>;
  updateBinding(capability: CapabilityId, update: BindingUpdate): Promise<void>;
  getAudit(query?: AuditQuery): Promise<AuditPage>;
  getUsage(query?: UsageQuery): Promise<UsagePage>;
  getApprovals(state?: ApprovalState): Promise<PlatformApproval[]>;
  signApproval(id: string): Promise<void>;
  rejectApproval(id: string, reason: string): Promise<void>;
  getConnections(): Promise<Connection[]>;
  createConnection(connection: NewConnection): Promise<CreatedConnection>;
  revokeConnection(id: string): Promise<void>;
  getBots(): Promise<RegistryEntry[]>;
  getWorkflows(): Promise<RegistryEntry[]>;
  getHealth(): Promise<PlatformHealth>;
}

export interface HttpPlatformClientOptions {
  baseUrl?: string;
  token: string;
  fetch?: typeof fetch;
}

function queryString(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.size ? '?' + search : '';
}

function responseDenial(body: unknown, status: number): PlatformDenialCode | undefined {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const code = body.code;
    if (typeof code === 'string' && Object.hasOwn(denialMessages, code)) {
      return code as PlatformDenialCode;
    }
  }
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'quota_exceeded';
  return undefined;
}

export class HttpPlatformClient implements PlatformClient {
  private readonly root: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;

  constructor({
    baseUrl = '',
    token,
    fetch: fetcher = globalThis.fetch.bind(globalThis),
  }: HttpPlatformClientOptions) {
    this.root = baseUrl.replace(/\/+$/, '') + '/platform/v1';
    this.token = token;
    this.fetcher = fetcher;
  }

  private async request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    expectJson = true,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(this.root + path, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + this.token,
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new PlatformError('unavailable');
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const denial = responseDenial(payload, response.status);
    if (denial || !response.ok || (expectJson && payload === undefined)) {
      throw new PlatformError(denial ?? 'unavailable');
    }
    return (expectJson ? payload : undefined) as T;
  }

  getMe() {
    return this.request<PlatformIdentity>('/me');
  }
  getWorkspaces() {
    return this.request<Workspace[]>('/workspaces');
  }
  getWorkspace(id: string) {
    return this.request<Workspace>('/workspaces/' + encodeURIComponent(id));
  }
  getModules() {
    return this.request<PlatformModule[]>('/modules');
  }
  updateModule(moduleId: ModuleId, enabled: boolean) {
    return this.request<void>(
      '/modules/' + encodeURIComponent(moduleId),
      'PATCH',
      { enabled },
      false,
    );
  }
  getCapabilities() {
    return this.request<Capability[]>('/capabilities');
  }
  getProviders(capability: CapabilityId) {
    return this.request<Provider[]>('/providers' + queryString({ capability }));
  }
  updateBinding(capability: CapabilityId, update: BindingUpdate) {
    return this.request<void>(
      '/capabilities/' + encodeURIComponent(capability) + '/binding',
      'PUT',
      update,
      false,
    );
  }
  getAudit(query: AuditQuery = {}) {
    return this.request<AuditPage>('/audit' + queryString({ ...query }));
  }
  getUsage(query: UsageQuery = {}) {
    return this.request<UsagePage>('/usage' + queryString({ ...query }));
  }
  getApprovals(state?: ApprovalState) {
    return this.request<PlatformApproval[]>('/approvals' + queryString({ state }));
  }
  signApproval(id: string) {
    return this.request<void>(
      '/approvals/' + encodeURIComponent(id) + '/sign',
      'POST',
      undefined,
      false,
    );
  }
  rejectApproval(id: string, reason: string) {
    return this.request<void>(
      '/approvals/' + encodeURIComponent(id) + '/reject',
      'POST',
      { reason },
      false,
    );
  }
  getConnections() {
    return this.request<Connection[]>('/connections');
  }
  createConnection(connection: NewConnection) {
    return this.request<CreatedConnection>('/connections', 'POST', connection);
  }
  revokeConnection(id: string) {
    return this.request<void>('/connections/' + encodeURIComponent(id), 'DELETE', undefined, false);
  }
  getBots() {
    return this.request<RegistryEntry[]>('/registry/bots');
  }
  getWorkflows() {
    return this.request<RegistryEntry[]>('/registry/workflows');
  }
  getHealth() {
    return this.request<PlatformHealth>('/health');
  }
}
export function canCreateConnection(role: PlatformRole) {
  return role === 'admin' || role === 'operator';
}

export function canDecideApproval(me: PlatformIdentity, approval: PlatformApproval) {
  return (
    (me.role === 'approver' || me.role === 'admin') &&
    me.actor.id === approval.approverId &&
    me.actor.id !== approval.requestedBy &&
    me.tenant.id === approval.tenantId &&
    approval.state === 'pending'
  );
}
