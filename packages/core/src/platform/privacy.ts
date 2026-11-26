import { randomUUID } from 'node:crypto';
import { PlatformAudit, PlatformError, type MutationContext } from './audit.ts';
import { dayMs, instant, iso } from './compliance-time.ts';
import type { TenantRepository } from './repository.ts';
import {
  buildExportBundle,
  recordRef,
  retentionFor,
  retentionPolicies,
  type PrivacyRecordSource,
  type RetentionHold,
  type RetentionHoldInput,
  type RetentionPolicy,
} from './retention.ts';

export interface PrivacyRequestInput {
  subjectId: string;
  kind: 'access' | 'export' | 'deletion';
}

export interface VerificationInput {
  proofRef: string;
}

type PrivacyStatus = 'pending_verification' | 'verified' | 'retention_blocked' | 'completed';
type BlockReason = 'unclassified' | 'hold' | 'minimum_retention';

export interface PrivacyRequest extends PrivacyRequestInput {
  id: string;
  dueAt: string;
  status: PrivacyStatus;
  history: { status: PrivacyStatus; at: string; actorId: string }[];
  deletion?: {
    deleted: number;
    blocked: { recordType: string; id: string; reasons: BlockReason[] }[];
  };
}

export interface PrivacyOptions {
  records: PrivacyRecordSource;
  verifyIdentity: (
    tenantId: string,
    subjectId: string,
    requestId: string,
    proofRef: string,
  ) => Promise<boolean>;
}

export class PrivacyService {
  private readonly requests: TenantRepository<PrivacyRequest>;
  private readonly holds: TenantRepository<RetentionHold>;
  private readonly policyRows: TenantRepository<RetentionPolicy>;
  private readonly audit: PlatformAudit;
  private readonly options?: PrivacyOptions;
  private readonly now: () => string;

  constructor(
    requests: TenantRepository<PrivacyRequest>,
    holds: TenantRepository<RetentionHold>,
    policyRows: TenantRepository<RetentionPolicy>,
    audit: PlatformAudit,
    options: PrivacyOptions | undefined,
    now: () => string,
  ) {
    this.requests = requests;
    this.holds = holds;
    this.policyRows = policyRows;
    this.audit = audit;
    this.options = options;
    this.now = now;
  }

  list(tenantId: string) {
    return this.requests.list(tenantId);
  }

  private source() {
    if (!this.options) throw new PlatformError('unavailable');
    return this.options;
  }

  private async get(tenantId: string, id: string) {
    const request = await this.requests.get(tenantId, id);
    if (!request) throw new PlatformError('not_found');
    return request;
  }

  create(context: MutationContext, input: PrivacyRequestInput) {
    return this.audit.transaction(context.tenantId, async () => {
      const at = this.now();
      const request: PrivacyRequest = {
        ...input,
        id: 'privacy-' + randomUUID(),
        dueAt: iso(instant(at) + 30 * dayMs),
        status: 'pending_verification',
        history: [{ status: 'pending_verification', at, actorId: context.actor.id }],
      };
      await this.audit.record(context, 'platform.privacy.create', 'ok', request.id);
      await this.requests.put(context.tenantId, request.id, request);
      return request;
    });
  }

  private async advance(
    context: MutationContext,
    request: PrivacyRequest,
    status: PrivacyStatus,
    at: string,
  ) {
    request.status = status;
    request.history.push({ status, at, actorId: context.actor.id });
    await this.audit.record(context, 'platform.privacy.' + status, 'ok', request.id);
    await this.requests.put(context.tenantId, request.id, request);
  }

  verify(context: MutationContext, id: string, { proofRef }: VerificationInput) {
    const { tenantId } = context;
    return this.audit
      .transaction(tenantId, async () => {
        const request = await this.get(tenantId, id);
        if (request.status === 'pending_verification') {
          if (!(await this.source().verifyIdentity(tenantId, request.subjectId, id, proofRef))) {
            await this.audit.record(context, 'platform.privacy.verify', 'denied', id);
            return undefined;
          }
          await this.advance(context, request, 'verified', this.now());
        }
        return request;
      })
      .then((request) => {
        if (!request) throw new PlatformError('forbidden');
        return request;
      });
  }

  complete(context: MutationContext, id: string) {
    const { tenantId } = context;
    return this.audit.transaction(tenantId, async () => {
      const request = await this.get(tenantId, id);
      if (request.status === 'pending_verification') throw new PlatformError('forbidden');
      const at = this.now();
      if (request.kind === 'deletion' && request.status === 'completed') return { request };
      const source = this.source().records;
      if (request.kind !== 'deletion') {
        const bundle = await buildExportBundle(source, tenantId, request.subjectId, at);
        if (request.status !== 'completed') await this.advance(context, request, 'completed', at);
        else await this.audit.record(context, 'platform.privacy.export', 'ok', id);
        return { request, bundle };
      }

      const records = await source.list(tenantId, request.subjectId);
      const holds = await this.holds.list(tenantId);
      const policies = await this.policies(tenantId);
      const eligible = [];
      const blocked = [];
      for (const record of records) {
        if (record.tenantId !== tenantId || record.subjectId !== request.subjectId) continue;
        const { holdIds, unclassified, minimumTime } = retentionFor(
          record,
          holds,
          instant(at),
          policies,
        );
        const reasons: BlockReason[] = [];
        if (holdIds.length) reasons.push('hold');
        if (unclassified) reasons.push('unclassified');
        if (minimumTime > instant(at)) reasons.push('minimum_retention');
        if (reasons.length) blocked.push({ id: record.id, recordType: record.recordType, reasons });
        else eligible.push(recordRef(record));
      }
      // Defer the whole request if a record is held, so an operator can retry with the same scope.
      const deleted = blocked.length
        ? 0
        : await source.delete(tenantId, request.subjectId, request.id, eligible);
      request.deletion = { deleted, blocked };
      await this.advance(context, request, blocked.length ? 'retention_blocked' : 'completed', at);
      return { request };
    });
  }

  addHold(context: MutationContext, input: RetentionHoldInput) {
    return this.audit.transaction(context.tenantId, async () => {
      const createdAt = this.now();
      if (input.until !== undefined && instant(input.until) <= instant(createdAt))
        throw new PlatformError('forbidden');
      const hold = { ...input, createdAt, id: 'hold-' + randomUUID() };
      await this.audit.record(context, 'platform.retention.hold', 'ok', hold.id);
      await this.holds.put(context.tenantId, hold.id, hold);
      return hold;
    });
  }

  releaseHold(context: MutationContext, id: string) {
    return this.audit.transaction(context.tenantId, async () => {
      const hold = await this.holds.get(context.tenantId, id);
      if (!hold) throw new PlatformError('not_found');
      if (!hold.releasedAt) {
        hold.releasedAt = this.now();
        await this.audit.record(context, 'platform.retention.release', 'ok', id);
        await this.holds.put(context.tenantId, id, hold);
      }
      return hold;
    });
  }

  async policies(tenantId: string) {
    const stored = new Map(
      (await this.policyRows.list(tenantId)).map((policy) => [policy.dataClass, policy]),
    );
    return retentionPolicies.map((policy) => ({ ...(stored.get(policy.dataClass) ?? policy) }));
  }

  setPolicy(context: MutationContext, policy: RetentionPolicy) {
    return this.audit.transaction(context.tenantId, async () => {
      const baseline = retentionPolicies.find(({ dataClass }) => dataClass === policy.dataClass);
      if (
        !baseline ||
        !Number.isSafeInteger(policy.minimumRetentionDays) ||
        !Number.isSafeInteger(policy.purgeAfterDays) ||
        policy.minimumRetentionDays < baseline.minimumRetentionDays ||
        policy.purgeAfterDays < policy.minimumRetentionDays ||
        policy.purgeAfterDays > 36500
      )
        throw new PlatformError('forbidden');
      await this.policyRows.put(context.tenantId, policy.dataClass, policy);
      await this.audit.record(context, 'platform.retention.policy.update');
      return policy;
    });
  }

  dryRun(tenantId: string, asOf?: string) {
    return this.audit.transaction(tenantId, async () => {
      const time = instant(asOf ?? this.now());
      const holds = await this.holds.list(tenantId);
      const policies = await this.policies(tenantId);
      const records = await this.source().records.list(tenantId);
      const items = records
        .filter((record) => record.tenantId === tenantId)
        .map((record) => {
          const { holdIds, unclassified, purgeAt } = retentionFor(record, holds, time, policies);
          const status = holdIds.length
            ? 'held'
            : unclassified
              ? 'unclassified'
              : instant(purgeAt) <= time
                ? 'eligible'
                : 'scheduled';
          return { ...recordRef(record), status, purgeAt, holdIds };
        });
      return { asOf: iso(time), items };
    });
  }
}
