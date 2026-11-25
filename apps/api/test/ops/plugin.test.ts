import assert from 'node:assert/strict';
import test from 'node:test';
import { FakeGateway } from '@bs/core';
import Fastify from 'fastify';
import {
  installOps,
  instrumentGatewayCall,
  opsPlugin,
  checkReadiness,
} from '../../src/ops/index.ts';
import {
  JsonLogger,
  MemorySpanExporter,
  Tracer,
} from '../../../../packages/core/src/observability/index.ts';

const ready = { database: () => true, queue: () => true, providers: () => true };

test('readiness aggregates probes in parallel and aborts a slow check', async () => {
  let queueSignal: AbortSignal | undefined;
  const result = await checkReadiness(
    {
      database: async () => true,
      queue: (signal) => {
        queueSignal = signal;
        return new Promise(() => {});
      },
      providers: () => {
        throw new Error('fake provider details');
      },
    },
    10,
  );
  assert.equal(queueSignal?.aborted, true);
  assert.deepEqual(result, {
    status: 'unavailable',
    checks: { database: 'ok', queue: 'unavailable', providers: 'unavailable' },
  });
});

test('registered ops plugin exposes liveness and dependency readiness', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(opsPlugin, { checks: { ...ready, queue: () => false } });
  assert.deepEqual((await app.inject('/ops/health')).json(), { status: 'ok' });
  const readiness = await app.inject('/ops/ready');
  assert.equal(readiness.statusCode, 503);
  assert.equal(readiness.json().checks.queue, 'unavailable');
  assert.equal((await app.inject('/ops/metrics')).statusCode, 403);
  assert.equal((await app.inject('/ops/alerts')).statusCode, 403);
});

test('root instrumentation correlates verified tool spans and hides HTTP internals', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  const logs: string[] = [];
  const exporter = new MemorySpanExporter();
  const tracer = new Tracer(exporter);
  let now = 0;
  installOps(app, {
    checks: ready,
    tracer,
    logger: new JsonLogger({ write: (line) => logs.push(line) }),
    authorize: (request) => request.headers.authorization === 'Bearer fixture-ops',
    now: () => (now += 20),
  });
  const gateway = new FakeGateway();
  const call = instrumentGatewayCall(tracer, gateway.call.bind(gateway));
  app.register(async (api) => {
    api.get('/v1/orders/:id', () =>
      call({
        tool: 'order.read',
        envelope: {
          version: 'v1',
          tenantId: 'tenant-rivetquay',
          actor: { id: 'actor-reader', kind: 'person' },
          traceId: 'call-demo',
          correlationId: 'batch-demo',
          idempotencyKey: 'fake-key',
          source: 'rest',
        },
        input: { orderId: 'ord-001' },
      }),
    );
    api.get('/v1/failure', () => {
      throw new Error('private-value person@example.test');
    });
  });

  const injected = await app.inject({
    url: '/v1/orders/private-value?email=person@example.test',
    headers: {
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'x-request-id': 'untrusted',
    },
  });
  assert.equal(injected.statusCode, 200);
  assert.equal(injected.json().state, 'ok');
  assert.match(String(injected.headers['x-request-id']), /^[0-9a-f-]{36}$/);
  const [tool, server] = exporter.spans;
  assert.equal(tool.parentSpanId, server.spanId);
  assert.equal(tool.traceId, server.traceId);
  assert.equal(server.parentSpanId, '00f067aa0ba902b7');
  assert.equal(tool.attributes['tenant.id'], 'tenant-rivetquay');
  assert.equal(tool.attributes['actor.id'], 'actor-reader');
  assert.equal(tool.attributes['call.trace_id'], 'call-demo');
  assert.equal(tool.attributes['correlation.id'], 'batch-demo');
  assert.equal(tool.status, 'ok');

  const failed = await app.inject('/v1/failure');
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(failed.json(), { error: 'internal_error' });
  assert.equal(logs.length, 1);
  assert.equal(JSON.parse(logs[0]).fields.requestId, failed.headers['x-request-id']);
  await app.inject('/v1/no-match/private-value');
  assert.equal((await app.inject('/ops/ready')).statusCode, 200);
  const headers = { authorization: 'Bearer fixture-ops' };
  const metrics = await app.inject({ url: '/ops/metrics', headers });
  assert.match(String(metrics.headers['content-type']), /text\/plain; version=0.0.4/);
  assert.match(
    metrics.body,
    /http_requests_total\{method="GET",route="\/v1\/orders\/:id",status="200"\} 1/,
  );
  assert.match(metrics.body, /route="unmatched",status="404"/);
  assert.match(metrics.body, /http_request_errors_total\{method="GET",route="\/v1\/failure"\} 1/);
  assert.doesNotMatch(
    JSON.stringify({ spans: exporter.spans, logs, metrics: metrics.body }),
    /private-value|example\.test|fake-key|fixture-ops/,
  );
  const alerts = (await app.inject({ url: '/ops/alerts', headers })).json().alerts;
  assert.equal(
    alerts.find(({ id }: { id: string }) => id === 'rest-availability-burn').short.bad,
    1,
  );
});
