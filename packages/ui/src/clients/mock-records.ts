import type {
  Approval,
  DemoFixtures,
  DraftPurchaseOrderOutput,
  PurchaseOrder,
  RunForecastInput,
} from '@bs/contracts';
import { canOperate, canReview, PlatformError } from '../platform-client.ts';
import type { PlatformIdentity } from '../platform-client.ts';
import { dealStages } from './records.ts';
import type { FraudDecision, ProfileDecision, RecordsClient, InsightsClient } from './records.ts';

export class MockRecordsState {
  readonly drafts = new Map<string, DraftPurchaseOrderOutput>();
  readonly orders = new Map<string, PurchaseOrder>();
  readonly fraudDecisions = new Map<string, FraudDecision>();
  readonly profileDecisions = new Map<string, ProfileDecision>();
}

export function mockApproval(
  me: PlatformIdentity,
  id: string,
  tool: Approval['tool'],
  subjectId: string,
  now: string,
  version = 1,
): Approval {
  return {
    id,
    tenantId: me.tenant.id,
    requestedBy: me.actor.id,
    approverId: 'actor-approver',
    tool,
    subjectId,
    materialHash: '0'.repeat(64),
    sourceVersion: version,
    policyVersion: 'fixture-policy-v1',
    expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
    state: 'pending',
  };
}

export function requireFixture<T>(value: T | undefined): T {
  if (value === undefined) throw new PlatformError('not_found');
  return value;
}

export function requireRole(allowed: boolean) {
  if (!allowed) throw new PlatformError('forbidden');
}

export function createMockRecords(
  me: PlatformIdentity,
  fixtures: DemoFixtures,
  now: string,
  state: MockRecordsState,
  enabled: (module: 'records' | 'procurement' | 'insights') => boolean,
): { records: RecordsClient; insights: InsightsClient } {
  const tenant = me.tenant.id;
  const prefix = tenant + ':';
  const scoped = <T extends { tenantId: string }>(rows: T[]) =>
    rows.filter((row) => row.tenantId === tenant);
  function read<T>(value: T, module: 'records' | 'procurement' | 'insights' = 'records'): T {
    if (!enabled(module)) throw new PlatformError('module_disabled');
    return structuredClone(value);
  }
  const orders = scoped(fixtures.orders);
  const customers = scoped(fixtures.customers);
  const requests = scoped(fixtures.purchaseRequests);
  const invoices = scoped(fixtures.invoices);
  const inventory = scoped(fixtures.skus);

  const records: RecordsClient = {
    async listOrders(customerId) {
      return read(orders.filter((row) => !customerId || row.customerId === customerId));
    },
    async getOrder(id) {
      return read(requireFixture(orders.find((row) => row.id === id)));
    },
    async listPurchaseRequests() {
      return read(requests, 'procurement');
    },
    async getPurchaseRequest(id) {
      return read(requireFixture(requests.find((row) => row.id === id)), 'procurement');
    },
    async listPurchaseDrafts() {
      return read(
        [...state.drafts.values()].filter(
          ({ approval }) =>
            approval.tenantId === tenant &&
            (approval.approverId === me.actor.id ||
              approval.requestedBy === me.actor.id ||
              me.role === 'admin'),
        ),
        'procurement',
      );
    },
    async draftPurchaseOrder(id) {
      requireRole(canOperate(me.role));
      const request = await records.getPurchaseRequest(id);
      const draftId = 'draft-' + id + '-v' + request.version;
      const previous = state.drafts.get(prefix + draftId);
      if (previous) {
        if (previous.approval.requestedBy !== me.actor.id)
          throw new PlatformError('idempotency_conflict');
        return structuredClone(previous);
      }
      const draft = {
        id: draftId,
        tenantId: tenant,
        requestId: id,
        sourceVersion: request.version,
        vendorId: request.vendorId,
        costCentre: request.costCentre,
        currency: request.currency,
        lines: request.lines,
      };
      const result = {
        draft,
        approval: mockApproval(
          me,
          'approval-' + draftId,
          'purchase.order.approve',
          draftId,
          now,
          request.version,
        ),
      };
      state.drafts.set(prefix + draftId, result);
      return structuredClone(result);
    },
    async approvePurchaseOrder(draftId, approvalId) {
      requireRole(canReview(me.role));
      read(null, 'procurement');
      const item = requireFixture(state.drafts.get(prefix + draftId));
      const { approval, draft } = item;
      if (
        approval.id !== approvalId ||
        approval.approverId !== me.actor.id ||
        approval.requestedBy === me.actor.id ||
        Date.parse(approval.expiresAt) <= Date.parse(now)
      )
        throw new PlatformError('invalid_approval');
      const existing = state.orders.get(prefix + draftId);
      if (existing) return structuredClone(existing);
      const order: PurchaseOrder = {
        id: 'po-' + draft.requestId,
        draft,
        approvalId,
        status: 'approved',
      };
      state.orders.set(prefix + draftId, order);
      approval.state = 'consumed';
      return structuredClone(order);
    },
    async listPurchaseOrders() {
      return read(
        [...state.orders.values()].filter(({ draft }) => draft.tenantId === tenant),
        'procurement',
      );
    },
    async listInventory() {
      return read(inventory);
    },
    async listVendors() {
      return read(scoped(fixtures.vendors));
    },
    async listCustomers() {
      return read(customers);
    },
    async getCustomer(id) {
      return read(requireFixture(customers.find((row) => row.id === id)));
    },
    async listContacts(customerId) {
      return read(
        customers
          .filter((row) => !customerId || row.id === customerId)
          .map((row) => ({
            id: 'contact-' + row.id,
            customerId: row.id,
            name: row.name + ' purchasing',
            email: row.email,
            phone: row.phone,
          })),
      );
    },
    async listDeals() {
      return read(
        customers.slice(0, 5).map((row, index) => ({
          id: 'deal-' + row.id,
          customerId: row.id,
          title: row.name + ' supply renewal',
          stage: dealStages[index],
          valueCents: 180_000 + 35_000 * index,
        })),
      );
    },
    async listCustomerInvoices(customerId) {
      return read(invoices.filter((row) => row.customerId === customerId));
    },
    async getInvoice(id) {
      return read(requireFixture(invoices.find((row) => row.id === id)));
    },
    async getConsent(customerId) {
      const customer = await records.getCustomer(customerId);
      return (['email', 'sms', 'voice'] as const).map((channel) => ({
        channel,
        state: customer.outreachAllowed
          ? channel === 'email'
            ? 'allowed'
            : 'unknown'
          : 'suppressed',
        evidenceId: 'consent-' + customer.id,
      }));
    },
  };

  const fraudQueue = orders.filter(({ id }) => ['ord-003', 'ord-004'].includes(id));
  const insights: InsightsClient = {
    async listFraudQueue() {
      read(null, 'insights');
      return Promise.all(
        fraudQueue.map(async ({ id }) => ({
          ...(await insights.scoreFraud(id)),
          decision: state.fraudDecisions.get(prefix + id) ?? null,
        })),
      );
    },
    async scoreFraud(id) {
      const order = requireFixture(orders.find((item) => item.id === id));
      const score = id === 'ord-003' ? 0.94 : id === 'ord-004' ? 0.78 : 0.08;
      return read(
        {
          orderId: order.id,
          rule: { score, reasons: order.signals, version: 'fixture-rules-v1' },
          model: {
            score: id === 'ord-003' ? 0.89 : id === 'ord-004' ? 0.81 : 0.06,
            artifactId: 'fixture-fraud-v1',
          },
          disposition: score > 0.5 ? 'review' : 'pass',
        },
        'insights',
      );
    },
    async reviewFraud(orderId, decision) {
      requireRole(canReview(me.role));
      read(requireFixture(fraudQueue.find(({ id }) => id === orderId)), 'insights');
      state.fraudDecisions.set(prefix + orderId, decision);
    },
    async forecast({ series, skuId, horizonWeeks }: RunForecastInput) {
      if (!Number.isInteger(horizonWeeks) || horizonWeeks < 1 || horizonWeeks > 12)
        throw new PlatformError('invalid_input');
      if (series === 'sku_demand') requireFixture(inventory.find(({ id }) => id === skuId));
      const enough = series === 'weekly_sales' || skuId === 'sku-001';
      const factor = series === 'weekly_sales' ? 2500 : 1;
      return read(
        {
          status: enough ? 'fixture' : 'insufficient_history',
          unit: series === 'weekly_sales' ? 'cents' : 'items',
          artifactId: 'fixture-forecast-v1',
          points: enough
            ? Array.from({ length: horizonWeeks }, (_, index) => {
                const weekOf = new Date(Date.UTC(2026, 10, 30 + index * 7))
                  .toISOString()
                  .slice(0, 10);
                const estimate = 84 + index * 4 + (index % 3) * 5;
                return {
                  weekOf,
                  estimate: estimate * factor,
                  lower: (estimate - 15) * factor,
                  upper: (estimate + 22) * factor,
                };
              })
            : [],
        },
        'insights',
      );
    },
    async profile(id) {
      const customer = requireFixture(customers.find((row) => row.id === id));
      const decision = state.profileDecisions.get(prefix + id);
      return read(
        {
          customerId: id,
          segment: !customer.outreachAllowed
            ? 'abstain'
            : customer.lastOrderOn < '2026-06-01'
              ? 'win_back'
              : 'active',
          evidenceIds: [
            id,
            ...orders.filter((order) => order.customerId === id).map((order) => order.id),
          ],
          artifactId: 'fixture-profile-v1',
          reviewRequired: true,
          reviewStatus:
            decision === 'accept' ? 'accepted' : decision === 'reject' ? 'rejected' : 'pending',
        },
        'insights',
      );
    },
    async reviewProfile(id, decision) {
      requireRole(canReview(me.role));
      await insights.profile(id);
      state.profileDecisions.set(prefix + id, decision);
    },
  };
  return { records, insights };
}
