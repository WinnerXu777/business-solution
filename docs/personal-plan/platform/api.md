# Platform API

These routes extend the authenticated [platform OpenAPI document](../../../apps/api/src/platform/openapi.json). The server derives the tenant and actor from the verified bearer identity. Every response sets `Cache-Control: no-store`. Cross-tenant and missing resource lookups return the same 404.

## Login and session lifecycle

| Method and path under `/platform/v1`           | Behavior                                                                                                                                                                                                                                                                                |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /auth/login?tenantId={id}`                | Returns `{authorizeUrl}` and sets a five-minute Secure, HttpOnly, SameSite=Lax cookie. The browser follows the returned URL. Pass `stepUp=true` to request fresh MFA.                                                                                                                   |
| `GET /auth/callback?code={code}&state={state}` | Exchanges the code using S256 PKCE. The browser correlation cookie is required. Returns `status: "authenticated"` with session tokens for an existing membership, or `status: "enrollment_required"` with a five-minute `enrollmentToken` for a verified email in the requested tenant. |
| `POST /auth/refresh`                           | Accepts `{refreshToken}`, rotates it, and returns a new access token. An invalid, expired, or superseded refresh token returns 403.                                                                                                                                                     |
| `POST /auth/logout`                            | Accepts `{refreshToken}` and revokes the session family. The response includes `logoutUrl` when discovery advertises an issuer logout endpoint. The browser can visit that URL to request issuer logout.                                                                                |

Session responses include `accessToken`, `refreshToken`, `expiresAt`, and `refreshExpiresAt`. Send access tokens as bearer credentials. Access tokens last five minutes. Refresh tokens have an absolute eight-hour lifetime. A role change, membership removal, or tenant suspension invalidates both. Resuming a tenant requires a new login. Logout revokes every access token in that session family.

## Membership and tenant lifecycle

| Method and path under `/platform/v1` | Behavior                                                                                                                                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /members`                       | Returns memberships for the verified tenant. Member IDs are stable actor IDs, and the version changes when the assigned role changes.                                                          |
| `POST /invites`                      | Requires member management. Accepts `{email, roleId}` and returns 201 with a one-time token and its 24-hour expiry.                                                                            |
| `POST /invites/{token}/accept`       | Accepts `{enrollmentToken}` from callback. Redeems a matching tenant invitation and returns session tokens. The ID token's verified email must match the invitation.                           |
| `PATCH /members/{id}/role`           | Requires member management. Accepts `{roleId}` and returns the updated membership.                                                                                                             |
| `DELETE /members/{id}`               | Requires member management. Removes the membership and returns 204.                                                                                                                            |
| `GET /roles`                         | Lists built-in and custom roles with their named permissions.                                                                                                                                  |
| `POST /roles`                        | Requires role management. Accepts `{id, name, permissions}` and returns the tenant-local custom role with status 201.                                                                          |
| `POST /tenants`                      | Platform operator only. Accepts `{name, region, plan, adminEmail}` and returns 201 with `{tenant, adminInvite}`. The region is `ca-central-1`, and the plan uses the billing plan input shape. |
| `POST /tenants/{id}/suspend`         | Platform operator only. Suspends tenant access and returns the updated tenant.                                                                                                                 |
| `POST /tenants/{id}/resume`          | Platform operator only. Restores tenant access and returns the updated tenant.                                                                                                                 |

Reader, operator, approver, and admin roles can read platform, record, member, and role information. Operator can request actions, approver can decide designated approvals, and admin manages members, roles, platform settings, and export requests. A requester cannot approve their own request, including with a custom role that grants both permissions. Custom administrative roles can delegate permissions they already hold. Only a built-in admin can assign the built-in admin role, and an active tenant must retain its last built-in admin.

Protected administrative writes and tenant lifecycle writes require MFA within ten minutes by default. The relying party recognizes a signed `amr` containing `mfa` or an explicitly configured `acr` value, along with `auth_time`. A step-up request requires the provider to authenticate again. Refresh preserves the original MFA time. Hosts can set `requireStepUp: false` for synthetic deployments.

Provisioning selects native bindings in Canada Central. Records start enabled, and selected plan add-ons enable corresponding procurement, collections, workflows, insights, and AI modules. Enabled modules start with a fixture allowance of 40 actions per UTC month. The trusted `directory.requestExport(identity)` operation records a tenant-scoped request, which `directory.exportRequests(identity)` can list.

`GET /approvals` may include `materialPreview`. For purchase order drafts it exposes the internal requisition and vendor IDs, currency, and line count from the bound draft. Other approval types omit the preview until their governed material is available as an allowlisted projection.

## Host wiring

Create one `PlatformAuth` using the platform services' directory, the OIDC configuration, and a host-managed signing key of at least 32 bytes. Register `platformRoutes` with `{services, auth}`. Pass `createPlatformSessionIdentityVerifier(auth)` to the governed REST/MCP routes and use `services.gateway` there to apply current platform permissions. A fixture-only registration can still use `{services, verifyIdentity}` with the fixture verifier.

Configure the Dex issuer, client ID, optionally its client secret, and the exact callback URI. The injected HTTP client supplies decoded JSON for discovery, token exchange, and JWKS. Configure it with bounded timeouts and disable redirects. Discovery endpoints are restricted to the issuer origin. ID tokens use RS256. For an existing synthetic user, call `directory.linkUser(actorId, issuer, subject)` at startup. Set `platformOperators` to vetted issuer and subject pairs with a membership in an active tenant.

Identity and lifecycle state are process-local in this milestone. Restarting clears grants created at runtime, invitations, export requests, and sessions. The host should omit authorization headers, cookies, token request and response bodies, callback query strings, and invitation path tokens from request logs. The governance gateway still uses fixture grants and records. Dynamic tenant tool execution requires the governance integration.

## Billing and credentials

| Method and path under `/platform/v1`   | Behavior                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /billing/plan`                    | Returns the current subscription revision, recurring monthly price, UTC window and each meter's included, used and overage quantities.                                |
| `GET /billing/skus`                    | Lists the CAD catalog, monthly prices and meter definitions.                                                                                                          |
| `POST /billing/plan`                   | Admin only. Replaces the add-on set via `{"addOns":["erp"],"overageLimitCents":0}`. Platform is always included. Omit the optional limit to retain the current limit. |
| `GET /billing/invoices`                | Returns `items` (draft and finalized invoices, newest window first) and `creditNotes`.                                                                                |
| `GET /billing/invoices/{id}`           | Returns the draft or finalized snapshot for the tenant-scoped invoice ID.                                                                                             |
| `POST /billing/invoices/{id}/finalize` | Admin only. Finalizes a closed billing window. Subsequent calls return the saved invoice and simulated settlement reference. An open window returns 403.              |
| `GET /credentials`                     | Returns active `{"ref":"vault://…"}` entries for the tenant.                                                                                                          |
| `POST /credentials`                    | Admin only. Accepts `capability`, `providerId` and a write-only `secret`. Returns 201 with `{"ref":"vault://…"}`.                                                     |
| `POST /credentials/{ref}/rotate`       | Admin only. Accepts a replacement `secret` and returns the same reference.                                                                                            |
| `DELETE /credentials/{ref}`            | Admin only. Revokes the reference and returns 204. A repeat revoke of the same tenant's reference also returns 204.                                                   |

Encode credential path parameters with `encodeURIComponent(ref)` so the complete reference occupies one segment. Set the binding's `credentialRef` through the existing capability endpoint. The vault verifies the reference belongs to the same tenant, capability and provider. The binding response continues to omit credential refs. Credential request bodies should stay out of host request logging.

## Billing rules

- Demo tenants begin with Platform in the UTC calendar month containing the fixture epoch. Add-on changes apply immediately. Each SKU's active milliseconds are summed before its subscription cents and included units are rounded half up. Prorated allowances remain visible for removed SKUs until the window closes. The recurring monthly price reflects the current plan.
- Outcome usage is recorded once per tenant, SKU, outcome ID and unit. Usage for an unsubscribed SKU is rejected by the core ingestion seam. CRM snapshots use a monthly peak. Forecasting uses the largest Monday-based weekly total of series observed within the invoice window. Voice seconds are summed before any display conversion.
- Provider attempts are separately deduplicated by tenant, SKU, provider, attempt and unit. Premium pass-through uses reconciled CAD vendor cost. An explicitly configured uplift uses CAD cents per unit. BYO is informational by default for the fixture route and the customer's vendor charge stays outside their platform invoice. Each configured rate requires its version. Quoted prices are resolved and persisted at ingestion.
- Native overages default to zero. When a server-side SKU/unit rate and an admin ceiling are both configured, the closing plan's ceiling authorizes cumulative overages for that window. Only whole units within the pre-tax ceiling become charges. Provider attempts use separate quoted rates. Dispatch reservations, alerts and hard stops belong to the gateway.
- Drafts include events received before finalization. An exact replay remains idempotent after close, while new events for a finalized window are rejected. Corrections use the trusted `billing.credit(context, invoiceId, reasonRef)` function. It issues one full credit per invoice, reversing the finalized lines and tax while retaining the original invoice. Credits have no mutation route in v1.
- Amounts are integer CAD cents. The default jurisdiction is Ontario with 13% HST rounded half up on the invoice subtotal. Hosts can pass a tax table and tenant-to-region function. Finalization stores the tax and fake settlement with the invoice.

## Gateway and persistence handoff

Import the platform factory from `packages/core/src/platform/index.ts`. Keep one service instance in the app host. The platform routes take that instance and the existing identity verifier. The platform service exposes these in-process seams to trusted gateway and adapter code.

- `resolveBinding(tenantId, capability, {operation, dataClasses, region?, features?})` pins the current binding version and rechecks data classes, region and required features against the fixture provider profiles. Pass the verified tenant and actual call classification. With two arguments the resolver uses the capability's tenant-scoped classification and supplies no fallback. The optional fallback is a configured same-region native provider for a retryable read or inference failure. The gateway owns call budgets and decides whether to use it. The fixture region profiles are development assumptions.
- `credentialAccessor(evidence, async (secret) => ...)` supplies a buffer to the selected adapter callback after committing the redacted access audit. Each use rechecks the current credential, so rotation updates the same reference and revocation stops subsequent uses. Finish secret-dependent work in the callback and avoid copying the buffer into logs or results. A request already holding a buffer can finish. Set `BS_PLATFORM_VAULT_MASTER_KEY` to a canonical base64-encoded 32-byte local key or inject a fixture key in tests. The vault uses a wrapped, random key per tenant. Losing the master key makes existing credentials unreadable.
- `billing.recordUsage(context, event)` accepts a typed SKU outcome or premium/BYO provider attempt with IDs, units, quantity, time and the applicable price version. The fixture facade maps evidenced outcomes from its existing gateway counters. The fixture outcome and billing writes have separate transaction boundaries. When Lane A wires durable usage ingestion, pass `fixtureUsageBridge: false` and feed the ledger from the committed gateway outcomes and dispatch attempts. Reserve hard caps before dispatch.
- Pass the API-owned `platformPostgres(pool)` adapter as `persistence` when creating services. Apply [platform state migration 004](../../../infra/migrations/004_platform_state.sql) and tenant isolation migration 007 first. See [platform persistence](persistence.md) for role setup, transaction behavior, and the bootstrap changes.

## Consent and outbound checks

| Method and path under `/platform/v1` | Behavior |
| --- | --- |
| `GET /consents` | Lists the current tenant's consent ledger, including expired and withdrawn grants. |
| `POST /consents` | Accepts `contactId`, `channel`, `purpose`, `basis`, `source`, `evidenceRef`, and optional `expiresAt`. Implied consent requires a future expiry. Returns 201 with the unsubscribe token once. |
| `POST /consents/{id}/withdraw` | Revokes the grant and any prior grants for the same contact, destination, channel, and purpose. A repeat returns the existing withdrawal. |
| `POST /consents/unsubscribe` | Public token redemption. Accepts `tenantId`, `consentId`, and `token` in the body. A valid token withdraws the grant and suppresses its destination and channel for the tenant across purposes. Well-formed submissions always receive 204. |
| `GET /suppressions` | Lists the tenant suppression ledger. Platform operators can select `?scope=platform`. |
| `POST /suppressions` | Accepts `channel`, `destination`, and `reason` of `opt_out`, `do_not_contact`, or `policy`. Returns 201 with the existing or new entry. Platform operators can select `?scope=platform`. |
| `POST /contact-check` | Accepts `contactId`, `channel`, and `purpose`. Returns the current `allow` decision and `reasons`, plus the matching `consentId` on allowance. |

The protected compliance routes require `settings.manage` and step-up when enabled. Platform suppression access requires a platform operator session and step-up when enabled. Notification routes require `platform.read` and a person identity.

The fixture contacts use Toronto time and the synthetic voice number `+14165550107` is on the fixture DNCL. The contact source supplies recipient IANA time zone, verified destination, outreach flag, completeness of history, and optionally a cadence key to group multiple contacts under one debtor. Email destinations are case-normalized and phone destinations use E.164. Platform suppression takes precedence over tenant suppression, followed by the fixture DNCL for voice. Consent binds the current destination, channel, and purpose. A later grant must have a timestamp after the last withdrawal for its scope. A suppression continues to block even after a fresh grant.

`services.contacts.canContact(tenantId, contactId, channel, purpose, at)` is read-only. Call `reserveContact` at effect dispatch with the stable action ID and actual recipient to recheck and reserve a slot atomically with the tenant attempt ledger. The guarded message adapter applies that check to each approved send, including each message in a workflow. `fixtureMessages` enables it on the locally constructed gateway. An injected gateway must guard its own effect adapters with `guardMessageAdapter` and supply the governed purpose. Log staff attempts with `logManualContact`. Reservations count through uncertain or failed attempts. The host must cancel or recheck any separately queued effects and coordinate with the carrier for active calls.

**TODO-verify** with counsel before real outreach. The demo uses a weekday 09:00–17:00 recipient-local window, optional blocked local dates, and three attempts across channels and purposes per tenant/cadence key in a rolling seven days. Express consent is required for fixture voice and collections SMS. Verify holidays, CASL basis and expiry rules, appropriate scopes and consent text, the applicable DNCL and ADAD obligations, collection rules, sender disclosure, token delivery and abuse controls, and routing for ineligible debtor classes. The local guard runs alongside approval and balance checks. It provides no legal eligibility determination.

## Privacy and retention

| Method and path under `/platform/v1` | Behavior |
| --- | --- |
| `GET /privacy-requests` | Lists requests and status history for the current tenant. |
| `POST /privacy-requests` | Accepts `subjectId` and `kind` of `access`, `export`, or `deletion`. Returns 201 with a due date and `pending_verification` status. |
| `POST /privacy-requests/{id}/verify` | Verifies a `proofRef` via the injected tenant, subject, and request-scoped verifier. The reference stays out of request history. |
| `POST /privacy-requests/{id}/complete` | After verification, returns the request and an access/export bundle when applicable. Deletion blocked by holds, minimum retention, or unclassified fields returns `retention_blocked` with reasons and can be retried. |
| `GET /retention/policies` | Lists the tenant's effective durations for public, internal, personal, sensitive, and financial data. |
| `POST /retention/dry-run` | Accepts optional `asOf`. Reports tenant record references, their scheduled purge times, hold IDs, and eligibility. It leaves source records untouched. |

Inject `privacy: {records, verifyIdentity}` with a synthetic record source. A missing injection makes proof verification and source operations unavailable. The source must scope records to the tenant and handle safe deletion for an identified subject, checking record versions atomically. It must return the original count for a successfully committed deletion operation ID on retry. The core also filters returned rows by tenant and subject. Deletion defers the whole request when any scoped record is blocked. Evidence and holds are managed by trusted code through `addHold` and `releaseHold`. A hold can apply to a subject or an entire tenant and matches both record and field classes. Use a source that accounts for joint records before returning subject-scoped deletion candidates.

Bundles are JSON with record IDs, types, versions, classes, and source fields. A repeat completion of a verified export rebuilds it from the current source. The core keeps workflow state and audit IDs and does not persist bundle contents. The field registry classifies contact, consent, invoice, audit, and platform log fields. It masks personal, sensitive, financial, and unknown fields in log projections. Purge scheduling uses the longest applicable duration among record and field classes. Unclassified shapes block deletion and are flagged in dry runs.

**TODO-verify** the demo's 30-calendar-day request deadline, proof and disclosure procedures, purge ages of 365/365/180/30/2,192 days respectively, and the 2,192-day financial minimum. Confirm the proper tax-record clock and hold release criteria, privacy timelines and exemptions, recipient delivery, processor and backup propagation, and any additional regulated classes.

## Events, webhooks, and notifications

| Method and path under `/platform/v1` | Behavior |
| --- | --- |
| `GET /webhooks` | Lists tenant subscriptions and their event filters. |
| `POST /webhooks` | Accepts a synthetic HTTPS `.example` `url` and nonempty `events` array. Returns 201 with the signing secret once. |
| `POST /webhooks/{id}/test` | Queues a `webhook.test` event for that subscription and returns 202. |
| `GET /webhooks/{id}/deliveries` | Lists deliveries with attempt history, status codes, retry times, and replay links. |
| `POST /webhooks/deliveries/{id}/replay` | Queues a new delivery from a dead letter and returns 202. A repeat returns that replay. |
| `GET /notifications` | Lists events addressed to the authenticated user in the current tenant and their read timestamps. |
| `POST /notifications/{id}/read` | Marks that user's notification as read and preserves the timestamp on retry. |

`services.events.publish(tenantId, event, notifyUserIds)` takes a stable producer event ID, timestamp, event type, and typed ID-only metadata. Event types are `record.changed`, `approval.requested`, `approval.decided`, `workflow.run.settled`, `invoice.finalized`, and `consent.withdrawn`. The fixture gateway emits events for approval requests and decisions, PO creation, and successful simulated workflow settlement. Billing finalization and ledger withdrawal enqueue in the same platform persistence transaction as their source change. Other producers can publish through the typed seam or call `appendInTransaction` inside an existing platform transaction. Pass only users authorized for that event. Exact event replays retain the original fanout and notification state.

The host supplies a fake `webhookTransport` and ticks `services.events.deliverDue(tenantId)` for each active demo tenant. The service leaves deliveries queued if no transport is configured. A configured platform master key derives one secret per tenant and subscription. Treat it as a stable key for the lifetime of current subscriptions. Each attempt signs the UTF-8 string formed by joining the Unix timestamp in seconds, delivery ID, and exact JSON body with dots. Verify `x-platform-signature` as `v1=` plus the lowercase hex HMAC-SHA256, using `x-platform-timestamp` and `x-platform-delivery` and a constant-time comparison. Receivers should bound signature freshness and dedupe the stable event ID. Delivery retries reuse the delivery ID. Replays get a new delivery ID and retain the event ID.

A 2xx response settles a delivery. Other responses, transport failures, and expired delivery claims can retry after 30 seconds and two minutes, up to three attempts per delivery. The worker uses a 30-second claim and a 10-second transport deadline. An interrupted send may be delivered twice. The attempt ledger retains status data and omits provider response bodies.

## Remaining host integration

- Register the existing platform plugin with the host's verified identity, and inject the demo privacy adapters and fake webhook transport. Schedule the worker tick. An injected application gateway needs the per-effect guard. Keep unsubscribe bodies, webhook secrets, privacy proofs, export bundles, and evidence out of request and response logs.
- For durable operation, connect the existing platform persistence adapter and migration. The memory implementation is process-local. Platform suppression and the final external call have a timing boundary. A distributed host needs an authoritative shared suppression check at each dispatch, coordinated cancellation, and tests for that race. The fixture gateway bridge publishes after its underlying write and has a separate transaction boundary. General governed record writes and all workflow terminal outcomes need publication from their transactional outboxes.
- The synthetic scope has no network transport, live DNCL lookups, or automatic data purge. Before broadening it, specify webhook egress and rotation controls, pagination and expiry for event/outbox history, and durable privacy source and hold reconciliation.
