# Supervisor reference

**English** | [简体中文](../zh-CN/supervisor-reference.md) | [Documentation](README.md)

The [supervisor Skill](../../skills/orchestrate-code/SKILL.md) covers the main path. This page holds the detail a supervisor needs less often: exact rules for each mechanism, edge cases and behavior kept for older tasks. [src/schema.ts](../../src/schema.ts) and [src/tools.ts](../../src/tools.ts) are authoritative.

## Contract resolution

`workflow_task_create` needs `id`, `repository`, `goal` and `acceptance`. Omitted fields resolve in this order: built-in defaults, repository `defaults`, task input. Built-ins are `contractVersion=1`, `planRevision=1`, `baseRef=HEAD`, branch `codex/<id>` (or the profile's `branchPrefix`), provider `deepseek`, `workspaceMode=worktree`, one adaptable step and `verificationPolicy=commands_required`.

- Arrays and scalars supplied by the task replace the default, including an explicit empty array.
- `resources` and `environment` merge by field name.
- Repository `requirements.constraints` are always appended, and a required verification policy cannot be weakened.
- `profile://scripts/<file>` in a check's command or args resolves to an existing file inside the bound profile directory when the contract is created, revised or amended. Commands run in the task workspace; the script itself is not copied into the task.

The server stores the full resolved spec and `configuration-v<planRevision>.json` with the profile revision/hash, the task's own overrides and the source of each field. Read that artifact when you need the complete agreement. A missing profile is created automatically; an existing one is reused unchanged.

## Scope

`allowedPaths` entries are literal repository-relative paths: a file, or a directory prefix with or without a trailing slash. The contract is rejected at creation, plan update and amendment when an entry contains `*` or `?`, a backslash, a drive letter or leading slash, an empty segment, or a `.`/`..` segment. Square brackets and braces are ordinary characters, as in `app/[id]/page.tsx`.

Scope is checked three times: when a worker run ends (the result is `scopeViolations` in status, informational), before verification and before acceptance (both refuse). Untracked files count. `allowedPaths` is a review control, not a sandbox.

## Resources

| Field | Default | Ceiling | Effect |
|---|---|---|---|
| `taskTimeoutMinutes` | effective ceiling | machine `taskTimeoutMinutes`, repository `limits` | Whole worker run, including a report resubmission. |
| `workerMemoryLimitMB` | effective ceiling | machine `workerMemoryLimitMB`, repository `limits` | Committed memory of the worker process tree. |
| `workerSteps` | machine `workerSteps` (150) | machine `maxWorkerSteps` (600), repository `limits` | Model steps in one run. |
| `tokenBudget` | repository `limits.tokenBudget`, otherwise none | repository `limits.tokenBudget` | Cumulative reported tokens of the task. |

A task pins the resolved values at creation. Change them later with `workflow_plan_amend`; they apply from the next dispatch.

**Token budget.** Dispatch refuses when the task has already reached the budget. During a run, the worker is stopped once reported usage passes it; the task becomes `failed` with `WORKER_TOKEN_BUDGET` in `lastError`, the workspace is kept, and resuming is an ordinary recovery dispatch after the budget is raised. Token counts are the provider's reported input, output and reasoning tokens; cache reads are not counted toward the budget.

**Cost.** `costReported` sums the provider's own cost figure. Custom endpoints usually report 0; if the provider entry has `pricing` (`currency`, `inputPerMillion`, `outputPerMillion`, optional `cacheReadPerMillion`), cost is estimated from reported tokens instead, with cache reads priced at `cacheReadPerMillion` or the input rate. Pricing is pinned with the provider when the task is created. These are estimates from list prices, not an invoice. A run that fails after spending tokens still adds them to the task totals.

## Environment

`environment` is a map of variable names to values, added to the worker process and to verification commands. `${NAME}` expands from the environment built so far, so `"PATH": "D:/tools/bin;${PATH}"` prepends. On Windows, names match case-insensitively and the contract's spelling replaces the inherited one. At most 64 variables.

Names containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL`, or starting with `OPENAI`, `ANTHROPIC`, `CLAUDE`, `CODEX`, `GH_`, `GITHUB_`, `OPENCODE_` or `XDG_`, are rejected: these are the names stripped from the worker environment, and contract contents are stored in task records and shown to the worker. The worker's own control variables always win.

Put a repository's toolchain variables in the profile's `defaults.environment` so tasks inherit them. There is no workspace setup command: a fresh worktree has no installed dependencies or build directory unless the worker or the repository's own scripts create them.

## Dispatch, queue and capacity

`maxParallel` counts running workers across all repositories. A dispatch at the limit fails unless `queue:true` is passed. A queued task has status `queued`; `workflow_status {id}.queued` shows its position and the status it will return to.

- Preconditions (key present, dependencies accepted, workspace intact, budgets) are checked when the task is queued and again when it starts. Recovery attempts are counted at the start, not at queueing.
- Queued dispatches start oldest first as slots free.
- `workflow_cancel {id,scope:"queue"}` withdraws the dispatch and restores the previous status. Plan updates are refused while queued.
- If a queued dispatch cannot start, the task returns to its previous status with `queueError`; the wait CLI treats that as attention.
- The queue lives in the daemon's memory. A daemon stop or restart withdraws every queued dispatch, sets `queueError` and starts nothing.

Verification is not queued and does not use worker slots.

## Run progress

While a task is `running`, `workflow_status {id}.run` contains:

| Field | Meaning |
|---|---|
| `startedAt`, `elapsedSeconds`, `timeoutMinutes` | Wall-clock position against the run's time limit. |
| `phase` | `starting`, `working` or `report_repair`. |
| `steps`, `stepLimit` | Model steps used by this run and its budget. |
| `tokens` | Reported tokens of this run so far. |
| `lastTool` | The most recent tool call: name, state and title (for shell commands, the command). |
| `lastActivityAt`, `idleSeconds` | When the transcript last changed. A long-running build shows as idle with a running tool. |

Progress is read from the worker once per second and kept in memory. It does not change the task's `revision`, so `workflow_wait` and the wait CLI do not return for it. After the run, `lastRun` keeps the run ID, timestamps, duration, outcome, steps and tokens.

## How a run ends

| Result | Status | Recovery attempt | Feedback needed to resume |
|---|---|---|---|
| Valid `ready_for_review` report | `awaiting_review` | – | – |
| Valid `needs_replan` report | `needs_replan` | no | Plan update first |
| Valid `blocked` report, steps below the budget | `blocked` | yes | yes |
| Valid `blocked` report, step budget used up | `blocked`, `continuation.reason=step_limit` | no, up to `maxStepContinuations` in a row | no |
| Report invalid after one resubmission | `needs_changes`, `continuation.reason=report_invalid` | no | no (system-written feedback is attached) |
| Provider error, timeout, memory limit, token budget, process exit | `failed` | yes | yes |
| Daemon stopped during the run | `interrupted` | yes | yes |

**Step-limit continuation.** A run is at its step limit when the number of model steps it took equals its budget. The worker's last step has no tools, so it can only report what remains. Dispatching such a task again continues the same session and workspace: the new contract carries a `continuation` object telling the worker not to redo finished work. The first `maxStepContinuations` (default 2) consecutive continuations need no feedback and do not count as recovery; the counter resets when a run reaches `awaiting_review`. After that, or after a plan update, the ordinary recovery rule applies. Repeated step-limit runs mean the task is too large: raise `workerSteps` or split it.

**Invalid report.** The task goes to `needs_changes` with feedback written by the system (all criterion IDs, the validation errors, a reference to the submission artifact). Dispatching continues the same session with tools enabled, so the worker can also finish verification it had not run. Acceptance still requires a valid report; the supervisor never writes one.

**Abort reasons.** When the worker process ends, the reason is reported as itself: `WORKER_MEMORY_LIMIT` with the peak, `WORKER_MEMORY_GUARD_FAILED`, `WORKER_TOKEN_BUDGET`, or "OpenCode process exited; inspect server.log and memory report".

## Reports

The worker's final answer must contain one JSON object matching `WorkerReportSchema`. Before validation, format defects that carry no claim are repaired and recorded in `reportSubmissions[].normalizations`:

- the object is taken from a markdown fence or surrounding text;
- unknown top-level keys are dropped; unknown keys on acceptance results, checks and blockers are dropped, and their string values are kept as evidence lines;
- a summary over 6,000 characters is truncated;
- omitted `changedFiles`, `checks`, `deviations` and `blockers` become empty arrays;
- a reported check that is not in `workerChecks` moves to `deviations`; a worker check that was not reported is recorded as `not_run`, which can never satisfy `ready_for_review`.

Never repaired: task/plan/run/attempt identity, criterion coverage, statuses, the evidence required for `met`, `pending_supervisor` and executed checks, and outcome consistency. A report that fails these gets one resubmission by the `reporter` agent with all tools denied, in the same session, run and attempt, sharing the task deadline and capped at 120 seconds. Its usage is recorded separately in `report-submission-<runId>.json`. The task stays `running` during the resubmission; do not dispatch again.

The task message includes `REPORT_TEMPLATE`: the report skeleton with this run's identity, every criterion ID and every worker check name filled in.

## Amend or update

| | `workflow_plan_amend` | `workflow_plan_update` |
|---|---|---|
| Fields | `checks`, `allowedPaths`, `resources` | Everything except execution identity |
| `planRevision` | unchanged | +1 |
| Worker report, feedback, evidence | kept | cleared |
| Session, workspace, attempts, recovery budget | kept | kept |
| Allowed in | any state except `verifying` and terminal states | not `running`, `verifying`, `queued` or terminal |
| Record | `amendment-<id>.json` with before/after values and the reason; listed in status and handoff | `plan-v<n>.json` and a new `configuration-v<n>.json` |

Amended values are also written into the task's stored overrides, so a later plan update keeps them. Amending `checks` clears the verified fingerprint when the last round ran the planned selection, because that round no longer covers the plan; a round run with an explicit `selection` is unaffected. Amending `allowedPaths` on an idle task recomputes `scopeViolations`. Amendments to a running task's resources apply from the next dispatch.

A plan update on a `failed`, `interrupted` or `blocked` task still requires diagnostic feedback at the next dispatch and consumes recovery budget. Execution identity (`id`, `repository`, `baseRef`, `fetchRemote`, `branch`, `provider`, `mode`, `workspaceMode`, `dependencies`) never changes; use a distinct task. `refreshRepositoryProfile=true` adopts the current profile in the new revision.

## Verification

Each round has a `verificationRunId`, a `verification-<id>.json` artifact and `verify-<id>-<check>.log` files. Checks run in order, in the task workspace, with the contract `environment`, outside worker slots and memory guards.

- By default the round stops at the first failing check. `continueOnFailure:true` runs every check; the round still fails if any check fails.
- Each result has `status`, `exitCode`, `durationMs` and the log name. A failed check also has `tail`, the last 1,500 characters of output (or the error for a timeout or launch failure), and `exitDetail` for exit codes outside 0–255: the hex code and, for common Windows NTSTATUS values, a name such as `0xC0000005 access violation`.
- `rerun:"failed"` requires a finished previous round for the same plan revision and worker run whose source fingerprint equals the current one. It repeats that round's selection; checks that passed there are copied with `reusedFrom` set to the round that actually ran them, and the others run. The new round's artifact records `rerunOf`. Any source change, a rework run or a plan update invalidates reuse.
- The round passes only if every selected check has a passing result and the source fingerprint is unchanged at the end.
- `workflow_verify_stop` aborts the round and waits for the process tree; completed results are kept and nothing is granted.

Acceptance compares the latest round's results with its selection and the verified fingerprint with the current source. `review_allowed` contracts may be accepted with `verification:{mode:"review_only",omittedCoverage:[...]}` instead.

## Waiting

`workflow_wait {ids,after,timeoutMs}` returns when a listed task's revision passes its cursor, or after at most 25 seconds.

`node dist/src/cli.js wait <id>...` chains those reads in one process for up to eight IDs and prints one JSON object `{reason,tasks,attention?}`.

- `--until attention` (default) returns when a task is in `awaiting_review`, `needs_changes`, `needs_replan`, `blocked`, `failed`, `interrupted`, `accepted`, `integrated` or `cancelled`, or has a `queueError`. `attention` lists those task IDs.
- Tasks already in a terminal state at the first read are ignored unless every listed task is terminal, or their status changes later.
- `--after <id>=<revision>` excludes that task until its revision passes the value. Without a cursor, a task already in an attention state returns immediately.
- `--until change` returns on any revision change after the cursor, or after the first read when no cursor is given.
- `--timeout-ms` bounds the whole wait; a timeout prints the latest snapshot and exits 2. Ctrl+C exits 130. Neither changes any task.

The CLI reconnects transient read failures and never dispatches work.

## Overview and archive

`workflow_status {}` returns `{scope,total,matched,countsByStatus,tasks,hint}` with one compact row per task, newest first: ID, title, status, revisions, `needsSupervisor`, repository, workspace, branch, model, `updatedAt` and `idleDays`. `scope` is `active` (default; everything except accepted, integrated and cancelled), `all` or `archived`. `status`, `repository` (compared as a path, case-insensitive on Windows) and `limit` (default 50, at most 200) narrow it.

`workflow_archive {ids,removeWorktree?}` handles each ID separately and reports the outcome per task.

- Only `accepted`, `integrated` and `cancelled` tasks can be archived, and not while an unfinished task lists them in `dependencies`.
- The task directory moves from `.runtime/tasks/<id>` to `.runtime/archive/<id>`. Nothing in it is deleted. The branch and the OpenCode session state under `.runtime/workers/<id>` stay.
- The ID stays reserved. `workflow_status {id}` and `scope:"archived"` still read the task; other tools report it as archived.
- `removeWorktree:true` runs `git worktree remove` without `--force` on a worktree inside the installation's `worktrees/` directory. Git refuses when the worktree has modified or untracked files; the task is then left unarchived and the error is returned. In-place workspaces are never touched.

There is no unarchive tool; moving the directory back restores the task.

## Models

Legacy tasks created before provider pinning pin their provider configuration, model and tags on their next explicit dispatch. Plan updates and amendments preserve the pinned snapshot. `workflow_status` reports the pinned model, tags, selection reason, `modelConfigPinned`, `costCurrency` and `pricingConfigured`.

## Older tasks

- Contracts without `workerChecks`: the worker selects bounded incremental checks and records them in criterion evidence. Workflow-generated instructions that assigned a full suite to the worker or the supervisor are superseded by supervisor-selected verification.
- Check results recorded before verification rounds existed are archived as a round before a new round or dispatch clears them.
- Tasks without a recovery counter start it at zero; `attempts` keeps counting every dispatch.
- Tasks without `environment`, `workerSteps` or the newer status fields behave as if those were unset; `workerSteps` falls back to the machine default.
- `infrastructureRetryCredits` on a task extend its recovery limit; they are granted by a maintainer for workflow defects, never by the supervisor.
