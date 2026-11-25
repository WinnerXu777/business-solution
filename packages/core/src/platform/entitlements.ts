import type { Entitlement, ModuleId, UsageCounterEvent } from '@bs/contracts';
import { PlatformAudit, PlatformError, type MutationContext } from './audit.ts';
import type { TenantRepository } from './repository.ts';

const modules = {
  records: { name: 'Records', description: 'Governed REST and MCP access to business records.' },
  procurement: { name: 'Procurement', description: 'Purchase requisitions and purchase orders.' },
  collections: { name: 'Collections', description: 'Invoice reminders by email, voice and SMS.' },
  workflows: { name: 'Workflows', description: 'Preview and run versioned customer workflows.' },
  insights: {
    name: 'Insights',
    description: 'Fraud review, demand forecasts and customer profiles.',
  },
  ai: { name: 'AI', description: 'Native and BYO inference routes.' },
} satisfies Record<ModuleId, { name: string; description: string }>;

export class ModuleCatalog {
  list() {
    return (Object.keys(modules) as ModuleId[]).map((moduleId) => ({
      moduleId,
      ...modules[moduleId],
    }));
  }
}

export function actionUsage(events: UsageCounterEvent[], module: ModuleId) {
  return events
    .filter((event) => event.module === module && event.unit === 'actions')
    .reduce((sum, event) => sum + event.quantity, 0);
}

export class EntitlementStore {
  private readonly catalog = new ModuleCatalog();
  private readonly fixtures: readonly Entitlement[];
  private readonly repository: TenantRepository<boolean>;
  private readonly audit: PlatformAudit;
  private readonly now: () => string;

  constructor(
    fixtures: readonly Entitlement[],
    repository: TenantRepository<boolean>,
    audit: PlatformAudit,
    now: () => string,
  ) {
    this.fixtures = structuredClone(fixtures);
    this.repository = repository;
    this.audit = audit;
    this.now = now;
  }

  async listing(tenantId: string, usage: UsageCounterEvent[]) {
    const instant = Date.parse(this.now());
    return Promise.all(
      this.catalog.list().map(async (module) => {
        const row = this.fixtures.find(
          (item) =>
            item.tenantId === tenantId &&
            item.flag.module === module.moduleId &&
            item.unit === 'actions' &&
            Date.parse(item.windowStart) <= instant &&
            instant < Date.parse(item.windowEnd),
        );
        const override = await this.repository.get(tenantId, module.moduleId);
        const used = row
          ? actionUsage(
              usage.filter(
                (event) =>
                  event.tenantId === tenantId &&
                  Date.parse(event.occurredAt) >= Date.parse(row.windowStart) &&
                  Date.parse(event.occurredAt) < Date.parse(row.windowEnd),
              ),
              module.moduleId,
            )
          : 0;
        return {
          ...module,
          enabled: Boolean(row && (override ?? row.flag.enabled)),
          allowance: row?.allowance ?? 0,
          used,
          windowStart: row?.windowStart ?? null,
          windowEnd: row?.windowEnd ?? null,
        };
      }),
    );
  }

  override(tenantId: string, module: ModuleId) {
    return this.repository.get(tenantId, module);
  }

  async setEnabled(
    context: MutationContext,
    module: string,
    enabled: boolean,
    usage: UsageCounterEvent[],
  ) {
    const current = (await this.listing(context.tenantId, usage)).find(
      (row) => row.moduleId === module,
    );
    if (!current) throw new PlatformError('not_found');
    if (!current.windowStart) throw new PlatformError('module_disabled');
    await this.audit.record(context, 'platform.module.update');
    await this.repository.put(context.tenantId, current.moduleId, enabled);
    return { ...current, enabled };
  }
}
