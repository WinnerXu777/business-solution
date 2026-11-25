# Rivetquay Industrial Supply

Rivetquay is a fictional Toronto industrial supplies distributor. The platform console, Fastify API and LangGraph worker share a governed gateway for business records, approvals, provider routing and usage. The fixture environment uses synthetic records and simulated providers.

## Local development

Use Node.js 24.4.1, pnpm 11.25.0, uv 0.9.11 and Python 3.12. Dependency installation requires registry access.

```sh
corepack enable
pnpm install --frozen-lockfile
uv sync --locked
pnpm dev
```

Open http://127.0.0.1:5173. The local launcher starts both the API and web, provisions the fixture identities, and starts the Python worker on the first automation request. With `DATABASE_URL` unset, state lives in memory and resets when the API restarts. The API health endpoint is http://127.0.0.1:3000/health. Set `API_PORT` to change the API port.

The fixture identity picker includes the Rivetquay admin, operator, approver and reader, plus the Spoolharbour operator. Use the admin for modules or provider bindings, the operator for chat and workflows, and the approver for approval decisions. **Milestone 1 portal** in the sidebar opens the original demo. The Vite server proxies platform, tool and automation requests to the API. Set `VITE_API_PROXY_TARGET` to change the target. `VITE_API_BASE_URL` defaults to the Vite origin and can point at another host that serves the API routes to the browser.

### Local OIDC sign-in

Set `BS_AUTH_MODE=oidc` to use Lane D's session-based sign-in. For the in-memory launcher on PowerShell, start only Dex, then run the usual launcher.

```powershell
docker compose -f infra/compose/compose.yaml --profile oidc up -d dex
$env:BS_AUTH_MODE = 'oidc'
pnpm dev
```

Open http://localhost:5173 so the browser uses the registered redirect and can store the loopback sign-in cookie. Choose Rivetquay and sign in as `operator@rivetquay.example`, `approver@rivetquay.example`, `admin@rivetquay.example`, or `reader@rivetquay.example`. For Spoolharbour use `operator@spoolharbour.example`. All five fictional accounts use `rivetquay-demo`. Sign in with the operator to request approval and the separate approver to decide it. The local Dex mode uses password-only accounts and ephemeral sessions. Open a new sign-in after refreshing the browser or restarting the API. Unset `BS_AUTH_MODE` to return to the fixture picker.

To install fixture connectors or try a simulated BYO binding with durable storage, set `BS_PLATFORM_VAULT_MASTER_KEY` to a private base64-encoded 32-byte demo key before startup. The memory launcher generates a temporary key. As the fixture admin, create a credential on the Providers screen with an invented secret and bind the LLM capability to the corresponding provider. A saved binding takes precedence over the fixture route selected by the caller. Keep the same vault key across restarts when using Postgres.

## Docker Compose

```sh
docker compose -f infra/compose/compose.yaml up --build -d --wait
```

The Compose stack runs Postgres, Mailpit, the API, the web server and the fixture worker. The API applies migrations before listening and talks to the worker over a shared Unix socket. Open the web console at http://127.0.0.1:5173 and Mailpit at http://127.0.0.1:8025. Email goes to Mailpit and voice and SMS are simulated. The demo's published ports bind to loopback.

For the full Compose stack with Dex, set `BS_AUTH_MODE=oidc` and add `--profile oidc` before `up` in the Compose command. Open http://localhost:5173. For custom ports, match `BS_DEX_ISSUER` and `BS_OIDC_REDIRECT_URI` in `infra/compose/.env.example` to the issuer and redirect in a copy of `infra/compose/dex.yaml` and set `DEX_CONFIG` to the copy's path.

Postgres seeds the business tables on a fresh volume. Run `pnpm reset-fixtures` to reload those tables in an existing Compose project. Governance and platform state persist in Postgres. Durable mode uses the wall clock for approval expiry and fixture entitlements cover November 2026. To run an API process directly against a local Postgres instance, set `DATABASE_URL` and run `node infra/migrate.mjs` before starting the API.

For a parallel worktree, copy `infra/compose/.env.example` to `infra/compose/.env.lane`. Choose a distinct `COMPOSE_PROJECT_NAME` and five distinct host ports. Pass `--env-file infra/compose/.env.lane` to Compose and to `pnpm reset-fixtures`.

## Governed fixture API

Direct API launches provision fixture tokens from `FIXTURE_BEARER_BINDINGS`. The value is a JSON object keyed by bearer token with `tenantId` and `actorId` as each value. The server resolves the actor's kind and role from the fixture directory. Bind admin tokens to `actor-admin` in `tenant-rivetquay`. `pnpm dev` and Compose enable the built-in local fixture tokens, such as `fixture-operator` and `fixture-admin`.

```powershell
$fixtureToken = node -p "require('node:crypto').randomUUID()"
$env:FIXTURE_BEARER_BINDINGS = @{
  $fixtureToken = @{ tenantId = 'tenant-rivetquay'; actorId = 'actor-reader' }
} | ConvertTo-Json -Compress
pnpm --filter @bs/api dev
```

Send `Authorization: Bearer <token>` to `GET /platform/v1/me`, `POST /v1/tools/order.read` or `POST /mcp`. REST tool calls include an envelope with the verified tenant and actor. To list MCP tools, send `Accept: application/json` and the JSON body `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`.

Record list tools accept `query` for case-insensitive substring search, `limit` from 1 to 100 (default 25), and a `cursor` from the previous page's `output.nextCursor`. Keep the tenant, tool and filters the same when requesting that page and use a fresh idempotency key. The response is `{ items, nextCursor }`, with `null` at the end. The Records console reads all pages through the same tools. Sync the HubSpot-shaped fixture from Connectors to see its contacts and deals in governed records. Connector installs and snapshots reset when the API restarts.

For the native LLM API, create an `api_client` connection with the scopes `llm.models`, `llm.chat.completions` and `llm.embeddings` as needed. Send `Authorization: Bearer <tenantId>.<connectionId>.<secret>` to `/llm/v1/models`, `/llm/v1/chat/completions` or `/llm/v1/embeddings`. Use the `fixture-chat` or `fixture-embedding` model alias. The local API uses the tenant's capability binding with a fixture adapter and posts usage to the tenant's billing ledger.

## Checks and contracts

```sh
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run schema-check
pnpm run test
docker compose -f infra/compose/compose.yaml config --quiet
```

Run `pnpm codegen` after changing the shared contract sources to regenerate the published JSON Schema, OpenAPI, TypeScript, Pydantic and SQL files. See the [milestone handoff](docs/personal-plan/milestone-1.md) for fixture IDs and lane ownership.
