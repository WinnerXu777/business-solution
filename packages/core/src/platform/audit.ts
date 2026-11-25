import { randomUUID } from 'node:crypto';
import type { AuditEntry, CallEnvelope, Denied } from '@bs/contracts';
import type { PlatformIdentity } from './identity.ts';
import { PlatformQueue, type PlatformPersistence, type TenantRepository } from './repository.ts';
import { redactFields } from './classification.ts';

export type PlatformCode = Exclude<Denied['code'], 'suppressed'> | 'unavailable';

export class PlatformError extends Error {
  readonly code: PlatformCode;

  constructor(code: PlatformCode, message = code.replaceAll('_', ' ')) {
    super(message);
    this.code = code;
  }
}

export interface AuditSink {
  append(entry: AuditEntry): Promise<void>;
}

export interface MutationContext extends PlatformIdentity {
  source: CallEnvelope['source'];
  traceId: string;
  correlationId: string;
}

export class PlatformAudit {
  private readonly sink: AuditSink;
  private readonly now: () => string;
  private readonly persistence?: PlatformPersistence;
  private readonly queue = new PlatformQueue();

  constructor(sink: AuditSink, now: () => string, persistence?: PlatformPersistence) {
    this.sink = sink;
    this.now = now;
    this.persistence = persistence;
  }

  transaction<Result>(tenantId: string, run: () => Promise<Result>) {
    return this.persistence?.transaction(tenantId, run) ?? this.queue.run(run);
  }

  record(
    context: MutationContext,
    tool: string,
    state: AuditEntry['state'] = 'ok',
    subjectId?: string,
  ) {
    const entry: AuditEntry = {
      id: 'audit-' + randomUUID(),
      tenantId: context.tenantId,
      actor: { id: context.actor.id, kind: context.actor.kind },
      source: context.source,
      traceId: context.traceId,
      correlationId: context.correlationId,
      actionId: subjectId ?? 'action-' + randomUUID(),
      tool,
      state,
      policyVersion: 'fixture-policy-v1',
      occurredAt: this.now(),
    };
    // The audit registry classifies every field in this allowlisted AuditEntry projection.
    return this.sink.append(redactFields('audit', entry) as unknown as AuditEntry);
  }
}

export function repositoryAuditSink(repository: TenantRepository<AuditEntry>): AuditSink {
  return { append: (entry) => repository.put(entry.tenantId, entry.id, entry) };
}
