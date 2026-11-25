import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PlatformAudit, PlatformError, type MutationContext } from './audit.ts';
import {
  billingSkus,
  catalogPriceVersion,
  currency,
  isSku,
  sku,
  type AddOnId,
  type SkuId,
} from './billing-catalog.ts';
import {
  cents,
  nonnegativeInteger,
  rateUsage,
  usageKey,
  type BillingUsage,
  type OveragePrice,
  type ProviderPrice,
  type RatedUsage,
} from './billing-usage.ts';
import type { TenantRepository } from './repository.ts';
import { timestamp } from './queries.ts';

export interface PlanInput {
  addOns: AddOnId[];
  overageLimitCents?: number;
}

interface PlanRevision {
  version: number;
  effectiveAt: number;
  addOns: AddOnId[];
  overageLimitCents: number;
  priceVersion: typeof catalogPriceVersion;
}

interface BillingWindow {
  start: number;
  end: number;
}

export interface InvoiceLine {
  kind: 'subscription' | 'overage' | 'provider';
  skuId: SkuId;
  description: string;
  priceVersion: string;
  amountCents: number;
  quantity?: number;
  unit?: string;
  providerId?: string;
  chargeMode?: ProviderPrice['chargeMode'];
}

export interface TaxRate {
  code: string;
  basisPoints: number;
}

interface InvoiceAmounts {
  currency: typeof currency;
  lines: InvoiceLine[];
  subtotalCents: number;
  tax: TaxRate & { region: string; amountCents: number };
  totalCents: number;
}

export interface InvoiceDraft extends InvoiceAmounts {
  id: string;
  status: 'draft';
  windowStart: string;
  windowEnd: string;
}

export interface FinalInvoice extends Omit<InvoiceDraft, 'status'> {
  status: 'finalized';
  finalizedAt: string;
  settlement: SettlementReceipt;
}

export interface CreditNote extends InvoiceAmounts {
  id: string;
  invoiceId: string;
  reasonRef: string;
  issuedAt: string;
}

interface SettlementReceipt {
  status: 'simulated';
  reference: string;
}

export interface SettlementAdapter {
  /** Local, synchronous, side-effect-free settlement reference for the finalized snapshot. */
  simulate(tenantId: string, invoice: InvoiceDraft): SettlementReceipt;
}

const fakeSettlement: SettlementAdapter = {
  simulate: (tenantId, { id }) => ({
    status: 'simulated',
    reference: 'fixture:' + tenantId + ':' + id,
  }),
};

export interface BillingOptions {
  providerPrices?: readonly ProviderPrice[];
  overagePrices?: readonly OveragePrice[];
  taxTable?: Readonly<Record<string, TaxRate>>;
  taxRegion?: (tenantId: string) => string;
  settlement?: SettlementAdapter;
}

export interface BillingRepositories {
  plans: TenantRepository<PlanRevision[]>;
  usage: TenantRepository<RatedUsage>;
  invoices: TenantRepository<FinalInvoice>;
  credits: TenantRepository<CreditNote>;
}

function iso(instant: number) {
  return new Date(instant).toISOString();
}

function windowAt(instant: number): BillingWindow {
  const date = new Date(instant);
  date.setUTCDate(1);
  date.setUTCHours(0, 0, 0, 0);
  const start = date.valueOf();
  date.setUTCMonth(date.getUTCMonth() + 1);
  return { start, end: date.valueOf() };
}

function invoiceId(tenantId: string, window: BillingWindow) {
  const tenantHash = createHash('sha256').update(tenantId).digest('hex').slice(0, 24);
  return 'invoice-' + iso(window.start).slice(0, 7) + '-' + tenantHash;
}

function roundedRatio(value: number, numerator: number, denominator: number) {
  const divisor = BigInt(denominator);
  return cents(Number((BigInt(value) * BigInt(numerator) + divisor / 2n) / divisor));
}

function activeSkus(plan: PlanRevision): SkuId[] {
  return ['platform', ...plan.addOns];
}

function timeBySku(plans: PlanRevision[], window: BillingWindow) {
  const durations = new Map<SkuId, number>();
  plans.forEach((plan, index) => {
    const start = Math.max(plan.effectiveAt, window.start);
    const end = Math.min(plans[index + 1]?.effectiveAt ?? window.end, window.end);
    if (end <= start) return;
    for (const id of activeSkus(plan)) durations.set(id, (durations.get(id) ?? 0) + end - start);
  });
  return durations;
}

function usageQuantity(events: RatedUsage[], aggregation: 'sum' | 'peak' | 'weekly_peak') {
  if (aggregation === 'peak') {
    return events.reduce((peak, { event }) => Math.max(peak, event.quantity), 0);
  }
  if (aggregation === 'sum') {
    return events.reduce((sum, { event }) => cents(sum + event.quantity), 0);
  }
  const day = 86_400_000;
  const weeks = new Map<number, number>();
  let peak = 0;
  for (const { event } of events) {
    const week = Math.floor((timestamp(event.occurredAt) + 3 * day) / (7 * day));
    const total = cents((weeks.get(week) ?? 0) + event.quantity);
    weeks.set(week, total);
    peak = Math.max(peak, total);
  }
  return peak;
}

function allowances(duration: Map<SkuId, number>, window: BillingWindow, usage: RatedUsage[]) {
  return [...duration].flatMap(([skuId, activeTime]) =>
    sku(skuId).meters.map(({ unit, allowance, aggregation }) => {
      const included = roundedRatio(allowance, activeTime, window.end - window.start);
      const used = usageQuantity(
        usage.filter(
          ({ event }) => event.kind === 'outcome' && event.skuId === skuId && event.unit === unit,
        ),
        aggregation,
      );
      return { skuId, unit, included, used, overage: Math.max(0, used - included) };
    }),
  );
}

function providerLines(usage: RatedUsage[]) {
  const lines = new Map<string, InvoiceLine>();
  for (const { event, chargeMode, amountCents } of usage) {
    if (event.kind !== 'provider' || chargeMode === 'included') continue;
    const { skuId, providerId, quantity, unit, priceVersion } = event;
    const key = JSON.stringify([skuId, providerId, unit, priceVersion, chargeMode]);
    const previous = lines.get(key);
    lines.set(key, {
      kind: 'provider',
      skuId,
      providerId,
      description: providerId + ' usage',
      unit,
      priceVersion,
      chargeMode,
      quantity: cents(quantity + (previous?.quantity ?? 0)),
      amountCents: cents(amountCents + (previous?.amountCents ?? 0)),
    });
  }
  return [...lines.values()];
}

export class BillingLedger {
  private readonly repositories: BillingRepositories;
  private readonly audit: PlatformAudit;
  private readonly now: () => string;
  private readonly firstWindow: BillingWindow;
  private readonly providerPrices: readonly ProviderPrice[];
  private readonly overagePrices: readonly OveragePrice[];
  private readonly taxTable: Readonly<Record<string, TaxRate>>;
  private readonly taxRegion: (tenantId: string) => string;
  private readonly settlement: SettlementAdapter;
  private readonly initialPlan?: (
    tenantId: string,
  ) => (PlanInput & { createdAt: string }) | undefined;

  constructor(
    repositories: BillingRepositories,
    audit: PlatformAudit,
    now: () => string,
    startsAt: string,
    options: BillingOptions = {},
    initialPlan?: BillingLedger['initialPlan'],
  ) {
    this.repositories = repositories;
    this.audit = audit;
    this.now = now;
    this.firstWindow = windowAt(timestamp(startsAt));
    this.providerPrices = structuredClone(options.providerPrices ?? []);
    this.overagePrices = structuredClone(options.overagePrices ?? []);
    this.taxTable = structuredClone(options.taxTable ?? { ON: { code: 'HST', basisPoints: 1300 } });
    this.taxRegion = options.taxRegion ?? (() => 'ON');
    this.settlement = options.settlement ?? fakeSettlement;
    this.initialPlan = initialPlan;
  }

  skus() {
    return billingSkus();
  }

  private async plans(tenantId: string): Promise<PlanRevision[]> {
    const initial = this.initialPlan?.(tenantId);
    return (
      (await this.repositories.plans.get(tenantId, 'subscription')) ?? [
        {
          version: 1,
          effectiveAt: initial ? timestamp(initial.createdAt) : this.firstWindow.start,
          addOns: initial?.addOns ?? [],
          overageLimitCents: initial?.overageLimitCents ?? 0,
          priceVersion: catalogPriceVersion,
        },
      ]
    );
  }

  private async planView(tenantId: string, instant: number, plans: PlanRevision[]) {
    const window = windowAt(instant);
    const plan = plans.at(-1)!;
    const { effectiveAt, ...details } = plan;
    const duration = timeBySku(plans, window);
    return {
      ...details,
      currency,
      effectiveAt: iso(effectiveAt),
      windowStart: iso(window.start),
      windowEnd: iso(window.end),
      monthlyCents: activeSkus(plan).reduce((total, id) => total + sku(id).monthlyCents, 0),
      allowances: allowances(duration, window, await this.windowUsage(tenantId, window)),
    };
  }

  plan(tenantId: string) {
    return this.audit.transaction(tenantId, async () =>
      this.planView(tenantId, timestamp(this.now()), await this.plans(tenantId)),
    );
  }

  changePlan(context: MutationContext, input: PlanInput) {
    const { tenantId } = context;
    const addOns = [...new Set(input.addOns)].sort();
    const limit = input.overageLimitCents;
    if (
      addOns.some((id) => !isSku(id) || String(id) === 'platform') ||
      (limit !== undefined && !nonnegativeInteger(limit))
    )
      throw new PlatformError('forbidden');

    return this.audit.transaction(tenantId, async () => {
      const instant = timestamp(this.now());
      const plans = await this.plans(tenantId);
      const previous = plans.at(-1)!;
      if (instant < previous.effectiveAt) throw new PlatformError('unavailable');
      const overageLimitCents = limit ?? previous.overageLimitCents;
      if (
        !isDeepStrictEqual(previous.addOns, addOns) ||
        overageLimitCents !== previous.overageLimitCents
      ) {
        plans.push({
          version: previous.version + 1,
          addOns,
          effectiveAt: instant,
          priceVersion: catalogPriceVersion,
          overageLimitCents,
        });
        await this.audit.record(context, 'platform.billing.plan.change');
        await this.repositories.plans.put(tenantId, 'subscription', plans);
      }
      return this.planView(tenantId, instant, plans);
    });
  }

  recordUsage(context: MutationContext, event: BillingUsage) {
    return this.record(context, event, false);
  }

  /** Fixture bridge. The existing usage counter already audits outcomes for unsubscribed SKUs. */
  recordFixtureUsage(context: MutationContext, event: BillingUsage) {
    return this.record(context, event, true);
  }

  private record(context: MutationContext, incoming: BillingUsage, skipUnsubscribed: boolean) {
    const { tenantId } = context;
    const occurredAt = timestamp(incoming.occurredAt);
    const event = { ...incoming, occurredAt: iso(occurredAt) };
    const key = usageKey(event);
    return this.audit.transaction(tenantId, async () => {
      const prior = await this.repositories.usage.get(tenantId, key);
      if (prior) {
        const replay =
          skipUnsubscribed && event.kind === 'outcome'
            ? { ...event, occurredAt: prior.event.occurredAt }
            : event;
        if (!isDeepStrictEqual(prior.event, replay))
          throw new PlatformError('idempotency_conflict');
        return prior;
      }
      if (occurredAt > timestamp(this.now()) || occurredAt < this.firstWindow.start)
        throw new PlatformError('forbidden');
      const plans = await this.plans(tenantId);
      const active = activeSkus(plans.findLast((plan) => plan.effectiveAt <= occurredAt)!);
      if (!active.includes(event.skuId)) {
        if (skipUnsubscribed) return;
        throw new PlatformError('module_disabled');
      }
      const window = windowAt(occurredAt);
      if (await this.repositories.invoices.get(tenantId, invoiceId(tenantId, window))) {
        throw new PlatformError('idempotency_conflict', 'Billing window already finalized.');
      }
      const rated = rateUsage(event, this.providerPrices);
      await this.audit.record(context, 'platform.billing.usage.record');
      await this.repositories.usage.put(tenantId, key, rated);
      return rated;
    });
  }

  private async windowUsage(tenantId: string, window: BillingWindow) {
    return (await this.repositories.usage.list(tenantId)).filter(({ event }) => {
      const instant = timestamp(event.occurredAt);
      return window.start <= instant && instant < window.end;
    });
  }

  private overages(usage: ReturnType<typeof allowances>, ceiling: number) {
    let remaining = ceiling;
    const lines: InvoiceLine[] = [];
    for (const { skuId, unit, overage } of usage) {
      const price = this.overagePrices.find((item) => item.skuId === skuId && item.unit === unit);
      if (!price || !cents(price.unitCents)) continue;
      const quantity = Math.min(overage, Math.floor(remaining / price.unitCents));
      if (quantity === 0) continue;
      const amountCents = quantity * price.unitCents;
      remaining -= amountCents;
      lines.push({
        kind: 'overage',
        skuId,
        unit,
        quantity,
        amountCents,
        description: sku(skuId).name + ' overage',
        priceVersion: catalogPriceVersion,
      });
    }
    return lines;
  }

  private async draft(tenantId: string, window: BillingWindow): Promise<InvoiceDraft> {
    const plans = await this.plans(tenantId);
    const usage = await this.windowUsage(tenantId, window);
    const duration = timeBySku(plans, window);
    const lines: InvoiceLine[] = [...duration].map(([skuId, activeTime]) => {
      const { name, monthlyCents, priceVersion } = sku(skuId);
      return {
        kind: 'subscription',
        skuId,
        description: name,
        priceVersion,
        amountCents: roundedRatio(monthlyCents, activeTime, window.end - window.start),
      };
    });
    const ceiling =
      plans.findLast(({ effectiveAt }) => effectiveAt < window.end)?.overageLimitCents ?? 0;
    lines.push(
      ...this.overages(allowances(duration, window, usage), ceiling),
      ...providerLines(usage),
    );
    const subtotalCents = cents(lines.reduce((sum, line) => sum + line.amountCents, 0));
    const region = this.taxRegion(tenantId);
    const rate = Object.hasOwn(this.taxTable, region) && this.taxTable[region];
    if (!rate || !rate.code || !nonnegativeInteger(rate.basisPoints))
      throw new PlatformError('unavailable');
    const amountCents = roundedRatio(subtotalCents, rate.basisPoints, 10_000);
    return {
      id: invoiceId(tenantId, window),
      status: 'draft',
      windowStart: iso(window.start),
      windowEnd: iso(window.end),
      currency,
      lines,
      subtotalCents,
      tax: { ...rate, region, amountCents },
      totalCents: cents(subtotalCents + amountCents),
    };
  }

  private invoiceWindow(tenantId: string, id: string, now: number) {
    if (!/^invoice-\d{4}-(0[1-9]|1[0-2])-[a-f0-9]{24}$/.test(id))
      throw new PlatformError('not_found');
    const window = windowAt(timestamp(id.slice(8, 15) + '-01T00:00:00Z'));
    if (
      window.start < this.firstWindow.start ||
      window.start > now ||
      id !== invoiceId(tenantId, window)
    )
      throw new PlatformError('not_found');
    return window;
  }

  private async invoiceInWindow(tenantId: string, window: BillingWindow) {
    return (
      (await this.repositories.invoices.get(tenantId, invoiceId(tenantId, window))) ??
      this.draft(tenantId, window)
    );
  }

  invoices(tenantId: string) {
    return this.audit.transaction(tenantId, async () => {
      const items: (FinalInvoice | InvoiceDraft)[] = [];
      for (
        let window = windowAt(timestamp(this.now()));
        window.start >= this.firstWindow.start;
        window = windowAt(window.start - 1)
      ) {
        items.push(await this.invoiceInWindow(tenantId, window));
      }
      return { items, creditNotes: await this.repositories.credits.list(tenantId) };
    });
  }

  invoice(tenantId: string, id: string) {
    return this.audit.transaction(tenantId, () =>
      this.invoiceInWindow(tenantId, this.invoiceWindow(tenantId, id, timestamp(this.now()))),
    );
  }

  finalize(context: MutationContext, id: string) {
    const { tenantId } = context;
    return this.audit.transaction(tenantId, async () => {
      const existing = await this.repositories.invoices.get(tenantId, id);
      if (existing) return existing;
      const now = timestamp(this.now());
      const window = this.invoiceWindow(tenantId, id, now);
      if (now < window.end) throw new PlatformError('forbidden', 'Billing window is still open.');
      const draft = await this.draft(tenantId, window);
      const invoice: FinalInvoice = {
        ...draft,
        status: 'finalized',
        finalizedAt: iso(now),
        settlement: this.settlement.simulate(tenantId, structuredClone(draft)),
      };
      await this.audit.record(context, 'platform.billing.invoice.finalize', 'ok', id);
      await this.repositories.invoices.put(tenantId, id, invoice);
      return invoice;
    });
  }

  credit(context: MutationContext, invoiceId: string, reasonRef: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(reasonRef)) throw new PlatformError('forbidden');
    const { tenantId } = context;
    return this.audit.transaction(tenantId, async () => {
      const invoice = await this.repositories.invoices.get(tenantId, invoiceId);
      if (!invoice) throw new PlatformError('not_found');
      const id = 'credit-' + invoiceId;
      const existing = await this.repositories.credits.get(tenantId, id);
      if (existing) {
        if (existing.reasonRef !== reasonRef) throw new PlatformError('idempotency_conflict');
        return existing;
      }
      const credit: CreditNote = {
        id,
        invoiceId,
        reasonRef,
        issuedAt: this.now(),
        currency,
        lines: invoice.lines.map((line) => ({ ...line, amountCents: 0 - line.amountCents })),
        subtotalCents: 0 - invoice.subtotalCents,
        tax: { ...invoice.tax, amountCents: 0 - invoice.tax.amountCents },
        totalCents: 0 - invoice.totalCents,
      };
      await this.audit.record(context, 'platform.billing.credit.issue', 'ok', id);
      await this.repositories.credits.put(tenantId, id, credit);
      return credit;
    });
  }
}
