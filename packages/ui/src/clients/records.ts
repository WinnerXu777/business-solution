import type {
  Customer,
  Invoice,
  Order,
  PurchaseRequest,
  PurchaseOrder,
  DraftPurchaseOrderOutput,
  Sku,
  Vendor,
  ScoreFraudOutput,
  RunForecastInput,
  RunForecastOutput,
  RunProfileOutput,
} from '@bs/contracts';
import type { PlatformIdentity, RequestJson } from '../platform-client.ts';
import { PlatformError, unwrapTool } from '../platform-client.ts';

export interface Contact {
  id: string;
  customerId: string;
  name: string;
  email: string;
  phone: string;
}
export const dealStages = ['lead', 'qualified', 'proposal', 'won', 'lost'] as const;
export interface Deal {
  id: string;
  customerId: string;
  title: string;
  stage: (typeof dealStages)[number];
  valueCents: number;
}
export interface Consent {
  channel: 'email' | 'sms' | 'voice';
  state: 'allowed' | 'suppressed' | 'unknown';
  evidenceId?: string;
}
export interface RecordsClient {
  listOrders(customerId?: string): Promise<Order[]>;
  getOrder(id: string): Promise<Order>;
  listPurchaseRequests(): Promise<PurchaseRequest[]>;
  getPurchaseRequest(id: string): Promise<PurchaseRequest>;
  listPurchaseDrafts(): Promise<DraftPurchaseOrderOutput[]>;
  draftPurchaseOrder(id: string, key: string): Promise<DraftPurchaseOrderOutput>;
  approvePurchaseOrder(draftId: string, approvalId: string, key: string): Promise<PurchaseOrder>;
  listPurchaseOrders(): Promise<PurchaseOrder[]>;
  listInventory(): Promise<Sku[]>;
  listVendors(): Promise<Vendor[]>;
  listCustomers(): Promise<Customer[]>;
  getCustomer(id: string): Promise<Customer>;
  listContacts(customerId?: string): Promise<Contact[]>;
  listDeals(): Promise<Deal[]>;
  listCustomerInvoices(customerId: string): Promise<Invoice[]>;
  getInvoice(id: string): Promise<Invoice>;
  getConsent(customerId: string): Promise<Consent[]>;
}

export type FraudDecision = 'clear' | 'escalate';
export type ProfileDecision = 'accept' | 'reject';
export interface FraudReview extends ScoreFraudOutput {
  decision: FraudDecision | null;
}
export interface CustomerProfile extends RunProfileOutput {
  reviewStatus: 'pending' | 'accepted' | 'rejected' | 'unavailable';
}
export interface InsightsClient {
  listFraudQueue(): Promise<FraudReview[]>;
  scoreFraud(orderId: string): Promise<ScoreFraudOutput>;
  reviewFraud(orderId: string, decision: FraudDecision, key: string): Promise<void>;
  forecast(input: RunForecastInput): Promise<RunForecastOutput>;
  profile(customerId: string): Promise<CustomerProfile>;
  reviewProfile(customerId: string, decision: ProfileDecision, key: string): Promise<void>;
}

export class HttpRecordsClient implements RecordsClient {
  private readonly request: RequestJson;
  private readonly identity: () => Promise<PlatformIdentity>;
  constructor(request: RequestJson, identity: () => Promise<PlatformIdentity>) {
    this.request = request;
    this.identity = identity;
  }
  async call<T>(tool: string, input: object, idempotencyKey: string = crypto.randomUUID()) {
    const { tenant, actor } = await this.identity();
    const envelope = {
      version: 'v1',
      tenantId: tenant.id,
      actor: { id: actor.id, kind: actor.kind },
      source: 'portal',
      traceId: crypto.randomUUID(),
      correlationId: idempotencyKey,
      idempotencyKey,
    };
    return unwrapTool(
      await this.request<{ state: string; output?: T; code?: string }>(
        '/v1/tools/' + tool,
        'POST',
        { envelope, tool, input },
      ),
    ) as T;
  }
  listOrders(customerId?: string) {
    return this.call<Order[]>('order.list', { customerId });
  }
  getOrder(id: string) {
    return this.call<Order>('order.read', { orderId: id });
  }
  listPurchaseRequests() {
    return this.call<PurchaseRequest[]>('purchase.request.list', {});
  }
  getPurchaseRequest(id: string) {
    return this.call<PurchaseRequest>('purchase.request.read', { requestId: id });
  }
  listPurchaseDrafts() {
    return this.call<DraftPurchaseOrderOutput[]>('purchase.order.drafts.list', {});
  }
  draftPurchaseOrder(id: string, key: string) {
    return this.call<DraftPurchaseOrderOutput>('purchase.order.draft', { requestId: id }, key);
  }
  approvePurchaseOrder(draftId: string, approvalId: string, key: string) {
    return this.call<PurchaseOrder>('purchase.order.approve', { draftId, approvalId }, key);
  }
  listPurchaseOrders() {
    return this.call<PurchaseOrder[]>('purchase.order.list', {});
  }
  listInventory() {
    return this.call<Sku[]>('inventory.list', {});
  }
  listVendors() {
    return this.call<Vendor[]>('vendor.list', {});
  }
  listCustomers() {
    return this.call<Customer[]>('customer.list', {});
  }
  getCustomer(id: string) {
    return this.call<Customer>('customer.read', { customerId: id });
  }
  listContacts(customerId?: string) {
    return this.call<Contact[]>('contact.list', { customerId });
  }
  listDeals() {
    return this.call<Deal[]>('deal.list', {});
  }
  listCustomerInvoices(customerId: string) {
    return this.call<Invoice[]>('invoice.list', { customerId });
  }
  getInvoice(id: string) {
    return this.call<Invoice>('invoice.read', { invoiceId: id });
  }
  getConsent(customerId: string) {
    return this.call<Consent[]>('customer.consent.read', { customerId });
  }
}

export class HttpInsightsClient implements InsightsClient {
  private readonly records: HttpRecordsClient;
  constructor(records: HttpRecordsClient) {
    this.records = records;
  }
  async listFraudQueue() {
    const queue = await this.records.call<{ orderId: string; decision: FraudDecision | null }[]>(
      'fraud.queue',
      {},
    );
    return Promise.all(
      queue.map(async ({ orderId, decision }) => ({
        ...(await this.scoreFraud(orderId)),
        decision,
      })),
    );
  }
  scoreFraud(orderId: string) {
    return this.records.call<ScoreFraudOutput>('fraud.score', { orderId });
  }
  async reviewFraud(orderId: string, decision: FraudDecision, key: string) {
    await this.records.call('fraud.review', { orderId, decision }, key);
  }
  forecast(input: RunForecastInput) {
    return this.records.call<RunForecastOutput>('forecast.run', input);
  }
  async profile(customerId: string) {
    const profile = await this.records.call<RunProfileOutput>('profile.run', { customerId });
    try {
      const { reviewStatus } = await this.records.call<Pick<CustomerProfile, 'reviewStatus'>>(
        'profile.review.read',
        { customerId },
      );
      return { ...profile, reviewStatus };
    } catch (error) {
      if (error instanceof PlatformError && error.code === 'not_found')
        return { ...profile, reviewStatus: 'unavailable' as const };
      throw error;
    }
  }
  async reviewProfile(customerId: string, decision: ProfileDecision, key: string) {
    await this.records.call('profile.review', { customerId, decision }, key);
  }
}
