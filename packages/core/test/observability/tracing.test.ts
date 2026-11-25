import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatTraceparent,
  parseTraceparent,
  MemorySpanExporter,
  OtlpJsonSpanExporter,
  Tracer,
} from '../../src/observability/index.ts';

const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
const spanId = '00f067aa0ba902b7';
const header = '00-' + traceId + '-' + spanId + '-a3';

test('traceparent preserves all flag bits and accepts compatible future versions', () => {
  assert.deepEqual(parseTraceparent(header), { traceId, spanId, flags: 163 });
  assert.equal(formatTraceparent(parseTraceparent(header)!), header);
  assert.deepEqual(
    parseTraceparent('01' + header.slice(2) + '-extension'),
    parseTraceparent(header),
  );
  for (const invalid of [
    '',
    header.toUpperCase(),
    header + '-noise',
    header + '\n',
    header + ',' + header,
    'ff' + header.slice(2),
    header.replace(traceId, '0'.repeat(32)),
    header.replace(spanId, '0'.repeat(16)),
  ])
    assert.equal(parseTraceparent(invalid), undefined);
  assert.throws(() => formatTraceparent({ traceId, spanId, flags: 256 }), RangeError);
});

test('verified envelope fields propagate through nested asynchronous spans', async () => {
  const exporter = new MemorySpanExporter();
  let timestamp = 10n;
  const tracer = new Tracer(exporter, () => timestamp++);
  const envelope = {
    tenantId: 'tenant-rivetquay',
    actor: { id: 'actor-reader', kind: 'person' as const },
    traceId: '4bf92f35-77b3-4da6-a3ce-929d0e0e4736',
    correlationId: 'correlation-demo',
  };
  const root = tracer.startSpan('tool.order.read', { envelope });
  await tracer.run(root, async () => {
    await Promise.resolve();
    tracer
      .startSpan('repository.read')
      .end('ok', { 'error.type': 'account@example.test', prompt: 'private' });
  });
  root.end('ok');
  root.end('error');
  assert.equal(tracer.active(), undefined);
  assert.equal(exporter.spans.length, 2);
  const [child, parent] = exporter.spans;
  assert.equal(parent.traceId, traceId);
  assert.equal(child.traceId, traceId);
  assert.equal(child.parentSpanId, parent.spanId);
  assert.deepEqual(child.attributes, {
    'tenant.id': envelope.tenantId,
    'actor.id': envelope.actor.id,
    'actor.kind': envelope.actor.kind,
    'call.trace_id': envelope.traceId,
    'correlation.id': envelope.correlationId,
    'error.type': '[REDACTED]',
  });
  assert.equal(child.startTimeUnixNano, '11');
  assert.equal(parent.endTimeUnixNano, '13');
  tracer.startSpan('unsampled', { parent: { traceId, spanId, flags: 0 } }).end();
  assert.equal(exporter.spans.length, 2);
});

test('OTLP-shaped JSON uses the injected HTTP client and canonical IDs', async () => {
  const memory = new MemorySpanExporter();
  new Tracer(memory)
    .startSpan('fixture', { kind: 'server' })
    .end('error', { 'http.response.status_code': 503 });
  const [span] = memory.spans;
  const exporter = new OtlpJsonSpanExporter(
    {
      async post(url, { headers, body }) {
        assert.equal(url, 'http://127.0.0.1:4318/v1/traces');
        assert.equal(headers['content-type'], 'application/json');
        const [encoded] = JSON.parse(body).resourceSpans[0].scopeSpans[0].spans;
        assert.equal(encoded.traceId, span.traceId);
        assert.equal(encoded.spanId, span.spanId);
        assert.equal(encoded.kind, 2);
        assert.equal(encoded.status.code, 2);
        assert.deepEqual(encoded.attributes, [
          { key: 'http.response.status_code', value: { intValue: '503' } },
        ]);
        return { status: 200 };
      },
    },
    'http://127.0.0.1:4318/v1/traces',
  );
  await exporter.export(span);
});
