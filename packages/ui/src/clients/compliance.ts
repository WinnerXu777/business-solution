import type { RequestJson } from '../platform-client.ts';

const root = '/platform/v1';
export const contactChannels = ['email', 'sms', 'voice'] as const;
export const contactPurposes = ['marketing', 'collections', 'transactional'] as const;
export const suppressionReasons = ['opt_out', 'do_not_contact', 'policy'] as const;
export const privacyKinds = ['access', 'export', 'deletion'] as const;
export interface ContactCheck {
  contactId: string;
  channel: (typeof contactChannels)[number];
  purpose: (typeof contactPurposes)[number];
}
export interface ContactDecision {
  allow: boolean;
  reasons: string[];
  consentId?: string;
}
export interface ConsentEntry extends ContactCheck {
  id: string;
  basis: 'express' | 'implied';
  destination: string;
  source: string;
  evidenceRef: string;
  grantedAt: string;
  expiresAt?: string;
  withdrawnAt?: string;
}
export interface SuppressionInput {
  channel: ContactCheck['channel'];
  destination: string;
  reason: (typeof suppressionReasons)[number];
}
export interface SuppressionEntry extends SuppressionInput {
  id: string;
  createdAt: string;
}
export interface PrivacyInput {
  subjectId: string;
  kind: (typeof privacyKinds)[number];
}
type PrivacyStatus = 'pending_verification' | 'verified' | 'retention_blocked' | 'completed';
export interface PrivacyRequest extends PrivacyInput {
  id: string;
  dueAt: string;
  status: PrivacyStatus;
  history: { status: PrivacyStatus; at: string; actorId: string }[];
  deletion?: { deleted: number; blocked: { recordType: string; id: string; reasons: string[] }[] };
}
export interface PrivacyCompletion {
  request: PrivacyRequest;
  bundle?: { records: unknown[] };
}
export interface RetentionPolicy {
  dataClass: string;
  purgeAfterDays: number;
  minimumRetentionDays: number;
}
export interface RetentionReport {
  asOf: string;
  items: {
    id: string;
    recordType: string;
    version: string;
    status: 'held' | 'unclassified' | 'eligible' | 'scheduled';
    purgeAt: string;
    holdIds: string[];
  }[];
}

export interface ComplianceClient {
  listConsents(): Promise<ConsentEntry[]>;
  withdrawConsent(id: string): Promise<ConsentEntry>;
  listSuppressions(): Promise<SuppressionEntry[]>;
  addSuppression(input: SuppressionInput): Promise<SuppressionEntry>;
  removeSuppression(id: string): Promise<void>;
  checkContact(input: ContactCheck): Promise<ContactDecision>;
  listPrivacyRequests(): Promise<PrivacyRequest[]>;
  createPrivacyRequest(input: PrivacyInput): Promise<PrivacyRequest>;
  verifyPrivacyRequest(id: string, proofRef: string): Promise<PrivacyRequest>;
  completePrivacyRequest(id: string): Promise<PrivacyCompletion>;
  retentionPolicies(): Promise<RetentionPolicy[]>;
  purgeDryRun(asOf?: string): Promise<RetentionReport>;
}

export class HttpComplianceClient implements ComplianceClient {
  private readonly request: RequestJson;
  constructor(request: RequestJson) {
    this.request = request;
  }
  listConsents() {
    return this.request<ConsentEntry[]>(root + '/consents');
  }
  withdrawConsent(id: string) {
    return this.request<ConsentEntry>(
      root + '/consents/' + encodeURIComponent(id) + '/withdraw',
      'POST',
    );
  }
  listSuppressions() {
    return this.request<SuppressionEntry[]>(root + '/suppressions');
  }
  addSuppression(input: SuppressionInput) {
    return this.request<SuppressionEntry>(root + '/suppressions', 'POST', input);
  }
  removeSuppression(id: string) {
    return this.request<void>(
      root + '/suppressions/' + encodeURIComponent(id),
      'DELETE',
      undefined,
      undefined,
      false,
    );
  }
  checkContact(input: ContactCheck) {
    return this.request<ContactDecision>(root + '/contact-check', 'POST', input);
  }
  listPrivacyRequests() {
    return this.request<PrivacyRequest[]>(root + '/privacy-requests');
  }
  createPrivacyRequest(input: PrivacyInput) {
    return this.request<PrivacyRequest>(root + '/privacy-requests', 'POST', input);
  }
  verifyPrivacyRequest(id: string, proofRef: string) {
    return this.request<PrivacyRequest>(
      root + '/privacy-requests/' + encodeURIComponent(id) + '/verify',
      'POST',
      { proofRef },
    );
  }
  completePrivacyRequest(id: string) {
    return this.request<PrivacyCompletion>(
      root + '/privacy-requests/' + encodeURIComponent(id) + '/complete',
      'POST',
    );
  }
  retentionPolicies() {
    return this.request<RetentionPolicy[]>(root + '/retention/policies');
  }
  purgeDryRun(asOf?: string) {
    return this.request<RetentionReport>(root + '/retention/dry-run', 'POST', { asOf });
  }
}
