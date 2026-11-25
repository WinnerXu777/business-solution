import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  formatTraceparent,
  JsonLogger,
  MetricsRegistry,
  parseTraceparent,
  SloMonitor,
  Tracer,
  type Span,
} from '../../../../packages/core/src/observability/index.ts';
import { checkReadiness, type ReadinessChecks } from './readiness.ts';

export interface OpsOptions {
  checks: ReadinessChecks;
  readinessTimeoutMs?: number;
  authorize?: (request: FastifyRequest) => boolean | Promise<boolean>;
  tracer?: Tracer;
  logger?: JsonLogger;
  metrics?: MetricsRegistry;
  slos?: SloMonitor;
  now?: () => number;
}

function surfaceOf(route: string): string {
  if (route.startsWith('/v1/')) return 'rest';
  if (route === '/mcp') return 'mcp';
  if (route.startsWith('/platform/')) return 'platform';
  if (route.startsWith('/automation/')) return 'automation';
  return 'other';
}

function failureStatus(error: unknown, fallback = 500): number {
  const code =
    error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : fallback;
  return typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599
    ? code
    : fallback;
}

const knownMethods = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
const latencyBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export function installOps(app: FastifyInstance, options: OpsOptions): void {
  const {
    checks,
    readinessTimeoutMs,
    authorize,
    tracer = new Tracer(),
    logger = new JsonLogger(),
    metrics = new MetricsRegistry(),
    slos = new SloMonitor(),
    now = () => performance.now(),
  } = options;
  const latency = metrics.histogram(
    'http_request_duration_seconds',
    'API request duration in seconds',
    latencyBuckets,
    ['method', 'route'],
  );
  const requests = metrics.counter('http_requests_total', 'Completed HTTP requests', [
    'method',
    'route',
    'status',
  ]);
  const errors = metrics.counter('http_request_errors_total', 'HTTP request exceptions', [
    'method',
    'route',
  ]);
  const inflight = metrics.gauge('http_requests_in_flight', 'Active HTTP requests');
  inflight.set(0);

  const active = new WeakMap<FastifyRequest, { id: string; span: Span; started: number }>();
  const routeLabels = (request: FastifyRequest) => ({
    method: knownMethods.has(request.method) ? request.method : 'OTHER',
    route: request.is404 ? 'unmatched' : (request.routeOptions.url ?? 'unmatched'),
  });

  app.addHook('onRequest', (request, reply, done) => {
    const traceparent = request.headers.traceparent;
    const parent = parseTraceparent(typeof traceparent === 'string' ? traceparent : undefined);
    const labels = routeLabels(request);
    const span = tracer.startSpan(labels.method + ' ' + labels.route, {
      parent: parent ?? null,
      kind: 'server',
    });
    const id = randomUUID();
    active.set(request, { id, span, started: now() });
    inflight.add(1);
    reply.header('x-request-id', id).header('traceparent', formatTraceparent(span));
    tracer.run(span, done);
  });

  function finish(request: FastifyRequest, status: number): void {
    const state = active.get(request);
    if (!state) return;
    active.delete(request);
    inflight.add(-1);
    const labels = routeLabels(request);
    const seconds = Math.max(0, now() - state.started) / 1000;
    latency.observe(seconds, labels);
    requests.inc({ ...labels, status: String(status) });
    if (status !== 499) slos.record(surfaceOf(labels.route), status, seconds);
    state.span.end(status >= 500 ? 'error' : 'unset', {
      'http.request.method': labels.method,
      'http.response.status_code': status,
      'http.route': labels.route,
      'request.id': state.id,
    });
  }

  app.addHook('onResponse', async (request, reply) => finish(request, reply.statusCode));
  app.addHook('onRequestAbort', async (request) => finish(request, 499));
  app.addHook('onTimeout', async (request) => finish(request, 503));

  app.addHook('onError', async (request, reply, error) => {
    const state = active.get(request);
    const labels = routeLabels(request);
    const status = failureStatus(error, reply.statusCode >= 400 ? reply.statusCode : 500);
    errors.inc(labels);
    logger.log(status >= 500 ? 'error' : 'warn', 'HTTP request exception', {
      ...labels,
      status,
      requestId: state?.id,
      traceId: state?.span.traceId,
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = failureStatus(error);
    return reply.code(status).send({
      error: status < 500 ? 'request_rejected' : 'internal_error',
    });
  });

  app.get('/ops/health', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ status: 'ok' }),
  );
  app.get('/ops/ready', async (_request, reply) => {
    const result = await checkReadiness(checks, readinessTimeoutMs);
    return reply
      .header('cache-control', 'no-store')
      .code(result.status === 'ready' ? 200 : 503)
      .send(result);
  });
  app.register(async (ops) => {
    ops.addHook('onRequest', async (request, reply) => {
      reply.header('cache-control', 'no-store');
      let allowed = false;
      try {
        allowed = (await authorize?.(request)) === true;
      } catch {
        // A failed identity lookup must deny access.
      }
      if (!allowed) return reply.code(403).send({ error: 'forbidden' });
    });
    ops.get('/ops/metrics', async (_request, reply) =>
      reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.expose()),
    );
    ops.get('/ops/alerts', async () => ({ alerts: slos.evaluate() }));
  });
}

// Register on the parent instance with installOps when sibling routes need the hooks.
export const opsPlugin: FastifyPluginAsync<OpsOptions> = async (app, options) =>
  installOps(app, options);
