import type { CapabilityId, RequestJson } from '../platform-client.ts';

export const billingAddOns = [
  'erp',
  'crm',
  'inbound-chat',
  'inbound-voice',
  'procurement',
  'collections-email',
  'collections-outbound',
  'workflows',
  'fraud',
  'forecasting',
  'profiling',
] as const;
export type BillingAddOn = (typeof billingAddOns)[number];
export type BillingSkuId = 'platform' | BillingAddOn;

export interface BillingSku {
  id: BillingSkuId;
  name: string;
  currency: 'CAD';
  priceVersion: string;
  monthlyCents: number;
  meters: { unit: string; allowance: number; aggregation: 'sum' | 'peak' | 'weekly_peak' }[];
}
export interface BillingPlan {
  addOns: BillingAddOn[];
  overageLimitCents: number;
  version: number;
  priceVersion: string;
  currency: 'CAD';
  effectiveAt: string;
  windowStart: string;
  windowEnd: string;
  monthlyCents: number;
  allowances: {
    skuId: BillingSkuId;
    unit: string;
    included: number;
    used: number;
    overage: number;
  }[];
}
export interface PlanUpdate {
  addOns: BillingAddOn[];
  overageLimitCents?: number;
}
interface InvoiceAmounts {
  currency: 'CAD';
  lines: {
    skuId: BillingSkuId;
    kind: 'subscription' | 'overage' | 'provider';
    description: string;
    priceVersion: string;
    amountCents: number;
    providerId?: string;
    unit?: string;
    quantity?: number;
    chargeMode?: 'informational' | 'pass_through' | 'uplift';
  }[];
  subtotalCents: number;
  tax: { code: string; region: string; basisPoints: number; amountCents: number };
  totalCents: number;
}
export type BillingInvoice = InvoiceAmounts & {
  id: string;
  windowStart: string;
  windowEnd: string;
} & (
    | { status: 'draft' }
    | {
        status: 'finalized';
        finalizedAt: string;
        settlement: { status: 'simulated'; reference: string };
      }
  );
export interface BillingInvoices {
  items: BillingInvoice[];
  creditNotes: (InvoiceAmounts & {
    id: string;
    invoiceId: string;
    reasonRef: string;
    issuedAt: string;
  })[];
}
export interface BillingClient {
  getPlan(): Promise<BillingPlan | null>;
  listSkus(): Promise<BillingSku[]>;
  changePlan(input: PlanUpdate): Promise<void>;
  listInvoices(): Promise<BillingInvoices>;
  getInvoice(id: string): Promise<BillingInvoice>;
  finalizeInvoice(id: string): Promise<void>;
}
export interface CredentialRef {
  ref: string;
}
export interface CredentialInput {
  capability: CapabilityId;
  providerId: string;
  secret: string;
}
export interface CredentialsClient {
  list(): Promise<CredentialRef[]>;
  add(input: CredentialInput): Promise<void>;
  rotate(ref: string, secret: string): Promise<void>;
  revoke(ref: string): Promise<void>;
}
export interface Connector {
  id: string;
  name: string;
  description: string;
  auth: 'oauth' | 'none';
}
export interface ConnectorStatus {
  state: 'available' | 'installed' | 'connected' | 'error';
  lastSyncAt: string | null;
}
export interface ReconciliationReport {
  syncId: string;
  imported: number;
  unchanged: number;
  issues: { recordId: string; reason: string }[];
}
export interface ConnectorsClient {
  list(): Promise<Connector[]>;
  install(id: string): Promise<void>;
  startOAuth(id: string): Promise<{ authorizeUrl: string }>;
  status(id: string): Promise<ConnectorStatus>;
  sync(id: string): Promise<void>;
  reconciliation(id: string): Promise<ReconciliationReport | null>;
}

export class HttpBillingClient implements BillingClient {
  private readonly request: RequestJson;
  constructor(request: RequestJson) {
    this.request = request;
  }
  getPlan() {
    return this.request<BillingPlan | null>('/platform/v1/billing/plan');
  }
  listSkus() {
    return this.request<BillingSku[]>('/platform/v1/billing/skus');
  }
  async changePlan(input: PlanUpdate) {
    await this.request('/platform/v1/billing/plan', 'POST', input, undefined, false);
  }
  listInvoices() {
    return this.request<BillingInvoices>('/platform/v1/billing/invoices');
  }
  getInvoice(id: string) {
    return this.request<BillingInvoice>(invoicePath(id));
  }
  async finalizeInvoice(id: string) {
    await this.request(invoicePath(id) + '/finalize', 'POST', undefined, undefined, false);
  }
}

export class HttpCredentialsClient implements CredentialsClient {
  private readonly request: RequestJson;
  constructor(request: RequestJson) {
    this.request = request;
  }
  list() {
    return this.request<CredentialRef[]>('/platform/v1/credentials');
  }
  async add(input: CredentialInput) {
    await this.request('/platform/v1/credentials', 'POST', input, undefined, false);
  }
  async rotate(ref: string, secret: string) {
    await this.request(credentialPath(ref) + '/rotate', 'POST', { secret }, undefined, false);
  }
  async revoke(ref: string) {
    await this.request(credentialPath(ref), 'DELETE', undefined, undefined, false);
  }
}

export class HttpConnectorsClient implements ConnectorsClient {
  private readonly request: RequestJson;
  constructor(request: RequestJson) {
    this.request = request;
  }
  list() {
    return this.request<Connector[]>('/connectors');
  }
  async install(id: string) {
    await this.request(connectorPath(id) + '/install', 'POST', undefined, undefined, false);
  }
  startOAuth(id: string) {
    return this.request<{ authorizeUrl: string }>(connectorPath(id) + '/oauth/start', 'POST');
  }
  status(id: string) {
    return this.request<ConnectorStatus>(connectorPath(id) + '/status');
  }
  async sync(id: string) {
    await this.request(connectorPath(id) + '/sync', 'POST', undefined, undefined, false);
  }
  reconciliation(id: string) {
    return this.request<ReconciliationReport | null>(connectorPath(id) + '/reconciliation');
  }
}

const invoicePath = (id: string) => '/platform/v1/billing/invoices/' + encodeURIComponent(id);
const credentialPath = (ref: string) => '/platform/v1/credentials/' + encodeURIComponent(ref);
const connectorPath = (id: string) => '/connectors/' + encodeURIComponent(id);
