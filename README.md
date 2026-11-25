# Rivetquay Industrial Supply

A Milestone 1 base for a fictional Toronto industrial supplies distributor. The portal, Fastify API and LangGraph worker have starter entry points. The shared fixtures and in-memory gateway run the scenario for lane development.

## Quickstart

Use Node.js 24.4.1, Corepack with pnpm 11.25.0, uv 0.9.11, Python 3.12 and Docker Compose v2 or later. Install requires access to the public package registries. The tests use fixture data and no live providers.

```sh
corepack enable
pnpm install
uv sync
pnpm format:check
pnpm lint
pnpm typecheck
pnpm schema-check
pnpm test
docker compose -f infra/compose/compose.yaml --profile placeholders config --quiet
```

Registry access was blocked when the scaffold was built. The pnpm and uv lockfiles still need to be resolved. The install commands above generate them from the direct dependency pins. Once the owner reviews and adds both locks, use `pnpm install --frozen-lockfile` and `uv sync --locked` for reproducible setup. CI also uses locked installs when the corresponding lock is present.

Run the starter apps from the repo root in separate terminals.

```sh
pnpm --filter @bs/web dev
pnpm --filter @bs/api dev
uv run --no-sync python -m workers.bs_worker
```

Open the portal at localhost:5173 and the API health route at localhost:3000/health. Set `API_PORT` for the local API or pass `--port` to the Vite command.

## Governed fixture API

Set `FIXTURE_BEARER_BINDINGS` in the API host environment to a JSON object keyed by opaque bearer tokens. Each value contains `tenantId` and `actorId` from the fixture grants. The server looks up the actor kind and role from the fixtures. With no bindings configured, the REST tool routes and `/mcp` return `401`; `/health` stays public.

```powershell
$fixtureToken = node -p "require('node:crypto').randomUUID()"
$env:FIXTURE_BEARER_BINDINGS = @{
  $fixtureToken = @{ tenantId = 'tenant-rivetquay'; actorId = 'actor-reader' }
} | ConvertTo-Json -Compress
pnpm --filter @bs/api dev
```

Send `Authorization: Bearer <token>` to `POST /v1/tools/order.read` and `POST /mcp`. REST calls include an envelope with the caller's fixture tenant and actor. To list MCP tools, send `Accept: application/json` and the JSON body `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`.

## Local infrastructure

```sh
docker compose -f infra/compose/compose.yaml up -d --wait
pnpm reset-fixtures
```

Postgres initializes with the SQL fixture on a fresh volume. Reset replaces the rows in the `demo_fixture` tables inside the selected Compose project and clears any generated purchase orders. For an existing volume, run the reset before using the API's Postgres repository.

Set `DATABASE_URL` in the API host environment to use Postgres, for example `postgres://demo:demo-local-only@127.0.0.1:5432/demo` with the default Compose port. With the variable unset, the API seeds its repository in memory. Restart the API to reset its in-memory records, approvals, idempotency outcomes and usage counters. Mailpit listens on localhost:8025 for its web inbox and localhost:1025 for SMTP. The optional `placeholders` Compose profile starts stub containers on the app ports.

For a parallel worktree, copy `infra/compose/.env.example` to `infra/compose/.env.lane`. Choose a distinct `COMPOSE_PROJECT_NAME` and five distinct host ports. Volume names derive from the project unless overridden. Pass `--env-file infra/compose/.env.lane` to Compose and to `pnpm reset-fixtures`.

## Shared contracts

Edit `packages/contracts/v1/shared.json`, `packages/contracts/v1/tools.json` or `packages/contracts/fixtures/demo.json` through the shared owner. Run `pnpm codegen` to regenerate the published JSON Schema, OpenAPI, TypeScript, Pydantic and SQL files. Run `pnpm schema-check` to detect drift.

See the [milestone handoff](docs/personal-plan/milestone-1.md) for fixture IDs and lane ownership.
