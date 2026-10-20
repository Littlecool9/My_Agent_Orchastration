# Everyday use

**English** | [简体中文](../zh-CN/daily-guide.md) | [Documentation](README.md)

## Start with three steps

1. Open the repository you want to develop in a terminal. On Windows, you can enter `wt` in Explorer's address bar if Windows Terminal is installed.
2. Run `claude`.
3. Invoke `/orchestrate-code` with your task.

```text
/orchestrate-code Implement <goal> from the latest <baseline>. You plan and independently review; delegate implementation to DeepSeek. Ask me about key decisions. Do not commit or push.
```

Use ordinary conversation for other questions. You do not need to open the orchestrator folder, manually start OpenCode, run a launcher script or write task JSON each time. Codex users invoke `$orchestrate-code` after completing [setup](getting-started.md).

## Defaults and workspace choices

New tasks use the configured `deepseek-flash` model by default. Workers run incremental checks; the supervisor chooses independent verification according to change risk, project size and cost. Targeted, affected-module, smoke, static or full checks are available; the supervisor records rationale and omitted coverage.

Each worker and its ordinary build/test descendants have a default 3 GiB committed-memory budget, configurable through `workerMemoryLimitMB`. Hitting it terminates the group while retaining code, session and memory artifacts. Two parallel workers each have their own 3 GiB limit.

Worktrees are recommended. You can also request:

- “Create a new branch in this checkout; do not use a worktree.”
- “Use the current branch. If it is a main branch, show and record the warning before editing; no extra confirmation is needed.”

Only one task can occupy a checkout. Preserve existing changes or choose a worktree; the workflow does not automatically stash, reset or overwrite them.

## Before the first task

Complete [installation and configuration](getting-started.md). Put keys in `.env.local` in the installation directory: `DEEPSEEK_API_KEY` for the default provider, `MOONSHOT_API_KEY` for Kimi. Do not send keys in chat. Check the effective `executionEnabled`; for review-only setup, use `false`. Adding a key does not dispatch work.

Once user-level MCP and the Skill are installed, normal `claude` sessions can find them. Reopen old sessions. If the command is missing, check `/mcp` and the Skill installation.

## Execution is disabled even though the file says true

Ask the supervisor to read `workflow_config`. `executionEnabled` is the running value; `diskExecutionEnabled` is on disk. `restartRequired=true` means reload is needed. `configFile` identifies the effective file. A missing `workflow.local.json` is normal.

When nothing is running or verifying, run `npm run stop` followed by `npm run start` from the installation directory. Restart preserves tasks. Continue preparing the existing task instead of recreating it. Normally you do not need to reconnect MCP. Optional local configuration must contain the complete configuration.

## Select verification

Say “Choose verification based on the change risk; a full suite is not required.” The supervisor records strategy, rationale, commands and `omittedCoverage` through `workflow_verify.selection`, without rewriting the task plan. Implementation acceptance still requires at least one passing independent command and an honest account of untested scope.

## Resume interrupted work

Read `workflow_status` first. Do not recreate the task or worktree. For `failed`, `interrupted` or `blocked`, inspect existing changes and supply structured diagnostic feedback matching the current plan and acceptance IDs to `workflow_dispatch`. Continue the original session. For `needs_replan`, update the plan first.

Before resuming, the worker archives and removes unreplayable empty assistant messages, retaining tool history. If repair fails, fix the workflow instead of repeatedly dispatching or manually editing its database.

OpenCode uses asynchronous submission with short polling requests, while `taskTimeoutMinutes` limits the overall run. Temporary polling failures retry reads without resubmitting work. A maintainer can grant audited `infrastructureRetryCredits` for workflow failures; historical attempts and run IDs are never reset.

## Useful requests

| Goal | Ask the supervisor |
|---|---|
| New task | “Implement … from … with these acceptance criteria …” |
| Plan first | “Investigate and propose a plan; wait for approval before editing.” |
| Progress | “Summarize progress, blockers and the next step.” |
| Rework | “This requirement is unmet: … Inspect it and send concrete feedback.” |
| New requirement | “Add … First check whether the plan must change.” |
| Resume | “Inspect the previous task and its changes; continue without starting over.” |
| Stop | “Stop current execution, retain changes and explain how to resume.” |

Closing the client can leave dispatched workers running and consuming API usage. To stop them, explicitly ask the supervisor. Task cancellation and stopping the daemon have different recovery behavior; see the [advanced guide](advanced-guide.md).

## Review delivery

Check what changed, actual build/test results, risks, design decisions, workspace mode, path and branch. A worker's completion report still needs independent supervisor acceptance.

Run npm commands from the orchestrator installation; start the client in the target repository. For details, see [advanced use](advanced-guide.md), [setup](getting-started.md) and the [protocol](protocol.md).
