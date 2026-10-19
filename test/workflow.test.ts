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
test('rework resumes the same session and attempt limit stops repeated dispatches', async () => {
  const { engine, worker } = await fixture(); await engine.prepare('one'); await engine.dispatch('one'); await until(engine, 'one', 'awaiting_review');
  const feedback = { planRevision: 1, summary: 'Cover another edge case', findings: [{ criterionIds: ['AC-01'], description: 'Missing edge case', evidence: ['value.txt'], requestedChange: 'Add coverage' }] };
  await engine.review('one', 'rework', 'Cover another edge case', ['value.txt'], feedback); await engine.dispatch('one'); await until(engine, 'one', 'awaiting_review');
  assert.deepEqual(worker.sessions, ['fixture-session', 'fixture-session']);
  await engine.review('one', 'rework', 'Still incomplete', ['test'], feedback); await assert.rejects(engine.dispatch('one'), /Attempt limit/);
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
  assert.equal(summary.infrastructureRetryCredits, 1); assert.equal(summary.attemptLimit, 2); assert.equal(summary.remainingAttempts, 0);
  await engine.review('one', 'rework', 'More coverage', ['value.txt'], feedback);
  await assert.rejects(engine.dispatch('one'), /Attempt limit/);
});
