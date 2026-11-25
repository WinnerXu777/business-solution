import { randomUUID } from 'node:crypto';
import type { AuditEntry, CallEnvelope, Denied } from '@bs/contracts';
import type { PlatformIdentity } from './identity.ts';
import { PlatformQueue, type PlatformPersistence, type TenantRepository } from './repository.ts';

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
    return this.sink.append({
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
    });
  }
}

export function repositoryAuditSink(repository: TenantRepository<AuditEntry>): AuditSink {
  return { append: (entry) => repository.put(entry.tenantId, entry.id, entry) };
}
