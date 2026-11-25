import { loadDemoFixtures, type AuditEntry, type DemoFixtures } from '@bs/contracts';
import { GovernedGateway } from '../governance/index.ts';
import { PlatformAudit, repositoryAuditSink, type AuditSink } from './audit.ts';
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
import { MemoryTenantRepository, type TenantRepository } from './repository.ts';

export { PlatformError, type MutationContext, type PlatformCode } from './audit.ts';
export { ConnectionStore, type ConnectionInput } from './connections.ts';
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
  type BindingInput,
} from './providers.ts';
export { PlatformQueries, type AuditFilters, type UsageFilters } from './queries.ts';
export { MemoryTenantRepository, type TenantRepository } from './repository.ts';

interface PlatformOptions {
  fixtures?: DemoFixtures;
  gateway?: Pick<GovernedGateway, 'call' | 'signApproval' | 'audit' | 'usage'>;
  now?: () => string;
  auditSink?: AuditSink;
  dataClasses?: typeof fixtureDataClasses;
  repositories?: {
    audit?: TenantRepository<AuditEntry>;
    entitlements?: TenantRepository<boolean>;
    bindings?: TenantRepository<BindingRevision[]>;
    connections?: TenantRepository<StoredConnection>;
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
  const auditEntries = options.repositories?.audit ?? new MemoryTenantRepository<AuditEntry>();
  const localSink = repositoryAuditSink(auditEntries);
  const audit = new PlatformAudit(
    {
      async append(entry) {
        await options.auditSink?.append(structuredClone(entry));
        await localSink.append(entry);
      },
    },
    now,
  );
  const directory = new TenantDirectory(fixtures);
  const entitlements = new EntitlementStore(
    fixtures.entitlements,
    options.repositories?.entitlements ?? new MemoryTenantRepository(),
    audit,
    now,
  );
  const providers = new ProviderRegistry();
  const bindings = new CapabilityBindingStore(
    providers,
    options.repositories?.bindings ?? new MemoryTenantRepository(),
    audit,
    options.dataClasses,
  );
  const gateway = new PlatformGateway(
    options.gateway ?? new GovernedGateway({ fixtures, now }),
    directory,
    entitlements,
    audit,
    now,
  );

  return {
    directory,
    entitlements,
    providers,
    bindings,
    gateway,
    connections: new ConnectionStore(
      options.repositories?.connections ?? new MemoryTenantRepository(),
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
