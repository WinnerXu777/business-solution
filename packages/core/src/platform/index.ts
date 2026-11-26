import { loadDemoFixtures, type AuditEntry, type DemoFixtures } from '@bs/contracts';
import type { ProviderAdapters } from '@bs/adapters';
import { GovernedGateway } from '../governance/index.ts';
import { PlatformAudit, repositoryAuditSink, type AuditSink } from './audit.ts';
import { BillingLedger, type BillingOptions, type BillingRepositories } from './billing.ts';
import { fixtureByoPrice } from './billing-gateway.ts';
import { ConnectionStore, type StoredConnection } from './connections.ts';
import { guardMessageAdapter } from './contact-gateway.ts';
import { ContactLedger, type ContactPolicy } from './contacts.ts';
import { EntitlementStore } from './entitlements.ts';
import { PlatformEventBus, type WebhookTransport } from './events.ts';
import { PlatformGateway } from './gateway.ts';
import type { PlatformGovernance } from './governance-adapter.ts';
import { fixtureAdmin, TenantDirectory } from './identity.ts';
import { PrivacyService, type PrivacyOptions } from './privacy.ts';
import {
  CapabilityBindingStore,
  ProviderRegistry,
  type BindingRevision,
  type fixtureDataClasses,
} from './providers.ts';
import { PlatformQueries } from './queries.ts';
import {
  MemoryPlatformPersistence,
  type PlatformPersistence,
  type TenantRepository,
} from './repository.ts';
import {
  CredentialVault,
  readVaultMasterKey,
  type StoredCredential,
  type WrappedTenantKey,
} from './vault.ts';

export { PlatformError, type MutationContext, type PlatformCode } from './audit.ts';
export { ConnectionStore, type ConnectionInput } from './connections.ts';
export { guardMessageAdapter } from './contact-gateway.ts';
export * from './contacts.ts';
export * from './events.ts';
export * from './privacy.ts';
export * from './retention.ts';
export { dataClasses, fieldClass, redactFields, type DataClass } from './classification.ts';
export { BillingLedger, type PlanInput, type BillingOptions } from './billing.ts';
export { billingSkus, catalogPriceVersion, type SkuId } from './billing-catalog.ts';
export { type BillingUsage, type ProviderPrice } from './billing-usage.ts';
export { EntitlementStore, ModuleCatalog } from './entitlements.ts';
export { PlatformGateway, type PlatformApproval } from './gateway.ts';
export {
  fixtureAdmin,
  nativeTenantRegion,
  TenantDirectory,
  type PlatformIdentity,
  type PlatformRole,
  type TenantInput,
} from './identity.ts';
export { PlatformAuth, type PlatformAuthOptions } from './auth.ts';
export { PlatformSessions } from './sessions.ts';
export { OidcRelyingParty, type OidcHttpClient } from './oidc.ts';
export { permissions, type Permission } from './permissions.ts';
export {
  capabilities,
  CapabilityBindingStore,
  ProviderRegistry,
  type BindingCall,
  type BindingInput,
  type Capability,
  type ResolvedBinding,
} from './providers.ts';
export { PlatformQueries, type AuditFilters, type UsageFilters } from './queries.ts';
export { PostgresPlatformPersistence, type QueryPool } from './postgres.ts';
export {
  MemoryPlatformPersistence,
  MemoryTenantRepository,
  RepositoryConflict,
  type PlatformPersistence,
  type TenantRepository,
} from './repository.ts';
export { type CredentialAccessor, type CredentialInput } from './vault.ts';

interface PlatformOptions {
  fixtures?: DemoFixtures;
  gateway?: PlatformGovernance;
  now?: () => string;
  auditSink?: AuditSink;
  dataClasses?: typeof fixtureDataClasses;
  persistence?: PlatformPersistence;
  billing?: BillingOptions;
  fixtureUsageBridge?: boolean;
  vaultMasterKey?: Uint8Array;
  contactPolicy?: ContactPolicy;
  privacy?: PrivacyOptions;
  webhookTransport?: WebhookTransport;
  fixtureMessages?: ProviderAdapters['messages'];
  repositories?: {
    audit?: TenantRepository<AuditEntry>;
    entitlements?: TenantRepository<boolean>;
    bindings?: TenantRepository<BindingRevision[]>;
    connections?: TenantRepository<StoredConnection>;
    billing?: Partial<BillingRepositories>;
    credentialKeys?: TenantRepository<WrappedTenantKey>;
    credentials?: TenantRepository<StoredCredential>;
  };
}

const bots = [
  { id: 'order-chat', name: 'Order chat', kind: 'chat', status: 'active', module: 'records' },
  { id: 'order-voice', name: 'Order voice', kind: 'voice', status: 'active', module: 'records' },
  {
    id: 'pr-to-po',
    name: 'PR to PO',
    kind: 'procurement',
    status: 'active',
    module: 'procurement',
  },
  {
    id: 'collections-reminder',
    name: 'Collections reminder',
    kind: 'collections',
    status: 'active',
    module: 'collections',
  },
];
const workflows = [
  {
    id: 'win-back-v1',
    name: 'Win-back campaign',
    kind: 'workflow',
    status: 'active',
    module: 'workflows',
  },
];

export function createPlatformServices(options: PlatformOptions = {}) {
  const fixtures = options.fixtures ?? loadDemoFixtures();
  const startedAt = performance.now();
  const epoch = Date.parse(fixtures.asOf);
  const now = options.now ?? (() => new Date(epoch + performance.now() - startedAt).toISOString());
  if (options.persistence && (options.repositories || options.auditSink)) {
    throw new Error(
      'Transactional platform persistence must own all state and audit repositories.',
    );
  }
  const persistence = options.persistence ?? new MemoryPlatformPersistence();
  function repo<Row>(collection: string, override?: TenantRepository<Row>) {
    return override ?? persistence.repository<Row>(collection);
  }
  const auditEntries = repo<AuditEntry>('audit', options.repositories?.audit);
  const localSink = repositoryAuditSink(auditEntries);
  const audit = new PlatformAudit(
    {
      async append(entry) {
        await options.auditSink?.append(structuredClone(entry));
        await localSink.append(entry);
      },
    },
    now,
    persistence,
  );
  const directory = new TenantDirectory(fixtures, now, persistence, audit);
  const entitlements = new EntitlementStore(
    fixtures.entitlements,
    repo('entitlements', options.repositories?.entitlements),
    audit,
    now,
    (tenantId) => directory.initialPlan(tenantId),
  );
  const providers = new ProviderRegistry();
  const masterKey = options.vaultMasterKey ?? readVaultMasterKey();
  const vault = new CredentialVault(
    masterKey,
    repo('credential_keys', options.repositories?.credentialKeys),
    repo('credentials', options.repositories?.credentials),
    audit,
    now,
  );
  const events = new PlatformEventBus(
    repo('platform_events'),
    repo('webhooks'),
    persistence.repository('webhook_deliveries'),
    repo('notifications'),
    audit,
    now,
    masterKey,
    options.webhookTransport,
  );
  const contacts = new ContactLedger(
    {
      consents: repo('consents'),
      suppressions: repo('suppressions'),
      attempts: repo('contact_attempts'),
    },
    audit,
    options.contactPolicy ?? {
      async resolve(tenantId, contactId) {
        const customer = fixtures.customers.find(
          (row) => row.tenantId === tenantId && row.id === contactId,
        );
        if (!customer) return;
        return {
          timeZone: 'America/Toronto',
          destinations: { email: customer.email, sms: customer.phone, voice: customer.phone },
          historyComplete: true,
          outreachAllowed: customer.outreachAllowed,
        };
      },
      async nationalDoNotCall(destination) {
        return destination === '+14165550107';
      },
    },
    now,
    (tenantId, consent) =>
      events.appendInTransaction(tenantId, {
        id: 'withdrawal-' + consent.id,
        type: 'consent.withdrawn',
        occurredAt: consent.withdrawnAt!,
        data: { consentId: consent.id, channel: consent.channel, purpose: consent.purpose },
      }),
  );
  const privacy = new PrivacyService(
    repo('privacy_requests'),
    repo('retention_holds'),
    repo('retention_policies'),
    audit,
    options.privacy,
    now,
  );
  const billingRepositories = options.repositories?.billing;
  const billing = new BillingLedger(
    {
      plans: repo('billing_plans', billingRepositories?.plans),
      usage: repo('billing_usage', billingRepositories?.usage),
      invoices: repo('billing_invoices', billingRepositories?.invoices),
      credits: repo('billing_credits', billingRepositories?.credits),
    },
    audit,
    now,
    fixtures.asOf,
    {
      ...options.billing,
      providerPrices: [fixtureByoPrice, ...(options.billing?.providerPrices ?? [])],
    },
    (tenantId) => directory.initialPlan(tenantId),
    (tenantId, { id, finalizedAt }) =>
      events.appendInTransaction(tenantId, {
        id: 'finalized-' + id,
        type: 'invoice.finalized',
        occurredAt: finalizedAt,
        data: { invoiceId: id },
      }),
  );
  const bindings = new CapabilityBindingStore(
    providers,
    repo('bindings', options.repositories?.bindings),
    audit,
    options.dataClasses,
    vault,
  );
  const messages = options.fixtureMessages;
  const purposeFor = (preview: { sourceId: string; customerId: string }) =>
    preview.sourceId === preview.customerId ? 'marketing' : 'collections';
  const gateway = new PlatformGateway(
    options.gateway ??
      new GovernedGateway({
        fixtures,
        now,
        providers: messages
          ? {
              messages: {
                email: guardMessageAdapter(contacts, messages.email, purposeFor),
                voice: guardMessageAdapter(contacts, messages.voice, purposeFor),
                sms: guardMessageAdapter(contacts, messages.sms, purposeFor),
              },
            }
          : undefined,
      }),
    directory,
    entitlements,
    audit,
    now,
    repo('gateway_requests'),
    repo('approval_previews'),
    options.fixtureUsageBridge === false ? undefined : billing,
    events,
  );

  return {
    directory,
    entitlements,
    providers,
    bindings,
    resolveBinding: bindings.resolveBinding.bind(bindings),
    billing,
    contacts,
    privacy,
    events,
    vault,
    gateway,
    connections: new ConnectionStore(
      repo('connections', options.repositories?.connections),
      audit,
      now,
    ),
    queries: new PlatformQueries(gateway, auditEntries, entitlements),
    registry(tenantId: string, kind: 'bots' | 'workflows') {
      if (tenantId !== fixtureAdmin.tenantId) return [];
      return structuredClone(kind === 'bots' ? bots : workflows);
    },
  };
}

export type PlatformServices = ReturnType<typeof createPlatformServices>;
