# Agent Orchestrator repository guidance

This repository implements a local MCP scheduler and its supervisor Skill. Target project repositories, repository profiles and task worktrees have their own instructions; do not copy their conventions or task-specific checks into this project's defaults.

## Read the right entry point

- Maintaining this repository: follow this file, then the relevant source and tests.
- Using the workflow in another project: read `skills/orchestrate-code/SKILL.md`. Its capability table and startup sequence are the supervisor's operating guide; the installation's root instructions are not automatically loaded in the target project.
- OpenCode workers receive `prompts/executor.txt` or `prompts/investigator.txt` plus a resolved task contract. Keep supervisor operations out of worker instructions.
- `CLAUDE.md` imports this file. `AGENTS.md` directs clients using that discovery convention here. Maintain the shared guidance only in `AGENT.md`.

## Find the implementation

| Concern | Source |
|---|---|
| MCP names, descriptions and dispatch | `src/tools.ts`, `src/mcp.ts` |
| Task lifecycle, evidence and acceptance | `src/engine.ts`, `src/schema.ts`, `src/protocol.ts` |
| Repository profiles and frozen defaults | `src/repository-profile.ts` |
| Daemon, CLI and persistent waits | `src/daemon.ts`, `src/cli.ts`, `src/wait.ts` |
| Worker permissions, processes and memory guard | `src/opencode.ts`, `src/memory-guard.ts`, `scripts/worker-job.*` |
| Installation, updates and client ownership | `scripts/setup-lib.mjs`, `scripts/setup.mjs`, `scripts/update.mjs` |
| Supervisor instructions distributed to clients | `skills/orchestrate-code/SKILL.md`, generated `integrations/claude/skills/orchestrate-code/SKILL.md` |

## Work and verification

Use Node.js 22+, TypeScript ESM and the existing dependency lockfile. Worker execution requires Windows. Keep changes focused; preserve unrelated work and local configuration. Never print keys or daemon authentication tokens.

Run `npm run build` after TypeScript changes, then the affected compiled tests with `node --test --test-concurrency=1 dist/test/<name>.test.js`. `npm test` runs the whole suite. Test scheduler, updater and installer changes with isolated fixtures; do not dispatch paid workers or build a target project just to test the orchestrator. A live provider probe requires an explicit request.

Task records in `.runtime/`, worktrees, credentials and `skills/orchestrate-code/repositories.local/` are local state. Preserve them during setup and updates. Keep repository-specific scripts, drafts and check recipes in the owning profile. Do not fabricate successful checks, acceptance reviews or reset recovery budgets.

## Keep capabilities discoverable

When adding or changing a workflow capability, update its MCP description, the supervisor Skill's capability table and operating instructions, and the corresponding English/Chinese guide. Update worker prompts only when worker behavior changes. Document the current implementation; do not describe a proposed feature as available.

After editing the shared Skill, run `node scripts/prepare-integrations.mjs` to regenerate the Claude variant. Changing this repository does not refresh already installed Skills or an already running client's tool descriptions. Use the explicit updater below, and verify installed content before claiming it is current.

## Local commands and updating

- `npm run doctor`: local backend diagnostics.
- `node dist/src/cli.js wait <id>` or `npm run wait -- <id>`: persistent wait until supervisor attention is needed; use `--until change` for a revision change. Prefer the client's background-shell support to writing a watcher.
- `npm run update -- --check`: inspect source/client synchronization without changes.
- `npm run update`: apply this checkout to the backend and its managed client installations. `update.cmd` is the Windows double-click entry; `update.ps1` is the PowerShell entry.
- `npm run update -- --pull`: explicitly fetch and fast-forward the current branch before applying it; requires a clean checkout and an upstream. Default updates use local source.

The updater preserves keys, profiles and task history, refuses active work, and tells the user to reopen/reconnect clients. See `docs/en/updating.md` or `docs/zh-CN/updating.md` for options, recovery and the boundary between installed files and an open chat.
