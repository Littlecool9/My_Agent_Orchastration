# Architecture and execution behavior

**English** | [简体中文](../zh-CN/architecture.md) | [Documentation](README.md)

## Execution policy

Workers run change-related incremental `workerChecks`. The supervisor chooses targeted, affected-module, smoke, static or full independent checks according to risk, project size and runtime, and executes them through `workflow_verify`, recording rationale and omitted coverage.

`workerMemoryLimitMB` defaults to 3072 MiB (3 GiB) per OpenCode worker and its ordinary compiler/test descendants. A Windows Job Object is attached before execution. Reaching the limit terminates the group and records why; guard exit also cleans up descendants. The guard itself, supervisor and other applications are outside the Job. With two workers, each has its own limit; this is not a machine-wide or shared budget.

Set this value in the effective configuration and restart when no tasks are active. `.runtime/workers/<task-id>/memory-*.json` records limits, peaks, PIDs and exit reasons. Committed memory is different from RSS or total system usage. Non-Windows worker startup currently refuses to run without a guard.

New tasks default to provider `deepseek`, configured with `deepseek-flash`. Select Kimi explicitly; existing tasks do not migrate automatically.

`workspaceMode` supports `worktree` (recommended), `branch` (a new branch in the original checkout) and `current`. Before using a main branch directly, the supervisor displays a warning and records it in `mainBranchWarning`, without another approval step. Original-checkout modes require a clean checkout and exclusive task occupancy.

## Components

```text
Claude / GPT supervisor (existing subscription)
  -> explicitly invoked Skill + MCP stdio
    -> persistent local daemon (127.0.0.1, random token)
      -> task records, reports and verification logs
      -> OpenCode server per active task run (isolated API environment)
        -> configured Kimi / DeepSeek API
```

The scheduler is deterministic code with no additional planning model. The supervisor owns goals, plans, dependencies, feedback and acceptance. Workers investigate and implement detailed code changes. Complete records persist locally; the supervisor receives bounded summaries by default. Rework reuses the recorded OpenCode session.

Execution submits to OpenCode's `/session/:id/prompt_async` and polls status/messages with bounded short requests, avoiding a single HTTP request waiting for the whole run. The overall task deadline still applies. Cancellation interrupts polling and stops the process. Temporary polling errors retry reads up to three times without resubmitting work. A final result must belong to the current turn, come from an idle session and pass strict report validation. Failures retain the run ID, underlying network error and latest message snapshot.

## Persistent session repair

Before resuming a session, the worker checks for empty assistant records, including interrupted step-start/reasoning-only messages and empty API error records. Repair runs only when idle: archive complete original history, precisely delete individual invalid messages through OpenCode, then verify all retained messages are identical. Archive or verification failure stops before sending a model request.

Valid text, tool calls and tool-error records remain. Repair does not use workspace-reverting operations. Maintenance database backups belong in `.runtime/session-backups/`; per-run history repair archives are `history-repair-*.json` in the worker directory.

## Repository rules and worker roles

Executor/investigator prompts require reading root `CLAUDE.md` and its linked or `@`-referenced local rules; if absent, fall back to root `AGENTS.md`. Read applicable module/directory rules before working there, and reread them on resume. This is a prompt requirement, not programmatic proof that rules were read. Automatic Claude Code configuration integration stays disabled; workers do not load the supervisor's personal Skills or settings.

Role prompts are read on dispatch. Changes affect the next start/resume, not an active turn. OpenCode's built-in build/plan/general/explore/scout agents and task/plan tools are disabled. Only executor or investigator is requested, and sessions containing built-in Plan history cannot resume. Workers may make local implementation/debugging decisions but must escalate changes to fixed design.

## Lifecycle and acceptance

```text
planned -> ready -> running -> awaiting_review
  -> verifying -> awaiting_review -> accepted
```

Review, verification and normal rework can repeat without a round limit. Configuration currently allows two parallel tasks and 90 minutes per run. `maxAttempts` defaults to 5, limiting cumulative recovery dispatches from `failed`, `interrupted` and `blocked`, rather than initial execution or normal rework. Recovery requires current structured diagnostic feedback. Plan changes, completion and daemon restarts do not reset recovery usage.

At the limit the supervisor diagnoses or takes over; it must not recreate an identical task to bypass the budget. A maintainer can record audited `infrastructureRetryCredits` for workflow infrastructure failures. Historical attempt numbers and run IDs never roll back, and workers cannot grant credits. `workflow_status` reports `attempts`, `recoveryAttempts`, `recoveryAttemptLimit` and `remainingRecoveryAttempts`; `reworkLimit=null` means normal rework is unlimited. Legacy missing recovery counts begin at zero without discarding history.

`blocked` describes an environment/access/dependency issue. `needs_replan` requires `workflow_plan_update` before another dispatch. `planRevision` is separate from state `revision`. Each run has a unique `runId`; reports must match task, plan, run and attempt. A plan update invalidates old reports, feedback and checks while retaining history, workspace and session.

JSON contracts and reports are validated by application schemas. With the pinned OpenCode 1.19.3, local tests found that native `json_schema` output could cause `OutputFormatJsonSchema` errors when reading persistent messages. The workflow therefore carries JSON in ordinary messages and validates it in the application. Plain text, missing fields, mismatched versions and incomplete completion claims cannot enter review.

`prepare`, `dispatch` and `verify` reject execution when `executionEnabled=false`. Task creation reads local Git identity/profile data and stores a resolved plan without modifying repository files or calling a model. Profiles bind to the Git common directory, so worktrees share preferences; task snapshots retain their profile revision/hash and field provenance. Verification executes real commands outside the model, storing selection, omitted coverage, exit codes and logs. Default acceptance requires passing selected independent checks on current source. A `review_allowed` contract also permits explicit review-only acceptance with source fingerprint, rationale, evidence and omitted coverage. The supervisor must read code for functional coverage; the server cannot prove semantic correctness. See [repository preferences](repository-preferences.md).

Closing the MCP client does not stop the daemon. Dispatched work can continue, but further planning and acceptance need an active supervisor. If the daemon dies, an IPC guard stops OpenCode. On restart unfinished tasks become `interrupted` and are not automatically replayed.

## Files to inspect

| File | Responsibility |
|---|---|
| [Shared Skill](../../skills/orchestrate-code/SKILL.md) | Planning, delegation, rework and acceptance |
| [Configuration](../../workflow.config.json) | Execution gate, limits and providers |
| [Engine](../../src/engine.ts) | State, dependencies, verification and acceptance |
| [Worker](../../src/opencode.ts) | OpenCode process, credentials and sessions |
| [MCP tools](../../src/tools.ts) | Supervisor-facing tool interface |
| [Role prompts](../../prompts/) | Executor/investigator autonomy and escalation |
| [Protocol validation](../../src/protocol.ts) and [schemas](../../src/schema.ts) | Contracts, reports and feedback |
| [Memory guard](../../src/memory-guard.ts) | Windows Job Object supervision |

## Current boundaries

- Worktrees, branches and OpenCode tool permissions are not an OS sandbox. Implementation workers have broad shell access to run toolchains; publishing prohibitions and allowed-path validation cannot prevent arbitrary shell bypass. Use trusted local repositories.
- Investigators cannot write files or use general shell commands. They receive file reads and limited Git queries; the supervisor handles more complex read-only checks.
- Dependencies validate scheduling and baselines, but do not merge source. Prerequisite code must be in the chosen baseline; the supervisor integrates tasks and runs combined verification.
- Evidence is supplied by models/supervisors. The server validates run identity and source state, not whether a human-quality review occurred. Tokens/cost come from OpenCode; custom-provider cost may be zero and is not an invoice.
- Task text, repository rules, build commands and `AGENTS.md` are trusted inputs. Workers do not automatically inherit client plugins, browser tools or supervisor subscription usage.

Keys are loaded from local files/environment, not MCP configuration. Worker environment filtering strips inherited supervisor API/OAuth/GitHub credentials and injects the selected provider's key, with separate XDG configuration/data directories. Log redaction is best effort, not complete secret detection.
