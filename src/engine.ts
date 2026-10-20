import path from 'node:path';
import { readFileSync, writeFileSync, existsSync, realpathSync, renameSync, copyFileSync } from 'node:fs';
import { Store } from './store.js';
import { executionGuard, redact } from './config.js';
import { prepareWorkspace, workspaceMode, workspaceKey, assertAllowedPaths, assertWorktree, fingerprint, changedFiles } from './worktree.js';
import { runCommand, git } from './process.js';
import type { Config, Task, TaskSpec, VerificationRun, SupervisorEvidenceInput, RepositoryConfiguration, TaskInput, TaskPlanPatch, ReviewVerification } from './schema.js';
import type { Worker } from './opencode.js';
import { TaskSpecSchema, TaskInputSchema, TaskPlanPatchSchema, ReviewVerificationSchema, VerificationSelectionSchema, SupervisorEvidenceSchema, type VerificationSelection, type Feedback } from './schema.js';
import { RepositoryProfiles, repositoryIdentity, resolveTaskInput, resourceLimits, assertResourceLimits } from './repository-profile.js';
import { randomUUID } from 'node:crypto';
import { taskContract, validateFeedback, validateReport, renderReport } from './protocol.js';

export class Engine {
  readonly store: Store;
  readonly profiles: RepositoryProfiles;
  private busy = new Set<string>();
  private preparingWorkspaces = new Set<string>();
  private running = new Set<string>();
  private verifying = new Map<string, AbortController>();
  private promises = new Map<string, Promise<void>>();
  constructor(readonly root: string, readonly config: Config, readonly env: NodeJS.ProcessEnv, readonly worker: Worker) {
    this.store = new Store(path.join(root, '.runtime/tasks'));
    this.profiles = new RepositoryProfiles(root);
    for (const t of this.store.all()) if (['running', 'verifying'].includes(t.status)) {
      if (t.status === 'verifying') this.interruptVerification(t);
      t.status = 'interrupted'; t.lastError = 'Daemon stopped before completion. Inspect worktree and resume explicitly; no automatic replay.'; this.store.save(t);
    }
  }
  async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new Error('Task has another operation in progress');
    this.busy.add(id); try { return await action(); } finally { this.busy.delete(id); }
  }
  create(spec: TaskSpec, configuration?: RepositoryConfiguration): Task {
    spec = TaskSpecSchema.parse(spec);
    if (spec.planRevision !== 1) throw new Error('New tasks must start at planRevision=1');
    if (!this.config.providers[spec.provider]) throw new Error('Unknown provider');
    assertResourceLimits(spec.resources, configuration?.limits ?? resourceLimits(this.config));
    for (const dep of spec.dependencies) { if (dep === spec.id) throw new Error('Self dependency'); this.store.get(dep); }
    return this.store.create(spec, configuration);
  }
  async createFromInput(input: TaskInput): Promise<Task> {
    input = TaskInputSchema.parse(input);
    const identity = await repositoryIdentity(input.repository); const profile = this.profiles.find(identity);
    const { spec, configuration } = resolveTaskInput(input, identity, profile, this.config);
    return this.create(spec, configuration);
  }
  private async dependencies(task: Task): Promise<void> {
    for (const id of task.spec.dependencies) {
      const dep = this.store.get(id);
      if (dep.status !== 'accepted') throw new Error(`Dependency ${id} is not accepted`);
      if (dep.verifiedFingerprint !== await fingerprint(dep)) throw new Error(`Dependency ${id} changed after acceptance`);
    }
  }
  async prepare(id: string): Promise<Task> {
    executionGuard(this.config, this.root);
    return this.locked(id, async () => {
      const t = this.store.get(id); if (t.status !== 'planned') throw new Error('Only planned tasks can be prepared');
      await this.dependencies(t);
      // Dependencies gate scheduling. Their accepted code must already be committed
      // into the selected base; never silently ignore uncommitted prerequisite work.
      for (const depID of t.spec.dependencies) {
        const dep = this.store.get(depID);
        if (await git(dep.worktree!, ['status', '--porcelain'])) throw new Error(`Dependency ${depID} must be committed as authorized BEFORE verification/acceptance, and present in this task's base`);
        const depHead = await git(dep.worktree!, ['rev-parse', 'HEAD']);
        if (await git(t.spec.repository, ['merge-base', depHead, t.spec.baseRef]) !== depHead) throw new Error(`Selected base does not contain dependency ${depID}`);
      }
      const sharedKey = workspaceMode(t.spec) === 'worktree' ? undefined : workspaceKey(t.spec.repository);
      if (sharedKey && (this.preparingWorkspaces.has(sharedKey) || this.store.all().some(other =>
        other.spec.id !== id && other.worktree && !['accepted', 'cancelled'].includes(other.status) && workspaceKey(other.worktree) === sharedKey)))
        throw new Error('Workspace is already reserved by another task; finish/cancel it or use a separate worktree');
      if (sharedKey) this.preparingWorkspaces.add(sharedKey);
      let prepared;
      try { prepared = await prepareWorkspace(this.root, t.spec); }
      finally { if (sharedKey) this.preparingWorkspaces.delete(sharedKey); }
      Object.assign(t, prepared, { status: 'ready' }); this.store.event(id, 'prepared', prepared); return this.store.save(t);
    });
  }
  async dispatch(id: string, feedback?: Feedback): Promise<Task> {
    executionGuard(this.config, this.root);
    return this.locked(id, async () => {
      const t = this.store.get(id);
      if (!['ready', 'needs_changes', 'interrupted', 'failed', 'blocked'].includes(t.status)) throw new Error(`Cannot dispatch task in ${t.status}; needs_replan requires a supervisor plan update`);
      if (feedback) feedback = validateFeedback(t, feedback);
      const recovery = t.recoveryPending || ['failed', 'interrupted', 'blocked'].includes(t.status);
      if (recovery && !feedback) throw new Error('Resuming a failed/interrupted/blocked task requires structured diagnostic feedback');
      if (recovery && (t.recoveryAttempts ?? 0) >= this.config.maxAttempts + (t.infrastructureRetryCredits ?? 0))
        throw new Error('Recovery attempt limit reached. Supervisor must investigate or take over a focused fix; do not recreate the same task to bypass the retry budget.');
      if (this.running.size >= this.config.maxParallel) throw new Error('Parallel execution limit reached; wait for an active task');
      const p = this.config.providers[t.spec.provider]!;
      if (!this.env[p.apiKeyEnv]) throw new Error(`Missing ${p.apiKeyEnv}; configure it locally and restart the daemon`);
      await this.dependencies(t); await assertWorktree(t);
      // Recheck after awaits so concurrent dispatches cannot oversubscribe.
      if (this.running.size >= this.config.maxParallel) throw new Error('Parallel execution limit reached');
      if (recovery) t.recoveryAttempts = (t.recoveryAttempts ?? 0) + 1;
      delete t.recoveryPending;
      this.archiveLegacyVerification(t);
      t.feedback = feedback ?? t.feedback; t.status = 'running'; t.attempts++; t.runId = randomUUID(); t.checks = []; delete t.verifiedFingerprint; delete t.lastError; delete t.report;
      delete t.verificationSelection;
      delete t.verificationRunId;
      const contract = redact(JSON.stringify(taskContract(t), null, 2), this.env);
      writeFileSync(path.join(this.store.dir(id), 'contract.json'), contract);
      writeFileSync(path.join(this.store.dir(id), `contract-run-${t.runId}.json`), contract);
      this.store.save(t); this.running.add(id); this.store.event(id, 'dispatched', { attempt: t.attempts, recovery: !!recovery, recoveryAttempts: t.recoveryAttempts ?? 0, provider: t.spec.provider });
      const operation = this.execute(t).finally(() => { this.running.delete(id); this.promises.delete(id); });
      this.promises.set(id, operation); return t;
    });
  }
  private async execute(task: Task): Promise<void> {
    const id = task.spec.id;
    try {
      const result = await this.worker.run(task, session => {
        const current = this.store.get(id); current.sessionID = session; this.store.save(current);
      });
      const current = this.store.get(id); if (current.status !== 'running') return;
      writeFileSync(path.join(this.store.dir(id), `raw-report-attempt-${current.attempts}.json`), redact(JSON.stringify(result.report ?? null, null, 2), this.env));
      const report = validateReport(current, result.report);
      const summary = redact(renderReport(report), this.env);
      writeFileSync(path.join(this.store.dir(id), 'report.json'), redact(JSON.stringify(report, null, 2), this.env));
      writeFileSync(path.join(this.store.dir(id), 'worker-report.md'), summary);
      writeFileSync(path.join(this.store.dir(id), 'transcript.json'), redact(JSON.stringify(result.transcript, null, 2), this.env));
      current.status = report.outcome === 'ready_for_review' ? 'awaiting_review' : report.outcome; current.report = report; current.summary = summary.slice(0, 6000);
      current.totalTokens += result.tokens; current.cost += result.cost;
      this.store.save(current); this.store.event(id, current.status, { report: 'report.json', planRevision: current.spec.planRevision, runId: current.runId });
    } catch (error) {
      const current = this.store.get(id); if (current.status !== 'running') return;
      current.status = 'failed'; current.lastError = redact(String(error), this.env); this.store.save(current); this.store.event(id, 'failed', current.lastError);
    }
  }
  async verify(id: string, selection?: VerificationSelection): Promise<Task> {
    executionGuard(this.config, this.root);
    return this.locked(id, async () => {
      const t = this.store.get(id); if (t.status !== 'awaiting_review') throw new Error('Verify only a completed worker result');
      const chosen = selection ? VerificationSelectionSchema.parse(selection) : {
        strategy: 'planned' as const, rationale: 'Use the supervisor-selected checks in the current plan', checks: t.spec.checks, omittedCoverage: [],
      };
      if (t.spec.mode === 'implement' && !chosen.checks.length) throw new Error('Implementation requires at least one supervisor-selected verification command');
      await assertWorktree(t); await assertAllowedPaths(t);
      this.archiveLegacyVerification(t);
      const controller = new AbortController();
      const runID = randomUUID();
      const run: VerificationRun = { id: runID, artifact: `verification-${runID}.json`, status: 'running',
        planRevision: t.spec.planRevision, workerRunId: t.runId, startedAt: new Date().toISOString(), selection: chosen, checks: [] };
      t.status = 'verifying'; t.checks = []; delete t.verifiedFingerprint; delete t.lastError;
      t.verificationSelection = chosen; t.verificationRunId = run.id;
      t.verificationHistory ??= []; t.verificationHistory.push(this.verificationReference(run));
      this.writeVerification(id, run);
      this.store.event(id, 'verification_selected', { ...chosen, verificationRunId: run.id, artifact: run.artifact }); this.store.save(t);
      this.verifying.set(id, controller);
      const operation = this.runVerification(t, run, controller.signal).finally(() => {
        if (this.verifying.get(id) === controller) { this.verifying.delete(id); this.promises.delete(id); }
      });
      this.promises.set(id, operation); return t;
    });
  }
  private verificationReference(run: VerificationRun) {
    return { id: run.id, artifact: run.artifact, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt };
  }
  private writeVerification(id: string, run: VerificationRun): void {
    const file = path.join(this.store.dir(id), run.artifact); const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, redact(JSON.stringify(run, null, 2), this.env)); renameSync(temp, file);
  }
  private archiveLegacyVerification(t: Task): void {
    if (t.verificationRunId || !t.checks.length) return;
    const id = randomUUID(); const finishedAt = t.checks.at(-1)!.finishedAt;
    const selection = t.verificationSelection ?? { strategy: 'planned', rationale: 'Archived legacy verification', checks: t.spec.checks, omittedCoverage: [] };
    const run: VerificationRun = { id, artifact: `verification-${id}.json`, status: t.checks.every(c => c.passed) && t.checks.length === selection.checks.length && t.verifiedFingerprint ? 'passed' : 'failed',
      startedAt: finishedAt, finishedAt, planRevision: t.spec.planRevision, workerRunId: t.runId, selection, checks: [], verifiedFingerprint: t.verifiedFingerprint };
    for (const check of t.checks) {
      const file = path.basename(check.log); const log = `verify-${id}-${file}`;
      if (existsSync(path.join(this.store.dir(t.spec.id), file))) copyFileSync(path.join(this.store.dir(t.spec.id), file), path.join(this.store.dir(t.spec.id), log));
      run.checks.push({ ...check, log });
    }
    this.writeVerification(t.spec.id, run); t.verificationHistory ??= []; t.verificationHistory.push(this.verificationReference(run));
    t.verificationRunId = run.id;
  }
  private interruptVerification(t: Task): void {
    const ref = t.verificationHistory?.find(r => r.id === t.verificationRunId);
    if (!ref || ref.status !== 'running') return;
    const run: VerificationRun = JSON.parse(readFileSync(path.join(this.store.dir(t.spec.id), ref.artifact), 'utf8'));
    run.status = 'interrupted'; run.finishedAt = new Date().toISOString(); run.error = 'Daemon stopped during verification';
    Object.assign(ref, this.verificationReference(run)); this.writeVerification(t.spec.id, run);
    delete t.verifiedFingerprint;
  }
  private saveVerification(id: string, run: VerificationRun): void {
    this.writeVerification(id, run);
    const current = this.store.get(id);
    if (current.verificationRunId !== run.id) return;
    const ref = current.verificationHistory?.find(r => r.id === run.id);
    if (ref) Object.assign(ref, this.verificationReference(run));
    current.checks = run.checks;
    if (run.status !== 'running') {
      if (current.status === 'verifying') current.status = 'awaiting_review';
      if (run.verifiedFingerprint && !['cancelled', 'interrupted'].includes(current.status)) current.verifiedFingerprint = run.verifiedFingerprint;
      else delete current.verifiedFingerprint;
      if (run.error) current.lastError = run.error;
      this.store.event(id, ['passed', 'failed'].includes(run.status) ? 'verified' : `verification_${run.status}`, {
        verificationRunId: run.id, status: run.status, artifact: run.artifact, checks: run.checks,
      });
    }
    this.store.save(current);
  }
  private async runVerification(t: Task, run: VerificationRun, signal: AbortSignal): Promise<void> {
    const id = t.spec.id;
    try {
      run.sourceFingerprint = await fingerprint(t);
      for (const check of run.selection.checks) {
        if (signal.aborted) break;
        const log = path.join(this.store.dir(id), `verify-${run.id}-${check.name}.log`);
        try {
          const result = await runCommand(check.command, check.args, t.worktree!, this.env, check.timeoutMinutes * 60000, log, signal);
          run.checks.push({ name: check.name, exitCode: result.code, passed: result.code === 0, status: result.code === 0 ? 'passed' : 'failed', log: path.basename(log), finishedAt: new Date().toISOString() });
        } catch (error) {
          writeFileSync(log, redact(String(error), this.env), { flag: 'a' });
          run.checks.push({ name: check.name, exitCode: null, passed: false, status: signal.aborted ? 'stopped' : 'failed', log: path.basename(log), finishedAt: new Date().toISOString() });
        }
        this.saveVerification(id, run); if (signal.aborted || !run.checks.at(-1)!.passed) break;
      }
      if (!signal.aborted) {
        const after = await fingerprint(t);
        if (run.sourceFingerprint !== after) throw new Error('Source changed during verification; inspect changes and verify again');
        if (run.checks.length === run.selection.checks.length && run.checks.every(c => c.passed)) {
          run.status = 'passed'; run.verifiedFingerprint = after;
        } else run.status = 'failed';
      }
    } catch (error) { run.status = 'failed'; run.error = redact(String(error), this.env); }
    if (signal.aborted) {
      const status = this.store.get(id).status;
      run.status = status === 'cancelled' ? 'cancelled' : status === 'interrupted' ? 'interrupted' : 'stopped';
      run.error = redact(String(signal.reason ?? 'Verification stopped'), this.env); delete run.verifiedFingerprint;
    }
    run.finishedAt = new Date().toISOString(); this.saveVerification(id, run);
  }
  async stopVerification(id: string, reason: string): Promise<Task> {
    return this.locked(id, async () => {
      const t = this.store.get(id);
      // A completed round wins a race with stop; repeated stops are harmless.
      if (t.status === 'awaiting_review' && t.verificationRunId) return t;
      if (t.status !== 'verifying') throw new Error('Task has no active verification');
      const controller = this.verifying.get(id);
      if (!controller) throw new Error('Verification is not owned by this daemon');
      if (!reason.trim()) throw new Error('Stopping verification requires a reason');
      controller.abort(reason); await this.promises.get(id);
      return this.store.get(id);
    });
  }
  async addEvidence(id: string, input: SupervisorEvidenceInput): Promise<unknown> {
    return this.locked(id, async () => {
      const entry = SupervisorEvidenceSchema.parse(input); const t = this.store.get(id);
      if (['running', 'verifying'].includes(t.status)) throw new Error('Stop active execution before recording supervisor evidence');
      if (entry.planRevision !== t.spec.planRevision) throw new Error('Evidence refers to a stale planRevision');
      if (entry.criterionIds.some(cid => !t.spec.acceptance.some(c => c.id === cid))) throw new Error('Evidence references an unknown acceptance criterion');
      await assertWorktree(t);
      const ref = { id: randomUUID(), artifact: '', kind: entry.kind, summary: redact(entry.summary, this.env),
        planRevision: t.spec.planRevision, runId: t.runId, sourceFingerprint: await fingerprint(t), at: new Date().toISOString() };
      ref.artifact = `evidence-${ref.id}.json`;
      writeFileSync(path.join(this.store.dir(id), ref.artifact), redact(JSON.stringify({ ...entry, ...ref, source: 'supervisor' }, null, 2), this.env));
      t.supervisorEvidence ??= []; t.supervisorEvidence.push(ref);
      this.store.event(id, 'supervisor_evidence_added', ref); this.store.save(t);
      return ref;
    });
  }
  async review(id: string, decision: 'accept' | 'rework', rationale: string, evidence: string[], feedback?: Feedback, verification?: ReviewVerification): Promise<Task> {
    return this.locked(id, async () => {
      const t = this.store.get(id); if (t.status !== 'awaiting_review') throw new Error('Task is not awaiting supervisor review');
      if (!rationale.trim() || !evidence.length) throw new Error('Supervisor review requires rationale and evidence references');
      let reviewVerification;
      if (verification) {
        verification = ReviewVerificationSchema.parse(verification);
        if (decision !== 'accept') throw new Error('Review-only verification is only valid for acceptance');
        if (t.spec.verificationPolicy !== 'review_allowed') throw new Error('This task requires independent commands; review-only acceptance is not permitted');
      }
      if (decision === 'accept') {
        if (!t.report || t.report.outcome !== 'ready_for_review' || t.report.planRevision !== t.spec.planRevision) throw new Error('Acceptance requires a current structured ready_for_review report');
        await assertWorktree(t); await assertAllowedPaths(t);
        if (verification) {
          t.verifiedFingerprint = await fingerprint(t); reviewVerification = { ...verification, sourceFingerprint: t.verifiedFingerprint };
        } else {
          const selected = t.verificationSelection?.checks ?? t.spec.checks;
          if (t.spec.mode === 'implement' && (!selected.length || t.checks.length !== selected.length || t.checks.some((c, index) => !c.passed || c.name !== selected[index]!.name))) throw new Error('All required independent checks must pass; run independent verification before acceptance');
          if (!t.verifiedFingerprint || t.verifiedFingerprint !== await fingerprint(t)) throw new Error('Run independent verification on the current source before acceptance');
        }
        t.status = 'accepted';
      } else { if (!feedback) throw new Error('Rework requires criterion-linked structured feedback'); t.feedback = validateFeedback(t, feedback); t.status = 'needs_changes'; }
      t.reviews.push({ decision, rationale, evidence, at: new Date().toISOString(), planRevision: t.spec.planRevision, ...(feedback ? { feedback } : {}), ...(reviewVerification ? { verification: reviewVerification } : {}) }); this.store.event(id, 'review', t.reviews.at(-1)); return this.store.save(t);
    });
  }
  async updatePlan(id: string, expectedPlanRevision: number, input: TaskPlanPatch, changeReason: string, refreshRepositoryProfile = false): Promise<Task> {
    return this.locked(id, async () => {
      const t = this.store.get(id);
      if (['running', 'verifying', 'accepted', 'cancelled'].includes(t.status)) throw new Error(`Cannot update a plan in ${t.status}`);
      if (expectedPlanRevision !== t.spec.planRevision) throw new Error('Stale plan update; reread current contract');
      input = TaskPlanPatchSchema.parse(input);
      const identity = t.configuration?.identity ?? await repositoryIdentity(t.spec.repository);
      const profile = refreshRepositoryProfile ? this.profiles.find(identity) : t.configuration?.profile;
      const { spec, configuration } = resolveTaskInput({ ...input, planRevision: input.planRevision ?? expectedPlanRevision + 1 }, identity, profile, this.config, t);
      if (spec.planRevision !== expectedPlanRevision + 1) throw new Error('Plan revision must increase exactly by one');
      for (const key of ['id', 'contractVersion', 'repository', 'baseRef', 'fetchRemote', 'branch', 'provider', 'mode', 'dependencies'] as const)
        if (JSON.stringify(spec[key]) !== JSON.stringify(t.spec[key])) throw new Error(`Cannot change execution identity field ${key}; create a distinct task instead`);
      if (workspaceMode(spec) !== workspaceMode(t.spec)) throw new Error('Cannot change execution identity field workspaceMode; create a distinct task instead');
      if (!changeReason.trim()) throw new Error('Plan update requires a reason');
      if (!this.config.providers[spec.provider]) throw new Error('Unknown provider');
      writeFileSync(path.join(this.store.dir(id), `plan-v${t.spec.planRevision}.json`), JSON.stringify(t.spec, null, 2));
      this.archiveLegacyVerification(t);
      if (['failed', 'interrupted', 'blocked'].includes(t.status)) t.recoveryPending = true;
      this.store.writeConfiguration(spec, configuration);
      t.spec = spec; t.configuration = configuration; t.status = t.worktree ? 'ready' : 'planned'; t.checks = [];
      delete t.feedback; delete t.report; delete t.verifiedFingerprint; delete t.lastError; delete t.summary;
      delete t.verificationSelection;
      delete t.verificationRunId;
      this.store.event(id, 'plan_updated', { planRevision: spec.planRevision, changeReason, refreshRepositoryProfile }); return this.store.save(t);
    });
  }
  async cancel(id: string): Promise<Task> {
    return this.locked(id, async () => {
      const t = this.store.get(id); if (['accepted', 'cancelled'].includes(t.status)) throw new Error('Task is already terminal');
      t.status = 'cancelled'; this.store.save(t); this.verifying.get(id)?.abort('Task cancelled'); await this.worker.cancel(id);
      await this.promises.get(id); this.store.event(id, 'cancelled', {}); return this.store.get(id);
    });
  }
  async wait(ids: string[], after: Record<string, number> = {}, timeoutMs = 20000, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const read = () => ids.map(id => this.store.get(id));
    const changed = (tasks: Task[]) => tasks.some(t => t.revision > (after[t.spec.id] ?? -1));
    const initial = read();
    if (timeoutMs <= 0 || changed(initial)) return initial.map(t => this.summary(t));
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timer); unsubscribe(); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else { try { resolve(read().map(t => this.summary(t))); } catch (e) { reject(e); } }
      };
      const abort = () => finish(signal?.reason ?? new Error('Wait cancelled'));
      const unsubscribe = this.store.onChange(id => { if (ids.includes(id) && changed(read())) finish(); });
      const timer = setTimeout(() => finish(), Math.min(timeoutMs, 25000));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  summary(t: Task): unknown {
    return { id: t.spec.id, title: t.spec.title, status: t.status, revision: t.revision, planRevision: t.spec.planRevision, runId: t.runId, attempts: t.attempts,
      attemptLimitScope: 'recovery_only', reworkLimit: null,
      recoveryAttempts: t.recoveryAttempts ?? 0,
      recoveryAttemptLimit: this.config.maxAttempts + (t.infrastructureRetryCredits ?? 0),
      remainingRecoveryAttempts: Math.max(0, this.config.maxAttempts + (t.infrastructureRetryCredits ?? 0) - (t.recoveryAttempts ?? 0)),
      recoveryPending: !!t.recoveryPending || ['failed', 'interrupted', 'blocked'].includes(t.status),
      infrastructureRetryCredits: t.infrastructureRetryCredits ?? 0,
      provider: t.spec.provider, model: this.config.providers[t.spec.provider]?.model, worktree: t.worktree,
      workspaceMode: workspaceMode(t.spec), workspacePath: t.worktree, workspaceWarnings: t.workspaceWarnings ?? [],
      workerChecks: t.spec.workerChecks ?? [], plannedVerificationChecks: t.spec.checks.map(c => c.name), verificationSelection: t.verificationSelection,
      verificationPolicy: t.spec.verificationPolicy ?? 'commands_required', acceptanceVerification: t.reviews.at(-1)?.verification?.mode,
      resources: t.spec.resources, repositoryProfile: t.configuration?.profile ? { id: t.configuration.profile.value.id, revision: t.configuration.profile.value.revision, hash: t.configuration.profile.hash } : undefined,
      verificationRunId: t.verificationRunId, verificationHistory: t.verificationHistory ?? [], supervisorEvidence: t.supervisorEvidence ?? [],
      baseCommit: t.baseCommit, sessionID: t.sessionID, summary: t.summary?.slice(0, 2400), lastError: t.lastError,
      checks: t.checks, totalTokensReported: t.totalTokens, costReported: t.cost,
      artifacts: ['task.json', 'events.jsonl', ...(t.configuration ? [`configuration-v${t.spec.planRevision}.json`] : []), ...(t.runId ? ['contract.json'] : []), ...(t.report ? ['report.json', 'worker-report.md', 'transcript.json'] : []),
        ...(t.verificationHistory ?? []).map(r => r.artifact), ...(t.supervisorEvidence ?? []).map(e => e.artifact)] };
  }
  artifact(id: string, name: string, offset = 0, length = 12000): unknown {
    const dir = realpathSync(this.store.dir(id));
    if (!/^[a-z0-9][a-z0-9.-]*$/i.test(name)) throw new Error('Artifact must be a filename, not a path');
    const file = realpathSync(path.join(dir, name));
    if (path.dirname(file) !== dir) throw new Error('Artifact escapes task directory');
    const text = redact(readFileSync(file, 'utf8'), this.env);
    return { name, totalCharacters: text.length, offset, text: text.slice(offset, offset + Math.min(length, 20000)) };
  }
  async diff(id: string): Promise<unknown> {
    const t = this.store.get(id); await assertWorktree(t);
    const stat = await git(t.worktree!, ['diff', '--stat', t.baseCommit!, '--']);
    return { files: await changedFiles(t.worktree!, t.baseCommit!), stat, worktree: t.worktree, instruction: 'Read the actual changed code in this worktree before acceptance; this is a summary, not a code review.' };
  }
  async close(): Promise<void> {
    for (const t of this.store.all()) if (['running', 'verifying'].includes(t.status)) {
      t.status = 'interrupted'; t.lastError = 'Daemon stopped; inspect worktree and resume explicitly.'; this.store.save(t);
    }
    for (const controller of this.verifying.values()) controller.abort('Daemon stopped during verification');
    await this.worker.close(); await Promise.all([...this.promises.values()]);
  }
}
