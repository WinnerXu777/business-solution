You are one of three parallel Codex lanes for milestone 1 of a personal project. Your git worktree is the current directory, on its own branch. Read README.md, docs/personal-plan/milestone-1.md (your lane row, owner decisions, walkthrough), docs/personal-plan/architecture.md, modules.md and safety-notes.md first.

Rules:
- Edit ONLY your lane's owned paths from milestone-1.md. Do not edit contracts, fixtures, root manifests, lockfiles, app bootstrap or other lanes' paths. If you need a shared change, do not make it: describe the exact diff in your final report under "Requested shared changes" and work around it with a local adapter/shim inside your paths.
- Do not add dependencies (the sandbox may have no network; node_modules and .venv are already installed). If a dependency is truly needed, list it under "Requested shared changes".
- Fictional/synthetic data only. No live provider or network calls; tests use fakes.
- Commit your work to the current branch in small logical commits (end each message with a blank line and "Co-Authored-By: Codex <noreply@openai.com>"). Never push, never switch branches, never touch other worktrees.
- Before finishing run: pnpm run format:check, lint, typecheck, schema-check, test (use `npx -y pnpm@11.25.0 run <script>` if pnpm is missing; uv is at C:/Users/Caleb/AppData/Roaming/Python/Python313/Scripts/uv.exe - prepend that dir to PATH). All must pass.
- Final report: what was built, changed paths, commits, commands with results, assumptions/defaults chosen, requested shared changes, risks.
