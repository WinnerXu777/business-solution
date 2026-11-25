import { HttpAutomationClient } from './clients/automation.ts';
import type { AutomationClient } from './clients/automation.ts';
import { HttpAccessClient, HttpAuthClient } from './clients/access.ts';
import type { AccessClient, AuthClient } from './clients/access.ts';
import { HttpConversationsClient } from './clients/conversations.ts';
import type { ConversationsClient } from './clients/conversations.ts';
import { HttpLlmClient } from './clients/llm.ts';
import type { LlmClient } from './clients/llm.ts';
import { HttpRecordsClient, HttpInsightsClient } from './clients/records.ts';
import type { RecordsClient, InsightsClient } from './clients/records.ts';
import {
  HttpBillingClient,
  HttpCredentialsClient,
  HttpConnectorsClient,
} from './clients/administration.ts';
import type {
  BillingClient,
  CredentialsClient,
  ConnectorsClient,
} from './clients/administration.ts';
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
  platformOperator?: boolean;
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
export type PlatformApproval = Omit<Approval, 'state'> & {
  state: ApprovalState | 'denied';
  materialPreview?: unknown;
};

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
  | Denied['code']
  | Failed['code']
  | 'unknown'
  | 'step_up_required'
  | 'unauthenticated';
export const denialMessages = {
  forbidden: 'You don’t have permission to do this.',
  not_found: 'This item could not be found.',
  module_disabled: 'The required module is disabled.',
  quota_exceeded: 'The allowance for this module has been reached.',
  invalid_approval: 'This approval is no longer valid for this action.',
  idempotency_conflict: 'A conflicting request has already been recorded.',
  suppressed: 'Outreach is suppressed for this record.',
  invalid_input: 'Check the input and try again.',
  provider_error: 'The configured provider could not complete the action.',
  unknown: 'Reconcile the outcome before trying again.',
  unavailable: 'The platform is unavailable. Try again shortly.',
  step_up_required: 'Sign in again with MFA to continue.',
  unauthenticated: 'Your session has ended. Sign in to continue.',
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
  readonly auth: AuthClient;
  readonly access: AccessClient;
  readonly conversations: ConversationsClient;
  readonly llm: LlmClient;
  readonly automation: AutomationClient;
  readonly records: RecordsClient;
  readonly insights: InsightsClient;
  readonly billing: BillingClient;
  readonly credentials: CredentialsClient;
  readonly connectors: ConnectorsClient;
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
  token?: string;
  fetch?: typeof fetch;
}

function queryString(params: Record<string, string | number | undefined>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.size ? '?' + search : '';
}

export type RequestJson = <T>(
  path: string,
  method?: string,
  body?: unknown,
  headers?: Record<string, string>,
  expectJson?: boolean,
) => Promise<T>;

export function unwrapTool(result: { state: string; output?: unknown; code?: string }): unknown {
  if (result.state === 'ok') return result.output;
  if (result.state === 'unknown') throw new PlatformError('unknown');
  if (result.state === 'pending_approval') throw new PlatformError('invalid_approval');
  throw new PlatformError(responseDenial(result, 200) ?? 'unavailable');
}

function responseDenial(body: unknown, status: number): PlatformDenialCode | undefined {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const code = body.code;
    if (
      typeof code === 'string' &&
      Object.hasOwn(denialMessages, code) &&
      (status !== 401 || code === 'step_up_required')
    ) {
      return code as PlatformDenialCode;
    }
  }
  if (status === 400) return 'invalid_input';
  if (status === 401) return 'unauthenticated';
  if (status === 409) return 'idempotency_conflict';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'quota_exceeded';
  return undefined;
}

export class HttpPlatformClient implements PlatformClient {
  readonly auth: AuthClient;
  readonly access: AccessClient;
  readonly conversations: ConversationsClient;
  readonly llm: LlmClient;
  readonly automation: AutomationClient;
  readonly records: RecordsClient;
  readonly insights: InsightsClient;
  readonly billing: BillingClient;
  readonly credentials: CredentialsClient;
  readonly connectors: ConnectorsClient;
  private readonly root: string;
  private readonly token?: string;
  private readonly fetcher: typeof fetch;

  constructor({
    baseUrl = '',
    token,
    fetch: fetcher = globalThis.fetch.bind(globalThis),
  }: HttpPlatformClientOptions) {
    this.root = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.fetcher = fetcher;
    const request = this.requestJson.bind(this);
    const records = new HttpRecordsClient(request, () => this.getMe());
    this.records = records;
    this.insights = new HttpInsightsClient(records);
    const open = async (path: string, init: RequestInit) => {
      const response = await this.fetch(path, init);
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        throw new PlatformError(responseDenial(payload, response.status) ?? 'unavailable');
      }
      return response;
    };
    this.automation = new HttpAutomationClient(request, open);
    this.auth = new HttpAuthClient(request);
    this.access = new HttpAccessClient(request);
    this.conversations = new HttpConversationsClient(request, open);
    this.llm = new HttpLlmClient(request, open);
    this.billing = new HttpBillingClient(request);
    this.credentials = new HttpCredentialsClient(request);
    this.connectors = new HttpConnectorsClient(request);
  }

  private async fetch(path: string, init: RequestInit) {
    try {
      return await this.fetcher(this.root + path, {
        ...init,
        ...(this.token ? {} : { credentials: 'include' }),
        headers: { ...init.headers, ...(this.token && { Authorization: 'Bearer ' + this.token }) },
      });
    } catch {
      if (init.signal?.aborted) throw init.signal.reason;
      throw new PlatformError('unavailable');
    }
  }

  private async requestJson<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    headers?: Record<string, string>,
    expectJson = true,
  ): Promise<T> {
    const response = await this.fetch(path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json().catch(() => undefined);
    const denial = responseDenial(payload, response.status);
    if (denial || !response.ok || (expectJson && payload === undefined)) {
      throw new PlatformError(denial ?? 'unavailable');
    }
    return (expectJson ? payload : undefined) as T;
  }

  private request<T>(path: string, method?: string, body?: unknown, expectJson = true) {
    return this.requestJson<T>('/platform/v1' + path, method, body, undefined, expectJson);
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

export function canOperate(role: PlatformRole) {
  return role === 'admin' || role === 'operator';
}

export function canReview(role: PlatformRole) {
  return role === 'admin' || role === 'approver';
}
