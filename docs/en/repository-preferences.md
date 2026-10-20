# Repository preferences

[简体中文](../zh-CN/repository-preferences.md) | [Documentation index](README.md)

Repository preferences save reusable workflow choices locally. Tasks inherit them automatically, and each task stores its own full agreement. Repository-specific scripts belong in their owning repository when possible; local helpers can also live next to the profile.

## Automatic first-use initialization

Users can start an ordinary workflow task without knowing about profiles. The Skill checks for an existing profile and calls `workflow_repository_init {repository}` if missing. `workflow_task_create` independently ensures this too, so initialization does not depend on the agent remembering the Skill step. Reading `workflow_repository_config` stays read-only.

Minimal init needs only an absolute repository path. It generates an ID from the Git common directory and saves revision 1 with empty defaults/limits/requirements, plus a local `scripts/` directory. It returns `{created,profile,identity,effectiveLimits}`. Repeated calls reuse the existing profile without rewriting it or changing its revision. Concurrent calls and worktrees converge on the same binding; generated-ID collisions never overwrite another repository's profile. A failed contract validation after first-use init may still leave this valid minimal profile in place.

No provider, validation strategy, test command, resource budget or coding preference is inferred or copied from a task. Unset values inherit built-in defaults; `commands_required` remains the default acceptance policy. Init does not run tests/models or change target repository files, and works with execution disabled. Normal repository-rule reading and meaningful task decisions continue as usual; there is no profile setup questionnaire. Missing repositories, invalid profiles and duplicate bindings remain explicit errors rather than being overwritten.

## Bind and configure a repository

Read `workflow_repository_config {repository}` to see the binding, profile revision/hash, preferences and effective resource limits. To customize an initialized profile, pass its returned ID and current revision (normally 1) to `workflow_repository_config_update`, preserving unrelated preferences. If you explicitly configure a named profile before automatic initialization, use your chosen ID and `expectedRevision=0`, for example:

```json
{
  "repository": "C:/path/to/project",
  "id": "my-project",
  "expectedRevision": 0,
  "preferences": {
    "defaults": {
      "provider": "deepseek",
      "baseRef": "HEAD",
      "workspaceMode": "worktree",
      "verificationPolicy": "review_allowed"
    },
    "requirements": { "constraints": ["Preserve existing author headers and CRLF."] },
    "limits": { "workerMemoryLimitMB": 2048 }
  }
}
```

This example intentionally permits explicit code-review-only acceptance. Keep the default `commands_required` policy for repositories that require independent commands, and provide their checks in the defaults or task input. The [longer example](../../examples/repository-preferences.json) also sets resource defaults.

Profiles are written under `skills/orchestrate-code/repositories.local/<id>/profile.json` in the orchestrator installation; the adjacent `scripts/` directory is created too. This area is ignored by Git. Existing profiles require their current revision for updates. Updates replace the preference document, increment its revision and affect new tasks. They never dispatch work or rewrite existing tasks.

Binding uses Git's canonical common directory, including Windows case normalization. Worktrees share one binding; identically named repositories and separate clones remain independent. Copy/export the local profile directory for backup or migration, then use the same ID/current revision with `rebind=true` to explicitly bind it to the new repository. Duplicate bindings and accidental ID reuse are rejected. Malformed profiles produce an explicit error instead of silently losing preferences.

## Defaults and requirements

- `defaults`: base/fetch references, branch prefix, provider, workspace mode, task mode, repeated non-goals, decisions, context references, steps, autonomy, constraints, allowed paths, worker/supervisor checks, verification policy and resource settings.
- `requirements.constraints`: always appended and deduplicated, even when a task replaces default constraints. These are contract instructions, with the same review/cooperation boundaries as other task constraints.
- `requirements.verificationPolicy=commands_required`: prevents tasks from weakening command-based acceptance.
- `limits`: repository caps for `workerMemoryLimitMB` and `taskTimeoutMinutes`. The machine configuration is also a hard ceiling; task/default values above the smaller ceiling are rejected. Omitted resources use the effective ceiling. Worker startup and overall worker execution respect the smaller task/current-machine budgets. These settings do not add a memory guard to supervisor verification commands.

Task-supplied scalar values and arrays replace defaults, including explicit empty arrays; resources merge by field. Put rules that must survive overrides in `requirements.constraints`. A temporary override affects that task only. Persistent changes use the profile update operation.

## Create a short contract

`workflow_task_create` needs only four fields inside `spec`:

```json
{
  "spec": {
    "id": "feature-one",
    "repository": "C:/path/to/project",
    "goal": "Implement the selected feature within the agreed module boundary.",
    "acceptance": [{ "id": "AC-01", "requirement": "Describe the observable acceptance condition." }]
  }
}
```

Add task-specific design decisions, scope, checks or steps when useful. Full existing contracts remain supported. Without repository overrides, built-ins use contract/plan version 1, `baseRef=HEAD`, branch `codex/<id>`, DeepSeek, worktree mode, one adaptable step and bounded local autonomy. The title defaults to the first 120 characters of the goal. Implementation contracts still need a check unless they explicitly allow review-only acceptance.

The task stores the resolved `TaskSpec` and `configuration-v<planRevision>.json`. This artifact includes the complete profile, revision/hash, original task overrides, effective limits and field provenance (`builtin`, `repository_default`, `task`, `repository_requirement` or `previous_plan`). Execution identity remains fixed across plan revisions. The worker receives the resolved contract and profile identity; routine status only adds the profile reference, not the full preference document.

## Change plans and preferences

`workflow_plan_update` accepts a partial `spec`, for example `{goal:"Clarified goal"}`, with task ID, `expectedPlanRevision` and `changeReason`. The next plan revision is automatic unless explicitly supplied. It resolves against the task's frozen profile and retains explicit task overrides. Older configuration artifacts remain available.

Use `refreshRepositoryProfile=true` on an explicit plan update to adopt current preferences. Frozen execution identity stays unchanged; its provenance may point to `previous_plan`. Editing a live profile alone never changes a running or existing task. Active/accepted/terminal plan restrictions remain in force.

## Verification and scripts

The default `commands_required` policy retains independent-command acceptance. `review_allowed` permits an explicit `workflow_review` acceptance with:

```json
{
  "id": "feature-one",
  "decision": "accept",
  "rationale": "Explain the code review and why the omitted testing is acceptable.",
  "evidence": ["Concrete source/criterion references"],
  "verification": { "mode": "review_only", "omittedCoverage": ["Automated regression tests"] }
}
```

This records the reviewed source fingerprint and omissions without claiming tests passed. Empty checks alone do not authorize it. Criteria that explicitly require testing still need their actual evidence. `workflow_verify` itself continues to require an actual command for implementation verification.

For local scripts, use `profile://scripts/check.ps1` as a check command or argument. It resolves to an existing file inside this profile directory, including paths with spaces. Checks execute in the actual task workspace. Missing files, traversal and references resolving outside the profile directory are rejected. Scripts are maintained separately; configuration snapshots preserve resolved paths and preferences, not copies of script contents. No rule-file synchronization hook is introduced.
