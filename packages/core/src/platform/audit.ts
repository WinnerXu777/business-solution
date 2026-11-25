import { randomUUID } from 'node:crypto';
import type { AuditEntry, CallEnvelope, Denied } from '@bs/contracts';
import type { PlatformIdentity } from './identity.ts';
import type { TenantRepository } from './repository.ts';

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

  constructor(sink: AuditSink, now: () => string) {
    this.sink = sink;
    this.now = now;
  }

  record(context: MutationContext, tool: string, state: AuditEntry['state'] = 'ok') {
    return this.sink.append({
      id: 'audit-' + randomUUID(),
      tenantId: context.tenantId,
      actor: { id: context.actor.id, kind: context.actor.kind },
      source: context.source,
      traceId: context.traceId,
      correlationId: context.correlationId,
      actionId: 'action-' + randomUUID(),
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
