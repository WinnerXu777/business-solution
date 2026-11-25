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
