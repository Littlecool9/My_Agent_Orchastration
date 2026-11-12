import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.js';
import { ConfigSchema, TaskSpecSchema, type Task, type WorkerProgress, type VerificationRun } from '../src/schema.js';
import { workerEnv, pricedCost, type Worker } from '../src/opencode.js';
import { ROOT, applyEnvironment } from '../src/config.js';
import { git, describeExitCode } from '../src/process.js';
import { callTool } from '../src/tools.js';
import { ReportValidationError } from '../src/report-submission.js';
import { contractFields, makeReport } from './fixtures.js';

const scratch = path.join(ROOT, 'work/workflow-tests'); mkdirSync(scratch, { recursive: true });
const config = ConfigSchema.parse({ executionEnabled: true, maxParallel: 1, maxAttempts: 2, taskTimeoutMinutes: 5,
  providers: { fixture: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', contextLimit: 32768, outputLimit: 4096 } } });
const node = (script: string, name = 'check') => ({ name, command: process.execPath, args: ['-e', script], timeoutMinutes: 1 });
const feedback = (planRevision = 1) => ({ planRevision, summary: 'Diagnosed', findings: [{ criterionIds: ['AC-01'], description: 'Diagnosed the abnormal run', evidence: ['run log'], requestedChange: 'Resume' }] });

class ScriptedWorker implements Worker {
  runs = 0; hold = false; outcome: 'ready_for_review' | 'blocked' = 'ready_for_review';
  steps?: number; invalidReport = false; fail = false; private releases: (() => void)[] = [];
  async run(task: Task, session: (id: string) => void, _observe?: unknown, progress?: (p: WorkerProgress) => void) {
    this.runs++; session(task.sessionID ?? 'fixture-session');
    if (this.steps !== undefined) progress?.({ phase: 'working', steps: this.steps, stepLimit: 150, tokens: 40, cost: 0.5,
      lastActivityAt: new Date().toISOString(), lastTool: { tool: 'bash', status: 'completed', title: 'pytest -q tests/test_value.py' } });
    if (this.hold) await new Promise<void>(resolve => this.releases.push(resolve));
    if (this.invalidReport) throw new ReportValidationError('Final report is still invalid after one resubmission: Unrecognized key', [{ category: 'schema', message: 'Unrecognized key: "evidence_note"' }]);
    if (this.fail) throw new Error('fixture failure');
    writeFileSync(path.join(task.worktree!, 'value.txt'), 'good\n');
    return { report: makeReport(task, this.outcome), transcript: [], tokens: 12, cost: 0 };
  }
  release() { this.releases.shift()?.(); }
  async cancel() { this.release(); }
  async close() { while (this.releases.length) this.release(); }
}
async function fixture(overrides: Partial<typeof config> = {}) {
  const root = mkdtempSync(path.join(scratch, 'rel-')); const repository = path.join(root, 'repository'); mkdirSync(repository);
  await git(repository, ['init', '-b', 'master']); writeFileSync(path.join(repository, 'value.txt'), 'old\n');
  await git(repository, ['config', 'core.autocrlf', 'true']); await git(repository, ['add', 'value.txt']);
  await git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const worker = new ScriptedWorker(); const engine = new Engine(root, { ...config, ...overrides }, { ...process.env, FIXTURE_KEY: 'local-test-only' }, worker);
  const spec = TaskSpecSchema.parse({ ...contractFields, id: 'one', title: 'Fixture task', repository, baseRef: 'master', branch: 'workflow/one', provider: 'fixture', goal: 'Fix fixture',
    acceptance: [{ id: 'AC-01', requirement: 'value is good' }], checks: [node("if(require('fs').readFileSync('value.txt','utf8') !== 'good\\n') process.exit(2)", 'actual-value')] });
  engine.create(spec); return { root, repository, worker, engine, spec };
}
async function until(engine: Engine, id: string, done: (t: Task) => boolean, timeout = 15000): Promise<Task> {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const t = engine.store.get(id); if (done(t)) return t; await delay(20); }
  throw new Error(`Timed out; ${id} is ${engine.store.get(id).status}`);
}
const settled = (engine: Engine, id: string, attempts: number) => until(engine, id, t => t.attempts === attempts && !['running', 'queued'].includes(t.status));
const reviewable = (engine: Engine, id: string) => until(engine, id, t => t.status === 'awaiting_review');
const contract = (engine: Engine, id: string) => JSON.parse(readFileSync(path.join(engine.store.dir(id), 'contract.json'), 'utf8'));

test('a run that only exhausted its step budget continues without feedback or recovery budget, a bounded number of times', async () => {
  const f = await fixture({ maxAttempts: 1 }); f.worker.outcome = 'blocked'; f.worker.steps = 150;
  await f.engine.prepare('one'); await f.engine.dispatch('one');
  let t = await settled(f.engine, 'one', 1);
  assert.equal(t.status, 'blocked'); assert.equal(t.continuation?.reason, 'step_limit'); assert.equal(t.lastRun?.steps, 150);
  let summary = f.engine.summary(t) as any;
  assert.equal(summary.recoveryPending, false); assert.match(summary.continuation.nextAction, /without diagnostic feedback/);
  await f.engine.dispatch('one'); t = await settled(f.engine, 'one', 2);
  assert.equal(t.recoveryAttempts, undefined); assert.equal(t.stepContinuations, 1);
  assert.equal(contract(f.engine, 'one').continuation.reason, 'step_limit');
  await f.engine.dispatch('one'); t = await settled(f.engine, 'one', 3);
  assert.equal(t.stepContinuations, 2); assert.equal(t.recoveryAttempts, undefined);
  // The free continuations are consecutive and finite; after that the ordinary recovery rule applies.
  summary = f.engine.summary(t) as any; assert.equal(summary.recoveryPending, true);
  await assert.rejects(f.engine.dispatch('one'), /diagnostic feedback/);
  f.worker.outcome = 'ready_for_review';
  await f.engine.dispatch('one', feedback()); t = await settled(f.engine, 'one', 4);
  assert.equal(t.status, 'awaiting_review'); assert.equal(t.recoveryAttempts, 1);
  assert.equal(t.stepContinuations, undefined); assert.equal(t.continuation, undefined);
});

test('a blocked report below the step budget and a plan update after a step limit keep the diagnostic-feedback rule', async () => {
  const f = await fixture(); f.worker.outcome = 'blocked'; f.worker.steps = 20;
  await f.engine.prepare('one'); await f.engine.dispatch('one');
  let t = await settled(f.engine, 'one', 1);
  assert.equal(t.status, 'blocked'); assert.equal(t.continuation, undefined);
  await assert.rejects(f.engine.dispatch('one'), /diagnostic feedback/);
  f.worker.steps = 150; await f.engine.dispatch('one', feedback()); t = await settled(f.engine, 'one', 2);
  assert.equal(t.continuation?.reason, 'step_limit');
  await f.engine.updatePlan('one', 1, { goal: 'Narrower goal' }, 'Split the task');
  assert.equal(f.engine.store.get('one').continuation, undefined);
  await assert.rejects(f.engine.dispatch('one'), /diagnostic feedback/);
});

test('a final report that stays invalid becomes ordinary rework with system feedback instead of a failed run', async () => {
  const f = await fixture({ maxAttempts: 1 }); f.worker.invalidReport = true; f.worker.steps = 80;
  await f.engine.prepare('one'); await f.engine.dispatch('one');
  let t = await settled(f.engine, 'one', 1);
  assert.equal(t.status, 'needs_changes'); assert.equal(t.continuation?.reason, 'report_invalid');
  assert.deepEqual(t.feedback!.findings[0]!.criterionIds, ['AC-01']); assert.match(t.feedback!.findings[0]!.description, /evidence_note/);
  assert.match(t.lastError!, /no recovery attempt/); assert.equal(t.totalTokens, 40, 'tokens spent by the run are still accounted');
  assert.ok(readFileSync(path.join(f.engine.store.dir('one'), 'events.jsonl'), 'utf8').includes('report_invalid'));
  f.worker.invalidReport = false;
  await f.engine.dispatch('one'); t = await settled(f.engine, 'one', 2);
  assert.equal(t.status, 'awaiting_review'); assert.equal(t.recoveryAttempts, undefined);
  assert.equal(contract(f.engine, 'one').continuation.reason, 'report_invalid'); assert.equal(contract(f.engine, 'one').feedback.findings.length, 1);
});

test('a daemon restart drops a queued dispatch without starting a worker', async () => {
  const f = await fixture(); await f.engine.prepare('one');
  const t = f.engine.store.get('one'); t.status = 'queued'; t.queued = { from: 'ready', at: new Date().toISOString() }; f.engine.store.save(t);
  const worker = new ScriptedWorker(); const restarted = new Engine(f.root, config, f.engine.env, worker);
  assert.equal(restarted.store.get('one').status, 'ready'); assert.match(restarted.store.get('one').queueError!, /nothing ran/);
  assert.equal(worker.runs, 0); assert.equal(restarted.idle, true);
  await restarted.dispatch('one'); assert.equal((await reviewable(restarted, 'one')).queueError, undefined);
});

test('a full dispatch can wait in a queue, be withdrawn, and starts when a slot frees', async () => {
  const f = await fixture(); f.worker.hold = true;
  f.engine.create({ ...f.spec, id: 'two', branch: 'workflow/two' }); await f.engine.prepare('one'); await f.engine.prepare('two');
  await f.engine.dispatch('one');
  await assert.rejects(f.engine.dispatch('two'), /queue=true/);
  assert.equal((await f.engine.dispatch('two', undefined, true)).status, 'queued');
  assert.deepEqual((f.engine.capacity() as any).queuedTasks, ['two']); assert.equal(f.engine.idle, false);
  assert.equal((f.engine.summary(f.engine.store.get('two')) as any).queued.position, 1);
  await assert.rejects(f.engine.dispatch('two', undefined, true), /already queued/);
  await assert.rejects(f.engine.updatePlan('two', 1, { goal: 'Changed' }, 'While queued'), /scope=queue/);
  const withdrawn = await callTool(f.engine, 'workflow_cancel', { id: 'two', scope: 'queue' }) as any;
  assert.equal(withdrawn.status, 'ready'); assert.deepEqual((f.engine.capacity() as any).queuedTasks, []);
  await assert.rejects(f.engine.cancel('two', 'queue'), /no queued dispatch/);
  await f.engine.dispatch('two', undefined, true);
  f.worker.release(); await reviewable(f.engine, 'one');
  await until(f.engine, 'two', t => t.status === 'running');
  assert.equal(f.worker.runs, 2); assert.deepEqual((f.engine.capacity() as any).queuedTasks, []);
  f.worker.hold = false; f.worker.release(); await reviewable(f.engine, 'two');
  assert.equal(f.engine.store.get('two').attempts, 1);
});

test('status shows live run progress without changing the revision, and records the finished run', async () => {
  const f = await fixture(); f.worker.hold = true; f.worker.steps = 42;
  await f.engine.prepare('one'); await f.engine.dispatch('one');
  const revision = f.engine.store.get('one').revision;
  const live = await callTool(f.engine, 'workflow_status', { id: 'one' }) as any;
  assert.equal(live.run.steps, 42); assert.equal(live.run.stepLimit, 150); assert.equal(live.run.phase, 'working');
  assert.equal(live.run.lastTool.title, 'pytest -q tests/test_value.py'); assert.ok(live.run.elapsedSeconds >= 0); assert.ok(live.run.idleSeconds >= 0);
  assert.equal(f.engine.store.get('one').revision, revision);
  f.worker.release(); const done = await reviewable(f.engine, 'one');
  const after = f.engine.summary(done) as any;
  assert.equal(after.run, undefined); assert.equal(after.lastRun.steps, 42); assert.equal(after.lastRun.outcome, 'awaiting_review');
});

test('verification can continue past a failure, reports the failure tail, and reruns only failed checks on unchanged source', async () => {
  const f = await fixture(); const prepared = await f.engine.prepare('one'); await f.engine.dispatch('one'); await reviewable(f.engine, 'one');
  const flag = path.join(f.root, 'flaky-now-passes');
  const selection = { strategy: 'custom' as const, rationale: 'Three independent checks', omittedCoverage: [], checks: [
    node('process.exit(0)', 'a-pass'),
    node(`console.log('boom detail'); process.exit(require('fs').existsSync(${JSON.stringify(flag)}) ? 0 : 3)`, 'b-flaky'),
    node('process.exit(0)', 'c-pass')] };
  await f.engine.verify('one', selection); let t = await reviewable(f.engine, 'one');
  assert.deepEqual(t.checks.map(c => [c.name, c.status]), [['a-pass', 'passed'], ['b-flaky', 'failed']]);
  assert.match(t.checks[1]!.tail!, /boom detail/); assert.equal(t.checks[0]!.tail, undefined); assert.ok(t.checks[1]!.durationMs! >= 0);
  await f.engine.verify('one', selection, { continueOnFailure: true }); t = await reviewable(f.engine, 'one');
  assert.deepEqual(t.checks.map(c => c.status), ['passed', 'failed', 'passed']); assert.equal(t.verifiedFingerprint, undefined);
  const prior = t.verificationHistory!.at(-1)!;
  await assert.rejects(f.engine.verify('one', selection, { rerun: 'failed' }), /omit selection/);
  writeFileSync(path.join(prepared.worktree!, 'value.txt'), 'edited after the round\n');
  await assert.rejects(f.engine.verify('one', undefined, { rerun: 'failed' }), /Source changed/);
  writeFileSync(path.join(prepared.worktree!, 'value.txt'), 'good\n'); writeFileSync(flag, 'yes');
  await callTool(f.engine, 'workflow_verify', { id: 'one', rerun: 'failed' }); t = await reviewable(f.engine, 'one');
  assert.deepEqual(t.checks.map(c => [c.name, c.passed, c.reusedFrom]), [['a-pass', true, prior.id], ['b-flaky', true, undefined], ['c-pass', true, prior.id]]);
  const run: VerificationRun = JSON.parse(readFileSync(path.join(f.engine.store.dir('one'), t.verificationHistory!.at(-1)!.artifact), 'utf8'));
  assert.equal(run.status, 'passed'); assert.equal(run.rerunOf, prior.id);
  await assert.rejects(f.engine.verify('one', undefined, { rerun: 'failed' }), /nothing to rerun/);
  assert.equal((await f.engine.review('one', 'accept', 'All three pass on current source; b-flaky reran once', ['value.txt'])).status, 'accepted');
});

test('abnormal Windows exit codes are decoded', () => {
  assert.equal(describeExitCode(3221225786), '0xC000013A terminated by Ctrl+C or console close');
  assert.equal(describeExitCode(-1073741819), '0xC0000005 access violation');
  assert.equal(describeExitCode(4294770688), '0xFFFD0000');
  assert.equal(describeExitCode(1), undefined); assert.equal(describeExitCode(null), undefined);
});

test('amending supervisor-side fields keeps the plan revision, report and session, and survives a later plan update', async () => {
  const f = await fixture();
  await f.engine.createFromInput({ id: 'amend', repository: f.repository, provider: 'fixture', baseRef: 'master', branch: 'workflow/amend', goal: 'Fix fixture',
    acceptance: [{ id: 'AC-01', requirement: 'value is good' }], allowedPaths: ['other.txt'], checks: [node('process.exit(5)', 'wrong-command')] });
  await f.engine.prepare('amend'); await f.engine.dispatch('amend'); let t = await reviewable(f.engine, 'amend');
  // Out-of-scope edits are visible as soon as the run ends, not only at verification.
  assert.deepEqual(t.scopeViolations, ['value.txt']);
  await assert.rejects(f.engine.verify('amend'), /outside the agreed scope.*workflow_plan_amend/);
  const good = node("if(require('fs').readFileSync('value.txt','utf8') !== 'good\\n') process.exit(2)", 'actual-value');
  const amended = await callTool(f.engine, 'workflow_plan_amend', { id: 'amend', expectedPlanRevision: 1,
    patch: { checks: [good], allowedPaths: ['value.txt'], resources: { workerSteps: 300 } }, reason: 'The planned check was wrong and value.txt is the intended target' }) as any;
  assert.equal(amended.planRevision, 1); assert.equal(amended.status, 'awaiting_review'); assert.equal(amended.amendments.length, 1);
  assert.equal(amended.scopeViolations, undefined); assert.equal(amended.resources.workerSteps, 300);
  t = f.engine.store.get('amend'); assert.ok(t.report, 'the worker report survives an amendment'); assert.equal(t.sessionID, 'fixture-session');
  const artifact = JSON.parse(readFileSync(path.join(f.engine.store.dir('amend'), t.amendments![0]!.artifact), 'utf8'));
  assert.equal(artifact.before.checks[0].name, 'wrong-command'); assert.equal(artifact.after.checks[0].name, 'actual-value'); assert.deepEqual(artifact.before.allowedPaths, ['other.txt']);
  await assert.rejects(f.engine.amendPlan('amend', 2, { allowedPaths: [] }, 'stale'), /Stale/);
  await assert.rejects(f.engine.amendPlan('amend', 1, { resources: { workerSteps: 700 } }, 'above the machine ceiling'), /workerSteps exceeds/);
  await assert.rejects(callTool(f.engine, 'workflow_plan_amend', { id: 'amend', expectedPlanRevision: 1, patch: { goal: 'New goal' }, reason: 'Not an amendable field' }));
  await assert.rejects(callTool(f.engine, 'workflow_plan_amend', { id: 'amend', expectedPlanRevision: 1, patch: {}, reason: 'Empty' }), /must change/);
  await f.engine.verify('amend'); t = await reviewable(f.engine, 'amend'); assert.equal(t.checks[0]!.name, 'actual-value');
  // Amending the planned checks voids a passing round that ran the old planned selection.
  await f.engine.amendPlan('amend', 1, { checks: [good, node('process.exit(0)', 'smoke')] }, 'Add a smoke check');
  await assert.rejects(f.engine.review('amend', 'accept', 'Old round', ['value.txt']), /independent verification/);
  await f.engine.review('amend', 'rework', 'One more case', ['value.txt'], feedback());
  const updated = await f.engine.updatePlan('amend', 1, { goal: 'Fix fixture with one more case' }, 'Clarify');
  assert.deepEqual(updated.spec.checks.map(c => c.name), ['actual-value', 'smoke']); assert.deepEqual(updated.spec.allowedPaths, ['value.txt']);
  assert.equal(updated.spec.resources?.workerSteps, 300);
  await assert.rejects(f.engine.amendPlan('amend', 2, { allowedPaths: ['src/**'] }, 'Glob'), /allowedPaths entry/);
});

test('the task overview is compact and filtered, and finished tasks can be archived without losing their records', async () => {
  const f = await fixture();
  f.engine.create({ ...f.spec, id: 'two', branch: 'workflow/two' }); f.engine.create({ ...f.spec, id: 'three', branch: 'workflow/three' });
  f.engine.create({ ...f.spec, id: 'child', branch: 'workflow/child', dependencies: ['one'] });
  await f.engine.prepare('one'); await f.engine.dispatch('one'); await reviewable(f.engine, 'one');
  await f.engine.verify('one'); await reviewable(f.engine, 'one'); await f.engine.review('one', 'accept', 'Checked', ['value.txt']);
  await f.engine.prepare('three'); await f.engine.cancel('three');
  const overview = await callTool(f.engine, 'workflow_status', {}) as any;
  assert.deepEqual(overview.tasks.map((t: any) => t.id).sort(), ['child', 'two']); assert.equal(overview.total, 4);
  assert.deepEqual(overview.countsByStatus, { accepted: 1, planned: 2, cancelled: 1 });
  assert.equal(overview.tasks[0].report, undefined, 'the overview carries no per-task history');
  assert.equal((await callTool(f.engine, 'workflow_status', { scope: 'all' }) as any).tasks.length, 4);
  assert.deepEqual((await callTool(f.engine, 'workflow_status', { scope: 'all', status: ['accepted'] }) as any).tasks.map((t: any) => t.id), ['one']);
  assert.equal((await callTool(f.engine, 'workflow_status', { repository: path.join(f.root, 'elsewhere') }) as any).matched, 0);
  assert.equal((await callTool(f.engine, 'workflow_status', { repository: f.repository.toUpperCase() }) as any).matched, process.platform === 'win32' ? 2 : 0);
  let result = await callTool(f.engine, 'workflow_archive', { ids: ['one', 'two'] }) as any;
  assert.match(result.results[0].error, /depend on one: child/); assert.match(result.results[1].error, /two is planned/);
  await f.engine.cancel('child');
  // git refuses to remove a worktree holding the worker's uncommitted edit; the task then stays active.
  result = await f.engine.archive(['one'], true) as any;
  assert.equal(result.results[0].archived, false); assert.ok(existsSync(path.join(f.root, 'worktrees/one')));
  result = await f.engine.archive(['one', 'three'], false) as any;
  assert.deepEqual(result.results.map((r: any) => [r.id, r.archived, r.worktree]), [['one', true, 'kept'], ['three', true, 'kept']]);
  assert.ok(existsSync(path.join(f.root, '.runtime/archive/one/task.json'))); assert.ok(existsSync(path.join(f.root, 'worktrees/one')));
  assert.throws(() => f.engine.store.get('one'), /archived/);
  const archived = await callTool(f.engine, 'workflow_status', { id: 'one' }) as any;
  assert.equal(archived.archived, true); assert.equal(archived.status, 'accepted');
  assert.deepEqual((await callTool(f.engine, 'workflow_status', { scope: 'archived' }) as any).tasks.map((t: any) => t.id).sort(), ['one', 'three']);
  assert.throws(() => f.engine.create({ ...f.spec, id: 'one' }), /archived task/);
  assert.equal((f.engine.handoff(['child']) as any).tasks[0].dependencies[0].archived, true);
});

test('archiving can remove a clean managed worktree', async () => {
  const f = await fixture(); const prepared = await f.engine.prepare('one'); await f.engine.cancel('one');
  const result = await f.engine.archive(['one'], true) as any;
  assert.equal(result.results[0].worktree, 'removed'); assert.equal(existsSync(prepared.worktree!), false);
  assert.equal(await git(f.repository, ['branch', '--list', 'workflow/one']) !== '', true, 'the branch is kept');
});

test('scope syntax and environment names are validated when the contract is created', async () => {
  const f = await fixture();
  for (const bad of ['src/**', 'src/*.ts', 'file?.txt', 'C:/abs/file', '/abs', 'src\\a.ts', './src', 'a/../b', 'a//b', ''])
    assert.throws(() => TaskSpecSchema.parse({ ...f.spec, allowedPaths: [bad] }), /allowedPaths entry/, bad);
  assert.deepEqual(TaskSpecSchema.parse({ ...f.spec, allowedPaths: ['CMakeLists.txt', 'modules/prefab', 'modules/prefab/', 'app/[id]/page.tsx'] }).allowedPaths.length, 4);
  assert.throws(() => TaskSpecSchema.parse({ ...f.spec, environment: { DEPLOY_API_KEY: 'x' } }), /credential/);
  assert.throws(() => TaskSpecSchema.parse({ ...f.spec, environment: { OPENCODE_CONFIG: 'x' } }), /reserved/);
  assert.throws(() => TaskSpecSchema.parse({ ...f.spec, environment: { 'BAD-NAME': 'x' } }));
  assert.deepEqual(TaskSpecSchema.parse(f.spec).environment, {});
});

test('contract environment reaches the worker and verification commands, with expansion and Windows case handling', async () => {
  const merged = applyEnvironment({ Path: 'C:/bin', HOME: 'C:/home' }, { PATH: 'D:/tools;${PATH}', SDK: '${HOME}/sdk', EMPTY: '${MISSING}' });
  assert.equal(merged.SDK, 'C:/home/sdk'); assert.equal(merged.EMPTY, '');
  if (process.platform === 'win32') { assert.equal(merged.PATH, 'D:/tools;C:/bin'); assert.equal('Path' in merged, false); }
  const f = await fixture();
  const env = workerEnv(ROOT, config, 'fixture', { PATH: 'fixture-path', FIXTURE_KEY: 'worker-secret' }, 'password', mkdtempSync(path.join(scratch, 'env-')), undefined,
    { steps: 300, environment: { VULKAN_SDK: 'D:/VulkanSDK', PATH: 'D:/vcpkg;${PATH}' } });
  assert.equal(env.VULKAN_SDK, 'D:/VulkanSDK'); assert.equal(env.PATH, 'D:/vcpkg;fixture-path'); assert.equal(env.WORKFLOW_API_KEY, 'worker-secret');
  assert.equal(JSON.parse(env.OPENCODE_CONFIG_CONTENT!).agent.executor.steps, 300);
  f.engine.create({ ...f.spec, id: 'env', branch: 'workflow/env', environment: { FIXTURE_FLAG: 'on' }, checks: [node("process.exit(process.env.FIXTURE_FLAG === 'on' ? 0 : 7)", 'sees-env')] });
  await f.engine.prepare('env'); await f.engine.dispatch('env'); await reviewable(f.engine, 'env');
  assert.deepEqual(contract(f.engine, 'env').environment, { FIXTURE_FLAG: 'on' });
  await f.engine.verify('env'); const t = await reviewable(f.engine, 'env'); assert.equal(t.checks[0]!.passed, true);
  assert.deepEqual((f.engine.summary(t) as any).environment, ['FIXTURE_FLAG']);
});

test('configured list prices estimate cost, and a token budget stops dispatch before more is spent', async () => {
  const pricing = { currency: 'CNY', inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.5 };
  assert.equal(pricedCost([{ info: { tokens: { input: 1e6, output: 5e5, reasoning: 5e5, cache: { read: 2e6 } } } }], pricing), 11);
  assert.equal(pricedCost([{ info: { tokens: { input: 1e6 } } }], undefined), 0);
  const f = await fixture({ providers: { fixture: { ...config.providers.fixture!, pricing } } });
  f.engine.create({ ...f.spec, id: 'priced', branch: 'workflow/priced', resources: { tokenBudget: 1000 } });
  const summary = f.engine.summary(f.engine.store.get('priced')) as any;
  assert.equal(summary.costCurrency, 'CNY'); assert.equal(summary.pricingConfigured, true); assert.equal(summary.tokenBudget, 1000);
  assert.deepEqual((await callTool(f.engine, 'workflow_config', {}) as any).providers.fixture.pricing, pricing);
  await f.engine.prepare('priced'); f.worker.fail = true; f.worker.steps = 5;
  await f.engine.dispatch('priced'); let t = await settled(f.engine, 'priced', 1);
  assert.equal(t.status, 'failed'); assert.equal(t.totalTokens, 40); assert.equal(t.cost, 0.5);
  t.totalTokens = 1000; f.engine.store.save(t);
  await assert.rejects(f.engine.dispatch('priced', feedback()), /Token budget exhausted.*workflow_plan_amend/);
  await f.engine.amendPlan('priced', 1, { resources: { tokenBudget: 5000 } }, 'User approved a larger budget');
  f.worker.fail = false; await f.engine.dispatch('priced', feedback()); t = await settled(f.engine, 'priced', 2);
  assert.equal(t.status, 'awaiting_review');
});

test('step budgets have a machine default and ceiling', () => {
  assert.equal(config.workerSteps, 150); assert.equal(config.maxWorkerSteps, 600); assert.equal(config.maxStepContinuations, 2);
  assert.throws(() => ConfigSchema.parse({ ...config, workerSteps: 700 }), /maxWorkerSteps/);
});
