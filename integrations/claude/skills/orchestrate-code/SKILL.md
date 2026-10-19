---
disable-model-invocation: true
name: orchestrate-code
description: Explicitly delegate a coding task or milestone to external OpenCode workers, then independently review their work and report results. Use when the user invokes this workflow.
---

Keep the current Claude/GPT main conversation as planner, supervisor and final reviewer. External OpenCode workers perform implementation through the `agent-orchestrator` MCP tools. Do not change the main model, authentication, provider endpoint or subscription login.

The workflow_config response includes projectRoot: use that path to find configuration, bundled examples and diagnostics; the client working directory remains the user's coding repository. Do not assume it is the workflow installation folder.

Only use this workflow when explicitly invoked. Read `workflow_config` first. If execution is disabled, stay in planning/review mode. A stored example task is not an instruction to run it. The alpha #244 example is authorized only after the user reviews the workflow, supplies credentials and explicitly starts that task.

## Plan and investigate

Read repository-root AGENTS.md and the relevant module AGENTS.md files. Use read-only investigator tasks for detailed exploration when useful; keep the main context focused on decisions, dependencies and evidence. The investigator can search/read files and use a narrow set of Git inspection commands; perform other needed read-only inspections yourself.

State the goal, acceptance criteria, scope, base branch, actual build/test commands and important decisions. Identify dependencies before parallelizing. Ask only about consequential product/design choices or missing information that blocks a sound implementation. Batch related questions. Honor any user-requested approval-before-code stage; do not treat elapsed time as approval.

Use `workflow_task_create` with contractVersion=1 and planRevision=1. Include goal/nonGoals, decisions with rationale, contextRefs, steps with dependencies and fixed/adaptable flexibility, autonomy.localDecisions/escalateWhen, and acceptance items with stable IDs. Do not send the whole chat. Send the relevant decisions and evidence so the worker can act without repeating project planning.

Use `workflow_prepare` to create its isolated branch/worktree, recording the actual base commit. For a latest-master request, set fetchRemote=origin and baseRef=origin/master. Never reuse a shared build directory. Inheriting accepted dependency code requires prerequisites committed and verified BEFORE acceptance and present in baseRef; scheduling dependencies alone do not merge code. Resolve the integration baseline before preparing dependent tasks.

## Execute and supervise

Dispatch independent tasks up to the configured limit. Use `workflow_wait` with the last revision values for bounded waits; inspect changes instead of narrating repeated identical status. Keep full transcripts in the backend; retrieve report/log excerpts only when they resolve a specific question. Workers may read applicable project instructions, implement, build, test and repair within the task. They do not control supervisor acceptance or recursively orchestrate other workers.

Workers use dedicated executor/investigator system prompts. Built-in build/plan/general/explore/scout are disabled; task/plan tools are denied. They keep local implementation/debugging autonomy but return `needs_replan` when a fixed decision, architecture boundary or scope needs to change. Do not forbid necessary local reasoning or turn every implementation choice into a supervisor round trip.

Read `report.json` for the criterion-linked report. For ordinary rework, invoke `workflow_review` with decision=rework and structured feedback: {planRevision, summary, findings:[{criterionIds, description, evidence, requestedChange}]}. Dispatch again to continue the same OpenCode session. Failed/interrupted/blocked sessions need the same structured diagnostic feedback at dispatch. Do not send unversioned free-text feedback.

For `needs_replan`, diagnose the contradiction and use `workflow_plan_update` with expectedPlanRevision, a full revised spec with planRevision incremented by exactly one, and changeReason. Ask the user only when the decision actually requires them. The update invalidates previous evidence/feedback and preserves the session, worktree and attempt budget. Do not dispatch an unchanged plan after needs_replan. Do not update active/accepted plans or change task execution identity; new repository/base/provider/mode needs a distinct task. At the attempt limit, investigate or take over a focused fix; do not evade the limit by recreating identical tasks. Report supervisor takeover and its reason.

The supervisor may make small integration changes or solve a worker's persistent blocker. Keep bulk implementation delegated. A valid report outcome ready_for_review leads to awaiting_review; blocked and needs_replan are explicit non-completion states. Missing/malformed/stale reports fail the round. A worker cannot report accepted.

## Verify and accept

Read the actual changed code (including untracked new files), check issue coverage and project invariants, then invoke `workflow_verify`. Verification runs asynchronously outside the model; wait for its results and read failure logs as needed. Exit codes and a source fingerprint are recorded. Rerun checks after source changes. A source fingerprint excludes ignored build outputs; it is not a complete environment reproducibility proof.

Use `workflow_review` with decision=accept only after reviewing the implementation and all required checks on the current source. Cite concrete code/tests/logs in evidence; a worker report is not independent evidence. The server checks status and test results, but cannot prove that a model actually reviewed the code. Never claim that the tool mechanically guarantees semantic correctness.

For multiple tasks, also validate their combined result in a separate integration worktree. Creating/merging that integration branch is supervisor work in v0.2; it is not automatic. Do not push, create PRs, close issues or change GitHub state unless the user asks. Report issue, branch/base commit, checks/counts where available, risks, and decisions requiring user review in Chinese.

## Recovery and limits

The local daemon outlives MCP client disconnects. If the supervisor closes, workers may finish but no new planning/review happens until the supervisor resumes. `workflow_status` restores task IDs, worktrees, session IDs and evidence references. Unexpected daemon restarts mark in-flight tasks interrupted; resumption is explicit and consumes another attempt. A cancelled task keeps its files; cancellation does not undo edits.

OpenCode permissions and worktrees are not an OS sandbox. Use trusted repositories. The broad implementation shell permission is needed for existing build tools; publishing bans and allowedPaths are cooperation/review controls, not a claim that arbitrary shell code cannot bypass them. Investigators have file writes and general shell commands denied.
