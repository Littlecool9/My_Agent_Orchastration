---
disable-model-invocation: true
name: orchestrate-code
description: Explicitly delegate a coding task or milestone to external OpenCode workers, then independently review their work and report results. Use when the user invokes this workflow.
---

Keep the current Claude/GPT main conversation as planner, supervisor and final reviewer. External OpenCode workers perform implementation through the `agent-orchestrator` MCP tools. Do not change the main model, authentication, provider endpoint or subscription login.

The workflow_config response includes projectRoot: use that path to find configuration, bundled examples and diagnostics; the client working directory remains the user's coding repository. Do not assume it is the workflow installation folder.

Only use this workflow when explicitly invoked. Read `workflow_config` first. If execution is disabled, stay in planning/review mode. A stored example task is not an instruction to run it. The alpha #244 example is authorized only after the user reviews the workflow, supplies credentials and explicitly starts that task.

Default new worker tasks to DeepSeek (provider=deepseek, configured deepseek-flash); use Kimi or another provider when the user selects it. Existing tasks retain their recorded provider/session; do not silently migrate their execution identity.

## Plan and investigate

Read repository-root AGENTS.md and the relevant module AGENTS.md files. Use read-only investigator tasks for detailed exploration when useful; keep the main context focused on decisions, dependencies and evidence. The investigator can search/read files and use a narrow set of Git inspection commands; perform other needed read-only inspections yourself.

State the goal, acceptance criteria, scope, base branch, actual build/test commands and important decisions. Identify dependencies before parallelizing. Ask only about consequential product/design choices or missing information that blocks a sound implementation. Batch related questions. Honor any user-requested approval-before-code stage; do not treat elapsed time as approval.

Use `workflow_task_create` with contractVersion=1 and planRevision=1. Include goal/nonGoals, decisions with rationale, contextRefs, steps with dependencies and fixed/adaptable flexibility, autonomy.localDecisions/escalateWhen, and acceptance items with stable IDs. Do not send the whole chat. Send the relevant decisions and evidence so the worker can act without repeating project planning.

Choose workspaceMode for the task: worktree is recommended for isolation, branch creates a new branch in the repository directory, and current uses the branch already checked out. Honor the user's choice; worktrees are optional. For current on the primary branch, first tell the user clearly that the task will modify that branch directly, then record the displayed text in mainBranchWarning. This is a warning, not a request for another approval. Use workflow_prepare to record the actual workspace and base commit; current never resets or pulls the checkout. Branch/current require a clean checkout and reserve that directory for one task until accepted/cancelled; preserve existing changes or choose isolation rather than stashing/resetting them automatically. For latest master, use fetchRemote=origin and baseRef=origin/master. Keep distinct build directories when concurrent workspaces need them. Inheriting accepted dependency code requires prerequisites committed and verified BEFORE acceptance and present in baseRef; scheduling dependencies alone do not merge code.

Separate testing in the contract: workerChecks contains targeted incremental checks; checks contains your planned independent validation commands. Choose scope yourself based on project size, changed modules, dependencies, risk and runtime: focused tests, affected-module tests, smoke, static checks or a full suite are all valid. Do not default large projects to a full build/test matrix. Honor current explicit user/project-required checks. Record your rationale and omitted coverage; do not claim unrun suites passed. Give checks stable names. Legacy workflow-generated full-suite mandates are superseded by this policy. Workers still run only incremental checks, recording bounded commands in criterion evidence if workerChecks is absent.

## Execute and supervise

Dispatch independent tasks in different directories up to the configured limit. Use `workflow_wait` with the last revision values for bounded waits; inspect changes instead of narrating repeated identical status. Keep full transcripts in the backend; retrieve report/log excerpts only when they resolve a specific question. Workers implement and run incremental checks only. They do not control supervisor acceptance or recursively orchestrate other workers.

Workers use dedicated executor/investigator system prompts. Built-in build/plan/general/explore/scout are disabled; task/plan tools are denied. They keep local implementation/debugging autonomy but return `needs_replan` when a fixed decision, architecture boundary or scope needs to change. Do not forbid necessary local reasoning or turn every implementation choice into a supervisor round trip.

workflow_config.workerMemoryLimitMB is the per-worker process-tree budget, default 3072 MiB. Windows Job Objects cover OpenCode and normally spawned compiler/test descendants. On WORKER_MEMORY_LIMIT inspect the worker memory artifact, reduce build parallelism/targets and diagnose before recovery. Do not blindly retry or bypass/increase the user's budget. The daemon/main conversation remains outside the worker job.

Read `report.json` for the criterion-linked report. For ordinary rework, invoke `workflow_review` with decision=rework and structured feedback: {planRevision, summary, findings:[{criterionIds, description, evidence, requestedChange}]}. Dispatch again to continue the same OpenCode session. Failed/interrupted/blocked sessions need the same structured diagnostic feedback at dispatch. Do not send unversioned free-text feedback.

For `needs_replan`, diagnose the contradiction and use `workflow_plan_update` with expectedPlanRevision, a full revised spec with planRevision incremented by exactly one, and changeReason. Ask the user only when the decision actually requires them. The update invalidates previous evidence/feedback and preserves the session, worktree and attempt budget. Do not dispatch an unchanged plan after needs_replan. Do not update active/accepted plans or change task execution identity; new repository/base/provider/mode needs a distinct task. At the attempt limit, investigate or take over a focused fix; do not evade the limit by recreating identical tasks. Report supervisor takeover and its reason.

The supervisor may make small integration changes or solve a worker's persistent blocker. Keep bulk implementation delegated. A valid report outcome ready_for_review leads to awaiting_review; blocked and needs_replan are explicit non-completion states. Missing/malformed/stale reports fail the round. A worker cannot report accepted.

## Verify and accept

Review actual changed code and issue coverage, then choose independent checks proportional to risk. Invoke workflow_verify with optional selection={strategy,rationale,checks,omittedCoverage}; strategy may be targeted/affected/smoke/full/custom. This changes the verification run without revising the whole task plan. Without selection it uses the planned checks. At least one actual independent command is required for implementation acceptance; even a small change may use a bounded static check. Full-suite testing is optional unless explicitly required by the current user/project contract. A worker's pending_supervisor criteria require your selected evidence and code review before acceptance. After repairs, select and rerun appropriate independent checks on current source, not automatically the whole suite. Verification records selection, exit codes, logs and a source fingerprint.

Use workflow_review decision=accept after code review and all independently selected checks pass on current source. State the strategy, concrete evidence, omitted coverage and residual risk in your rationale/final response. A worker report is not independent evidence; the server cannot prove semantic correctness or that the chosen scope is adequate.

For multiple tasks, validate their combined result in an integration workspace; a separate worktree is recommended but optional. Creating/merging an integration branch is supervisor work in v0.2; it is not automatic. Do not push, create PRs, close issues or change GitHub state unless the user asks. Report workspace mode/path, branch/base commit, incremental and full check results separately, risks, and decisions requiring user review in Chinese.

## Recovery and limits

The local daemon outlives MCP client disconnects. If the supervisor closes, workers may finish but no new planning/review happens until the supervisor resumes. `workflow_status` restores task IDs, worktrees, session IDs and evidence references. Unexpected daemon restarts mark in-flight tasks interrupted; resumption is explicit and consumes another attempt. A cancelled task keeps its files; cancellation does not undo edits.

OpenCode permissions and worktrees are not an OS sandbox. Use trusted repositories. The broad implementation shell permission is needed for existing build tools; publishing bans and allowedPaths are cooperation/review controls, not a claim that arbitrary shell code cannot bypass them. Investigators have file writes and general shell commands denied.
