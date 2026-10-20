import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.js';
import { ConfigSchema, TaskSpecSchema, type Task } from '../src/schema.js';
import { workerEnv, type Worker } from '../src/opencode.js';
import { ROOT, loadEnv } from '../src/config.js';
import { git } from '../src/process.js';
import { callTool } from '../src/tools.js';
import { fingerprint } from '../src/worktree.js';
import { contractFields, makeReport } from './fixtures.js';

const scratch = path.join(ROOT, 'work/workflow-tests'); mkdirSync(scratch, { recursive: true });
const config = ConfigSchema.parse({ executionEnabled: true, maxParallel: 1, maxAttempts: 2, taskTimeoutMinutes: 5,
  providers: { fixture: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', contextLimit: 32768, outputLimit: 4096 } } });
class FakeWorker implements Worker {
  sessions: string[] = []; fail = false; hold = false; release?: () => void;
  async run(task: Task, session: (id: string) => void) {
    const id = task.sessionID ?? 'fixture-session'; this.sessions.push(id); session(id);
    if (this.hold) await new Promise<void>(resolve => { this.release = resolve; });
    if (this.fail) throw new Error('fixture failure');
    writeFileSync(path.join(task.worktree!, 'value.txt'), 'good\n');
    return { report: makeReport(task), transcript: [{ text: 'fixture transcript' }], tokens: 12, cost: 0 };
  }
  async cancel() { this.release?.(); }
  async close() { this.release?.(); }
}
async function fixture(overrides: Partial<typeof config> = {}) {
  const root = mkdtempSync(path.join(scratch, 'case-')); const repository = path.join(root, 'repository'); mkdirSync(repository);
  await git(repository, ['init', '-b', 'master']); writeFileSync(path.join(repository, 'value.txt'), 'old\n');
  await git(repository, ['config', 'core.autocrlf', 'true']);
  await git(repository, ['add', 'value.txt']);
  await git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const worker = new FakeWorker(); const engine = new Engine(root, { ...config, ...overrides }, { ...process.env, FIXTURE_KEY: 'local-test-only' }, worker);
  const spec = TaskSpecSchema.parse({ ...contractFields, id: 'one', title: 'Fixture task', repository, baseRef: 'master', branch: 'workflow/one', provider: 'fixture', goal: 'Fix fixture', acceptance: [{ id: 'AC-01', requirement: 'value is good' }],
    checks: [{ name: 'actual-value', command: process.execPath, args: ['-e', "if(require('fs').readFileSync('value.txt','utf8') !== 'good\\n') process.exit(2)"], timeoutMinutes: 1 }] });
  engine.create(spec); return { root, repository, worker, engine, spec };
}
async function until(engine: Engine, id: string, expected: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const t = engine.store.get(id); if (t.status === expected) return t; await delay(20); }
  throw new Error(`Expected ${expected}, got ${engine.store.get(id).status}`);
}

test('review gate prevents worktree creation and dispatch without touching repository', async () => {
  const f = await fixture({ executionEnabled: false });
  await assert.rejects(f.engine.prepare('one'), /disabled/);
  await assert.rejects(f.engine.dispatch('one'), /disabled/);
  assert.equal(existsSync(path.join(f.root, 'worktrees/one')), false);
  assert.equal(await git(f.repository, ['branch', '--show-current']), 'master');
});
test('isolated worktree, real independent check, acceptance and stale-source rejection', async () => {
  const { engine, repository } = await fixture(); const task = await engine.prepare('one');
  assert.equal(await git(repository, ['branch', '--show-current']), 'master');
  await engine.dispatch('one'); await until(engine, 'one', 'awaiting_review');
  await assert.rejects(engine.review('one', 'accept', 'reviewed', ['value.txt']), /verification/);
  await engine.verify('one'); const checked = await until(engine, 'one', 'awaiting_review');
  assert.equal(checked.checks[0]!.passed, true); assert.equal(checked.checks[0]!.exitCode, 0);
  writeFileSync(path.join(task.worktree!, 'value.txt'), 'bad\n');
  await assert.rejects(engine.review('one', 'accept', 'reviewed', ['value.txt']), /verification/);
  writeFileSync(path.join(task.worktree!, 'value.txt'), 'good\n');
  assert.equal((await engine.review('one', 'accept', 'Code and check reviewed', ['value.txt', 'verify-actual-value.log'])).status, 'accepted');
});
test('a failed independent check cannot be accepted', async () => {
  const { engine } = await fixture(); const task = await engine.prepare('one');
  await engine.dispatch('one'); await until(engine, 'one', 'awaiting_review');
  writeFileSync(path.join(task.worktree!, 'value.txt'), 'wrong\n'); await engine.verify('one');
  const result = await until(engine, 'one', 'awaiting_review'); assert.equal(result.checks[0]!.exitCode, 2);
  await assert.rejects(engine.review('one', 'accept', 'reviewed', ['log']), /checks must pass/);
});
test('supervisor can verify and rework beyond maxAttempts until acceptance in the same session', async () => {
  const { engine, worker } = await fixture(); await engine.prepare('one'); await engine.dispatch('one'); await until(engine, 'one', 'awaiting_review');
  const feedback = { planRevision: 1, summary: 'Cover another edge case', findings: [{ criterionIds: ['AC-01'], description: 'Missing edge case', evidence: ['value.txt'], requestedChange: 'Add coverage' }] };
  for (let round = 0; round < 4; round++) {
    await engine.verify('one'); await until(engine, 'one', 'awaiting_review');
    await engine.review('one', 'rework', 'Cover another edge case', ['value.txt'], feedback);
    await engine.dispatch('one'); await until(engine, 'one', 'awaiting_review');
  }
  assert.equal(worker.sessions.length, 5); assert.ok(worker.sessions.every(id => id === 'fixture-session'));
  const summary = engine.summary(engine.store.get('one')) as any;
  assert.equal(summary.attempts, 5); assert.equal(summary.recoveryAttempts, 0);
  assert.equal(summary.remainingRecoveryAttempts, 2); assert.equal(summary.reworkLimit, null);
  await engine.verify('one'); await until(engine, 'one', 'awaiting_review');
  assert.equal((await engine.review('one', 'accept', 'All findings resolved', ['value.txt', 'verify-actual-value.log'])).status, 'accepted');
});
test('concurrent dispatches cannot bypass the configured parallel limit', async () => {
  const { engine, worker, spec } = await fixture(); worker.hold = true;
  engine.create({ ...spec, id: 'two', branch: 'workflow/two' }); await engine.prepare('one'); await engine.prepare('two');
  const outcomes = await Promise.allSettled([engine.dispatch('one'), engine.dispatch('two')]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  await engine.close();
});
test('cancelling a worker does not resurrect its result or delete its worktree', async () => {
  const { engine, worker } = await fixture(); worker.hold = true; const task = await engine.prepare('one');
  await engine.dispatch('one'); await engine.cancel('one'); await engine.close();
  assert.equal(engine.store.get('one').status, 'cancelled'); assert.equal(existsSync(task.worktree!), true);
});
test('daemon recovery marks in-flight work interrupted and requires diagnostic feedback', async () => {
  const f = await fixture(); await f.engine.prepare('one'); const t = f.engine.store.get('one'); t.status = 'running'; f.engine.store.save(t);
  const recovered = new Engine(f.root, config, { FIXTURE_KEY: 'local-test-only' }, f.worker);
  assert.equal(recovered.store.get('one').status, 'interrupted'); await assert.rejects(recovered.dispatch('one'), /diagnostic feedback/);
});
test('artifact traversal and unknown task fields are rejected', async () => {
  const { engine, spec } = await fixture();
  assert.throws(() => engine.artifact('one', '../daemon.json'), /filename/);
  assert.throws(() => engine.store.get('../../secrets'), /Invalid task ID/);
  await assert.rejects(callTool(engine, 'workflow_task_create', { spec: { ...spec, injected: true } }));
});
test('worker environment strips main-agent credentials and uses a single explicit API provider', () => {
  const state = mkdtempSync(path.join(scratch, 'env-'));
  const result = workerEnv(ROOT, config, 'fixture', { PATH: 'fixture-path', ANTHROPIC_API_KEY: 'main-secret', OPENAI_API_KEY: 'main-secret-2', GH_TOKEN: 'gh-secret', FIXTURE_KEY: 'worker-secret', VCPKG_ROOT: 'D:/vcpkg' }, 'local-password', state);
  assert.equal(result.ANTHROPIC_API_KEY, undefined); assert.equal(result.OPENAI_API_KEY, undefined); assert.equal(result.GH_TOKEN, undefined);
  assert.equal(result.WORKFLOW_API_KEY, 'worker-secret'); assert.equal(result.VCPKG_ROOT, 'D:/vcpkg');
  const parsed = JSON.parse(result.OPENCODE_CONFIG_CONTENT!); assert.deepEqual(parsed.enabled_providers, ['workflow']);
  assert.equal(parsed.agent.investigator.permission.edit, 'deny'); assert.equal(parsed.agent.executor.permission.task, 'deny');
  assert.equal(parsed.agent.plan.disable, true); assert.equal(parsed.agent.build.disable, true);
  assert.match(parsed.agent.executor.prompt, /workflow-executor/); assert.match(parsed.agent.investigator.prompt, /workflow-investigator/);
});
test('untracked new files participate in source fingerprint and scope validation', async () => {
  const { engine } = await fixture(); const task = await engine.prepare('one'); const before = await fingerprint(task);
  writeFileSync(path.join(task.worktree!, 'new-file.cpp'), 'int x;\n'); assert.notEqual(await fingerprint(task), before);
  task.spec.allowedPaths = ['value.txt']; task.status = 'awaiting_review'; engine.store.save(task);
  await assert.rejects(engine.verify('one'), /outside the agreed scope/);
});
test('missing API key prevents dispatch before any worker is called', async () => {
  const f = await fixture(); await f.engine.prepare('one'); delete f.engine.env.FIXTURE_KEY;
  await assert.rejects(f.engine.dispatch('one'), /Missing FIXTURE_KEY/); assert.equal(f.worker.sessions.length, 0);
});
test('example #244 is valid, latest-master based and not automatically created', () => {
  const example = JSON.parse(readFileSync(path.join(ROOT, 'examples/alpha-244.json'), 'utf8'));
  const task = TaskSpecSchema.parse(example.spec); assert.equal(task.baseRef, 'origin/master'); assert.equal(task.fetchRemote, 'origin');
  assert.equal(task.checks.length, 2); assert.equal(config.providers.fixture!.model, 'fixture');
});


test('a recorded infrastructure credit preserves monotonic attempt IDs and still enforces a finite retry budget', async () => {
  const { engine, worker } = await fixture({ maxAttempts: 1 });
  await engine.prepare('one'); worker.fail = true;
  await engine.dispatch('one'); const failed = await until(engine, 'one', 'failed');
  assert.equal(failed.attempts, 1); const firstRun = failed.runId;
  failed.infrastructureRetryCredits = 1; engine.store.save(failed);
  worker.fail = false;
  const feedback = { planRevision: 1, summary: 'Infrastructure transport fixed', findings: [{ criterionIds: ['AC-01'], description: 'First transport run was interrupted by an infrastructure defect', evidence: ['failure log'], requestedChange: 'Continue the existing worktree and session' }] };
  await engine.dispatch('one', feedback); const resumed = await until(engine, 'one', 'awaiting_review');
  assert.equal(resumed.attempts, 2); assert.notEqual(resumed.runId, firstRun);
  assert.equal(resumed.report!.attempt, 2);
  const summary = engine.summary(resumed) as any;
  assert.equal(summary.infrastructureRetryCredits, 1); assert.equal(summary.recoveryAttemptLimit, 2);
  assert.equal(summary.recoveryAttempts, 1); assert.equal(summary.remainingRecoveryAttempts, 1);
  await engine.review('one', 'rework', 'More coverage', ['value.txt'], feedback);
  worker.fail = true;
  await engine.dispatch('one'); await until(engine, 'one', 'failed');
  await engine.dispatch('one', feedback); await until(engine, 'one', 'failed');
  await assert.rejects(engine.dispatch('one', feedback), /Recovery attempt limit/);
});

for (const status of ['failed', 'interrupted', 'blocked'] as const) {
  test(`${status} recovery has a persistent budget that plan updates cannot bypass`, async () => {
    const f = await fixture({ maxAttempts: 1 }); await f.engine.prepare('one');
    await f.engine.dispatch('one'); await until(f.engine, 'one', 'awaiting_review');
    // Model an already persisted abnormal outcome, including legacy tasks without recovery counters.
    const task = f.engine.store.get('one'); task.status = status; f.engine.store.save(task);
    await f.engine.updatePlan('one', 1, { ...f.spec, planRevision: 2 }, 'Diagnose abnormal run');
    const feedback = { planRevision: 2, summary: 'Resume after diagnosis', findings: [{ criterionIds: ['AC-01'], description: 'Abnormal run diagnosed', evidence: ['run log'], requestedChange: 'Resume implementation' }] };
    await assert.rejects(f.engine.dispatch('one'), /diagnostic feedback/);
    delete f.engine.env.FIXTURE_KEY;
    await assert.rejects(f.engine.dispatch('one', feedback), /Missing FIXTURE_KEY/);
    assert.equal(f.engine.store.get('one').recoveryAttempts, undefined);
    f.engine.env.FIXTURE_KEY = 'local-test-only';
    await f.engine.dispatch('one', feedback); await until(f.engine, 'one', 'awaiting_review');
    // A successful review/rework round remains available after recovery budget is exhausted.
    await f.engine.review('one', 'rework', 'Add coverage', ['value.txt'], feedback);
    f.worker.fail = true;
    await f.engine.dispatch('one'); await until(f.engine, 'one', 'failed');
    const engine = new Engine(f.root, { ...config, maxAttempts: 1 }, f.engine.env, f.worker);
    await engine.updatePlan('one', 2, { ...f.spec, planRevision: 3 }, 'Retain recovery budget');
    const summary = engine.summary(engine.store.get('one')) as any;
    assert.equal(summary.attempts, 3); assert.equal(summary.recoveryAttempts, 1);
    assert.equal(summary.remainingRecoveryAttempts, 0); assert.equal(summary.recoveryPending, true);
    await assert.rejects(engine.dispatch('one', { ...feedback, planRevision: 3 }), /Recovery attempt limit/);
    assert.equal(engine.store.get('one').attempts, 3);
  });
}

test('new tasks default to DeepSeek and preserve an explicit provider selection', async () => {
  const f = await fixture({ providers: { ...config.providers, deepseek: { ...config.providers.fixture!, model: 'deepseek-flash' } } });
  const spec = TaskSpecSchema.parse({ ...f.spec, id: 'default-ds', provider: undefined });
  assert.equal(f.engine.create(spec).spec.provider, 'deepseek');
  assert.equal(f.engine.store.get('one').spec.provider, 'fixture');
  const status = await callTool(f.engine, 'workflow_config', {}) as any;
  assert.equal(status.defaultProvider, 'deepseek'); assert.equal(status.defaultModel, 'deepseek-flash');
});

test('branch workspace uses the repository checkout and full verification still gates acceptance', async () => {
  const f = await fixture();
  f.engine.create({ ...f.spec, id: 'branch-task', branch: 'workflow/branch-task', workspaceMode: 'branch',
    workerChecks: [{ name: 'targeted', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMinutes: 1 }] });
  const prepared = await f.engine.prepare('branch-task');
  assert.equal(prepared.worktree, f.repository);
  assert.equal(existsSync(path.join(f.root, 'worktrees/branch-task')), false);
  assert.equal(await git(f.repository, ['branch', '--show-current']), 'workflow/branch-task');
  await f.engine.dispatch('branch-task'); await until(f.engine, 'branch-task', 'awaiting_review');
  await assert.rejects(f.engine.review('branch-task', 'accept', 'reviewed', ['value.txt']), /verification/);
  await f.engine.verify('branch-task'); const verified = await until(f.engine, 'branch-task', 'awaiting_review');
  assert.deepEqual(verified.checks.map(c => c.name), ['actual-value']);
  assert.deepEqual(verified.report!.checks.map(c => c.name), ['targeted']);
  assert.equal((await f.engine.review('branch-task', 'accept', 'reviewed full and targeted results', ['value.txt', 'verify-actual-value.log'])).status, 'accepted');
});

test('direct primary-branch work requires a recorded warning, then prepares without another approval', async () => {
  const f = await fixture();
  const spec = { ...f.spec, id: 'direct', branch: 'master', workspaceMode: 'current' as const };
  f.engine.create(spec);
  await assert.rejects(f.engine.prepare('direct'), /warning required/i);
  const warning = '警告：本任务将直接修改 master 主分支。';
  await f.engine.updatePlan('direct', 1, { ...spec, planRevision: 2, mainBranchWarning: warning }, 'Record displayed primary-branch warning');
  const task = await f.engine.prepare('direct');
  assert.equal(task.worktree, f.repository); assert.deepEqual(task.workspaceWarnings, [warning]);
  assert.equal(await git(f.repository, ['branch', '--show-current']), 'master');
  assert.ok(readFileSync(path.join(f.engine.store.dir('direct'), 'events.jsonl'), 'utf8').includes(warning));
});

test('in-place preparation preserves dirty files and prevents concurrent ownership or branch switching', async () => {
  const f = await fixture();
  f.engine.create({ ...f.spec, id: 'owner', branch: 'workflow/owner', workspaceMode: 'branch' });
  f.engine.create({ ...f.spec, id: 'other', branch: 'workflow/other', workspaceMode: 'branch' });
  writeFileSync(path.join(f.repository, 'personal.txt'), 'user work');
  await assert.rejects(f.engine.prepare('owner'), /existing changes/);
  assert.equal(readFileSync(path.join(f.repository, 'personal.txt'), 'utf8'), 'user work');
  // Commit only the temporary fixture's user file, so branch preparation can proceed.
  await git(f.repository, ['add', 'personal.txt']);
  await git(f.repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture personal file']);
  await f.engine.prepare('owner');
  await assert.rejects(f.engine.prepare('other'), /reserved by another task/);
  assert.equal(await git(f.repository, ['branch', '--show-current']), 'workflow/owner');
});

test('concurrent prepares cannot reserve the same repository directory twice', async () => {
  const f = await fixture();
  f.engine.create({ ...f.spec, id: 'a', branch: 'workflow/a', workspaceMode: 'branch' });
  f.engine.create({ ...f.spec, id: 'b', branch: 'workflow/b', workspaceMode: 'branch' });
  const outcomes = await Promise.allSettled([f.engine.prepare('a'), f.engine.prepare('b')]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1);
});

test('switching a prepared shared checkout branch prevents dispatch', async () => {
  const f = await fixture();
  f.engine.create({ ...f.spec, id: 'shared', branch: 'workflow/shared', workspaceMode: 'branch' });
  await f.engine.prepare('shared'); await git(f.repository, ['switch', 'master']);
  await assert.rejects(f.engine.dispatch('shared'), /branch changed/);
  assert.equal(f.worker.sessions.length, 0);
});

test('supervisor chooses bounded verification without running planned full-suite commands', async () => {
  const f = await fixture();
  const original = f.engine.store.get('one');
  original.spec.checks = [{ name: 'expensive-full', command: process.execPath, args: ['-e', 'process.exit(91)'], timeoutMinutes: 1 }];
  f.engine.store.save(original);
  await f.engine.prepare('one'); await f.engine.dispatch('one'); await until(f.engine, 'one', 'awaiting_review');
  await f.engine.verify('one', { strategy: 'affected', rationale: 'Only value.txt changed; inspect its output instead of running the large project matrix',
    checks: [{ name: 'affected-value', command: process.execPath, args: ['-e', "if(require('fs').readFileSync('value.txt','utf8') !== 'good\\n')process.exit(1)"], timeoutMinutes: 1 }],
    omittedCoverage: ['Full project regression matrix'] });
  const result = await until(f.engine, 'one', 'awaiting_review');
  assert.deepEqual(result.checks.map(c => c.name), ['affected-value']); assert.equal(result.checks[0]!.passed, true);
  assert.equal(result.spec.checks[0]!.name, 'expensive-full');
  assert.deepEqual(result.verificationSelection?.omittedCoverage, ['Full project regression matrix']);
  assert.equal((await f.engine.review('one', 'accept', 'Affected test passed; full-matrix omission reviewed', ['value.txt', 'verify-affected-value.log'])).status, 'accepted');
});

test('selected verification cannot skip every check or accept a failed selected check', async () => {
  const f = await fixture(); await f.engine.prepare('one'); await f.engine.dispatch('one'); await until(f.engine, 'one', 'awaiting_review');
  await assert.rejects(f.engine.verify('one', { strategy: 'custom', rationale: 'No tests', checks: [], omittedCoverage: [] }), /at least one supervisor-selected/);
  await f.engine.verify('one', { strategy: 'targeted', rationale: 'Focused regression', checks: [{ name: 'failure', command: process.execPath, args: ['-e', 'process.exit(4)'], timeoutMinutes: 1 }], omittedCoverage: [] });
  const result = await until(f.engine, 'one', 'awaiting_review'); assert.equal(result.checks[0]!.exitCode, 4);
  await assert.rejects(f.engine.review('one', 'accept', 'reviewed', ['log']), /checks must pass/);
});
