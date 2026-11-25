import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import type { CallEnvelope } from '@bs/contracts';
import { redactText } from './redaction.ts';
import { validTraceId, type TraceContext } from './trace-context.ts';

type EnvelopeContext = Pick<CallEnvelope, 'tenantId' | 'actor' | 'traceId' | 'correlationId'>;
type Attributes = Record<string, string | number | boolean>;
type SpanStatus = 'unset' | 'ok' | 'error';

export interface SpanData extends TraceContext {
  name: string;
  parentSpanId?: string;
  kind: 'server' | 'internal';
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: SpanStatus;
  attributes: Attributes;
}

export interface SpanExporter {
  export(span: SpanData): void | Promise<void>;
}

export interface Span extends TraceContext {
  end(status?: SpanStatus, attributes?: Attributes): void;
}

interface StartSpanOptions {
  parent?: TraceContext | null;
  envelope?: EnvelopeContext;
  kind?: SpanData['kind'];
}

function randomId(bytes: number): string {
  let id: string;
  do {
    id = randomBytes(bytes).toString('hex');
  } while (!validTraceId(id, bytes * 2));
  return id;
}

function wireTraceId(id: string): string {
  if (validTraceId(id)) return id;
  const uuid = id.replaceAll('-', '').toLowerCase();
  if (/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id) && validTraceId(uuid)) return uuid;
  return createHash('sha256').update(id).digest('hex').slice(0, 32);
}

export class Tracer {
  private readonly scope = new AsyncLocalStorage<TraceContext>();
  private readonly envelopes = new WeakMap<TraceContext, EnvelopeContext>();
  private readonly epoch = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();

  constructor(exporter?: SpanExporter, now?: () => bigint) {
    this.exporter = exporter;
    this.now = now ?? (() => this.epoch + process.hrtime.bigint());
  }

  private readonly exporter?: SpanExporter;
  private readonly now: () => bigint;

  active(): TraceContext | undefined {
    return this.scope.getStore();
  }

  run<T>(span: TraceContext, work: () => T): T {
    return this.scope.run(span, work);
  }

  startSpan(
    name: string,
    { parent = this.active(), envelope, kind = 'internal' }: StartSpanOptions = {},
  ): Span {
    const traceId = parent?.traceId ?? (envelope ? wireTraceId(envelope.traceId) : randomId(16));
    const spanId = randomId(8);
    const flags = parent?.flags ?? 1;
    const identity = envelope ?? (parent && this.envelopes.get(parent));
    const started = this.now();
    let ended = false;

    const span: Span = {
      traceId,
      spanId,
      flags,
      end: (status = 'unset', attributes = {}) => {
        if (ended) return;
        ended = true;
        if (!this.exporter || !(flags & 1)) return;
        const stopped = this.now();
        try {
          const fields: Attributes = {};
          for (const [key, value] of Object.entries(attributes)) {
            if (
              !/^(?:http\.(?:request\.method|response\.status_code|route)|error\.type|request\.id|tool\.outcome)$/.test(
                key,
              )
            )
              continue;
            fields[key] = typeof value === 'string' ? redactText(value) : value;
          }
          if (identity) {
            fields['tenant.id'] = redactText(identity.tenantId);
            fields['actor.id'] = redactText(identity.actor.id);
            fields['actor.kind'] = identity.actor.kind;
            fields['call.trace_id'] = validTraceId(identity.traceId)
              ? identity.traceId
              : redactText(identity.traceId);
            fields['correlation.id'] = redactText(identity.correlationId);
          }
          const pending = this.exporter.export({
            name: redactText(name),
            traceId,
            spanId,
            parentSpanId: parent?.spanId,
            kind,
            flags,
            status,
            attributes: fields,
            startTimeUnixNano: started.toString(),
            endTimeUnixNano: (stopped < started ? started : stopped).toString(),
          });
          void Promise.resolve(pending).catch(() => {});
        } catch {
          // An unavailable exporter cannot fail a business action.
        }
      },
    };
    if (identity) this.envelopes.set(span, identity);
    return span;
  }
}
