import path from 'node:path';
import { readFileSync, writeFileSync, existsSync, realpathSync, renameSync, copyFileSync } from 'node:fs';
import { Store } from './store.js';
import { applyEnvironment, executionGuard, redact } from './config.js';
import { prepareWorkspace, workspaceMode, workspaceKey, assertAllowedPaths, assertWorktree, fingerprint, changedFiles, scopeViolations } from './worktree.js';
import { runCommand, git, describeExitCode } from './process.js';
import type { Config, Task, TaskSpec, VerificationRun, SupervisorEvidenceInput, RepositoryConfiguration, TaskInput, TaskPlanPatch, ReviewVerification, SupervisorNote, WorkerProgress, CheckResult, Status, PlanAmendment } from './schema.js';
import type { Worker } from './opencode.js';
import { TaskSpecSchema, TaskInputSchema, TaskPlanPatchSchema, ReviewVerificationSchema, VerificationSelectionSchema, SupervisorEvidenceSchema, SupervisorNoteSchema, PlanAmendmentSchema, type VerificationSelection, type Feedback } from './schema.js';
import { RepositoryProfiles, repositoryIdentity, resolveTaskInput, resourceLimits, assertResourceLimits, resolveCheckPath } from './repository-profile.js';
import { randomUUID } from 'node:crypto';
import { taskContract, validateFeedback, validateReport, renderReport } from './protocol.js';
import { ReportValidationError } from './report-submission.js';

const TERMINAL: Status[] = ['accepted', 'integrated', 'cancelled'];
const NEEDS_SUPERVISOR: Status[] = ['awaiting_review', 'needs_changes', 'needs_replan', 'blocked', 'failed', 'interrupted'];
export interface TaskFilter { scope?: 'active' | 'all' | 'archived'; status?: Status[]; repository?: string; limit?: number }
export interface VerifyOptions { continueOnFailure?: boolean; rerun?: 'failed' }

export class Engine {
  readonly store: Store;
  readonly profiles: RepositoryProfiles;
  private busy = new Set<string>();
  private preparingWorkspaces = new Set<string>();
  private running = new Set<string>();
  private verifying = new Map<string, AbortController>();
  private promises = new Map<string, Promise<void>>();
  // Live worker progress is kept in memory only; persisting each poll would wake every revision waiter.
  private progress = new Map<string, WorkerProgress>();
  // Dispatches waiting for a worker slot, oldest first. Not restored across daemon restarts.
  private queue: string[] = [];
  private closing = false;
  get idle(): boolean { return !this.busy.size && !this.preparingWorkspaces.size && !this.running.size && !this.verifying.size && !this.promises.size && !this.queue.length; }
  constructor(readonly root: string, readonly config: Config, readonly env: NodeJS.ProcessEnv, readonly worker: Worker) {
    this.store = new Store(path.join(root, '.runtime/tasks'));
    this.profiles = new RepositoryProfiles(root);
    for (const t of this.store.all()) {
      if (['running', 'verifying'].includes(t.status)) {
        if (t.status === 'verifying') this.interruptVerification(t);
        t.status = 'interrupted'; t.lastError = 'Daemon stopped before completion. Inspect worktree and resume explicitly; no automatic replay.'; this.store.save(t);
      } else if (t.status === 'queued') this.unqueue(t, 'Daemon restarted before the queued dispatch started; nothing ran. Dispatch again.');
    }
  }
  // A queued dispatch never started a worker, so withdrawing it restores the exact prior state.
  private unqueue(t: Task, error?: string): Task {
    this.queue = this.queue.filter(id => id !== t.spec.id);
    t.status = t.queued?.from ?? 'ready'; delete t.queued;
    if (error) t.queueError = error;
    return this.store.save(t);
  }
  async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new Error('Task has another operation in progress');
    this.busy.add(id); try { return await action(); } finally { this.busy.delete(id); }
  }
  create(spec: TaskSpec, configuration?: RepositoryConfiguration): Task {
    spec = TaskSpecSchema.parse(spec);
    if (spec.planRevision !== 1) throw new Error('New tasks must start at planRevision=1');
    if (!this.config.providers[spec.provider]) throw new Error('Unknown provider');
    if (this.config.providers[spec.provider]!.tags?.length && !spec.modelSelectionReason)
      throw new Error('Tagged model selection requires modelSelectionReason explaining task fit using user-defined tags');
    assertResourceLimits(spec.resources, configuration?.limits ?? resourceLimits(this.config));
    for (const dep of spec.dependencies) { if (dep === spec.id) throw new Error('Self dependency'); this.store.get(dep); }
    return this.store.create(spec, configuration, this.config.providers[spec.provider]);
  }
  async createFromInput(input: TaskInput): Promise<Task> {
    input = TaskInputSchema.parse(input);
    const identity = await repositoryIdentity(input.repository); const { profile } = this.profiles.ensure(identity);
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
        other.spec.id !== id && other.worktree && !['accepted', 'integrated', 'cancelled'].includes(other.status) && workspaceKey(other.worktree) === sharedKey)))
        throw new Error('Workspace is already reserved by another task; finish/cancel it or use a separate worktree');
      if (sharedKey) this.preparingWorkspaces.add(sharedKey);
      let prepared;
      try { prepared = await prepareWorkspace(this.root, t.spec); }
      finally { if (sharedKey) this.preparingWorkspaces.delete(sharedKey); }
      Object.assign(t, prepared, { status: 'ready' }); this.store.event(id, 'prepared', prepared); return this.store.save(t);
    });
  }
  async dispatch(id: string, feedback?: Feedback, queue = false): Promise<Task> {
    executionGuard(this.config, this.root);
    return this.locked(id, async () => {
      const t = this.store.get(id);
      if (t.status === 'queued') throw new Error('Task is already queued and starts when a worker slot frees. Use workflow_cancel with scope=queue to withdraw it.');
      if (!['ready', 'needs_changes', 'interrupted', 'failed', 'blocked'].includes(t.status)) throw new Error(`Cannot dispatch task in ${t.status}; needs_replan requires a supervisor plan update`);
      if (feedback) feedback = validateFeedback(t, feedback);
      // A run that only exhausted its model-step budget is not an environment failure: it may continue a bounded
      // number of times in a row without diagnostic feedback and without spending the recovery budget.
      const continuing = t.status === 'blocked' && t.continuation?.reason === 'step_limit' && !t.recoveryPending
        && (t.stepContinuations ?? 0) < this.config.maxStepContinuations;
      const recovery = !continuing && (t.recoveryPending || ['failed', 'interrupted', 'blocked'].includes(t.status));
      if (recovery && !feedback) throw new Error('Resuming a failed/interrupted/blocked task requires structured diagnostic feedback');
      if (recovery && (t.recoveryAttempts ?? 0) >= this.config.maxAttempts + (t.infrastructureRetryCredits ?? 0))
        throw new Error('Recovery attempt limit reached. Supervisor must investigate or take over a focused fix; do not recreate the same task to bypass the retry budget.');
      const tokenBudget = t.spec.resources?.tokenBudget;
      if (tokenBudget && t.totalTokens >= tokenBudget)
        throw new Error(`Token budget exhausted: ${t.totalTokens} of ${tokenBudget} reported tokens used. Raise resources.tokenBudget with workflow_plan_amend before dispatching.`);
      const p = t.executionProvider ?? this.config.providers[t.spec.provider];
      if (!p) throw new Error('Task provider is no longer configured; inspect its execution identity before resuming');
      if (!this.env[p.apiKeyEnv]) throw new Error(`Missing ${p.apiKeyEnv}; configure it locally and restart the daemon`);
      await this.dependencies(t); await assertWorktree(t);
      // Checked after the awaits so concurrent dispatches cannot oversubscribe.
      if (this.running.size >= this.config.maxParallel) {
        if (!queue) throw new Error('Parallel execution limit reached; wait for an active task or dispatch with queue=true');
        t.queued = { from: t.status, feedback, at: new Date().toISOString() }; t.status = 'queued'; delete t.queueError;
        this.queue.push(id); this.store.event(id, 'queued', { from: t.queued.from, position: this.queue.length });
        return this.store.save(t);
      }
      if (recovery) t.recoveryAttempts = (t.recoveryAttempts ?? 0) + 1;
      if (continuing) t.stepContinuations = (t.stepContinuations ?? 0) + 1;
      // Legacy tasks pin the effective model on their next explicit dispatch.
      t.executionProvider ??= structuredClone(p);
      delete t.recoveryPending; delete t.queueError; delete t.scopeViolations;
      if (t.continuation) t.continuedFrom = t.continuation; else delete t.continuedFrom;
      delete t.continuation;
      this.archiveLegacyVerification(t);
      t.feedback = feedback ?? t.feedback; t.status = 'running'; t.attempts++; t.runId = randomUUID(); t.runStartedAt = new Date().toISOString();
      t.checks = []; delete t.verifiedFingerprint; delete t.lastError; delete t.report;
      delete t.verificationSelection;
      delete t.verificationRunId;
      const contract = redact(JSON.stringify(taskContract(t), null, 2), this.env);
      writeFileSync(path.join(this.store.dir(id), 'contract.json'), contract);
      writeFileSync(path.join(this.store.dir(id), `contract-run-${t.runId}.json`), contract);
      this.store.save(t); this.running.add(id);
      this.store.event(id, 'dispatched', { attempt: t.attempts, recovery: !!recovery, recoveryAttempts: t.recoveryAttempts ?? 0, provider: t.spec.provider,
        ...(t.continuedFrom ? { continuation: t.continuedFrom.reason, consumedRecovery: !!recovery } : {}) });
      const operation = this.execute(t).finally(() => { this.running.delete(id); this.promises.delete(id); this.progress.delete(id); void this.drain(); });
      this.promises.set(id, operation); return t;
    });
  }
  // Start queued dispatches while slots are free. Preconditions are rechecked by dispatch itself.
  private async drain(): Promise<void> {
    while (!this.closing && this.queue.length && this.running.size < this.config.maxParallel) {
      const id = this.queue[0]!;
      if (this.busy.has(id)) { setTimeout(() => void this.drain(), 250).unref(); return; }
      let feedback: Feedback | undefined;
      try {
        const queued = this.store.get(id);
        if (queued.status !== 'queued') { this.queue.shift(); continue; }
        feedback = queued.queued?.feedback; this.unqueue(queued);
        // queue=true: if another dispatch took the slot meanwhile, wait for the next one instead of failing.
        await this.dispatch(id, feedback, true);
      } catch (error) {
        this.queue = this.queue.filter(other => other !== id);
        try {
          const t = this.store.get(id);
          if (t.status !== 'running') {
            t.queueError = redact('Queued dispatch could not start: ' + String(error), this.env); this.store.save(t);
            this.store.event(id, 'queue_start_failed', t.queueError);
          }
        } catch { /* the task disappeared; nothing to report on */ }
      }
    }
  }
  private async execute(task: Task): Promise<void> {
    const id = task.spec.id; const started = Date.now();
    let usageRecorded = false;
    const record = (current: Task): void => {
      const p = this.progress.get(id);
      current.lastRun = { runId: task.runId!, startedAt: task.runStartedAt ?? new Date(started).toISOString(), finishedAt: new Date().toISOString(),
        durationMs: Date.now() - started, outcome: current.status, steps: p?.steps, stepLimit: p?.stepLimit, tokens: p?.tokens };
    };
    try {
      const result = await this.worker.run(task, session => {
        const current = this.store.get(id); current.sessionID = session; this.store.save(current);
      }, state => {
        const current = this.store.get(id);
        if (current.runId !== task.runId) return;
        const artifact = `report-submission-${task.runId}.json`;
        current.reportSubmissions ??= [];
        const previous = current.reportSubmissions.find(r => r.runId === task.runId);
        current.totalTokens += state.tokens - (previous?.tokens ?? 0);
        current.cost += state.cost - (previous?.cost ?? 0); usageRecorded = true;
        const record = { ...state, artifact, runId: task.runId!, planRevision: task.spec.planRevision, attempt: task.attempts };
        // Persist even on cancellation/interruption; accounting cannot grant completion.
        writeFileSync(path.join(this.store.dir(id), artifact), redact(JSON.stringify(record, null, 2), this.env));
        current.reportSubmissions = [...current.reportSubmissions.filter(r => r.runId !== task.runId), JSON.parse(redact(JSON.stringify(record), this.env))];
        this.store.event(id, 'report_submission', { status: state.status, artifact, runId: task.runId }); this.store.save(current);
      }, progress => { this.progress.set(id, progress); });
      // Surface out-of-scope edits when the run ends instead of at verification. Computed before the
      // synchronous read-modify-save below so no other operation's save is overwritten.
      const outside = await Promise.resolve().then(() => scopeViolations(this.store.get(id))).catch(() => [] as string[]);
      const current = this.store.get(id); if (current.status !== 'running') return;
      writeFileSync(path.join(this.store.dir(id), `raw-report-attempt-${current.attempts}.json`), redact(JSON.stringify(result.report ?? null, null, 2), this.env));
      const report = validateReport(current, result.report);
      const summary = redact(renderReport(report), this.env);
      writeFileSync(path.join(this.store.dir(id), 'report.json'), redact(JSON.stringify(report, null, 2), this.env));
      writeFileSync(path.join(this.store.dir(id), 'worker-report.md'), summary);
      writeFileSync(path.join(this.store.dir(id), 'transcript.json'), redact(JSON.stringify(result.transcript, null, 2), this.env));
      current.status = report.outcome === 'ready_for_review' ? 'awaiting_review' : report.outcome; current.report = report; current.summary = summary.slice(0, 6000);
      if (!usageRecorded) { current.totalTokens += result.tokens; current.cost += result.cost; }
      const p = this.progress.get(id);
      if (current.status === 'blocked' && p && p.steps >= p.stepLimit)
        current.continuation = { reason: 'step_limit', runId: task.runId!, at: new Date().toISOString(), steps: p.steps, stepLimit: p.stepLimit,
          detail: `The run used its whole ${p.stepLimit}-step budget before finishing.` };
      if (current.status === 'awaiting_review') delete current.stepContinuations;
      if (outside.length) current.scopeViolations = outside;
      record(current);
      this.store.save(current); this.store.event(id, current.status, { report: 'report.json', planRevision: current.spec.planRevision, runId: current.runId,
        ...(current.continuation ? { continuation: current.continuation.reason } : {}), ...(outside.length ? { scopeViolations: outside } : {}) });
    } catch (error) {
      const current = this.store.get(id); if (current.status !== 'running') return;
      const p = this.progress.get(id);
      // A run that fails after spending tokens still spent them.
      if (!usageRecorded && p) { current.totalTokens += p.tokens; current.cost += p.cost; }
      if (error instanceof ReportValidationError) {
        // The model finished its turn and the workspace is intact; only the report is unusable. This becomes an
        // ordinary rework round with system-written feedback, not a failed run that spends the recovery budget.
        const artifact = `report-submission-${task.runId}.json`;
        const detail = redact(error.errors.map(e => e.message).join(' | '), this.env).slice(0, 3000);
        current.status = 'needs_changes';
        current.continuation = { reason: 'report_invalid', runId: task.runId!, at: new Date().toISOString(), steps: p?.steps, stepLimit: p?.stepLimit, detail };
        current.feedback = { planRevision: current.spec.planRevision, summary: 'The previous run ended without a valid final report. Its workspace changes are preserved.',
          findings: [{ criterionIds: current.spec.acceptance.map(c => c.id), description: 'The final report failed validation after one resubmission: ' + detail,
            evidence: [artifact], requestedChange: 'Check the current workspace state, finish any remaining work and incremental checks, then submit one report that follows REPORT_TEMPLATE exactly.' }] };
        current.lastError = 'Final report invalid after one resubmission. The work is preserved and no recovery attempt is consumed: inspect workflow_diff, then dispatch to continue the same session. ' + detail;
        record(current); this.store.save(current); this.store.event(id, 'report_invalid', { artifact, runId: task.runId, errors: detail });
        return;
      }
      current.status = 'failed'; current.lastError = redact(String(error), this.env); record(current); this.store.save(current); this.store.event(id, 'failed', current.lastError);
    }
  }
  async verify(id: string, selection?: VerificationSelection, options: VerifyOptions = {}): Promise<Task> {
    executionGuard(this.config, this.root);
    return this.locked(id, async () => {
      const t = this.store.get(id); if (t.status !== 'awaiting_review') throw new Error('Verify only a completed worker result');
      let chosen: VerificationSelection; const carried = new Map<string, CheckResult>(); let rerunOf: string | undefined;
      if (options.rerun === 'failed') {
        // Carry earlier passes forward only when they were measured on exactly the source being verified now.
        if (selection) throw new Error('rerun=failed repeats the previous selection; omit selection');
        const previous = t.verificationHistory?.at(-1);
        if (!previous || previous.status === 'running') throw new Error('No finished verification round to rerun');
        const prior: VerificationRun = JSON.parse(readFileSync(path.join(this.store.dir(id), previous.artifact), 'utf8'));
        if (prior.planRevision !== t.spec.planRevision || prior.workerRunId !== t.runId) throw new Error('The previous round belongs to an older plan or worker run; run the full selection');
        if (!prior.sourceFingerprint || prior.sourceFingerprint !== await fingerprint(t)) throw new Error('Source changed since the previous round; run the full selection');
        chosen = prior.selection; rerunOf = prior.id;
        for (const check of prior.checks) if (check.passed) carried.set(check.name, { ...check, reusedFrom: check.reusedFrom ?? prior.id });
        if (chosen.checks.every(check => carried.has(check.name))) throw new Error('Every check in the previous round passed; nothing to rerun');
      } else chosen = selection ? VerificationSelectionSchema.parse(selection) : {
        strategy: 'planned' as const, rationale: 'Use the supervisor-selected checks in the current plan', checks: t.spec.checks, omittedCoverage: [],
      };
      if (t.spec.mode === 'implement' && !chosen.checks.length) throw new Error('Implementation requires at least one supervisor-selected verification command');
      await assertWorktree(t); await assertAllowedPaths(t);
      this.archiveLegacyVerification(t);
      const controller = new AbortController();
      const runID = randomUUID();
      const run: VerificationRun = { id: runID, artifact: `verification-${runID}.json`, status: 'running',
        planRevision: t.spec.planRevision, workerRunId: t.runId, startedAt: new Date().toISOString(), selection: chosen, checks: [],
        ...(options.continueOnFailure ? { continueOnFailure: true } : {}), ...(rerunOf ? { rerunOf } : {}) };
      t.status = 'verifying'; t.checks = []; delete t.verifiedFingerprint; delete t.lastError; delete t.scopeViolations;
      t.verificationSelection = chosen; t.verificationRunId = run.id;
      t.verificationHistory ??= []; t.verificationHistory.push(this.verificationReference(run));
      this.writeVerification(id, run);
      this.store.event(id, 'verification_selected', { ...chosen, verificationRunId: run.id, artifact: run.artifact, continueOnFailure: !!options.continueOnFailure, rerunOf }); this.store.save(t);
      this.verifying.set(id, controller);
      const operation = this.runVerification(t, run, controller.signal, carried).finally(() => {
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
  private async runVerification(t: Task, run: VerificationRun, signal: AbortSignal, carried = new Map<string, CheckResult>()): Promise<void> {
    const id = t.spec.id;
    try {
      run.sourceFingerprint = await fingerprint(t);
      const env = applyEnvironment(this.env, t.spec.environment);
      for (const check of run.selection.checks) {
        if (signal.aborted) break;
        const reused = carried.get(check.name);
        if (reused) { run.checks.push(reused); this.saveVerification(id, run); continue; }
        const log = path.join(this.store.dir(id), `verify-${run.id}-${check.name}.log`); const started = Date.now();
        try {
          const result = await runCommand(check.command, check.args, t.worktree!, env, check.timeoutMinutes * 60000, log, signal);
          const passed = result.code === 0; const exitDetail = describeExitCode(result.code);
          run.checks.push({ name: check.name, exitCode: result.code, passed, status: passed ? 'passed' : 'failed', log: path.basename(log), finishedAt: new Date().toISOString(),
            durationMs: Date.now() - started, ...(exitDetail ? { exitDetail } : {}), ...(passed ? {} : { tail: result.output.slice(-1500) }) });
        } catch (error) {
          writeFileSync(log, redact(String(error), this.env), { flag: 'a' });
          run.checks.push({ name: check.name, exitCode: null, passed: false, status: signal.aborted ? 'stopped' : 'failed', log: path.basename(log), finishedAt: new Date().toISOString(),
            durationMs: Date.now() - started, tail: redact(String(error), this.env).slice(-1500) });
        }
        this.saveVerification(id, run); if (signal.aborted || (!run.checks.at(-1)!.passed && !run.continueOnFailure)) break;
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
  async addNote(id: string, input: SupervisorNote): Promise<unknown> {
    return this.locked(id, async () => {
      const entry = SupervisorNoteSchema.parse(input); const t = this.store.get(id);
      if (entry.planRevision !== t.spec.planRevision) throw new Error('Note refers to a stale planRevision');
      for (const related of entry.relatedTaskIds) this.store.get(related);
      const noteID = randomUUID();
      const ref = { id: noteID, artifact: `note-${noteID}.json`, planRevision: entry.planRevision,
        kind: entry.kind, summary: redact(entry.summary, this.env), relatedTaskIds: entry.relatedTaskIds, at: new Date().toISOString() };
      writeFileSync(path.join(this.store.dir(id), ref.artifact), redact(JSON.stringify({ ...entry, ...ref, source: 'supervisor', grantsVerification: false }, null, 2), this.env));
      t.supervisorNotes ??= []; t.supervisorNotes.push(ref);
      this.store.event(id, 'supervisor_note_added', ref); this.store.save(t); return ref;
    });
  }
  capacity(): unknown {
    const tasks = this.store.all();
    const runningWorkers = [...this.running].map(id => {
      const t = this.store.get(id);
      return { id, workspacePath: t.worktree, workerMemoryLimitMB: Math.min(t.spec.resources?.workerMemoryLimitMB ?? Infinity, this.config.workerMemoryLimitMB) };
    });
    const idleDays = (t: Task) => Math.floor((Date.now() - Date.parse(t.updatedAt)) / 86400000);
    return { maxParallel: this.config.maxParallel, runningWorkerCount: runningWorkers.length,
      freeWorkerSlots: Math.max(0, this.config.maxParallel - runningWorkers.length), runningWorkers,
      queuedTasks: [...this.queue],
      workerMemoryLimitMB: this.config.workerMemoryLimitMB,
      runningWorkerBudgetMB: runningWorkers.reduce((sum, t) => sum + t.workerMemoryLimitMB, 0),
      workerSteps: this.config.workerSteps, maxWorkerSteps: this.config.maxWorkerSteps,
      verificationTasks: [...this.verifying.keys()],
      // idleDays exposes abandoned tasks that still hold a directory; cancel or finish them to release it.
      workspaceReservations: tasks.filter(t => t.worktree && !TERMINAL.includes(t.status))
        .map(t => ({ id: t.spec.id, status: t.status, mode: workspaceMode(t.spec), path: t.worktree, updatedAt: t.updatedAt, idleDays: idleDays(t) })),
      notes: ['Slots are shared by all repositories in this daemon. A full dispatch fails unless queue=true, which starts it when a slot frees.',
        'Memory values are per-worker process-tree ceilings, not measured usage or a shared host budget.',
        'Independent verification uses separate processes outside worker memory guards and worker slots.',
        'branch/current reserve one directory until acceptance/cancellation; parallel tasks need distinct directories.',
        'Free slots do not prove CPU, RAM, disk or build-cache capacity. Plan independent tasks and bounded builds first.'] };
  }
  handoff(ids: string[]): unknown {
    return { generatedAt: new Date().toISOString(), currentSourceChecked: false,
      instruction: 'Persisted history only. Read referenced artifacts for details and inspect current source before review/verification. Notes are supervisor testimony, never passing checks.',
      tasks: ids.map(id => {
        const t = this.store.get(id);
        return { state: { id, status: t.status, revision: t.revision, planRevision: t.spec.planRevision, runId: t.runId,
          attempts: t.attempts, recoveryAttempts: t.recoveryAttempts ?? 0, workspacePath: t.worktree, branch: t.spec.branch, baseCommit: t.baseCommit,
          provider: t.spec.provider, model: t.executionProvider?.model, modelTags: t.executionProvider?.tags ?? [], modelSelectionReason: t.spec.modelSelectionReason,
          summary: t.summary?.slice(0, 2400), lastError: t.lastError, checks: t.checks,
          continuation: t.continuation, scopeViolations: t.scopeViolations, lastRun: t.lastRun, amendments: t.amendments ?? [],
          latestReportSubmission: t.reportSubmissions?.at(-1) ?? null }, contractArtifact: 'task.json', goal: t.spec.goal, nonGoals: t.spec.nonGoals, decisions: t.spec.decisions,
          dependencies: t.spec.dependencies.map(dep => {
            const d = this.store.getArchived(dep) ?? this.store.get(dep);
            return { id: dep, status: d.status, branch: d.spec.branch, baseCommit: d.baseCommit, ...(this.store.getArchived(dep) ? { archived: true } : {}) };
          }),
          acceptance: t.spec.acceptance.map(c => ({ ...c, workerResult: t.report?.acceptanceResults.find(r => r.id === c.id) })),
          feedback: t.feedback, recentReviews: t.reviews.slice(-3),
          latestWorkerReport: t.report ? { artifact: 'report.json', planRevision: t.report.planRevision, runId: t.report.runId, outcome: t.report.outcome } : null,
          latestVerification: t.verificationHistory?.at(-1) ?? null,
          recentNotes: t.supervisorNotes?.slice(-5) ?? [], notesOmitted: Math.max(0, (t.supervisorNotes?.length ?? 0) - 5),
          recentEvidence: t.supervisorEvidence?.slice(-5) ?? [], evidenceOmitted: Math.max(0, (t.supervisorEvidence?.length ?? 0) - 5) };
      }) };
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
      if (['running', 'verifying', 'queued', 'accepted', 'integrated', 'cancelled'].includes(t.status))
        throw new Error(`Cannot update a plan in ${t.status}` + (t.status === 'queued' ? '; withdraw it with workflow_cancel scope=queue first' : ''));
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
      // A new plan supersedes the interrupted run; the free step-limit continuation applied to the old contract only.
      delete t.continuation; delete t.scopeViolations;
      this.store.event(id, 'plan_updated', { planRevision: spec.planRevision, changeReason, refreshRepositoryProfile }); return this.store.save(t);
    });
  }
  // Change supervisor-side fields without a new plan revision. The worker never executes these values, so its
  // contract, report and session stay valid; a full plan update would discard them and cost another worker round.
  async amendPlan(id: string, expectedPlanRevision: number, input: PlanAmendment, reason: string): Promise<Task> {
    return this.locked(id, async () => {
      const t = this.store.get(id);
      if (['verifying', ...TERMINAL].includes(t.status)) throw new Error(`Cannot amend a plan in ${t.status}`);
      if (expectedPlanRevision !== t.spec.planRevision) throw new Error('Stale plan amendment; reread current contract');
      if (!reason.trim()) throw new Error('Plan amendment requires a reason');
      const patch = PlanAmendmentSchema.parse(input); const profile = t.configuration?.profile;
      const fields = (Object.keys(patch) as (keyof PlanAmendment)[]).filter(name => patch[name] !== undefined);
      const before = Object.fromEntries(fields.map(name => [name, t.spec[name]]));
      const next = structuredClone(t.spec);
      if (patch.checks) next.checks = patch.checks.map(check => ({ ...check, command: resolveCheckPath(check.command, profile), args: check.args.map(arg => resolveCheckPath(arg, profile)) }));
      if (patch.allowedPaths) next.allowedPaths = patch.allowedPaths;
      if (patch.resources) next.resources = { ...next.resources, ...patch.resources };
      assertResourceLimits(next.resources, resourceLimits(this.config, profile?.value.preferences));
      const spec = TaskSpecSchema.parse(next);
      // Only an idle task can be inspected here: awaiting git while a worker saves would overwrite its updates.
      const outside = patch.allowedPaths && t.worktree && t.status !== 'running' ? await scopeViolations({ ...t, spec }) : undefined;
      t.spec = spec;
      if (t.configuration) {
        // Later plan updates resolve from these overrides; keep them in step or the amendment would be reverted.
        t.configuration.overrides = { ...t.configuration.overrides, ...(patch.checks ? { checks: patch.checks } : {}), ...(patch.allowedPaths ? { allowedPaths: patch.allowedPaths } : {}),
          ...(patch.resources ? { resources: { ...t.configuration.overrides.resources, ...patch.resources } } : {}) };
        this.store.writeConfiguration(spec, t.configuration);
      }
      // A passing round that ran the planned checks no longer covers the plan once those checks change.
      if (patch.checks && t.verificationSelection?.strategy === 'planned') delete t.verifiedFingerprint;
      if (outside) { if (outside.length) t.scopeViolations = outside; else delete t.scopeViolations; }
      const amendmentID = randomUUID();
      const ref = { id: amendmentID, artifact: `amendment-${amendmentID}.json`, planRevision: spec.planRevision, fields, reason: redact(reason, this.env), at: new Date().toISOString() };
      writeFileSync(path.join(this.store.dir(id), ref.artifact), redact(JSON.stringify({ ...ref, before, after: Object.fromEntries(fields.map(name => [name, spec[name]])), source: 'supervisor' }, null, 2), this.env));
      t.amendments ??= []; t.amendments.push(ref);
      this.store.event(id, 'plan_amended', ref); return this.store.save(t);
    });
  }
  async cancel(id: string, scope: 'task' | 'queue' = 'task'): Promise<Task> {
    return this.locked(id, async () => {
      const t = this.store.get(id);
      if (scope === 'queue') {
        if (t.status !== 'queued') throw new Error('Task has no queued dispatch');
        this.store.event(id, 'dequeued', { restored: t.queued?.from }); return this.unqueue(t);
      }
      if (TERMINAL.includes(t.status)) throw new Error('Task is already terminal');
      this.queue = this.queue.filter(other => other !== id); delete t.queued;
      t.status = 'cancelled'; this.store.save(t); this.verifying.get(id)?.abort('Task cancelled'); await this.worker.cancel(id);
      await this.promises.get(id); this.store.event(id, 'cancelled', {}); return this.store.get(id);
    });
  }
  // Move finished tasks out of the active store. Records stay on disk; nothing is deleted except, on request, a clean worktree.
  async archive(ids: string[], removeWorktree = false): Promise<unknown> {
    const results: unknown[] = [];
    for (const id of ids) {
      try {
        results.push(await this.locked(id, async () => {
          const t = this.store.get(id);
          if (!TERMINAL.includes(t.status)) throw new Error(`Only accepted, integrated or cancelled tasks can be archived; ${id} is ${t.status}`);
          const dependents = this.store.all().filter(other => !TERMINAL.includes(other.status) && other.spec.dependencies.includes(id)).map(other => other.spec.id);
          if (dependents.length) throw new Error(`Unfinished tasks depend on ${id}: ${dependents.join(', ')}`);
          let worktree = 'kept';
          if (workspaceMode(t.spec) !== 'worktree' || !t.worktree) worktree = 'not_applicable';
          else if (removeWorktree && existsSync(t.worktree)) {
            if (path.dirname(realpathSync(t.worktree)) !== realpathSync(path.join(this.root, 'worktrees'))) throw new Error('Worktree is outside the managed worktrees directory; remove it yourself');
            // No --force: git refuses when the worktree holds modified or untracked files, and so does this operation.
            await git(t.spec.repository, ['worktree', 'remove', t.worktree]); worktree = 'removed';
          } else if (!existsSync(t.worktree)) worktree = 'already_missing';
          this.store.event(id, 'archived', { worktree });
          return { id, archived: true, status: t.status, directory: this.store.archive(id), worktree, branch: t.spec.branch,
            note: 'The branch and the OpenCode session state under .runtime/workers are kept.' };
        }));
      } catch (error) { results.push({ id, archived: false, error: redact(String(error), this.env) }); }
    }
    return { results };
  }
  // Without an ID the supervisor needs an overview, not every task's full record.
  list(filter: TaskFilter = {}): unknown {
    const scope = filter.scope ?? 'active'; const limit = filter.limit ?? 50;
    const repository = filter.repository ? this.pathKey(filter.repository) : undefined;
    const source = scope === 'archived' ? this.store.archived() : this.store.all();
    const counts: Record<string, number> = {}; for (const t of source) counts[t.status] = (counts[t.status] ?? 0) + 1;
    const selected = source.filter(t => (scope !== 'active' || !TERMINAL.includes(t.status)) && (!filter.status?.length || filter.status.includes(t.status))
      && (!repository || this.pathKey(t.spec.repository) === repository)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { scope, total: source.length, matched: selected.length, countsByStatus: counts,
      tasks: selected.slice(0, limit).map(t => ({ id: t.spec.id, title: t.spec.title, status: t.status, revision: t.revision, planRevision: t.spec.planRevision,
        needsSupervisor: NEEDS_SUPERVISOR.includes(t.status) || !!t.queueError, repository: t.spec.repository, workspaceMode: workspaceMode(t.spec), workspacePath: t.worktree,
        branch: t.spec.branch, model: (t.executionProvider ?? this.config.providers[t.spec.provider])?.model, updatedAt: t.updatedAt,
        idleDays: Math.floor((Date.now() - Date.parse(t.updatedAt)) / 86400000), ...(scope === 'archived' ? { archived: true } : {}) })),
      hint: 'Compact overview. Read one task with workflow_status {id}. scope=all includes accepted/integrated/cancelled tasks; scope=archived lists archived ones.' };
  }
  status(id: string): unknown {
    const archived = this.store.getArchived(id);
    return archived ? { ...(this.summary(archived) as object), archived: true, directory: this.store.archiveDir(id) } : this.summary(this.store.get(id));
  }
  private pathKey(directory: string): string { const absolute = path.resolve(directory); return process.platform === 'win32' ? absolute.toLowerCase() : absolute; }
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
    const live = t.status === 'running' ? this.progress.get(t.spec.id) : undefined; const provider = t.executionProvider ?? this.config.providers[t.spec.provider];
    const seconds = (from: string | undefined) => from ? Math.max(0, Math.round((Date.now() - Date.parse(from)) / 1000)) : undefined;
    return { id: t.spec.id, title: t.spec.title, status: t.status, revision: t.revision, planRevision: t.spec.planRevision, runId: t.runId, attempts: t.attempts,
      // Live view of the active run. It is not persisted and does not change revision; poll it with workflow_status, not workflow_wait.
      run: t.status === 'running' ? { startedAt: t.runStartedAt, elapsedSeconds: seconds(t.runStartedAt),
        timeoutMinutes: Math.min(t.spec.resources?.taskTimeoutMinutes ?? Infinity, this.config.taskTimeoutMinutes),
        ...(live ? { phase: live.phase, steps: live.steps, stepLimit: live.stepLimit, tokens: live.tokens, lastActivityAt: live.lastActivityAt,
          idleSeconds: seconds(live.lastActivityAt), lastTool: live.lastTool } : { phase: 'starting' }) } : undefined,
      lastRun: t.lastRun,
      // Set when the last run stopped at its step budget or without a valid report; nextAction says how to resume.
      continuation: t.continuation ? { ...t.continuation, freeContinuationsUsed: t.stepContinuations ?? 0, freeContinuationLimit: this.config.maxStepContinuations,
        nextAction: t.continuation.reason === 'report_invalid' ? 'Inspect workflow_diff, then workflow_dispatch {id}; this is ordinary rework and consumes no recovery attempt.'
          : (t.stepContinuations ?? 0) < this.config.maxStepContinuations && !t.recoveryPending
            ? 'workflow_dispatch {id} continues the same session without diagnostic feedback or a recovery attempt. Consider a larger resources.workerSteps via workflow_plan_amend, or a smaller task.'
            : 'Free continuations are used up: split the task or dispatch with diagnostic feedback (consumes a recovery attempt).' } : undefined,
      queued: t.queued ? { from: t.queued.from, at: t.queued.at, position: this.queue.indexOf(t.spec.id) + 1 } : undefined, queueError: t.queueError,
      scopeViolations: t.scopeViolations, amendments: t.amendments ?? [],
      attemptLimitScope: 'recovery_only', reworkLimit: null,
      recoveryAttempts: t.recoveryAttempts ?? 0,
      recoveryAttemptLimit: this.config.maxAttempts + (t.infrastructureRetryCredits ?? 0),
      remainingRecoveryAttempts: Math.max(0, this.config.maxAttempts + (t.infrastructureRetryCredits ?? 0) - (t.recoveryAttempts ?? 0)),
      recoveryPending: !!t.recoveryPending || (['failed', 'interrupted', 'blocked'].includes(t.status)
        && !(t.continuation?.reason === 'step_limit' && (t.stepContinuations ?? 0) < this.config.maxStepContinuations)),
      infrastructureRetryCredits: t.infrastructureRetryCredits ?? 0,
      provider: t.spec.provider, model: provider?.model,
      modelTags: t.executionProvider?.tags ?? [], modelSelectionReason: t.spec.modelSelectionReason,
      modelConfigPinned: !!t.executionProvider, worktree: t.worktree,
      workspaceMode: workspaceMode(t.spec), workspacePath: t.worktree, workspaceWarnings: t.workspaceWarnings ?? [],
      workerChecks: t.spec.workerChecks ?? [], plannedVerificationChecks: t.spec.checks.map(c => c.name), verificationSelection: t.verificationSelection,
      verificationPolicy: t.spec.verificationPolicy ?? 'commands_required', acceptanceVerification: t.reviews.at(-1)?.verification?.mode,
      resources: t.spec.resources, repositoryProfile: t.configuration?.profile ? { id: t.configuration.profile.value.id, revision: t.configuration.profile.value.revision, hash: t.configuration.profile.hash } : undefined,
      verificationRunId: t.verificationRunId, verificationHistory: t.verificationHistory ?? [], supervisorEvidence: t.supervisorEvidence ?? [], integration: t.integration,
      baseCommit: t.baseCommit, sessionID: t.sessionID, summary: t.summary?.slice(0, 2400), lastError: t.lastError,
      checks: t.checks, totalTokensReported: t.totalTokens, costReported: t.cost,
      // costReported is the provider's own figure, or an estimate from the user's configured list prices when the provider reports none.
      costCurrency: provider?.pricing?.currency ?? null, pricingConfigured: !!provider?.pricing, tokenBudget: t.spec.resources?.tokenBudget ?? null,
      environment: Object.keys(t.spec.environment ?? {}),
      reportSubmissions: t.reportSubmissions ?? [], supervisorNoteCount: t.supervisorNotes?.length ?? 0,
      recentSupervisorNotes: t.supervisorNotes?.slice(-5) ?? [],
      artifacts: ['task.json', 'events.jsonl', ...(t.configuration ? [`configuration-v${t.spec.planRevision}.json`] : []), ...(t.runId ? ['contract.json'] : []), ...(t.report ? ['report.json', 'worker-report.md', 'transcript.json'] : []),
        ...(t.verificationHistory ?? []).map(r => r.artifact), ...(t.supervisorEvidence ?? []).map(e => e.artifact), ...(t.amendments ?? []).map(a => a.artifact),
        ...(t.reportSubmissions ?? []).map(r => r.artifact), ...(t.supervisorNotes ?? []).map(n => n.artifact), ...(t.integration ? [t.integration.artifact] : [])] };
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
    this.closing = true;
    for (const t of this.store.all()) {
      if (['running', 'verifying'].includes(t.status)) { t.status = 'interrupted'; t.lastError = 'Daemon stopped; inspect worktree and resume explicitly.'; this.store.save(t); }
      else if (t.status === 'queued') this.unqueue(t, 'Daemon stopped before the queued dispatch started; nothing ran. Dispatch again.');
    }
    for (const controller of this.verifying.values()) controller.abort('Daemon stopped during verification');
    await this.worker.close(); await Promise.all([...this.promises.values()]);
  }
}
