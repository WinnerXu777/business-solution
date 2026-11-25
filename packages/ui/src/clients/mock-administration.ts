import { PlatformError, canOperate } from '../platform-client.ts';
import type { PlatformIdentity } from '../platform-client.ts';
import type {
  BillingClient,
  BillingInvoice,
  BillingPlan,
  BillingSku,
  Connector,
  ConnectorsClient,
  ConnectorStatus,
  CredentialRef,
  CredentialsClient,
  ReconciliationReport,
} from './administration.ts';
import { requireFixture, requireRole } from './mock-records.ts';

export function createMockAdministration(
  me: PlatformIdentity,
  now: string,
  accountingConnected: () => void,
  recordsImported: () => void,
): {
  billing: BillingClient;
  credentials: CredentialsClient;
  connectors: ConnectorsClient;
} {
  const demo = me.tenant.id === 'tenant-rivetquay';
  const skus: BillingSku[] = [
    {
      id: 'platform',
      name: 'Platform',
      monthlyCents: 65000,
      meters: [{ unit: 'tokens', allowance: 1_000_000, aggregation: 'sum' }],
    },
    {
      id: 'erp',
      name: 'Native or connected ERP',
      monthlyCents: 40000,
      meters: [{ unit: 'orders', allowance: 1000, aggregation: 'sum' }],
    },
    {
      id: 'crm',
      name: 'Native or connected CRM',
      monthlyCents: 25000,
      meters: [{ unit: 'active_records', allowance: 10000, aggregation: 'peak' }],
    },
    {
      id: 'workflows',
      name: 'Customer workflow builder',
      monthlyCents: 35000,
      meters: [{ unit: 'runs', allowance: 1000, aggregation: 'sum' }],
    },
  ].map((item) => ({ ...item, currency: 'CAD', priceVersion: 'cad-v1' })) as BillingSku[];
  const windowStart = '2026-11-01T00:00:00.000Z';
  const windowEnd = '2026-12-01T00:00:00.000Z';
  let plan: BillingPlan | null = demo
    ? {
        addOns: [],
        version: 1,
        overageLimitCents: 0,
        monthlyCents: skus[0].monthlyCents,
        currency: 'CAD',
        priceVersion: 'cad-v1',
        effectiveAt: windowStart,
        windowStart,
        windowEnd,
        allowances: [
          { skuId: 'platform', unit: 'tokens', included: 1_000_000, used: 240, overage: 0 },
        ],
      }
    : null;
  const invoices: BillingInvoice[] = demo
    ? [
        {
          id: 'invoice-2026-10-000000000000000000000001',
          windowStart: '2026-10-01T00:00:00.000Z',
          windowEnd: windowStart,
          currency: 'CAD',
          status: 'draft',
          subtotalCents: 65000,
          tax: { code: 'HST', region: 'ON', basisPoints: 1300, amountCents: 8450 },
          totalCents: 73450,
          lines: [
            {
              skuId: 'platform',
              kind: 'subscription',
              description: 'Platform monthly subscription',
              priceVersion: 'cad-v1',
              amountCents: 65000,
            },
          ],
        },
      ]
    : [];
  const refs: CredentialRef[] = demo
    ? [{ ref: 'vault://cred-00000000-0000-4000-8000-000000000000' }]
    : [];
  let sequence = 0;
  const catalogue: Connector[] = [
    {
      id: 'inventory-fixture',
      name: 'Warehouse ledger',
      description: 'Import fictional stock snapshots.',
      auth: 'none',
    },
    {
      id: 'accounting-fixture',
      name: 'Accounting sandbox',
      description: 'Reconcile fictional receivables.',
      auth: 'oauth',
    },
  ];
  const statuses = new Map<string, ConnectorStatus>();
  const reports = new Map<string, ReconciliationReport>();
  let syncSequence = 0;
  const admin = () => requireRole(me.role === 'admin');
  const connector = (id: string) => requireFixture(catalogue.find((item) => item.id === id));
  return {
    billing: {
      async getPlan() {
        return structuredClone(plan);
      },
      async listSkus() {
        return structuredClone(skus);
      },
      async changePlan({ addOns, overageLimitCents }) {
        admin();
        for (const id of addOns) requireFixture(skus.find((item) => item.id === id));
        const active = skus.filter(
          (sku) => sku.id === 'platform' || addOns.some((id) => id === sku.id),
        );
        plan = {
          addOns: [...addOns],
          effectiveAt: now,
          windowStart,
          windowEnd,
          currency: 'CAD',
          priceVersion: 'cad-v1',
          version: (plan?.version ?? 0) + 1,
          overageLimitCents: overageLimitCents ?? plan?.overageLimitCents ?? 0,
          monthlyCents: active.reduce((total, sku) => total + sku.monthlyCents, 0),
          allowances: active.flatMap((sku) =>
            sku.meters.map((meter) => ({
              skuId: sku.id,
              unit: meter.unit,
              included: meter.allowance,
              used:
                plan?.allowances.find((row) => row.skuId === sku.id && row.unit === meter.unit)
                  ?.used ?? 0,
              overage: 0,
            })),
          ),
        };
      },
      async listInvoices() {
        return structuredClone({ items: invoices, creditNotes: [] });
      },
      async getInvoice(id) {
        return structuredClone(requireFixture(invoices.find((row) => row.id === id)));
      },
      async finalizeInvoice(id) {
        admin();
        const index = invoices.findIndex((row) => row.id === id);
        const invoice = requireFixture(invoices[index]);
        if (invoice.status === 'finalized') return;
        if (invoice.windowEnd > now) throw new PlatformError('forbidden');
        invoices[index] = {
          ...invoice,
          status: 'finalized',
          finalizedAt: now,
          settlement: { status: 'simulated', reference: 'fixture-settlement-001' },
        };
      },
    },
    credentials: {
      async list() {
        return structuredClone(refs);
      },
      async add({ capability, providerId, secret }) {
        admin();
        if (!capability || !providerId || !secret.length || secret.length > 16384)
          throw new PlatformError('invalid_input');
        refs.unshift({
          ref: 'vault://cred-00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0'),
        });
      },
      async rotate(ref, secret) {
        admin();
        if (!secret.length || secret.length > 16384) throw new PlatformError('invalid_input');
        requireFixture(refs.find((row) => row.ref === ref));
      },
      async revoke(ref) {
        admin();
        const index = refs.findIndex((row) => row.ref === ref);
        if (index >= 0) refs.splice(index, 1);
      },
    },
    connectors: {
      async list() {
        return structuredClone(catalogue);
      },
      async install(id) {
        requireRole(canOperate(me.role));
        const item = connector(id);
        if (statuses.has(id)) return;
        statuses.set(id, {
          state: item.auth === 'none' ? 'connected' : 'installed',
          lastSyncAt: null,
        });
      },
      async startOAuth(id) {
        admin();
        const item = connector(id);
        if (item.auth !== 'oauth' || !statuses.has(id)) throw new PlatformError('invalid_input');
        // Fixture return simulates the callback with a local hash navigation.
        statuses.set(id, { state: 'connected', lastSyncAt: statuses.get(id)!.lastSyncAt });
        if (id === 'accounting-fixture') accountingConnected();
        return { authorizeUrl: '#/connectors/connector/' + encodeURIComponent(id) };
      },
      async status(id) {
        connector(id);
        return structuredClone(statuses.get(id) ?? { state: 'available', lastSyncAt: null });
      },
      async sync(id) {
        requireRole(canOperate(me.role));
        connector(id);
        const status = statuses.get(id);
        if (status?.state !== 'connected') throw new PlatformError('invalid_input');
        status.lastSyncAt = now;
        if (id === 'inventory-fixture') recordsImported();
        reports.set(id, {
          syncId: 'sync-' + ++syncSequence,
          imported: demo ? 3 : 0,
          unchanged: demo ? 7 : 0,
          issues: demo
            ? [
                {
                  recordId: 'fixture-line-12',
                  reason: 'Source total differs from the recorded balance.',
                },
              ]
            : [],
        });
      },
      async reconciliation(id) {
        connector(id);
        return structuredClone(reports.get(id) ?? null);
      },
    },
  };
}
