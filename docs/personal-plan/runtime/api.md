# Automation runtime API

The standalone fixture server mounts these routes under `/automation`. It uses Rivetquay fixture identities, deterministic native and BYO LLM routes, and simulated delivery by default. The main API can mount the same Fastify plugin with a verified identity resolver, a gateway, an approval signer and a runtime authorization callback. Use the same authenticated session on requests and SSE connections.

```powershell
node apps/api/src/automation/demo.ts
```

## Bots

| Method | Path                       | Request and response                                                                                                  |
| ------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| GET    | `/bots`                    | Lists registered bot versions, allowlisted tools, and action and active-time budgets.                                 |
| POST   | `/bots/runs`               | Accepts `botId`, `version`, `sessionId`, `prompt`, and `route` (native or byo). Returns the queued run with HTTP 202. |
| GET    | `/bots/runs/:runId`        | Returns the current run view for the requester.                                                                       |
| GET    | `/bots/runs/:runId/events` | Streams `text/event-stream`. Supply `Last-Event-ID` to receive later events only.                                     |
| POST   | `/bots/runs/:runId/resume` | Accepts `{ "approvalId": "..." }` from the designated approver. Returns the updated run.                              |
| POST   | `/bots/runs/:runId/cancel` | Requests cancellation and returns the run after any in-flight gateway call settles.                                   |

Start `fixture-chat` version 1 with an example body.

```json
{
  "botId": "fixture-chat",
  "version": 1,
  "sessionId": "fixture-session",
  "prompt": "Draft PO for pr-001",
  "route": "native"
}
```

A run has `id`, `botId`, `version`, `status`, `result`, and `pending`. The pending object carries the gateway approval and review material when available. Status moves from `queued` and `running` to `pending_approval` or a terminal state of `completed`, `denied`, `failed`, `unknown`, or `cancelled`. Send an `Idempotency-Key` to deduplicate start retries for the same requester. Reusing it with different input produces HTTP 409.

The event stream sends monotonically increasing sequence IDs and event kinds `started`, `step_started`, `step_settled`, `approval_required`, `resumed`, `settled`, and `cancelled`. Each event includes `runId`. Step events include a step ID and either a tool or a result state. Read the run view for review material and results. The stream closes at an approval or terminal state. Save the last event ID, pause reconnection while awaiting a decision, and reconnect after resume or cancellation. Once sent to the gateway, a call can still complete. The runtime blocks subsequent dispatch after cancellation.

## Workflows

| Method | Path                             | Request and response                                                                                                                                   |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/workflows/definitions`         | Lists published definitions for the workspace, including built-in `win-back-v1`.                                                                       |
| POST   | `/workflows/definitions`         | Publishes `{ id, version, nodes }`. Returns HTTP 201. A published version is immutable.                                                                |
| POST   | `/workflows/preview`             | Accepts a workflow target and returns the ordered plan of node IDs, kinds, delay durations and resolved action inputs. It performs zero gateway calls. |
| POST   | `/workflows/runs`                | Accepts a workflow target. Returns HTTP 202 and the current run view.                                                                                  |
| GET    | `/workflows/runs`                | Lists the requester's runs, newest first.                                                                                                              |
| GET    | `/workflows/runs/:runId/history` | Returns the run view and ordered history.                                                                                                              |
| GET    | `/workflows/dead-letters`        | Lists the requester's currently failed or unknown runs.                                                                                                |
| POST   | `/workflows/runs/:runId/replay`  | Replays the failed step of an eligible run. Returns HTTP 202.                                                                                          |
| GET    | `/approvals`                     | Lists approvals assigned to the current approver.                                                                                                      |
| POST   | `/approvals/approve`             | Accepts `{ approvalId }`. The gateway signs and the runner resumes the associated workflow.                                                            |

Preview or start the built-in workflow with this target.

```json
{
  "definitionId": "win-back-v1",
  "version": 1,
  "input": { "trigger": { "kind": "manual" }, "values": {} }
}
```

A workflow run exposes `id`, `definitionId`, `version`, `status`, `nodeId`, `dueAt` in epoch milliseconds, `approval`, `result`, and `replayable`. Its history contains ID, time, kind, node ID, and transition details. Use `dueAt` to time polling during delays and retries. Runs can be `running`, `delayed`, `retrying`, `pending_approval`, `completed`, `denied`, `failed`, or `unknown`.

### Definition shape

Nodes have unique IDs, form one reachable acyclic graph, and start with a trigger. The catalog accepts up to 40 nodes. Use scalar literals or `{ "ref": "field" }` to reference flat run values. Mapping entries resolve against the values before that node. Conditions compare both type and value.

| Kind        | Configuration                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger`   | `trigger` is `manual`, `schedule`, or `event`. Supply `name` for schedule or event and a `next` node ID.                                                                                                       |
| `condition` | `left`, `equals` (scalar), `next` when equal, and `otherwise` (node ID or null) when different.                                                                                                                |
| `mapping`   | `values`, a field-to-value map, and `next`.                                                                                                                                                                    |
| `delay`     | `milliseconds` (1 ms to 7 days) and `next`.                                                                                                                                                                    |
| `approval`  | `next` points directly to the dispatch action and is that action's sole incoming edge.                                                                                                                         |
| `action`    | `action` is `{ tool: "order.read", orderId }` or `{ tool: "workflow.template.run", templateId: "win-back-v1" }`. Optional `next`, `maxAttempts` (default 3, max 5), and `backoffMs` (default 1000, max 60000). |

A schedule or event receipt has `kind`, the published `name`, and a stable `key`. The run endpoint accepts these receipts from callers with trigger permission. A scheduler or event source supplies receipts. The local runner handles delays and retries within an accepted run. Manual launches optionally send an `Idempotency-Key`; schedule and event receipts deduplicate on workspace, definition, trigger, and receipt key. A launch pins the explicit published version.

The preview plan shows the executable path. The milestone-1 compatibility endpoint `POST /workflows/win-back-v1` with `{ "mode": "preview" }` provides the existing gateway review copy of the fixture audience and returns zero receipts. That compatibility read uses gateway metering. At execution the gateway rechecks permission, suppression, source material, and approval. The local runner caps each tenant at 16 active runs and 128 action attempts per minute. It uses exponential backoff for known retryable failures. A replay retains the run, version, cursor, and gateway idempotency key. Unknown outcomes require reconciliation.

## Authorization and errors

The plugin derives tenant and actor from the identity resolver. The requester owns run reads, SSE, cancellation, and replay. The designated separate approver owns approval decisions. Cross-tenant or foreign actor run lookups use the same HTTP 404 as missing runs. The optional authorization callback receives `bot`, `workflow`, `publish`, or `trigger` and is consulted again on the runtime's gateway dispatch. Supply current permission checks in integration. The gateway remains responsible for record access, entitlements, suppression and approval material.

Runtime command errors return `{ code }` with HTTP 400 for invalid input, 403 for forbidden, 404 for missing, 409 for conflicts, 429 for quotas, or 503 for a worker command failure. Fastify schema violations use its standard HTTP 400 validation body. A settled run can include a governed tool failure in its `result`.

## Worker boundaries

`BotStore` separates journal and lease operations from the tenant-specific LangGraph saver. The restart test recreates the LangGraph runtime against the retained checkpoint and journal, and checks the exact tool dispatches before and after approval. The default store lives in memory. A Postgres implementation should supply a tenant-bound saver and run journal with a per-run lease held across checkpoint recovery and dispatch. Gateway calls carry a stable key, and a journaled call without a known outcome stops for reconciliation.

`WorkflowRunner` separates the commands and deterministic node transitions from the local runner and the API timers. A durable Temporal implementation can schedule against the same versioned node catalog and send effects through gateway activities. The fixture server keeps workflow runs and timers, bot journals, and the API event relay in process memory. A process stop drops that fixture state.
