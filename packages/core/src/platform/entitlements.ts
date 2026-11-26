import type { Entitlement, ModuleId, UsageCounterEvent } from '@bs/contracts';
import { PlatformAudit, PlatformError, type MutationContext } from './audit.ts';
import type { AddOnId } from './billing-catalog.ts';
import type { PlanInput } from './billing.ts';
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

const moduleAddOns = {
  records: [],
  procurement: ['procurement'],
  collections: ['collections-email', 'collections-outbound'],
  workflows: ['workflows'],
  insights: ['fraud', 'forecasting', 'profiling'],
  ai: ['inbound-chat', 'inbound-voice'],
} satisfies Record<ModuleId, AddOnId[]>;

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
  private readonly initialPlan?: (
    tenantId: string,
  ) => Promise<(PlanInput & { createdAt: string }) | undefined>;

  constructor(
    fixtures: readonly Entitlement[],
    repository: TenantRepository<boolean>,
    audit: PlatformAudit,
    now: () => string,
    initialPlan?: EntitlementStore['initialPlan'],
  ) {
    this.fixtures = structuredClone(fixtures);
    this.repository = repository;
    this.audit = audit;
    this.now = now;
    this.initialPlan = initialPlan;
  }

  private provisioned(
    tenantId: string,
    module: ModuleId,
    instant: number,
    plan: (PlanInput & { createdAt: string }) | undefined,
  ): Entitlement | undefined {
    if (
      !plan ||
      (module !== 'records' && !moduleAddOns[module].some((id) => plan.addOns.includes(id)))
    )
      return;
    const date = new Date(instant);
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    return {
      tenantId,
      flag: { module, enabled: true },
      unit: 'actions',
      allowance: 40,
      windowStart: new Date(Math.max(start, Date.parse(plan.createdAt))).toISOString(),
      windowEnd: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)).toISOString(),
    };
  }

  async listing(tenantId: string, usage: UsageCounterEvent[]) {
    const instant = Date.parse(this.now());
    const plan = await this.initialPlan?.(tenantId);
    return Promise.all(
      this.catalog.list().map(async (module) => {
        const row =
          this.fixtures.find(
            (item) =>
              item.tenantId === tenantId &&
              item.flag.module === module.moduleId &&
              item.unit === 'actions' &&
              Date.parse(item.windowStart) <= instant &&
              instant < Date.parse(item.windowEnd),
          ) ?? this.provisioned(tenantId, module.moduleId, instant, plan);
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

  async override(tenantId: string, module: ModuleId) {
    const plan = await this.initialPlan?.(tenantId);
    if (plan && !this.provisioned(tenantId, module, Date.parse(this.now()), plan)) return false;
    return this.repository.get(tenantId, module);
  }

  async setEnabled(
    context: MutationContext,
    module: string,
    enabled: boolean,
    usage: UsageCounterEvent[],
  ) {
    return this.audit.transaction(context.tenantId, async () => {
      const current = (await this.listing(context.tenantId, usage)).find(
        (row) => row.moduleId === module,
      );
      if (!current) throw new PlatformError('not_found');
      if (!current.windowStart) throw new PlatformError('module_disabled');
      await this.audit.record(context, 'platform.module.update');
      await this.repository.put(context.tenantId, current.moduleId, enabled);
      return { ...current, enabled };
    });
  }
}
