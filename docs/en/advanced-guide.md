# Advanced use

**English** | [简体中文](../zh-CN/advanced-guide.md) | [Documentation](README.md)

The supervisor turns your goals into task contracts, delegates implementation, requests rework and independently accepts results. You do not need to open OpenCode or write JSON. This guide assumes [setup](getting-started.md) is complete and you have authorized the work. Read the effective configuration rather than assuming execution is enabled or disabled.

## 1. Open the client

After user-level setup, open a terminal in your target repository, run `claude`, then invoke `/orchestrate-code`. Check `/mcp` if the connection fails. Ordinary questions are not automatically delegated.

| Integration | Entry |
|---|---|
| Claude user/project Skill | `/orchestrate-code` |
| Temporary Claude plugin for troubleshooting | `/agent-orchestrator:orchestrate-code` |
| Codex MCP and Skill | `$orchestrate-code` |

For a temporary Claude session, run from the orchestrator installation:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-claude.ps1 -ProjectPath C:/path/to/your-project
```

## 2. Assign a task

Describe the goal, baseline, scope, acceptance criteria and publishing permissions. DeepSeek is the default worker provider; select Kimi explicitly if needed. Workers run incremental checks, while the supervisor selects independent validation. Worktrees are recommended; `branch` and `current` modes are supported.

```text
/orchestrate-code
Handle <repository and issue / feature>.
Use <baseline>; first confirm prerequisite code is present.
You own planning and independent acceptance; delegate implementation to DeepSeek.
Scope: <included and excluded work>.
Acceptance: <observable behavior, builds and tests>.
Prefer a worktree, or choose branch/current as appropriate. Warn before editing a main branch.
Use suitable build directories and read applicable repository rules.
Proceed autonomously except for key product, architecture or scope decisions.
Review failures and request rework as needed.
Report actual results, risks and design decisions for review.
Do not commit, push, open PRs or close issues.
```

The last line defines this template's delivery boundary. If you want commits or publication, state that scope in the task. The worker's default prompt does not allow it to publish on its own.

Repository-specific drafts belong under `skills/orchestrate-code/repositories.local/<id>/examples/`. Read the bound profile, current repository rules and issue requirements before adapting a draft; use `profile://scripts/<file>` for local check helpers. See [repository preferences](repository-preferences.md).

## 3. Assign a milestone

```text
/orchestrate-code
Handle <milestone> issues <list> from <baseline>.
Investigate dependencies, repository rules and acceptance criteria; form a phased plan.
Parallelize independent tasks only. Ensure dependent baselines contain prerequisite code.
You own overall design, contracts and independent acceptance; use DeepSeek workers.
Proceed with execution and rework, asking only about key decisions.
Use different directories for parallel tasks; serialize tasks sharing a checkout.
Workers run incremental checks; you select independent and combined verification.
Do not push. Report each issue, branch, test results, risks and design decisions.
```

For approval before edits, explicitly add “Present clarifications and the plan; wait for my approval before changing code.” Otherwise the supervisor proceeds within your task authorization.

Dependency checks do not merge worktrees. The supervisor selects integration baselines, combines work and tests the result. Any commits needed for dependent work must fit the task's authorization.

## 4. Communicate during execution

| Intent | Example |
|---|---|
| Progress | “Report changed results, blockers and next steps.” |
| Add acceptance requirements | “Add … Determine whether to stop the affected run and version the plan.” |
| Report a defect | “AC-02 is unmet because … Inspect evidence and rework in the same session.” |
| Inspect design | “List design decisions made by you and the worker, with reasons.” |
| Read-only investigation | “Inspect only; do not edit or run builds that write files. Report code locations.” |

The supervisor converts findings into structured feedback referencing acceptance IDs. A design change may require a new plan; fixing an omitted boundary check usually belongs to the existing plan. Do not continue against an obsolete contract.

## 5. Understand task states

| State | Meaning | Next step |
|---|---|---|
| `planned` | Contract stored; workspace not prepared | Review plan, then prepare |
| `ready` | Workspace prepared | Dispatch |
| `running` | Worker executing | Wait for meaningful progress |
| `awaiting_review` | Complete report available | Inspect code and independently verify |
| `verifying` | Real verification commands running | Wait for logs and exit codes |
| `needs_changes` | Review found defects | Rework with criterion-linked feedback |
| `needs_replan` | Contract/design conflict | Update the plan before dispatch |
| `blocked` | Environment, access or dependency blocker | Diagnose, repair and supply feedback |
| `failed` | Execution or report validation failed | Inspect the error and run artifacts |
| `interrupted` | Execution stopped; completion uncertain | Inspect changes before resuming |
| `accepted` | Supervisor accepted the task | Review delivery; publication is separate |
| `cancelled` | Task cancelled | Files remain; direct resume is unsupported |

Normal review/rework rounds are unlimited. `maxAttempts` defaults to 5 and limits only cumulative recovery dispatches after `failed`, `interrupted` or `blocked`. Initial execution and normal rework do not consume it. Recovery needs structured diagnostic feedback. Plan updates, normal completion and daemon restarts do not reset this count.

At the recovery limit, diagnose or take over a local fix rather than recreating the same task. `workflow_status` separates total `attempts` from `recoveryAttempts`, `recoveryAttemptLimit` and `remainingRecoveryAttempts`. Legacy tasks without a recovery count start that count at zero while preserving history.

## 6. Stop and resume

Closing Claude leaves dispatched workers able to finish and consume API usage. Without an online supervisor there is no next review or planning round.

To stop the daemon and active execution, run from the installation:

```powershell
npm run stop
```

Code and records remain; there is no source rollback. Resuming requires inspection and diagnostic feedback and consumes a recovery dispatch. Another MCP call may restart the daemon. To keep execution disabled, set `executionEnabled=false` in the effective configuration and ensure the daemon is stopped or has reloaded it.

Next day:

```text
/orchestrate-code Resume <task-id>; list existing tasks if I do not remember the ID.
Read status, the current plan and relevant summaries. Inspect actual workspace changes.
Do not recreate the same task or replay the whole transcript.
Continue review if ready; if interrupted, diagnose and resume the original session.
```

`workflow_cancel` cancels one task; it is not a lossless pause. Choose the stop method after checking state if you want to continue later.

## 7. Inspect delivery and artifacts

Delivery should include the task/issue, branch and base commit, actual verification results, risks, design decisions, workspace mode/path and commit/push status.

| Path relative to the installation | Contents |
|---|---|
| `worktrees/<task-id>/` | Source changes in worktree mode; branch/current use the original checkout |
| `.runtime/tasks/<task-id>/task.json` | Current state, plan, session and reviews |
| Same directory: `contract.json` | Last dispatched contract; `task.json` holds the latest plan |
| `report.json` | Validated worker report, not independent acceptance |
| `worker-report.md` | Human-readable report summary |
| `verify-*.log` | Actual supervisor verification output |
| `events.jsonl` | Dispatch, plan and review events |

Read both diffs and new files. A completion claim is insufficient. Missing toolchains or blocked checks must not be reported as passing.

## 8. Change models or settings

Choose the provider when creating a task and configure its key. Worker API usage is separate from supervisor subscriptions; a custom provider's reported `cost=0` does not mean free service.

An existing task's provider and baseline are part of its execution identity and cannot be changed directly. Plan any migration explicitly, handling existing changes. Editing global model settings does not migrate a persisted session.

After changing keys, endpoints, models or parallelism, restart only while no task is running or verifying:

```powershell
npm run stop
npm run start
```

`workflow.local.json` replaces the complete base configuration. Do not accidentally edit an inactive base file, or change a provider's execution identity while its task is active. After provider changes, use an explicit `--live` probe when appropriate; it need not run for every task.

## 9. Troubleshoot

| Symptom | First action |
|---|---|
| Skill missing | Check user MCP/Skill installation and reopen the client; temporary plugins use the namespaced entry |
| MCP tools missing | Check connection, installation path and compiled `dist/` |
| Execution disabled | Inspect effective/running config and restart after authorization |
| Missing key | Fill `.env.local`, then restart; do not put keys in prompts |
| 401/403 or unavailable model | Check key region, endpoint and model access before retrying |
| 429 | Diagnose rate/quota limits; reduce parallelism or wait |
| Invalid JSON or report version | Inspect raw response and protocol; do not accept plain text as success |
| Toolchain blocker | Inspect logs and required environment; do not omit acceptance checks |
| Branch/workspace already exists | Inspect the existing task and code before taking action |
| Recovery budget exhausted | Diagnose or take over; do not recreate a task to bypass the limit |

Use focused summaries and log excerpts. Keep full transcripts for specific investigations rather than refilling the supervisor context with all execution details.

For CLI troubleshooting, requests can be read from files to avoid shell JSON quoting:

```powershell
node dist/src/cli.js call TOOL_NAME --file C:/path/to/request.json
```

See [setup](getting-started.md), [protocol](protocol.md), [supervisor rules](../../skills/orchestrate-code/SKILL.md) and [architecture](architecture.md).
