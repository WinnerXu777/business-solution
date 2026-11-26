import { PlatformError } from '../platform-client.ts';
import type { PlatformIdentity } from '../platform-client.ts';
import type {
  ComplianceClient,
  ConsentEntry,
  PrivacyRequest,
  SuppressionEntry,
  RetentionPolicy,
} from './compliance.ts';

export function requireAccess(allowed: boolean | undefined) {
  if (!allowed) throw new PlatformError('forbidden');
}
export function findEntry<T extends { id: string }>(rows: T[], id: string) {
  const item = rows.find((row) => row.id === id);
  if (!item) throw new PlatformError('not_found');
  return item;
}

const policies: RetentionPolicy[] = [
  { dataClass: 'public', purgeAfterDays: 365, minimumRetentionDays: 0 },
  { dataClass: 'internal', purgeAfterDays: 365, minimumRetentionDays: 0 },
  { dataClass: 'personal', purgeAfterDays: 180, minimumRetentionDays: 0 },
  { dataClass: 'sensitive', purgeAfterDays: 30, minimumRetentionDays: 0 },
  { dataClass: 'financial', purgeAfterDays: 2192, minimumRetentionDays: 2192 },
];

export function createMockCompliance(me: PlatformIdentity, now: string): ComplianceClient {
  const demo = me.tenant.id === 'tenant-rivetquay';
  const destination = 'purchasing@quayfasteners.example';
  const consents: ConsentEntry[] = demo
    ? [
        {
          id: 'consent-001',
          contactId: 'contact-001',
          channel: 'email',
          purpose: 'marketing',
          basis: 'express',
          destination,
          source: 'fixture-form',
          evidenceRef: 'evidence-001',
          grantedAt: '2026-09-01T15:00:00Z',
          expiresAt: '2027-09-01T15:00:00Z',
        },
      ]
    : [];
  const suppressions: SuppressionEntry[] = demo
    ? [
        {
          id: 'suppression-001',
          channel: 'email',
          destination: 'billing@quaysafety.example',
          reason: 'opt_out',
          createdAt: now,
        },
      ]
    : [];
  const requests: PrivacyRequest[] = [];
  let sequence = 1;
  function manage() {
    requireAccess(me.role === 'admin');
  }
  function status(row: PrivacyRequest, next: PrivacyRequest['status']) {
    if (row.status !== next || !row.history.length) {
      row.status = next;
      row.history.push({ status: next, at: now, actorId: me.actor.id });
    }
  }
  return {
    async listConsents() {
      manage();
      return structuredClone(consents);
    },
    async withdrawConsent(id) {
      manage();
      const row = findEntry(consents, id);
      row.withdrawnAt ??= now;
      return structuredClone(row);
    },
    async listSuppressions() {
      manage();
      return structuredClone(suppressions);
    },
    async addSuppression(input) {
      manage();
      const normalized = input.destination.trim().toLowerCase();
      if (
        !(input.channel === 'email'
          ? /^[^\s@]+@[^\s@]+\.example$/.test(normalized)
          : /^\+1\d{3}55501\d{2}$/.test(normalized))
      )
        throw new PlatformError('invalid_input');
      const existing = suppressions.find(
        (row) => row.channel === input.channel && row.destination === normalized,
      );
      if (existing) return structuredClone(existing);
      const row = {
        ...input,
        destination: normalized,
        id: 'suppression-' + ++sequence,
        createdAt: now,
      };
      suppressions.push(row);
      return structuredClone(row);
    },
    async removeSuppression(id) {
      manage();
      findEntry(suppressions, id);
      suppressions.splice(
        suppressions.findIndex((row) => row.id === id),
        1,
      );
    },
    async checkContact(input) {
      manage();
      if (!demo || !['contact-001', 'contact-002'].includes(input.contactId))
        return { allow: false, reasons: ['contact_unavailable'] };
      const candidate = consents.find(
        (row) =>
          row.contactId === input.contactId &&
          row.channel === input.channel &&
          row.purpose === input.purpose,
      );
      const address =
        input.contactId === 'contact-001' ? destination : 'billing@quaysafety.example';
      if (suppressions.some((row) => row.destination === address && row.channel === input.channel))
        return { allow: false, reasons: ['tenant_suppression'] };
      if (!candidate) return { allow: false, reasons: ['consent_missing'] };
      if (candidate.withdrawnAt) return { allow: false, reasons: ['withdrawn'] };
      if (candidate.expiresAt && Date.parse(candidate.expiresAt) <= Date.parse(now))
        return { allow: false, reasons: ['consent_expired'] };
      return { allow: true, reasons: [], consentId: candidate.id };
    },
    async listPrivacyRequests() {
      manage();
      return structuredClone(requests);
    },
    async createPrivacyRequest(input) {
      manage();
      if (!['contact-001', 'contact-002'].includes(input.subjectId) || !demo)
        throw new PlatformError('not_found');
      const row: PrivacyRequest = {
        ...input,
        id: 'privacy-' + ++sequence,
        dueAt: new Date(Date.parse(now) + 30 * 86_400_000).toISOString(),
        status: 'pending_verification',
        history: [],
      };
      status(row, 'pending_verification');
      requests.unshift(row);
      return structuredClone(row);
    },
    async verifyPrivacyRequest(id, proofRef) {
      manage();
      const row = findEntry(requests, id);
      if (row.status === 'pending_verification') {
        requireAccess(proofRef === 'proof-' + row.subjectId);
        status(row, 'verified');
      }
      return structuredClone(row);
    },
    async completePrivacyRequest(id) {
      manage();
      const row = findEntry(requests, id);
      requireAccess(row.status !== 'pending_verification');
      if (row.kind === 'deletion' && row.subjectId === 'contact-001') {
        row.deletion = {
          deleted: 0,
          blocked: [
            { recordType: 'invoice', id: 'inv-001', reasons: ['hold', 'minimum_retention'] },
          ],
        };
        status(row, 'retention_blocked');
      } else {
        if (row.kind === 'deletion') row.deletion = { deleted: 1, blocked: [] };
        status(row, 'completed');
      }
      return {
        request: structuredClone(row),
        ...(row.kind !== 'deletion' && {
          bundle: {
            records: [
              {
                id: row.subjectId,
                recordType: 'contact',
                version: '1',
                fields: { id: row.subjectId },
              },
            ],
          },
        }),
      };
    },
    async retentionPolicies() {
      manage();
      return structuredClone(policies);
    },
    async purgeDryRun(asOf = now) {
      manage();
      return {
        asOf,
        items: demo
          ? [
              {
                id: 'inv-001',
                recordType: 'invoice',
                version: '1',
                status: 'held',
                purgeAt: '2032-10-01T15:00:00Z',
                holdIds: ['hold-001'],
              },
              ...(!requests.some(
                (row) =>
                  row.subjectId === 'contact-002' &&
                  row.kind === 'deletion' &&
                  row.status === 'completed',
              )
                ? [
                    {
                      id: 'contact-002',
                      recordType: 'contact',
                      version: '1',
                      status: (asOf >= '2026-10-01' ? 'eligible' : 'scheduled') as
                        | 'eligible'
                        | 'scheduled',
                      purgeAt: '2026-10-01T15:00:00Z',
                      holdIds: [],
                    },
                  ]
                : []),
            ]
          : [],
      };
    },
  };
}
