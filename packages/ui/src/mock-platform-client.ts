import { createMockAutomation, MockAutomationState } from './clients/mock-automation.ts';
import { createMockRecords, MockRecordsState } from './clients/mock-records.ts';
import { createMockAdministration } from './clients/mock-administration.ts';
import { createMockAccess, MockAuthClient } from './clients/mock-access.ts';
import type { SetupStep } from './clients/access.ts';
import { createMockConversations, createMockLlm } from './clients/mock-live.ts';
import { loadDemoFixtures } from '@bs/contracts';
import type { AuditEntry, ModuleId, UsageCounterEvent } from '@bs/contracts';
import {
  capabilityIds,
  canCreateConnection,
  canDecideApproval,
  PlatformError,
} from './platform-client.ts';
import type {
  ApprovalState,
  AuditQuery,
  BindingUpdate,
  Capability,
  CapabilityId,
  Connection,
  NewConnection,
  PlatformApproval,
  PlatformClient,
  PlatformIdentity,
  PlatformModule,
  PlatformRole,
  Provider,
  RegistryEntry,
  UsageQuery,
} from './platform-client.ts';

const labels = {
  llm: 'Language models',
  embeddings: 'Embeddings',
  chat: 'Chat',
  'contact-centre': 'Contact centre',
  telephony: 'Telephony',
  'speech-to-text': 'Speech to text',
  'text-to-speech': 'Text to speech',
  email: 'Email',
  sms: 'SMS',
  crm: 'CRM',
  erp: 'ERP',
  accounting: 'Accounting',
  'ml-scoring': 'ML scoring',
  workflow: 'Workflow',
} satisfies Record<CapabilityId, string>;

const moduleDetails = {
  records: ['Business records', 'Orders, inventory, customers and accounts.'],
  procurement: ['Procurement', 'Purchase requisitions and purchase orders.'],
  collections: ['Collections', 'Invoice follow-up across email, voice and SMS.'],
  workflows: ['Workflows', 'Governed execution of automation templates.'],
  insights: ['Insights', 'Fraud review, forecasts and customer profiles.'],
  ai: ['AI services', 'Language models, chat and voice.'],
} satisfies Record<ModuleId, [string, string]>;

const region = 'ca-central-1';
const catalog: Array<{
  providerId: string;
  name: string;
  mode: 'byo' | 'premium';
  capabilities: CapabilityId[];
  features: string[];
}> = [
  {
    providerId: 'openai',
    name: 'OpenAI',
    mode: 'byo',
    capabilities: ['llm', 'embeddings', 'chat'],
    features: ['Structured responses', 'Streaming'],
  },
  {
    providerId: 'anthropic',
    name: 'Anthropic',
    mode: 'premium',
    capabilities: ['llm', 'chat'],
    features: ['Structured responses', 'Streaming'],
  },
  {
    providerId: 'ringcentral-ringcx',
    name: 'RingCentral RingCX',
    mode: 'byo',
    capabilities: ['contact-centre'],
    features: ['Queues', 'Agent handoff'],
  },
  {
    providerId: 'elevenlabs',
    name: 'ElevenLabs',
    mode: 'premium',
    capabilities: ['speech-to-text', 'text-to-speech'],
    features: ['Speech streaming'],
  },
  {
    providerId: 'twilio',
    name: 'Twilio',
    mode: 'byo',
    capabilities: ['telephony', 'sms'],
    features: ['Programmable delivery'],
  },
  {
    providerId: 'sendgrid',
    name: 'Twilio SendGrid',
    mode: 'byo',
    capabilities: ['email'],
    features: ['Email delivery'],
  },
  {
    providerId: 'hubspot',
    name: 'HubSpot',
    mode: 'byo',
    capabilities: ['crm'],
    features: ['Contact sync'],
  },
  {
    providerId: 'odoo',
    name: 'Odoo Community',
    mode: 'byo',
    capabilities: ['erp'],
    features: ['Record sync'],
  },
  {
    providerId: 'quickbooks-online',
    name: 'QuickBooks Online',
    mode: 'byo',
    capabilities: ['accounting'],
    features: ['Invoice import'],
  },
];

type MockApproval = PlatformApproval & { materialPreview: object };

function inDateRange(occurredAt: string, from?: string, to?: string) {
  const timestamp = Date.parse(occurredAt);
  const end = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to + 'T23:59:59.999Z' : to;
  return (!from || timestamp >= Date.parse(from)) && (!end || timestamp <= Date.parse(end));
}

export interface MockPlatformClientOptions {
  role?: PlatformRole;
  tenantId?: string;
  now?: string;
  automationState?: MockAutomationState;
  recordsState?: MockRecordsState;
  platformOperator?: boolean;
  requireFreshMfa?: boolean;
  auth?: MockAuthClient;
}

export class MockPlatformClient implements PlatformClient {
  readonly auth: MockAuthClient;
  readonly access: PlatformClient['access'];
  readonly conversations: PlatformClient['conversations'];
  readonly llm: PlatformClient['llm'];
  readonly automation: PlatformClient['automation'];
  readonly records: PlatformClient['records'];
  readonly insights: PlatformClient['insights'];
  readonly billing: PlatformClient['billing'];
  readonly credentials: PlatformClient['credentials'];
  readonly connectors: PlatformClient['connectors'];
  private readonly identity: PlatformIdentity;
  private readonly setup = new Set<SetupStep>();
  private readonly now: string;
  private readonly modules: PlatformModule[];
  private readonly capabilities: Capability[];
  private readonly providers: Provider[];
  private readonly approvals: MockApproval[];
  private readonly audit: AuditEntry[] = [];
  private readonly usage: UsageCounterEvent[];
  private readonly connections: Connection[];
  private connectionSequence = 0;
  private auditSequence = 0;

  constructor({
    role = 'admin',
    tenantId = 'tenant-rivetquay',
    now,
    automationState = new MockAutomationState(),
    recordsState = new MockRecordsState(),
    platformOperator = false,
    requireFreshMfa = false,
    auth = new MockAuthClient(true),
  }: MockPlatformClientOptions = {}) {
    const fixtures = loadDemoFixtures();
    const workspace = fixtures.workspaces.find((item) => item.id === tenantId);
    if (!workspace) throw new PlatformError('not_found');
    const tenant = { id: workspace.id, name: workspace.name };
    const grant = fixtures.grants.find(
      (item) => item.tenantId === tenantId && item.role === role && item.actor.kind === 'person',
    );
    const displayName = {
      admin: 'Avery Chen',
      approver: 'Morgan Hale',
      operator: 'Casey Patel',
      reader: 'Sam Laurent',
    }[role];
    this.identity = {
      tenant,
      actor: { ...(grant?.actor ?? { id: 'actor-' + role, kind: 'person' }), displayName },
      role,
      platformOperator,
      workspaces: [tenant],
    };
    this.now = now ?? fixtures.asOf;
    this.auth = auth;
    if (tenantId === 'tenant-rivetquay') {
      this.setup.add('import_records');
      this.setup.add('choose_providers');
    }
    const requiresStepUp = () => requireFreshMfa && !auth.fresh;
    this.access = createMockAccess(this.identity, this.now, requiresStepUp, this.setup);
    const conversations = createMockConversations(this.identity, (id) =>
      this.automation.cancelBot(id),
    );
    this.conversations = conversations;
    const enabled = (module: ModuleId) =>
      this.modules.some((item) => item.moduleId === module && item.enabled);
    this.llm = createMockLlm(
      this.identity,
      this.now,
      () => enabled('ai'),
      requiresStepUp,
      () => this.capabilities.find(({ capability }) => capability === 'llm')?.binding,
    );
    this.automation = createMockAutomation(
      this.identity,
      fixtures,
      this.now,
      automationState,
      enabled,
      conversations.updateBot,
      () => this.setup.add('publish_workflow'),
    );
    const { records, insights } = createMockRecords(
      this.identity,
      fixtures,
      this.now,
      recordsState,
      enabled,
    );
    this.records = records;
    this.insights = insights;
    const { billing, credentials, connectors } = createMockAdministration(
      this.identity,
      this.now,
      () => this.setup.add('connect_accounting'),
      () => this.setup.add('import_records'),
    );
    this.billing = billing;
    this.credentials = credentials;
    this.connectors = connectors;
    const isRivetquay = tenantId === 'tenant-rivetquay';
    const order = fixtures.orders.find((item) => item.tenantId === tenantId);
    const quantities = isRivetquay ? [12, 8, 24, 3, 5, 7] : [];
    this.usage = fixtures.entitlements
      .filter((item) => item.tenantId === tenantId)
      .flatMap(({ flag, unit }, index) =>
        quantities[index]
          ? [
              {
                id: 'usage-' + (index + 1),
                tenantId,
                module: flag.module,
                outcomeId: index === 0 ? 'action-1' : 'fixture-outcome-' + (index + 1),
                unit,
                quantity: quantities[index],
                occurredAt: fixtures.asOf,
              },
            ]
          : [],
      );
    this.modules = fixtures.entitlements
      .filter((item) => item.tenantId === tenantId)
      .map((item) => {
        const [name, description] = moduleDetails[item.flag.module];
        return {
          moduleId: item.flag.module,
          name,
          description,
          enabled: item.flag.enabled,
          allowance: item.allowance,
          used: this.usage.find((event) => event.module === item.flag.module)?.quantity ?? 0,
          windowStart: item.windowStart,
          windowEnd: item.windowEnd,
        };
      });
    const nativeId = fixtures.llmRoutes.find((item) => item.kind === 'native')!.providerId;
    const byoId = fixtures.llmRoutes.find((item) => item.kind === 'byo')!.providerId;
    this.capabilities = capabilityIds.map((capability) => ({
      capability,
      label: labels[capability],
      binding: {
        providerId: nativeId,
        mode: 'native',
        status: 'active',
        region,
        version: 1,
        dataClasses: ['synthetic'],
        fallbackProviderId: null,
      },
    }));
    this.providers = [
      ...capabilityIds.map(
        (capability): Provider => ({
          providerId: nativeId,
          capability,
          name: 'Rivetquay Native',
          mode: 'native',
          regions: [region],
          features: [labels[capability]],
          notes: 'Local fixture adapter.',
        }),
      ),
      {
        providerId: byoId,
        capability: 'llm',
        name: 'Fixture BYO',
        mode: 'byo',
        regions: [region],
        features: ['Structured responses'],
        notes: 'Synthetic BYO route used in the walkthrough.',
      },
      ...catalog.flatMap(({ capabilities, ...provider }) =>
        capabilities.map(
          (capability): Provider => ({
            ...provider,
            capability,
            regions: [region],
            notes: 'Simulated provider and region for this preview.',
          }),
        ),
      ),
    ];

    this.approvals = isRivetquay
      ? [
          {
            id: 'approval-workflow-001',
            tenantId,
            requestedBy: 'actor-operator',
            approverId: role === 'approver' ? this.identity.actor.id : 'actor-admin',
            tool: 'workflow.template.run',
            subjectId: 'win-back-v1',
            sourceVersion: 1,
            policyVersion: 'policy-v1',
            materialHash: '7c83265365495a7ec9d6cb68d7c43b4684bd95a64a7a22e4c2e7a89367dfae41',
            materialPreview: { templateId: 'win-back-v1', customerIds: ['cust-008', 'cust-009'] },
            expiresAt: new Date(Date.parse(fixtures.asOf) + 3_600_000).toISOString(),
            state: 'pending',
          },
        ]
      : [];
    this.connections = isRivetquay
      ? [
          {
            id: 'connection-demo',
            kind: 'mcp_client',
            name: 'Warehouse console',
            scopes: ['records:read'],
            createdAt: fixtures.asOf,
            lastUsedAt: null,
          },
        ]
      : [];
    if (isRivetquay && order) {
      this.recordAudit('records.order.read', 'ok', 'actor-operator');
      this.recordAudit('workflow.template.run', 'pending_approval', 'actor-operator');
    }
  }

  private requireAdmin() {
    if (this.identity.role !== 'admin') throw new PlatformError('forbidden');
  }

  private recordAudit(tool: string, state: AuditEntry['state'], actorId = this.identity.actor.id) {
    const sequence = ++this.auditSequence;
    this.audit.unshift({
      id: 'audit-' + sequence,
      tenantId: this.identity.tenant.id,
      actor: { id: actorId, kind: 'person' },
      source: 'portal',
      tool,
      traceId: 'trace-' + sequence,
      correlationId: 'correlation-' + sequence,
      actionId: 'action-' + sequence,
      policyVersion: 'policy-v1',
      state,
      occurredAt: this.now,
    });
  }

  async getMe() {
    if (!this.auth.signedIn) throw new PlatformError('unauthenticated');
    return structuredClone(this.identity);
  }
  async getWorkspaces() {
    return (await this.getMe()).workspaces;
  }
  async getWorkspace(id: string) {
    const workspace = (await this.getWorkspaces()).find((item) => item.id === id);
    if (!workspace) throw new PlatformError('not_found');
    return workspace;
  }
  async getModules() {
    return structuredClone(this.modules);
  }
  async updateModule(moduleId: ModuleId, enabled: boolean) {
    this.requireAdmin();
    const module = this.modules.find((item) => item.moduleId === moduleId);
    if (!module) throw new PlatformError('not_found');
    module.enabled = enabled;
    this.recordAudit('platform.modules.update', 'ok');
  }
  async getCapabilities() {
    return structuredClone(this.capabilities);
  }
  async getProviders(capability: CapabilityId) {
    return structuredClone(this.providers.filter((item) => item.capability === capability));
  }
  async updateBinding(capability: CapabilityId, update: BindingUpdate) {
    this.requireAdmin();
    const item = this.capabilities.find((item) => item.capability === capability);
    if (!item) throw new PlatformError('not_found');
    const providers = this.providers.filter(
      (provider) =>
        provider.capability === capability && provider.regions.includes(item.binding.region),
    );
    const provider = providers.find((provider) => provider.providerId === update.providerId);
    const fallback = update.fallbackProviderId;
    if (!provider || (fallback && !providers.some((item) => item.providerId === fallback))) {
      throw new PlatformError('not_found');
    }
    if (
      fallback === provider.providerId ||
      (provider.mode === 'byo' &&
        provider.providerId !== item.binding.providerId &&
        !update.credentialRef?.trim())
    ) {
      throw new PlatformError('unavailable');
    }
    item.binding = {
      ...item.binding,
      providerId: provider.providerId,
      mode: provider.mode,
      status: 'active',
      fallbackProviderId: fallback || null,
      version: item.binding.version + 1,
    };
    this.setup.add('choose_providers');
    this.recordAudit('platform.capabilities.bind', 'ok');
  }

  async getAudit(query: AuditQuery = {}) {
    const entries = this.audit.filter(
      (item) =>
        (!query.tool || item.tool.includes(query.tool)) &&
        (!query.actorId || item.actor.id === query.actorId) &&
        (!query.state || item.state === query.state) &&
        inDateRange(item.occurredAt, query.from, query.to),
    );
    const start = query.cursor ? entries.findIndex((item) => item.id === query.cursor) + 1 : 0;
    if (query.cursor && start === 0) throw new PlatformError('not_found');
    const limit = Math.max(1, Math.min(100, query.limit ?? 20));
    const items = entries.slice(start, start + limit);
    return {
      items: structuredClone(items),
      nextCursor: start + limit < entries.length ? items.at(-1)!.id : null,
    };
  }
  async getUsage(query: UsageQuery = {}) {
    const items = this.usage.filter(
      (item) =>
        (!query.module || item.module === query.module) &&
        inDateRange(item.occurredAt, query.from, query.to),
    );
    const totals = this.modules
      .filter((item) => !query.module || item.moduleId === query.module)
      .map(({ moduleId: module, allowance }) => ({
        module,
        allowance,
        used: items
          .filter((item) => item.module === module)
          .reduce((total, item) => total + item.quantity, 0),
      }));
    return { items: structuredClone(items), totals };
  }

  private approvalState(approval: PlatformApproval): PlatformApproval['state'] {
    return (approval.state === 'pending' || approval.state === 'approved') &&
      Date.parse(approval.expiresAt) <= Date.parse(this.now)
      ? 'expired'
      : approval.state;
  }
  async getApprovals(state?: ApprovalState): Promise<PlatformApproval[]> {
    return structuredClone(
      this.approvals
        .map((approval) => ({ ...approval, state: this.approvalState(approval) }))
        .filter((approval) => !state || approval.state === state),
    );
  }
  private decideApproval(id: string, state: 'approved' | 'rejected') {
    const approval = this.approvals.find((item) => item.id === id);
    if (!approval) throw new PlatformError('not_found');
    if (this.identity.role !== 'admin' && this.identity.role !== 'approver')
      throw new PlatformError('forbidden');
    if (!canDecideApproval(this.identity, approval) || this.approvalState(approval) !== 'pending')
      throw new PlatformError('invalid_approval');
    approval.state = state;
    this.recordAudit('platform.approvals.' + (state === 'approved' ? 'sign' : 'reject'), 'ok');
  }
  async signApproval(id: string) {
    this.decideApproval(id, 'approved');
  }
  async rejectApproval(id: string, reason: string) {
    if (!reason.trim()) throw new PlatformError('invalid_approval');
    this.decideApproval(id, 'rejected');
  }

  async getConnections() {
    return structuredClone(this.connections);
  }
  async createConnection(input: NewConnection) {
    if (!canCreateConnection(this.identity.role)) throw new PlatformError('forbidden');
    if (!input.name.trim() || !input.scopes.length) throw new PlatformError('unavailable');
    const sequence = ++this.connectionSequence;
    const connection: Connection = {
      ...structuredClone(input),
      id: 'connection-fixture-' + sequence,
      createdAt: this.now,
      lastUsedAt: null,
    };
    this.connections.push(connection);
    this.recordAudit('platform.connections.create', 'ok');
    return { ...structuredClone(connection), secret: 'fixture-only-secret-' + sequence };
  }
  async revokeConnection(id: string) {
    this.requireAdmin();
    const index = this.connections.findIndex((item) => item.id === id);
    if (index < 0) throw new PlatformError('not_found');
    this.connections.splice(index, 1);
    this.recordAudit('platform.connections.revoke', 'ok');
  }
  async getBots(): Promise<RegistryEntry[]> {
    return this.approvals.length
      ? [
          { id: 'order-chat', name: 'Order help', kind: 'chat', status: 'active', module: 'ai' },
          {
            id: 'browser-voice',
            name: 'Order help voice',
            kind: 'voice',
            status: 'active',
            module: 'ai',
          },
        ]
      : [];
  }
  async getWorkflows(): Promise<RegistryEntry[]> {
    return this.approvals.length
      ? [
          {
            id: 'win-back-v1',
            name: 'Customer win-back',
            kind: 'template',
            status: 'active',
            module: 'workflows',
          },
        ]
      : [];
  }
  async getHealth() {
    return { status: 'ok', version: 'v1' };
  }
}
