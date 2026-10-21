---
disable-model-invocation: true
name: orchestrate-code
description: Explicitly delegate a coding task or milestone to external OpenCode workers, then independently review their work and report results. Use when the user invokes this workflow.
---

## Start here

1. Call `workflow_config` first. Its `projectRoot` is the orchestrator installation, while your current directory is the target coding repository. Follow the returned `guidance` paths when the workflow's usage is unclear.
2. Read the target repository's `CLAUDE.md` and its local instruction references (including `AGENTS.md`); if absent, read `AGENTS.md`. Apply relevant module instructions too. The orchestrator's root `AGENTS.md` is for maintaining the orchestrator, not a substitute for target project rules.
3. Read `workflow_repository_config {repository}`. Initialize a missing profile with `workflow_repository_init {repository}`; do not interrupt the user for minimal bookkeeping. Inspect its defaults, requirements, effective limits and adjacent check recipes/scripts before inventing commands.
4. For an existing task, read `workflow_status {id}` and its current contract before resuming. Otherwise create the plan, prepare, dispatch, wait, review actual code, independently verify, then accept or request rework.

## Capability index

| Need | Tool or command and how to use it |
|---|---|
| Installation path, execution gate and provider settings | `workflow_config {}`; it also points to this guide, repository guidance and the update entry. |
| Reusable project settings and hard limits | `workflow_repository_config {repository}`; worktrees share the binding. |
| Minimal first-use profile | `workflow_repository_init {repository}`; only an absolute repository path is needed. |
| Explicit persistent preferences | `workflow_repository_config_update {repository,id,expectedRevision,preferences}`; preserve unrelated preferences. |
| A new task | `workflow_task_create {spec:{id,repository,goal,acceptance}}` plus task-specific scope/checks; inherited defaults are frozen. |
| Workspace preparation | `workflow_prepare {id}`; records the actual base and selected workspace mode. |
| Start or resume a worker | `workflow_dispatch {id,feedback?}`; recovery needs structured diagnostic feedback. |
| Progress and revision cursor | `workflow_status {id}`; retain the returned `revision`. |
| Short MCP wait | `workflow_wait {ids,after,timeoutMs}`; each request is limited to 25 seconds. |
| Continuous/background wait | `node "<projectRoot>/dist/src/cli.js" wait <id>`; see the waiting instructions below. |
| Changed files and actual code review | `workflow_diff {id}`, then read the indicated workspace files. |
| Contract, reports, verification logs or evidence | `workflow_artifact {id,name,offset?,length?}`; use names from status and bounded excerpts. |
| Independent verification | `workflow_verify {id,selection?}`; selection changes the check scope without a plan update. |
| Stop only verification | `workflow_verify_stop {id,reason}`; retains the task/report and completed checks. |
| Append supervisor integration/check notes | `workflow_evidence_add {id,entry}`; records testimony, not automatic acceptance. |
| Accept or request rework | `workflow_review {id,decision,rationale,evidence,feedback?,verification?}`; obey the contract's verification policy. |
| Change the agreed plan | `workflow_plan_update {id,expectedPlanRevision,spec,changeReason}`; currently invalidates old evidence. |
| Stop the entire task | `workflow_cancel {id}`; terminal cancellation preserves edits and history. |
| Refresh an installed workflow | `node "<projectRoot>/scripts/update.mjs" --check`, then the same command without `--check`; see `docs/en/updating.md`. |

These are distinct operations: verification is asynchronous, cancelling a waiter only stops waiting, and `awaiting_review` is not acceptance. `integrated` records a historical delivery and does not satisfy the `accepted` dependency gate. Use available tool discovery if a listed MCP tool is not loaded; never invent a missing tool's behavior.

## Scope and resource syntax

`allowedPaths` currently matches literal repository-relative files and directory prefixes, such as `CMakeLists.txt` and `modules/prefab`. It does not support `*`, `**` or other glob syntax. Check the values before creation; the current API can otherwise defer a scope error until verification. An empty list permits all paths. Resources cannot exceed the effective machine/repository limits returned by `workflow_repository_config`; a numeric schema maximum is not the current execution budget.

Keep the current Claude/GPT main conversation as planner, supervisor and final reviewer. External OpenCode workers perform implementation through the `agent-orchestrator` MCP tools. Do not change the main model, authentication, provider endpoint or subscription login.

The workflow_config response includes projectRoot: use that path to find configuration, bundled examples and diagnostics; the client working directory remains the user's coding repository. Do not assume it is the workflow installation folder.

Keep repository-specific scripts in their owning repository when possible. Local scripts and profiles maintained alongside this Skill belong in projectRoot/skills/orchestrate-code/repositories.local/<repository-id>/, with profile.json and scripts/ under that directory; it is ignored by Git. Read workflow_repository_config for the target repository before planning. If profile is null, call workflow_repository_init with only repository as a routine preparation step, then continue the user's task. Do not require the user to know about profiles, choose an ID, fill out a setup questionnaire or approve this minimal local bookkeeping. Task creation also initializes a missing profile if you omit this step. Existing profiles are reused unchanged. One Git common directory binds one profile across worktrees; separate clones have separate bindings.

Minimal initialization records repository identity and empty preferences only. Unknown validation/resource/style settings remain unset and inherit built-in defaults; it does not infer test commands, permit skipping tests, or persist the current task's choices. Read repository-owned rules as part of normal planning. Save additional long-term preferences only when their persistent applicability is clear from the user's instruction, preserving unrelated existing preferences. Use workflow_repository_config_update with the profile's returned ID/current revision (normally 1 after init). A task-specific override does not update the profile. Ask only about consequential task decisions that cannot be resolved normally; profile setup itself should not interrupt the task.

Only use this workflow when explicitly invoked. Read `workflow_config` first. If execution is disabled, stay in planning/review mode. A stored example task is not an instruction to run it; dispatch requires the user's task instruction and configured credentials.

Default new worker tasks to DeepSeek (provider=deepseek, configured deepseek-flash); use Kimi or another provider when the user selects it. Existing tasks retain their recorded provider/session; do not silently migrate their execution identity.

## Plan and investigate

Read the target repository's instruction entry and relevant module rules as described in Start here. Use read-only investigator tasks for detailed exploration when useful; keep the main context focused on decisions, dependencies and evidence. The investigator can search/read files and use a narrow set of Git inspection commands; perform other needed read-only inspections yourself.

State the goal, acceptance criteria, scope, base branch, actual build/test commands and important decisions. Identify dependencies before parallelizing. Ask only about consequential product/design choices or missing information that blocks a sound implementation. Batch related questions. Honor any user-requested approval-before-code stage; do not treat elapsed time as approval.

Use workflow_task_create with spec containing id, repository, goal and acceptance items with stable IDs. Add this task's necessary decisions, nonGoals, contextRefs, steps, autonomy and overrides; omitted fields inherit repository defaults or built-in defaults (contractVersion/planRevision=1, baseRef=HEAD, branch=codex/<id>, a single adaptable step). Full contracts remain supported. Task-provided arrays replace defaults; repository requirements.constraints are always appended. Resources merge by field and cannot exceed repository/machine caps. The server stores a full resolved spec and configuration-vN.json with profile revision/hash, overrides and provenance. Read that artifact when you need the complete agreement. Do not send the whole chat or repeat inherited settings.

For locally maintained check scripts, profile://scripts/<file> in command/args resolves under the bound profile directory when the contract is created/revised; the referenced file must exist and remain inside that directory. Commands run from the actual task workspace. Script files themselves remain repository/local-maintainer-owned and are not copied into the task snapshot. See docs/en/repository-preferences.md under projectRoot for setup, partial plan updates and explicit profile rebinding after a move/import.

Choose workspaceMode for the task: worktree is recommended for isolation, branch creates a new branch in the repository directory, and current uses the branch already checked out. Honor the user's choice; worktrees are optional. For current on the primary branch, first tell the user clearly that the task will modify that branch directly, then record the displayed text in mainBranchWarning. This is a warning, not a request for another approval. Use workflow_prepare to record the actual workspace and base commit; current never resets or pulls the checkout. Branch/current require a clean checkout and reserve that directory for one task until accepted/cancelled; preserve existing changes or choose isolation rather than stashing/resetting them automatically. For latest master, use fetchRemote=origin and baseRef=origin/master. Keep distinct build directories when concurrent workspaces need them. Inheriting accepted dependency code requires prerequisites committed and verified BEFORE acceptance and present in baseRef; scheduling dependencies alone do not merge code.

Separate testing in the contract: workerChecks contains targeted incremental checks; checks contains your planned independent validation commands. Choose scope yourself based on project size, changed modules, dependencies, risk and runtime: focused tests, affected-module tests, smoke, static checks or a full suite are all valid. Do not default large projects to a full build/test matrix. Honor current explicit user/project-required checks. Record your rationale and omitted coverage; do not claim unrun suites passed. Give checks stable names. Legacy workflow-generated full-suite mandates are superseded by this policy. Workers still run only incremental checks, recording bounded commands in criterion evidence if workerChecks is absent.

## Execute and supervise

Dispatch independent tasks in different directories up to the configured limit. Use `workflow_wait` with the last revision values for bounded waits; inspect changes instead of narrating repeated identical status. Keep full transcripts in the backend; retrieve report/log excerpts only when they resolve a specific question. Workers implement and run incremental checks only. They do not control supervisor acceptance or recursively orchestrate other workers.

For a long shell wait, use the built-in CLI instead of writing a watcher. Replace `<projectRoot>` with the value from `workflow_config`:

```powershell
node "<projectRoot>/dist/src/cli.js" wait <id>
node "<projectRoot>/dist/src/cli.js" wait <id> --until change --after <id>=<revision>
```

When running in the installation directory, `npm run wait -- <id>` is equivalent. In a client with background-shell support, launch one waiter using that client's background-task option and use its completion notification; do not launch duplicate watchers. If background tasks are unavailable, keep using bounded `workflow_wait` calls with revision cursors.

The CLI supports up to eight IDs and chains bounded backend reads in one process. Default `--until attention` returns when any task needs supervisor attention, including review, replan, failure or cancellation. `--until change` waits for a revision change; `--after <id>=<revision>` resumes a cursor. `--timeout-ms` sets the overall limit (default 0 is unlimited). It prints one JSON result: inspect `reason` and each task's status before choosing the next operation. Timeout exits 2; Ctrl+C exits 130 and only stops waiting. Attention is not acceptance. The CLI reconnects read requests and never dispatches work. It does not wake a disconnected supervisor.

Workers use dedicated executor/investigator system prompts. Built-in build/plan/general/explore/scout are disabled; task/plan tools are denied. They keep local implementation/debugging autonomy but return `needs_replan` when a fixed decision, architecture boundary or scope needs to change. Do not forbid necessary local reasoning or turn every implementation choice into a supervisor round trip.

workflow_config.workerMemoryLimitMB is the per-worker process-tree budget, default 3072 MiB. Windows Job Objects cover OpenCode and normally spawned compiler/test descendants. On WORKER_MEMORY_LIMIT inspect the worker memory artifact, reduce build parallelism/targets and diagnose before recovery. Do not blindly retry or bypass/increase the user's budget. The daemon/main conversation remains outside the worker job.

Read `report.json` for the criterion-linked report. For ordinary rework, invoke `workflow_review` with decision=rework and structured feedback: {planRevision, summary, findings:[{criterionIds, description, evidence, requestedChange}]}. Dispatch again to continue the same OpenCode session. Failed/interrupted/blocked sessions need the same structured diagnostic feedback at dispatch. Do not send unversioned free-text feedback.

For needs_replan, diagnose the contradiction and use workflow_plan_update with expectedPlanRevision, a spec patch and changeReason. Omitted fields are preserved/resolved from the frozen profile; omitted planRevision becomes expected+1. Full revised specs remain supported. Set refreshRepositoryProfile=true only to explicitly adopt the current profile in a new plan revision; execution identity remains fixed. Ask the user only when the decision actually requires them. The update invalidates previous evidence/feedback and preserves the session, worktree, total run count and recovery budget. Do not dispatch an unchanged plan after needs_replan. Do not update active/accepted plans or change task execution identity; new repository/base/provider/mode needs a distinct task. Continue review, verification and rework until acceptance criteria are met; ordinary rework and needs_replan revisions have no round limit. maxAttempts defaults to 5 and only limits cumulative recovery dispatches after failed/interrupted/blocked runs. Initial execution and ordinary rework do not consume recovery budget. Plan updates, successful rounds and daemon restarts do not reset it. Recovery after a plan update still requires current diagnostic feedback. At the recovery limit, investigate or take over a focused fix; do not evade the limit by recreating identical tasks. Report supervisor takeover and its reason.

The supervisor may make small integration changes or solve a worker's persistent blocker. Keep bulk implementation delegated. A valid report outcome ready_for_review leads to awaiting_review; blocked and needs_replan are explicit non-completion states. Missing/malformed/stale reports fail the round. A worker cannot report accepted.

## Verify and accept

Review actual changed code and issue coverage, then choose independent checks proportional to risk. Invoke workflow_verify with optional selection={strategy,rationale,checks,omittedCoverage}; strategy may be targeted/affected/smoke/full/custom. This changes the verification run without revising the whole task plan. Without selection it uses the planned checks. Default verificationPolicy=commands_required requires at least one passing independent command. Contracts with verificationPolicy=review_allowed may instead accept through workflow_review verification={mode:review_only,omittedCoverage:[...]}, with explicit rationale and concrete code-review evidence; empty checks alone never waive verification. The review records the current source fingerprint without inventing successful commands. Honor explicitly test-dependent acceptance criteria and current user/project-required checks. Full-suite testing is optional unless explicitly required. A worker's pending_supervisor criteria require your selected evidence and code review before acceptance. After repairs, select and rerun appropriate independent checks on current source, not automatically the whole suite. Verification records selection, exit codes, logs and a source fingerprint.

Use workflow_verify_stop {id,reason} to stop checks without cancelling the task. It waits for the check process tree to exit and returns to awaiting_review, retaining the worker report, completed checks and per-round artifacts. A stopped round does not grant acceptance; choose and run the appropriate checks again. A stop after completion leaves that completed round unchanged. workflow_status lists verificationHistory and unique round/log filenames; retrieve them through workflow_artifact instead of assuming verify-<check>.log.

Record supervisor repairs and external tests through workflow_evidence_add {id,entry:{planRevision,kind,summary,criterionIds,evidence,log?}}, where kind is integration/verification/note. Supply concrete commands/results and criterion IDs. The server appends an artifact with the current source fingerprint and run identity; it does not execute those commands or treat testimony as a passing verification. Evidence can be appended after cancellation without reopening the task. Stop active execution before adding it.

Use workflow_review decision=accept after code review and all independently selected checks pass on current source. State the strategy, concrete evidence, omitted coverage and residual risk in your rationale/final response. A worker report is not independent evidence; the server cannot prove semantic correctness or that the chosen scope is adequate.

For multiple tasks, validate their combined result in an integration workspace; a separate worktree is recommended but optional. Creating/merging an integration branch is supervisor work in v0.2; it is not automatic. Do not push, create PRs, close issues or change GitHub state unless the user asks. Report workspace mode/path, branch/base commit, incremental and full check results separately, risks, and decisions requiring user review in Chinese.

## Recovery and limits

The local daemon outlives MCP client disconnects. If the supervisor closes, workers may finish but no new planning/review happens until the supervisor resumes. `workflow_status` restores task IDs, worktrees, session IDs and evidence references, with separate total attempts and recoveryAttempts/recoveryAttemptLimit/remainingRecoveryAttempts. Unexpected daemon restarts mark in-flight tasks interrupted; resumption is explicit and consumes one recovery retry. A cancelled task keeps its files; cancellation does not undo edits.

OpenCode permissions and worktrees are not an OS sandbox. Use trusted repositories. The broad implementation shell permission is needed for existing build tools; publishing bans and allowedPaths are cooperation/review controls, not a claim that arbitrary shell code cannot bypass them. Investigators have file writes and general shell commands denied.
