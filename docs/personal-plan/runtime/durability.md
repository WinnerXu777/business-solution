# Runtime and channel durability handoff

The SQL migrations in this directory follow main's migration 005. The integration owner can move
them into the shared migration directory in order. Each table requires a transaction with
`app.tenant_id` set locally. Both `USING` and `WITH CHECK` policies enforce the tenant scope.

The Python worker accepts a `PostgresBotStore` through the `store` parameter of
`workers.bs_worker.chat.stdio.main`. Its injected `RuntimeExecutor` must provide transactional
queries with dictionary rows and JSONB decoding, and tenant/run leases across transactions. A lease
must remain held even when checkpoint queries run on LangGraph threads. The worker host can provide
a module through `registerAutomation`'s `workerModule` option. The default fixture worker uses
memory. The Python environment does not contain psycopg, so this lane supplies the executor
interface and SQL without selecting a driver.

The conversation and connector repository interfaces are synchronous to preserve their existing
callers. Their query executors must return decoded JSONB rows synchronously and commit each query
with the tenant setting. Their asynchronous lease method must provide a session-level, tenant-bound
lock across committed statements and release it on process loss. Separate connections are needed
for the lease and for queries. Hosts must supply their configured tenant IDs for ingress connection
resolution and cross-tenant SLA scans. The LLM counter executor uses async transactions and must set
the same tenant setting. Do not share one database connection between concurrent transactions.

Conversation snapshots include participants, messages, queue assignments, SLA deadlines and SSE
events. A cursor comparison rejects concurrent stale updates. Receipt uniqueness and the
conversation update occur in the same statement. Connector state includes installations, checkpoint
and cached external-ID records, webhook history and write freezes. Provider credentials and webhook
secrets remain in the separately injected stores and must also survive host restarts. Webhook
hydration should be idempotent because an interrupted process can finish hydration before recording
the receipt.

Bot session turns are listed at `GET /bots/sessions/:sessionId/turns`, scoped to tenant and actor.
Completed bot responses produce a journaled `reply_delta` event before `settled`. LLM completion
streams emit a final JSON event with `type: final`, route, bindingVersion and usage immediately
before `[DONE]`. The optional settled-turn callback receives a stable conversation and turn ID.
Voice duration counts bytes consumed from the mono 16 kHz signed 16-bit input and successfully
played PCM output. A transcript-only fixture reports an unknown duration. The callback is
best-effort and its receiver should deduplicate turn IDs. The callback is not an outbox, so a
process loss between settlement and callback can leave an unreported outcome.

Fixed-window LLM reservations count the reserved amount immediately. Live reservations from a
previous window remain charged against the new window until settlement or expiry. Expiry defaults
to the provider timeout plus one minute and leaves the original window charged. A usage sink failure
blocks further reservations for the tenant. Operational reconciliation and clearing that block are
host responsibilities.
