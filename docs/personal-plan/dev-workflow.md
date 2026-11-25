# Development workflow

Use a monorepo so the owner can review a complete feature and run it from one Compose project. Give each Codex session one primary package and a small, demoable change. Run the tests in that session's own worktree before sending it for review.

## Package boundaries

| Planned location | Owns |
| --- | --- |
| `apps/web/` | Portal, approval inbox, chat and voice UI, workflow editor and run history. |
| `apps/api/` | REST/MCP and LLM API entry points, identity resolution and request handling. |
| `packages/contracts/` | Versioned JSON Schemas, OpenAPI, event envelopes and shared fixtures. Generate TypeScript and Python bindings from these definitions. |
| `packages/core/` | Gateway, permissions, policies, approvals, audit, entitlements and metering. |
| `packages/business/` | ERP and CRM records, persistence and domain rules. |
| `packages/adapters/` | Provider contracts and implementations, credential references and external ID mappings. |
| `workers/` | LangGraph, workflow dispatch and ML. Organize by responsibility and use the gateway for governed records and effects. |
| `infra/` and `tests/e2e/` | Compose, CI support and the resettable demo and integration checks. |

## Run parallel sessions

1. **Agree on interfaces first.** The owner sets the request and event shapes, caller identity, error states, retry semantics, fixture IDs and compatibility expectations. Land the shared contracts and fakes before consumer work diverges. Route changes to public interfaces, dependency locks and storage migrations through one assigned session at a time.
2. **Use one branch and worktree per session.** Start from the same accepted base. Assign owned paths and list any dependencies on other work. Give each Compose run a unique project name, ports and volumes, or run the stacks in turns. Use local fakes by default. The owner keeps control of the integration branch, shared test credentials and any cloud access.
3. **Write a short brief.** Include the user-visible result, the owned paths, contract version, fixture or dependency, side effects, acceptance checks and expected handoff. Ask the session to report assumptions, changed paths, tests run, any migration and remaining risks. Split work before two sessions need to edit the same files.
4. **Put guardrails in CI.** Run format, lint, type and schema checks, unit tests and adapter contract tests with fakes. Run the Compose smoke scenario plus focused checks for isolation, stale approvals, opt-outs, duplicate events, uncertain provider outcomes and caps. Check that migrations work from the prior demo version. Use synthetic fixtures and block live provider access in CI.
5. **Review and integrate.** Codex supplies the diff and test evidence. Have Claude review the integration candidate for correctness, boundary changes, unsafe effects and missing cases, using only personal project code and synthetic examples. The owner resolves review notes, checks permissions, migrations and provider behavior, then integrates one branch at a time and reruns CI against the combined changes. Run the demo from a clean checkout at each milestone and record any remaining issues before opening the next briefs.

See the [overview](README.md), [architecture](architecture.md), [roadmap](roadmap.md), [module scopes](modules.md) and [project boundaries](safety-notes.md).

The shared contract approach follows the [master architecture](../master-plan/01-architecture.md) and the [connector and MCP contract](../master-plan/providers/business-systems.md#connector-and-mcp-contract).
