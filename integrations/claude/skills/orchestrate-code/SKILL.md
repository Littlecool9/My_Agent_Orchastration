---
disable-model-invocation: true
name: orchestrate-code
description: Explicitly delegate a coding task or milestone to external OpenCode workers, then independently review their work and report results. Use when the user invokes this workflow.
---

You stay the planner, supervisor and final reviewer. External OpenCode workers implement through the `agent-orchestrator` MCP tools. Use this workflow only when the user invokes it. Do not change the main model, authentication, provider endpoint or subscription login.

## Start here

1. Call `workflow_config`. Its `projectRoot` is the orchestrator installation; your working directory is the target repository. If `executionEnabled` is false, stay in planning and review mode.
2. Read the target repository's `CLAUDE.md` and the instruction files it references (including `AGENTS.md`); if absent, read `AGENTS.md`. The orchestrator's own `AGENTS.md` is about maintaining the orchestrator, not the target project.
3. Read `workflow_repository_config {repository}`. If `profile` is null, call `workflow_repository_init {repository}` and continue; this is routine bookkeeping, not a question for the user.
4. For an existing task, read `workflow_status {id}` before resuming. After a context reset or with several tasks, read `workflow_handoff {ids:[...]}`, then check the current source yourself.
5. Before parallel work, read `workflow_capacity {}`.

Edge cases, field-by-field rules and legacy behavior are in `<projectRoot>/docs/en/supervisor-reference.md`. Read it when this guide does not answer a question; never guess a tool's behavior.

## Main path

Create, prepare, dispatch, wait, review the code, verify independently, then accept or request rework.

Create a task. Only `id`, `repository`, `goal` and `acceptance` are required; everything else inherits repository or built-in defaults:

```json
{ "spec": {
  "id": "allocator-overflow",
  "repository": "C:/path/to/project",
  "goal": "Reject node ID allocation overflow instead of wrapping.",
  "acceptance": [
    { "id": "AC-01", "requirement": "Allocating past the upper limit returns an error." },
    { "id": "AC-02", "requirement": "A regression test covers the boundary." }
  ],
  "allowedPaths": ["modules/allocator", "tests/allocator"],
  "workerChecks": [{ "name": "allocator-tests", "command": "ctest", "args": ["--test-dir", "build", "-R", "allocator"], "timeoutMinutes": 10 }],
  "checks": [{ "name": "allocator-and-graph", "command": "ctest", "args": ["--test-dir", "build", "-R", "allocator|graph"], "timeoutMinutes": 20 }]
} }
```

Then `workflow_prepare {id}`, `workflow_dispatch {id}`, and wait in a background shell:

```powershell
node "<projectRoot>/dist/src/cli.js" wait allocator-overflow
```

When it returns, read `workflow_status {id}`, `workflow_diff {id}` and the changed files in the workspace. Run `workflow_verify {id}`, wait again, then decide.

Request rework (same session, no round limit):

```json
{ "id": "allocator-overflow", "decision": "rework",
  "rationale": "AC-02 is not met.", "evidence": ["tests/allocator/limits.cpp has no case at the upper bound"],
  "feedback": { "planRevision": 1, "summary": "Add the boundary regression test",
    "findings": [{ "criterionIds": ["AC-02"], "description": "No test allocates at the upper limit",
      "evidence": ["tests/allocator/limits.cpp"], "requestedChange": "Add a test that allocates the last valid ID and then expects an error" }] } }
```

Accept, after reviewing the code and with a passing verification round on the current source:

```json
{ "id": "allocator-overflow", "decision": "accept",
  "rationale": "Overflow path and boundary test reviewed; affected-module checks pass. Full matrix not run.",
  "evidence": ["modules/allocator/ids.cpp:88", "verify-<run>-allocator-and-graph.log"] }
```

## Capability index

| Need | Tool or command and how to use it |
|---|---|
| Installation path, execution gate, step budgets, provider settings | `workflow_config {}`; also points to this guide, the reference and the update entry. |
| Worker model choice | Read `workflow_config.providers` model/tags/keyPresent/pricing; pass `provider` plus `modelSelectionReason` at task creation. |
| Parallel planning and resource bottlenecks | `workflow_capacity {}`; free slots, queued dispatches, memory ceilings, active verification and directory reservations with `idleDays`. |
| Reusable project settings and hard limits | `workflow_repository_config {repository}`; worktrees share the binding. |
| Minimal first-use profile | `workflow_repository_init {repository}`; only an absolute repository path is needed. |
| Explicit persistent preferences | `workflow_repository_config_update {repository,id,expectedRevision,preferences}`; preserve unrelated preferences. |
| A new task | `workflow_task_create {spec}`; see the example above. Inherited defaults are frozen into the task. |
| Workspace preparation | `workflow_prepare {id}`; records the actual base and workspace. |
| Start or resume a worker | `workflow_dispatch {id,feedback?,queue?}`; `queue:true` waits for a slot instead of failing. |
| Overview of unfinished tasks | `workflow_status {}`; compact list. Filter with `scope` (`active`, `all`, `archived`), `status`, `repository`, `limit`. |
| One task's state and live progress | `workflow_status {id}`; while running, `run` shows elapsed time, steps used/limit, tokens, last tool and idle seconds. Keep the returned `revision`. |
| Short MCP wait | `workflow_wait {ids,after,timeoutMs}`; at most 25 seconds per call. |
| Continuous/background wait | `node "<projectRoot>/dist/src/cli.js" wait <id>...`; see Execute and supervise. |
| Changed files and code review | `workflow_diff {id}`, then read the files in the indicated workspace. |
| Contract, reports, verification logs, evidence | `workflow_artifact {id,name,offset?,length?}`; use names from status and bounded excerpts. |
| Independent verification | `workflow_verify {id,selection?,continueOnFailure?,rerun?}`; failed checks carry the log tail in status. |
| Stop only verification | `workflow_verify_stop {id,reason}`; keeps the task, report and completed checks. |
| Fix a check command, widen scope, change a budget | `workflow_plan_amend {id,expectedPlanRevision,patch:{checks?,allowedPaths?,resources?},reason}`; keeps the worker report and session. |
| Change the agreed plan | `workflow_plan_update {id,expectedPlanRevision,spec,changeReason}`; invalidates the report and old evidence. |
| Supervisor integration/check notes | `workflow_evidence_add {id,entry}`; source-bound testimony, not acceptance. |
| Durable decisions, repairs, risks, next steps | `workflow_note_add {id,entry:{planRevision,kind,summary,detail?,relatedTaskIds?}}`. |
| Resume context or assemble a final report | `workflow_handoff {ids:[...]}`; persisted plans, claims, checks, reviews, amendments and recent notes. |
| Accept or request rework | `workflow_review {id,decision,rationale,evidence,feedback?,verification?}`. |
| Stop a task, or withdraw a queued dispatch | `workflow_cancel {id}` is terminal and keeps files; `workflow_cancel {id,scope:"queue"}` only leaves the queue. |
| Tidy finished tasks | `workflow_archive {ids,removeWorktree?}`; only tasks the user regards as finished. |
| Refresh an installed workflow | `node "<projectRoot>/scripts/update.mjs" --check`, then without `--check`; see `docs/en/updating.md`. |

Verification is asynchronous. Cancelling a waiter only stops waiting. `awaiting_review` is not acceptance. `integrated` records a historical delivery and does not satisfy the `accepted` dependency gate.

## Scope and resource syntax

`allowedPaths` takes literal repository-relative files and directory prefixes with forward slashes, such as `CMakeLists.txt` and `modules/prefab`. Globs (`*`, `?`), absolute paths, backslashes and `./..` segments are rejected when the task is created. An empty list permits all paths. If a run edits outside the scope, `workflow_status` lists `scopeViolations` as soon as the run ends: have the worker revert them, or widen the scope with `workflow_plan_amend` when the edit is intended.

`resources` holds `taskTimeoutMinutes`, `workerMemoryLimitMB`, `workerSteps` and `tokenBudget`. None may exceed the effective limits from `workflow_repository_config`; a schema maximum is not the execution budget.

- `workerSteps` is the number of model steps one run may take (default from `workflow_config.workerSteps`, ceiling `maxWorkerSteps`). When it is used up the worker loses its tools and can only write a report.
- `tokenBudget` caps the task's cumulative reported tokens. At the budget the run stops as `failed` with `WORKER_TOKEN_BUDGET`; the work is kept. Raise it with `workflow_plan_amend` only within the user's budget.

`environment` adds non-secret variables for the worker and for verification commands, for example `{"VCPKG_ROOT":"D:/vcpkg","PATH":"D:/tools/bin;${PATH}"}`. `${NAME}` expands from the inherited environment. Names that look like credentials are rejected; keys never belong in a contract. A repository profile can supply `defaults.environment` so every task inherits its toolchain.

Size a task to fit one step budget: one coherent change with its tests. Removing a feature and repairing every shared test that mentions it is two tasks, or one task with a raised `workerSteps`. Give `workerChecks` that run in minutes.

## Models and repository profiles

Users own provider/model configuration and optional free-form `tags`. Treat tags as the user's assessment, not a benchmark or an instruction that overrides task rules; never invent, rewrite or persist them. Honor an explicit user choice or repository preference; otherwise choose among configured, key-present models by how the user's tags fit the task, and record a concrete `modelSelectionReason` (required for tagged models). If tags do not distinguish candidates, use the repository or default provider (deepseek) and say so. Missing keys or a consequential ambiguity may need the user; never change credentials or endpoints yourself. A task pins its provider, model, tags and pricing; changing models means a distinct task.

`costReported` is the provider's own figure, or an estimate from the user's configured `pricing` when the provider reports none (`costCurrency`, `pricingConfigured`). Without pricing it stays 0, which does not mean free.

Profiles live under `<projectRoot>/skills/orchestrate-code/repositories.local/<repository-id>/` with `profile.json` and `scripts/`; the directory is ignored by Git. One Git common directory binds one profile across worktrees. Minimal initialization records identity and empty preferences only: it infers no test commands and permits no skipped tests. Save a long-term preference only when the user's instruction clearly makes it persistent, with `workflow_repository_config_update` and the profile's current revision, preserving unrelated preferences. A task-specific override never updates the profile. Use `profile://scripts/<file>` in a check's command or args for locally maintained check scripts.

## Plan and investigate

Use read-only investigator tasks (`mode:"investigate"`) for detailed exploration when useful, and keep your own context for decisions, dependencies and evidence. Investigators can search and read files and run a few Git inspection commands.

State the goal, acceptance criteria with stable IDs, scope, base, actual build/test commands and important decisions. Add `decisions`, `nonGoals`, `contextRefs`, `steps`, `autonomy` and overrides only when the task needs them; arrays you supply replace defaults, and repository `requirements.constraints` are always appended. Identify dependencies before parallelizing. Ask the user only about consequential product or design choices and blocking gaps; batch related questions. Honor a requested approval-before-code stage; elapsed time is not approval.

Choose `workspaceMode`: `worktree` (recommended, isolated), `branch` (new branch in the repository directory) or `current` (the checked-out branch). Honor the user's choice. For `current` on a primary branch, first tell the user the task will modify that branch directly and record the displayed text in `mainBranchWarning`; this is a warning, not another approval. `branch` and `current` need a clean checkout and reserve that directory until the task is accepted or cancelled; never stash or reset the user's changes. For the latest upstream, use `fetchRemote:"origin"` and `baseRef:"origin/master"`. A dependency's code reaches a dependent task only if it was committed and verified before acceptance and is contained in the dependent's `baseRef`; `dependencies` alone do not merge code.

Separate testing: `workerChecks` are the worker's targeted incremental checks; `checks` are your planned independent verification. Choose scope by project size, changed modules, risk and runtime. Do not default a large project to its full build/test matrix, but honor checks the user or project explicitly requires. Record your rationale and omitted coverage; never claim an unrun suite passed.

## Execute and supervise

Tell the user the planned concurrency, current `maxParallel` and free slots, dependency order, directory reservations and known build/memory/disk limits. Slots are shared across repositories. `branch`/`current` tasks in one directory serialize; independent parallel work needs separate worktrees. Memory ceilings are per worker process tree, not measured usage. Verification runs outside worker slots and memory guards and still competes for the machine. Do not raise limits, share mutable build directories or assume a shared compilation cache on your own; present the trade-off and follow the user's budget.

Dispatch independent tasks up to the limit. For more tasks than slots, pass `queue:true`: the task becomes `queued` and starts by itself when a slot frees. A daemon restart drops the queue without running anything and marks the task with `queueError`.

Wait with the CLI instead of writing a watcher:

```powershell
node "<projectRoot>/dist/src/cli.js" wait <id> [<id>...]
node "<projectRoot>/dist/src/cli.js" wait <a> <b> --after <a>=<revision>
node "<projectRoot>/dist/src/cli.js" wait <id> --until change --after <id>=<revision>
```

Launch one waiter with your client's background-task option and act on its completion; do not start duplicates. It takes up to eight IDs, prints one JSON result and returns when a task needs you: `attention` names those tasks. Tasks that were already accepted, integrated or cancelled when the wait started are ignored, so you can keep passing the same list. `--after <id>=<revision>` says you have already seen that task up to that revision; use it for a task you are still reviewing while others run. `--timeout-ms` sets an overall limit (exit 2); Ctrl+C exits 130 and only stops waiting. Without background tasks, use bounded `workflow_wait` calls with revision cursors. A waiter does not wake a disconnected supervisor.

For progress, read `workflow_status {id}` and look at `run`: steps against the limit, tokens, the last tool and idle seconds. Live progress does not change `revision`, so it never wakes a waiter. Report changes, not repeated identical status. A long idle time with a build or test as the last tool is normal; idle with no tool for many minutes deserves a look at the workspace.

Workers keep local implementation and debugging autonomy, run incremental checks only, cannot accept their own work and cannot orchestrate other workers. They return `needs_replan` when a fixed decision, architecture boundary or scope must change. Do not turn every implementation choice into a round trip.

How a run can end, and what to do:

| Status | Meaning | Next step |
|---|---|---|
| `awaiting_review` | Valid report, ready for you | Review the code, verify, then accept or rework. |
| `needs_changes` | You asked for rework, or `continuation.reason` is `report_invalid`: the work is done but the final report stayed invalid | Inspect `workflow_diff`, then `workflow_dispatch {id}`. Ordinary rework; no recovery attempt. |
| `blocked` with `continuation.reason:"step_limit"` | The run used its whole step budget | `workflow_dispatch {id}` continues the same session, without feedback and without a recovery attempt, up to `maxStepContinuations` times in a row. Consider a larger `workerSteps` or a smaller task. |
| `blocked` otherwise | Environment, access or dependency blocker | Diagnose, repair, then dispatch with diagnostic feedback (consumes a recovery attempt). |
| `needs_replan` | The contract conflicts with the code or itself | Diagnose and `workflow_plan_update`; never redispatch an unchanged plan. |
| `failed`, `interrupted` | The run did not complete | Read `lastError` and artifacts, inspect the workspace, then dispatch with diagnostic feedback (consumes a recovery attempt). |

`lastError` names the cause: `WORKER_MEMORY_LIMIT` (inspect the memory artifact, reduce build parallelism or targets; never bypass the user's budget), `WORKER_TOKEN_BUDGET`, a provider error, a timeout, or a process exit. Diagnose before retrying.

Feedback for rework and for recovery is always the structured form shown above, tied to the current `planRevision` and acceptance IDs; never free text. `maxAttempts` (default 5) limits only recovery dispatches after failed/interrupted/blocked runs. Initial execution, ordinary rework, step-limit continuations and report-invalid rework do not consume it; plan updates, successful rounds and daemon restarts do not reset it. At the limit, investigate or take over a focused fix and report the takeover; do not recreate the task to get a fresh budget.

Report format: unknown keys, an oversized summary, markdown fences and check-list bookkeeping are normalized automatically and listed in `reportSubmissions[].normalizations`. Other invalid reports get one automatic tool-disabled resubmission in the same run; while status shows report repair, do not dispatch again.

Two ways to change a task after creation:

- `workflow_plan_amend` for supervisor-side fields: your planned `checks`, `allowedPaths` and `resources`. The plan revision, worker report, session and evidence stay. Changing `checks` voids a passing round that ran the planned selection.
- `workflow_plan_update` for anything the worker acts on: goal, acceptance, steps, decisions, constraints, `workerChecks`. It bumps `planRevision`, clears the report, feedback and verification, and keeps the session, workspace, attempts and recovery budget. It cannot change the task's identity (repository, base, branch, provider, mode, workspace mode, dependencies); that needs a distinct task. Ask the user only when the decision is theirs.

You may make small integration changes or resolve a worker's persistent blocker yourself; keep bulk implementation delegated.

Record consequential decisions, repairs, unresolved risks and next actions with `workflow_note_add` (kind `decision`, `repair`, `risk`, `next_step` or `handoff`) as they happen, and write a handoff note before a context reset, before switching a shared directory and before the final report. Notes are your testimony without a source fingerprint and never count as verification. Build the final report from `workflow_handoff` and these records, separating worker claims, independent checks, your own repairs and omitted coverage; do not reconstruct passed checks from memory.

## Verify and accept

Review the changed code and criterion coverage first, then choose independent checks in proportion to risk. `workflow_verify {id}` runs the planned checks. Pass `selection:{strategy,rationale,checks,omittedCoverage}` (strategy `targeted`, `affected`, `smoke`, `full` or `custom`) to run a different set without changing the plan.

- A round stops at the first failing check. Pass `continueOnFailure:true` when the checks are independent and you want every result in one round.
- A failed check carries `tail` (the end of its output), `exitDetail` for abnormal exit codes and its log name in `workflow_status`; read the full log with `workflow_artifact` only when the tail is not enough.
- After a flaky or environmental failure, `workflow_verify {id,rerun:"failed"}` repeats the previous selection but runs only the checks that did not pass. Earlier passes are carried forward and marked `reusedFrom`, and only if the source is unchanged since that round. Say in your rationale that a check was rerun; do not rerun a real failure until it passes.
- After any source change, including your own repairs, select and run suitable checks again on the current source.

The default `verificationPolicy:"commands_required"` needs at least one passing independent command. A `review_allowed` contract may instead be accepted with `verification:{mode:"review_only",omittedCoverage:[...]}`, an explicit rationale and concrete code-review evidence; empty checks alone never waive verification. A worker's `pending_supervisor` criteria need your evidence and review before acceptance. A stopped round grants nothing; run suitable checks again.

Record your own repairs and externally run tests with `workflow_evidence_add {id,entry:{planRevision,kind,summary,criterionIds,evidence,log?}}` (kind `integration`, `verification` or `note`). The server stores the current source fingerprint; it does not run the commands or treat them as passing verification.

Accept only after code review and passing checks on the current source. State the strategy, evidence, omitted coverage and residual risk. A worker report is not independent evidence, and the server cannot judge whether your chosen scope was adequate.

For several tasks, validate the combined result in an integration workspace; creating and merging an integration branch is your work, not automatic. Do not push, open PRs, close issues or change GitHub state unless the user asks. Report workspace mode and path, branch and base commit, incremental and independent check results separately, risks, and the decisions the user should review, in Chinese.

## Housekeeping

`workflow_status {}` lists only unfinished tasks. Old tasks left in `awaiting_review`, `blocked` or `failed` keep their directory reserved (`workflow_capacity` shows `idleDays`); ask the user whether to finish or cancel them rather than leaving them. `workflow_archive {ids}` moves accepted, integrated or cancelled tasks to `.runtime/archive`: their records, branches and IDs are kept and they stay readable with `workflow_status {id}`. Pass `removeWorktree:true` only when the user wants the worktree directories gone; Git refuses to remove one that holds uncommitted or untracked files.

## Recovery and limits

The local daemon outlives MCP client disconnects. If you close, workers may finish, but nothing is planned or reviewed until you resume. `workflow_status` restores task IDs, workspaces, session IDs and evidence references. An unexpected daemon restart marks in-flight tasks `interrupted`; resuming is explicit and consumes a recovery attempt. A cancelled task keeps its files; cancellation does not undo edits.

OpenCode permissions and worktrees are not an OS sandbox. Use trusted repositories. The broad shell permission exists for build tools; publishing bans and `allowedPaths` are cooperation and review controls, not proof that shell code cannot bypass them. Investigators have file writes and general shell commands denied.
