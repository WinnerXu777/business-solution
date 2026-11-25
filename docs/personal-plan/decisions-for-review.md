# Decisions for owner review

Decisions made while the owner was away. Each lists the default chosen and how to change it.

| # | Date | Decision | Default chosen | Why / how to change |
| --- | --- | --- | --- | --- |
| 1 | 2026-11-25 | Local git commits for lane branches | Make local commits and worktrees so Codex lanes can branch from a shared base. Nothing is pushed to GitHub. | Parallel lanes need a base commit. Reset or squash before pushing if you prefer different history. |
| 2 | 2026-11-25 | Milestone 1 owner defaults (scenario, schema, permissions, approvals, retries, metering) | Accepted Codex's defaults in [milestone-1.md](milestone-1.md#owner-decisions): fictional Rivetquay distributor, v1 wire format, reader/operator/approver roles, one-hour single-use approvals bound to a material hash. | Edit milestone-1.md before lane integration; changing contracts after lanes land means a contract-owner pass. |
| 3 | 2026-11-25 | Python version for the lockfile | `uv.lock` resolved against Python 3.13 (miniconda). uv's managed 3.12 download failed on this machine. `requires-python` stays `>=3.12,<3.14`. | Rerun `uv lock --python 3.12` if you want 3.12 pinned. |
| 4 | 2026-11-25 | pnpm build scripts | Allowed esbuild's postinstall in `pnpm-workspace.yaml` (needed by Vite). | Set `esbuild: false` to block it. |
| 5 | 2026-11-25 | Compose runtime check | Docker daemon was not running, so Postgres seeding and Mailpit startup are unverified. `docker compose config` passes. | Start Docker Desktop and run the walkthrough from the README. |
