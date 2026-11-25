import type { SpanData, SpanExporter } from './tracing.ts';

export class MemorySpanExporter implements SpanExporter {
  readonly spans: SpanData[] = [];

  export(span: SpanData): void {
    this.spans.push(span);
  }
}

export class ConsoleSpanExporter implements SpanExporter {
  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void = console.log) {
    this.write = write;
  }

  export(span: SpanData): void {
    this.write(JSON.stringify(span));
  }
}

export interface OtlpHttpClient {
  post(
    url: string,
    request: { headers: Record<string, string>; body: string },
  ): Promise<{ status: number }>;
}

export class OtlpJsonSpanExporter implements SpanExporter {
  private readonly client: OtlpHttpClient;
  private readonly url: string;
  private readonly serviceName: string;

  constructor(client: OtlpHttpClient, url: string, serviceName = 'rivetquay-api') {
    this.client = client;
    this.url = url;
    this.serviceName = serviceName;
  }

  async export(span: SpanData): Promise<void> {
    const attributes = Object.entries(span.attributes).map(([key, value]) => ({
      key,
      value:
        typeof value === 'string'
          ? { stringValue: value }
          : typeof value === 'boolean'
            ? { boolValue: value }
            : Number.isInteger(value)
              ? { intValue: String(value) }
              : { doubleValue: value },
    }));
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: this.serviceName } }],
          },
          scopeSpans: [
            {
              scope: { name: 'rivetquay.observability' },
              spans: [
                {
                  traceId: span.traceId,
                  spanId: span.spanId,
                  parentSpanId: span.parentSpanId,
                  flags: span.flags,
                  name: span.name,
                  kind: span.kind === 'server' ? 2 : 1,
                  startTimeUnixNano: span.startTimeUnixNano,
                  endTimeUnixNano: span.endTimeUnixNano,
                  attributes,
                  status: { code: { unset: 0, ok: 1, error: 2 }[span.status] },
                },
              ],
            },
          ],
        },
      ],
    });
    const response = await this.client.post(this.url, {
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (response.status < 200 || response.status >= 300) throw new Error('OTLP export failed');
  }
}
