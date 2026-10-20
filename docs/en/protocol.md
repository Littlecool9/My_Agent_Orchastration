# Task handoff protocol v1 (implementation v0.2)

**English** | [简体中文](../zh-CN/protocol.md) | [Documentation](README.md)

The v0.1 free-text acceptance/feedback format must be upgraded to the versioned, ID-based structures below. Historical executed tasks are not automatically guessed or converted. Stored tasks retain their execution identity, with compatible defaults for newer fields.

The Claude/GPT supervisor owns the plan. MCP submits JSON, Zod validates it and the scheduler stores it. The complete contract becomes an OpenCode user message; separate role prompts define responsibilities. There is no extra planning model and no forwarding of the full supervisor conversation. Workers may make local implementation/debugging choices; fixed design, scope and interface changes require escalation.

## Input

`TaskSpec` uses `contractVersion=1` and `planRevision` starting at 1. Its execution identity consists of `id`, `repository`, `baseRef`, `branch`, `provider`, `mode`, `workspaceMode` and `dependencies`. The agreement includes goal/non-goals, decisions with rationale, context references, ordered steps with earlier-step dependencies and fixed/adaptable flexibility, autonomy, acceptance criteria with stable IDs, constraints, allowed paths and two check lists.

See the [complete example](../../examples/alpha-244.json); [src/schema.ts](../../src/schema.ts) is authoritative.

Every dispatch generates a `runId`, adds the attempt and resolved workspace path/mode/base commit, and writes `contract.json` plus immutable `contract-run-UUID.json`. This is the contract received for that run. State transitions use `revision`; plan changes use `planRevision`.

`workerChecks` contains incremental worker commands; `checks` contains the supervisor's planned independent verification. In the dispatched contract, the worker-facing `checks` list is projected from `workerChecks`; supervisor checks are represented by names and pending-supervisor markers. Legacy tasks without worker checks choose bounded incremental commands and record results in acceptance evidence, rather than running old full-suite steps. `pending_supervisor` requires supervisor check configuration and never means a check has passed.

The default provider is `deepseek`. `workspaceMode` defaults to recommended `worktree`, with `branch` and `current` also supported. Using `current` on a main branch requires a displayed and recorded `mainBranchWarning`. Original-checkout modes require a clean checkout and exclusive task occupancy, with the same branch and source-fingerprint protections as worktrees.

`workflow_verify` accepts `selection={strategy,rationale,checks,omittedCoverage}`. Strategies are `planned`, `targeted`, `affected`, `smoke`, `full` and `custom`. Without selection, planned checks run. With selection, only those commands run; the selection does not mutate `TaskSpec` or `planRevision`. Implementation acceptance requires at least one independent command and checks the selected results against the current source fingerprint. Full verification is selected when risk or the current user request calls for it.

Global `workerMemoryLimitMB` defaults to 3072 MiB committed memory per worker. Windows attaches the Job Object before OpenCode resumes execution, and ordinary descendants inherit it. Limit/guard failures appear in worker artifacts and diagnostics. Recovery retains source/session and does not automatically raise the limit.

## Waiting, verification rounds and supervisor evidence

`workflow_wait` remains a bounded revision wait (maximum 25 seconds), woken by task saves. Client disconnect cancels only that read. `node dist/src/cli.js wait <id>` composes bounded reads into one blocking CLI process; `--until change`, repeated `--after <id>=<revision>`, and `--timeout-ms` select revision waiting, reconnect cursors and an overall limit. The default returns when any task needs supervisor attention, rather than waiting for `accepted`. Output is `{reason,tasks}`; timeout returns the latest known snapshot and exits 2. Ctrl+C exits 130 without cancelling work.

Each verification gets a `verificationRunId`, a `verification-UUID.json` artifact and unique `verify-UUID-<check>.log` files. `verificationHistory` stores round references; artifacts preserve selection, plan/worker run identity, source fingerprints, results and final status (`passed`, `failed`, `stopped`, `cancelled` or `interrupted`). Reverification, rework and plan changes retain this history. Existing legacy check results/logs are archived before they are cleared. Legacy records have no reliable start time; their recorded finish time is used for both timestamps.

`workflow_verify_stop {id,reason}` aborts only verification, waits for process-tree exit and returns the task to `awaiting_review`. Completed checks survive; an interrupted command has `status=stopped`, `passed=false` and `exitCode=null`. No later checks launch. A round without completed source validation cannot grant acceptance. A completed round wins a race with stop; repeated stops of that round are harmless. Whole-task cancellation remains terminal.

`workflow_evidence_add {id,entry}` appends supervisor-supplied evidence. `entry` contains current `planRevision`, `kind=integration|verification|note`, a summary, nonempty criterion IDs and evidence references, and an optional log (at most 200,000 characters). The server records a unique artifact, current source fingerprint, worker run identity and timestamp, redacting configured secrets. Unknown criteria, stale plans and active execution are rejected. Recording is allowed after cancellation and does not reopen the task or grant independent verification. Inspect `supervisorEvidence` references and use `workflow_artifact` to read the records.

## Output

The worker's final response must be a single JSON object matching `WorkerReportSchema`. Markdown wrappers, plain text and inferred statuses are rejected. Fields include `taskId`, `planRevision`, `runId`, `attempt`, `summary`, `acceptanceResults`, `checks`, `changedFiles`, `deviations` and `blockers`.

- `ready_for_review`: each acceptance ID appears exactly once. Implemented criteria are `met`; criteria waiting for supervisor verification are `pending_supervisor`. Both require evidence. Each worker check appears once as `passed`, with no implementation blocker. The task enters `awaiting_review`, not `accepted`.
- `blocked`: environment, access or dependency issue, with evidence and a proposed next step. Retry the existing plan after supervisor diagnostic feedback.
- `needs_replan`: contract/design conflict or required scope change, with evidence and a proposed change. The supervisor must update the plan before redispatching.

The application checks run identity, complete coverage, evidence presence and status consistency. It cannot prove natural-language evidence is true. Verification runs actual commands, and the supervisor reviews code.

`report.json` is the validated current report. `raw-report-attempt-N.json` preserves raw output; `worker-report.md` is a generated Chinese summary, and `transcript.json` stores execution history. Translating repository guides does not change these runtime output formats.

## Rework

`workflow_review` with `decision=rework` requires feedback:

```json
{
  "planRevision": 1,
  "summary": "Add allocator boundary validation",
  "findings": [
    {
      "criterionIds": ["AC-02"],
      "description": "Node IDs wrap at the upper limit",
      "evidence": ["Specific source location", "Failing test or log"],
      "requestedChange": "Reject allocation overflow and add a regression test"
    }
  ]
}
```

The version must match the current plan and every referenced criterion must exist. Diagnostic redispatch after `failed`, `interrupted` or `blocked` uses the same structure. Feedback references a plan; it does not implicitly change it.

## Plan updates

`workflow_plan_update` accepts `id`, `expectedPlanRevision`, a complete new `spec` and `changeReason`. The plan version increases by exactly one. Updates are disallowed while running, verifying, accepted or cancelled, and cannot change execution identity.

The scheduler archives the old plan and clears obsolete feedback, reports, checks and verification fingerprints, while retaining workspace, session, changes and attempts. The next contract supersedes prior task instructions; useful investigation can still be reused.

Changing a baseline, repository or provider needs a distinct task and explicit migration, rather than applying old evidence to a different identity. `attempts` monotonically records every dispatch. Normal review/rework has no round limit. `maxAttempts` defaults to 5 and limits only cumulative recovery dispatches (`recoveryAttempts`) after `failed`, `interrupted` or `blocked`; initial execution is excluded. Updating the plan in an abnormal state still requires diagnostic feedback and consumes recovery budget. Plan updates, normal completion and daemon restarts do not reset it. Diagnose at the limit rather than recreating an identical task.

## OpenCode compatibility

Local experiments with pinned OpenCode 1.19.3 produced structured output using native `format=json_schema`, but subsequent message reads failed with `OutputFormatJsonSchema`, affecting recovery. v0.2 carries strict JSON in ordinary messages and validates schema plus semantic consistency in the application. It does not depend on that native format or modify the binary. Local fake-model tests check role prompts and JSON requirements; actual design-boundary compliance still requires real-task acceptance.
