import type { RequestJson } from '../platform-client.ts';
const root = '/bots';
export interface ProcurementPolicy {
  authorityLimitCents: number;
  approvalThresholdCents: number;
  preferredVendorIds: string[];
}
export const agingBuckets = ['1-30', '31-60', '61-90', '91+'] as const;
export const collectionChannels = ['email', 'sms', 'voice'] as const;
export interface CollectionsPolicy {
  cadenceDays: Record<(typeof agingBuckets)[number], number>;
  channels: (typeof collectionChannels)[number][];
  contactWindow: { start: string; end: string; timeZone: string };
}
export interface BotPolicyMap {
  procurement: ProcurementPolicy;
  collections: CollectionsPolicy;
}
export interface ProcurementException {
  id: string;
  poId: string;
  reason: string;
  status: 'open' | 'resolved';
}
export interface PurchaseMatch {
  poId: string;
  receiptId?: string;
  invoiceId?: string;
  lines: {
    skuId: string;
    ordered: number;
    received: number;
    invoiced: number;
    unitPriceCents: number;
    invoiceUnitPriceCents: number;
  }[];
}
export interface AccountEvent {
  id: string;
  at: string;
  kind: 'invoice' | 'payment' | 'reminder' | 'promise' | 'plan';
  referenceId: string;
  amountCents?: number;
}
export interface CommitmentInput {
  customerId: string;
  amountCents: number;
  dueOn: string;
}
export interface PromiseToPay extends CommitmentInput {
  id: string;
  status: 'open' | 'kept' | 'missed';
}
export interface PaymentPlanInput extends CommitmentInput {
  installments: number;
}
export interface PaymentPlan extends PaymentPlanInput {
  id: string;
  status: 'pending_approval' | 'approved';
  requestedBy: string;
}
export interface BotPoliciesClient {
  getPolicy<K extends keyof BotPolicyMap>(botId: K): Promise<BotPolicyMap[K]>;
  savePolicy<K extends keyof BotPolicyMap>(
    botId: K,
    input: BotPolicyMap[K],
  ): Promise<BotPolicyMap[K]>;
  listExceptions(): Promise<ProcurementException[]>;
  getMatch(poId: string): Promise<PurchaseMatch>;
  accountTimeline(customerId: string): Promise<AccountEvent[]>;
  listPromises(): Promise<PromiseToPay[]>;
  createPromise(input: CommitmentInput): Promise<PromiseToPay>;
  listPaymentPlans(): Promise<PaymentPlan[]>;
  createPaymentPlan(input: PaymentPlanInput): Promise<PaymentPlan>;
  approvePaymentPlan(id: string): Promise<PaymentPlan>;
}
export class HttpBotPoliciesClient implements BotPoliciesClient {
  private readonly request: RequestJson;
  constructor(request: RequestJson) {
    this.request = request;
  }
  getPolicy<K extends keyof BotPolicyMap>(botId: K) {
    return this.request<BotPolicyMap[K]>(root + '/policies/' + botId);
  }
  savePolicy<K extends keyof BotPolicyMap>(botId: K, input: BotPolicyMap[K]) {
    return this.request<BotPolicyMap[K]>(root + '/policies/' + botId, 'PUT', input);
  }
  listExceptions() {
    return this.request<ProcurementException[]>(root + '/procurement/exceptions');
  }
  getMatch(poId: string) {
    return this.request<PurchaseMatch>(root + '/procurement/matches/' + encodeURIComponent(poId));
  }
  accountTimeline(customerId: string) {
    return this.request<AccountEvent[]>(
      root + '/collections/accounts/' + encodeURIComponent(customerId) + '/timeline',
    );
  }
  listPromises() {
    return this.request<PromiseToPay[]>(root + '/collections/promises');
  }
  createPromise(input: CommitmentInput) {
    return this.request<PromiseToPay>(root + '/collections/promises', 'POST', input);
  }
  listPaymentPlans() {
    return this.request<PaymentPlan[]>(root + '/collections/payment-plans');
  }
  createPaymentPlan(input: PaymentPlanInput) {
    return this.request<PaymentPlan>(root + '/collections/payment-plans', 'POST', input);
  }
  approvePaymentPlan(id: string) {
    return this.request<PaymentPlan>(
      root + '/collections/payment-plans/' + encodeURIComponent(id) + '/approve',
      'POST',
    );
  }
}
