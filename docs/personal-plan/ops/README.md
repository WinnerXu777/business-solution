# Milestone 1 operations

The operations routes and their root Fastify hooks are opt-in until the application owner applies the wiring below. All commands target an isolated fixture environment.

| Route              | Purpose                                                                | Access                          |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------- |
| `GET /ops/health`  | Process liveness                                                       | Private network probe           |
| `GET /ops/ready`   | Database, queue and provider checks with a 1 second deadline per check | Private network probe           |
| `GET /ops/metrics` | Prometheus text format 0.0.4                                           | Explicit operator authorization |
| `GET /ops/alerts`  | Current burn-rate evaluations by rule                                  | Explicit operator authorization |

HTTP spans use registered route templates. The server generates a fresh `x-request-id` and forwards W3C trace context through `traceparent`. Verified gateway calls carry the envelope's tenant, actor, original trace ID and correlation ID. When a transport span exists, the child uses that W3C trace ID and keeps the envelope trace ID in `call.trace_id`. Standalone envelope spans normalize UUIDs or hash other legacy trace IDs to 128 bits. Child spans inherit the verified envelope fields. The sampled flag governs export.

Keep payloads, authorization headers and raw exception details out of telemetry. The logger redacts sensitive keys, common credential shapes, email addresses and phone numbers. An unlabeled opaque credential can resemble ordinary text. Call sites should emit only reviewed fields. Errors and warnings bypass the logger's sample rate. Prometheus labels contain method, registered route and status only.

## Objectives and alert interpretation

| Surface                    | Availability | Latency                |
| -------------------------- | ------------ | ---------------------- |
| REST `/v1/*`               | 99.9%        | 95% at or below 500 ms |
| MCP `/mcp`                 | 99.9%        | 95% at or below 500 ms |
| Platform `/platform/*`     | 99.9%        | 95% at or below 500 ms |
| Automation `/automation/*` | 99%          | 95% at or below 5 s    |

Availability uses the fraction of eligible responses with HTTP status below 500. Latency uses elapsed time through response completion, including errors. Unmatched routes, client aborts and operational probes are outside the objectives. Protocol-level failures inside 2xx HTTP responses are visible on gateway spans. The threshold is 4× budget burn over both the last 5 minutes and the last hour, with at least 20 requests in each window. Calculations use 10-second slices. History starts when the process starts and the endpoint evaluates local observations on demand. Multi-replica aggregation and alert delivery require an external monitoring system.

## App bootstrap wiring

Add these imports to `apps/api/src/app.ts`.

```ts
import { ConsoleSpanExporter, Tracer } from '../../../packages/core/src/observability/index.ts';
import { installOps, instrumentGatewayCall } from './ops/index.ts';
```

Immediately after the existing `resolveIdentity` declaration and before any route registrations, add the following block. This mounts hooks on the root Fastify instance so they apply to governance, platform, insights and automation. Fastify's encapsulated error handlers continue to handle their own routes.

```ts
const tracer = new Tracer(new ConsoleSpanExporter());
gateway.call = instrumentGatewayCall(tracer, gateway.call.bind(gateway));

const probePool = pool
  ? new pg.Pool({
      connectionString: env.DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 750,
      query_timeout: 750,
      statement_timeout: 750,
    })
  : undefined;
if (probePool) {
  probePool.on('error', () => app.log.warn('Readiness connection failed'));
  app.addHook('onClose', () => probePool.end());
}

installOps(app, {
  tracer,
  checks: {
    database: async () => {
      if (!probePool) return true;
      await probePool.query('SELECT 1');
      return true;
    },
    queue: async () => {
      if (!probePool) return true;
      const { rows } = await probePool.query<{ ready: boolean }>(
        "SELECT to_regclass('governance.outbox') IS NOT NULL AS ready",
      );
      return rows[0]?.ready === true;
    },
    providers: () => true,
  },
  authorize: async (request) => {
    const identity = await resolveIdentity(request);
    return (
      identity?.tenantId === fixtureAdmin.tenantId &&
      identity.actor.id === fixtureAdmin.actor.id &&
      services.directory.resolve(identity)?.role === 'admin'
    );
  },
});
```

In fixture memory mode database and queue checks represent the in-process implementations. The durable queue probe verifies the outbox table exists. Worker progress belongs in a future heartbeat check. The provider probe represents the in-process fakes. Add a local Mailpit probe if the deployment enables Mailpit and treats it as a readiness dependency. Internal calls made directly on the governed implementation need their own verified gateway seam if they require child spans.

Console export is enough for this demo. A Canadian OpenTelemetry Collector can later receive traces via the injected OTLP HTTP exporter. SDK integration, batch export, timeout and retry handling, dropped-export metrics, scrape credentials, retention and alert delivery are deployment follow-ups.

## Local load

With a fresh fixture API listening on loopback and fixture login enabled, run:

```sh
node tests/load/run.mjs --url http://127.0.0.1:3000 --concurrency 4 --duration 30 --ramp 5
node tests/load/run.mjs --url http://127.0.0.1:3000 --walkthrough
```

Duration, ramp and timeout are in seconds. The ramp is included in duration. In-flight requests can complete after the dispatch deadline. The default mix rotates through reads, chat, fixture voice and previews. These can generate fixture audit, usage and history. The single-pass walkthrough also exercises approvals, simulated delivery and idempotent retries. Use only a disposable demo server with fixture provider bindings. Output includes total and per-step nearest-rank p50, p95 and p99. Any request or walkthrough validation failure sets a nonzero exit status.

## Runbooks

- [Incident response](incident-response.md)
- [Restore drill](restore-drill.md)
- [Key rotation](key-rotation.md)
- [Provider outage](provider-outage.md)
- [Stuck outbox](stuck-outbox.md)
