import { loadDemoFixtures, type AuditEntry, type DemoFixtures } from '@bs/contracts';
import { GovernedGateway } from '../governance/index.ts';
import { PlatformAudit, repositoryAuditSink, type AuditSink } from './audit.ts';
import { BillingLedger, type BillingOptions, type BillingRepositories } from './billing.ts';
import { fixtureByoPrice } from './billing-gateway.ts';
import { ConnectionStore, type StoredConnection } from './connections.ts';
import { EntitlementStore } from './entitlements.ts';
import { PlatformGateway } from './gateway.ts';
import { fixtureAdmin, TenantDirectory } from './identity.ts';
import {
  CapabilityBindingStore,
  ProviderRegistry,
  type BindingRevision,
  type fixtureDataClasses,
} from './providers.ts';
import { PlatformQueries } from './queries.ts';
import {
  MemoryTenantRepository,
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
export { BillingLedger, type PlanInput, type BillingOptions } from './billing.ts';
export { billingSkus, catalogPriceVersion, type SkuId } from './billing-catalog.ts';
export { type BillingUsage, type ProviderPrice } from './billing-usage.ts';
export { EntitlementStore, ModuleCatalog } from './entitlements.ts';
export { PlatformGateway, type PlatformApproval } from './gateway.ts';
export {
  fixtureAdmin,
  TenantDirectory,
  type PlatformIdentity,
  type PlatformRole,
} from './identity.ts';
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
  MemoryTenantRepository,
  type PlatformPersistence,
  type TenantRepository,
} from './repository.ts';
export { type CredentialAccessor, type CredentialInput } from './vault.ts';

interface PlatformOptions {
  fixtures?: DemoFixtures;
  gateway?: Pick<GovernedGateway, 'call' | 'signApproval' | 'audit' | 'usage'>;
  now?: () => string;
  auditSink?: AuditSink;
  dataClasses?: typeof fixtureDataClasses;
  persistence?: PlatformPersistence;
  billing?: BillingOptions;
  fixtureUsageBridge?: boolean;
  vaultMasterKey?: Uint8Array;
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
  function repo<Row>(collection: string, override?: TenantRepository<Row>) {
    return (
      options.persistence?.repository<Row>(collection) ??
      override ??
      new MemoryTenantRepository<Row>()
    );
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
    options.persistence,
  );
  const directory = new TenantDirectory(fixtures);
  const entitlements = new EntitlementStore(
    fixtures.entitlements,
    repo('entitlements', options.repositories?.entitlements),
    audit,
    now,
  );
  const providers = new ProviderRegistry();
  const vault = new CredentialVault(
    options.vaultMasterKey ?? readVaultMasterKey(),
    repo('credential_keys', options.repositories?.credentialKeys),
    repo('credentials', options.repositories?.credentials),
    audit,
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
  );
  const bindings = new CapabilityBindingStore(
    providers,
    repo('bindings', options.repositories?.bindings),
    audit,
    options.dataClasses,
    vault,
  );
  const gateway = new PlatformGateway(
    options.gateway ?? new GovernedGateway({ fixtures, now }),
    directory,
    entitlements,
    audit,
    now,
    options.fixtureUsageBridge === false ? undefined : billing,
  );

  return {
    directory,
    entitlements,
    providers,
    bindings,
    resolveBinding: bindings.resolveBinding.bind(bindings),
    billing,
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
