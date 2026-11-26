# Codex handoff: continue building while Claude is offline

The owner is running Codex directly for a day. Claude will review everything afterwards from GitHub. This file is the whole brief, so read it first.

## Read first

- [README](../../README.md) (local dev and feature map), then [personal plan](README.md), [architecture](architecture.md), [modules](modules.md), [roadmap](roadmap.md) and [safety notes](safety-notes.md).
- [Owner decisions so far](decisions-for-review.md). Keep appending yours there.
- Lane briefs are in [lane-briefs/](lane-briefs/). Start with `common.md`, which holds the rules every lane follows.

## Ground rules

1. Personal project. Use fictional/synthetic data only, test-mode or fake providers only, and no live network calls in tests. Keep day-job IP separate.
2. Use **one branch per lane**, named `codex/<lane>-<topic>`, starting from `main`. Do not commit directly to `main`. Push the branch and open a **pull request** to `main`. The PR description is the lane report: what was built, changed paths, commands run with results, defaults chosen, shared changes requested, and risks.
3. Before pushing, run `pnpm run format:check`, `pnpm run lint`, `pnpm run typecheck`, `pnpm run schema-check` and `pnpm run test`. All must pass. Use pnpm 11.25.0 (`corepack enable` or `npx pnpm@11.25.0`) and `uv sync` for Python.
4. Edit only your lane's owned paths, as listed in its brief. One session at a time owns shared files (`apps/api/src/app.ts`, contracts, manifests, lockfile, infra, `apps/web`). That is the **integration lane (A)**. Other lanes list needed shared changes in their PR instead of making them.
5. Do not add dependencies outside the integration lane. Never put secrets in the repo.
6. UI tests go in `packages/ui/spec/` (not `test/`, which `node --test` picks up).

## Work queue

Pick up the lanes in this order. Running about four at a time works well.

| Lane | Brief | Branch suffix | Notes |
| --- | --- | --- | --- |
| A, integration | `lane-a5.md` plus every item in `pending-shared.md` | `integration` | Wires all merged lanes into the app, moves staged migrations into `infra/migrations`, extends e2e, and fixes the intermittent HTTP 500 on concurrent chat. Do it first and merge before the others need it. |
| B, runtime durability | `lane-b6.md` | `runtime-durability` | Reply deltas, settled-turn callback, Postgres durability for runtime, conversations, connectors and LLM limits. |
| C, frontend round 4 | `lane-c4.md` | `frontend-4` | Compliance, webhooks, bots, templates and ops screens; English/French; tenant branding; command palette. |
| E, more bots | `lane-e2.md` | `more-bots` | Order entry, quotes, AP invoice capture, customer service, plus an eval harness. |
| F, deploy and security | `lane-f2.md` | `deploy-security` | Containers, Lightsail scripts (dry-run), security middleware, threat model. |
| G, imports and reporting | `lane-g2.md` | `imports-reporting` | CSV onboarding import and reporting/semantic layer. |
| H, developer platform | `lane-h2.md` | `dev-platform-2` | SDK/CLI for all current APIs, Python SDK, OpenAPI bundle, sandbox. |

Lane D (platform durability and RLS) is finished and merged. Its follow-ups are in `pending-shared.md` for lane A.

**Existing branches on GitHub.**

| Branch | State | What to do |
| --- | --- | --- |
| `wip/integration` | Lane A partial snapshot, unreviewed | Start lane A from it. Review, finish, then open a PR. |
| `platform/durability-b` | Lane B finished and reviewed, not merged | Open a PR to `main` as is. |
| `platform/frontend-4` | Lane C round 4 finished and reviewed, not merged | Open a PR to `main` as is. |
| `lane-e/more-bots` | Lane E partial (WIP commit) | Continue `lane-e2.md` from it. |
| `lane-f/deploy-security` | Lane F partial (WIP commit) | Continue `lane-f2.md` from it. |
| `lane-g/imports-reporting`, `lane-h/dev-platform-2` | Not started (same as `main`) | Start fresh from `main`. |

Older `m1/*`, `platform/*`, `lane-*/start` and `m6/ml-depth` branches are already merged history. `m6/ml-depth` is a paused ML branch, so ignore it.

## Known issues

- Intermittent HTTP 500 on concurrent chat requests, seen under load.
- Docker, Postgres and Dex have not been run for real yet. Verify them if your environment allows.
- The Python lockfile resolved on 3.13, while the project pins `>=3.12,<3.14`.

## When done

Leave PRs open. Claude reviews each PR, then merges in dependency order (A first) and reruns the full checks on `main`.
