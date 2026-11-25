# Platform UI

Mount the console in a React application with a verified bearer token.

```tsx
import { HttpPlatformClient, PlatformApp } from '@bs/ui';

const client = new HttpPlatformClient({ baseUrl: '', token: fixtureToken });

<PlatformApp client={client} />;
```

The package includes the Operate, Records, Intelligence and Platform routes. Supplying an entry in
`extraRoutes` with a built-in path replaces that screen. Set `navLabel` to show an additional route in
the Platform group. Each injected component receives the scoped client, verified identity,
workspace, current path and notification callback.

Pass `resolveWorkspaceClient(workspace)` when the host can resolve a verified client for another
workspace. The switcher shows workspaces authorized by the current session. Requests use the
returned client's bearer token.

## Preview

Run `pnpm --filter @bs/ui dev` from the repository root and open the local URL printed by Vite. The
preview uses the fictional Rivetquay admin. Refreshing resets fixture state. Tests can share a
`MockAutomationState` and a `MockRecordsState` between operator and approver clients to exercise
separation of duties.

## HTTP integration

The host supplies the same verified bearer identity to the platform API, governance tools, runtime
and connectors. The client calls Lane D's billing and vault routes as specified in its platform API.
The automation client uses the routes in the runtime API. Draft workflow structure previews run
locally. Published structure previews use the runtime planner. When a planned action is win-back
dispatch, the UI also requests message material in compatibility preview mode. That route can meter
a preview read and must return zero delivery receipts.

The current runtime exposes requester-owned bot runs by ID. The console keeps the last 20 run IDs
for the workspace and actor in session storage. The assigned approver uses the reviewed material,
run ID and approval ID from the requester to resume the run. The requester console polls status
while an approval is pending and reconnects to the event stream from its last event ID after the
run changes state.

### Shared API changes requested

Register the following additions in the shared governed tool catalog and gateway. Each is
`POST /v1/tools/<tool>` with the verified v1 call envelope and the named tool and input fields.
Tenant scope comes from that verified identity. Success uses `{ state: 'ok', output }`. Preserve
the gateway's denial and failed result shapes.

| Tool                         | Input                                            | Success output                                                                                                           |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `order.list`                 | `{ customerId?: string }`                        | `Order[]`                                                                                                                |
| `purchase.request.list`      | `{}`                                             | `PurchaseRequest[]`                                                                                                      |
| `purchase.order.drafts.list` | `{}`                                             | `{ draft: PurchaseOrderDraft; approval: Approval }[]`, visible to requester and designated approver                      |
| `purchase.order.list`        | `{}`                                             | `PurchaseOrder[]`                                                                                                        |
| `inventory.list`             | `{}`                                             | `Sku[]`                                                                                                                  |
| `vendor.list`                | `{}`                                             | `Vendor[]`                                                                                                               |
| `customer.list`              | `{}`                                             | `Customer[]`                                                                                                             |
| `contact.list`               | `{ customerId?: string }`                        | `{ id; customerId; name; email; phone }[]`                                                                               |
| `deal.list`                  | `{}`                                             | `{ id; customerId; title; stage; valueCents }[]`, with stages `lead`, `qualified`, `proposal`, `won`, `lost`             |
| `invoice.list`               | `{ customerId: string }`                         | `Invoice[]`                                                                                                              |
| `customer.consent.read`      | `{ customerId: string }`                         | `{ channel; state; evidenceId? }[]`, with channels `email`, `sms`, `voice` and states `allowed`, `suppressed`, `unknown` |
| `fraud.queue`                | `{}`                                             | `{ orderId; decision: null or 'clear' or 'escalate' }[]`                                                                 |
| `fraud.review`               | `{ orderId; decision }`                          | `null` after storing the approver decision                                                                               |
| `profile.review.read`        | `{ customerId: string }`                         | `{ reviewStatus: 'pending' or 'accepted' or 'rejected' }`                                                                |
| `profile.review`             | `{ customerId; decision: 'accept' or 'reject' }` | `null` after storing the approver decision                                                                               |

The UI already consumes governed detail reads, draft and approval mutations, and insight tools.
Until the list and review routes land, the order, purchase request, customer and fraud lookup forms
can open a known ID directly. Forecasts and profile evidence use the existing tools. The mock
provides the full list and review flows.

Mount the runtime plugin under `/automation` and supply verified identity and runtime
authorization. To enable server-wide history for the requester, add `GET /automation/bots/runs`
returning `BotRun[]` newest first. To enable approval review in the approver's bot console, add
`GET /automation/bots/approvals` returning `{ runId; pending }[]` for the designated approver,
including the bound material. Attach bound previews to workflow inbox entries from newly started
runs where the gateway has review material. Preserve the optional redacted `materialPreview` field
when serializing platform approvals.

Mount the connector catalogue, install, OAuth start, status, sync and reconciliation handlers at
`/connectors` with the payloads in `src/clients/administration.ts`. The browser follows the
returned `authorizeUrl`. The mock returns a local hash and keeps the flow offline.

## Session mode and new platform adapters

A host with cookie-based sessions can mount the sign-in and callback flow from the same package.

```tsx
import { AuthenticatedPlatformApp, HttpPlatformClient } from '@bs/ui';

const client = new HttpPlatformClient({});
<AuthenticatedPlatformApp client={client} />;
```

The host serves the UI at the callback destination. The API validates OIDC state, exchanges the
code, manages HttpOnly session cookies and checks CSRF on session-authenticated mutations. The UI
removes callback parameters before exchange, handles session expiry, and refreshes identity after
a successful refresh. On `step_up_required`, it requests a fresh sign-in and lets the user
explicitly resubmit the operation. The existing bearer-token mount remains available.

The access, conversation and key routes below define the local HTTP adapter seam pending lane
integration. Arrays are returned directly. Mutations that return no object can respond with 204.
Read and authorize every request under its verified session. Use `{ code }` for platform denials.

| Method and path under `/platform/v1`                                          | Payload and result                                                                                                                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /auth/login`                                                             | `returnTo`, optional `stepUp=true`. Returns `{ authorizeUrl }`.                                                                                                        |
| `GET /auth/callback`, `POST /auth/refresh`, `POST /auth/logout`               | Callback takes `code` and `state`. Callback and refresh return `{ expiresAt? }`. Logout returns an empty response.                                                     |
| `GET /me`                                                                     | Existing identity with optional verified `platformOperator` flag                                                                                                       |
| `GET /members`, `POST /members/invitations`                                   | Members contain `id`, `name`, `email`, `roleId`. Invite takes `{ email, roleId }` and returns `{ url, expiresAt }` once.                                               |
| `PATCH /members/:id`, `DELETE /members/:id`                                   | Set `{ roleId }` or remove a member                                                                                                                                    |
| `GET /permissions`, `GET /roles`                                              | Permission `{ id, label }`. Role `{ id, name, builtIn, permissions }`.                                                                                                 |
| `POST /roles`, `PATCH /roles/:id`, `DELETE /roles/:id`                        | Save `{ name, permissions }` or delete a custom role                                                                                                                   |
| `GET /tenants/options`, `GET /tenants`, `POST /tenants`, `PATCH /tenants/:id` | Use `TenantOptions`, `Tenant`, `TenantProvision` in `src/clients/access.ts`. Provision uses `Idempotency-Key`. Patch takes `{ status }`.                               |
| `GET /onboarding`                                                             | Return `{ completed: SetupStep[] }` from workspace state                                                                                                               |
| `GET /conversations`, `GET /conversations/:id`                                | Return inbox summaries and details with transcript and optional active run ID, using `src/clients/conversations.ts`                                                    |
| `POST /conversations/:id/handoff`                                             | `{ direction: 'takeover' or 'handback' }`. Returns updated summary. Takeover stops subsequent bot dispatch.                                                            |
| `POST /conversations/:id/messages`                                            | `{ text }` with `Idempotency-Key`. Returns the persisted staff transcript line.                                                                                        |
| `POST /conversations/:id/voice`                                               | Multipart `audio` with `Idempotency-Key`. Streams `VoiceEvent` data frames and closes after `settled`. The browser sends one bounded recording when push-to-talk ends. |
| `GET /llm/keys`, `POST /llm/keys`, `DELETE /llm/keys/:id`                     | List metadata `{ id, name, prefix, createdAt }`, create with `{ name }` and return `{ secret }` once, or revoke by ID                                                  |

Conversation bot messages start a run through the documented `/automation/bots/runs` endpoint
with the conversation ID as `sessionId`. The runtime should persist the requester message and
bot result into that conversation. A `reply_delta` event carries the same `id` and `runId` as other
bot events and includes string `delta`. The UI can still show the final reply from the documented
run view if the runtime sends only lifecycle events. Requesters can share the review IDs with the
designated approver, who can use the assigned-run form in Bots.

The LLM adapter uses `/llm/v1/models`, `/llm/v1/chat/completions` and `/llm/v1/embeddings`.
The playground requests streaming usage and displays the route and binding from
`X-Provider-Route` and `X-Binding-Version` response headers or `provider_route` and
`binding_version` chunk fields. Tool mode only displays proposed calls.
