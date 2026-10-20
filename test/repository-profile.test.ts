import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.js';
import { ROOT } from '../src/config.js';
import { git } from '../src/process.js';
import { repositoryIdentity } from '../src/repository-profile.js';
import { ConfigSchema, RepositoryPreferencesSchema, TaskInputSchema, type TaskInput, type Task } from '../src/schema.js';
import { callTool } from '../src/tools.js';
import { taskContract } from '../src/protocol.js';
import { fingerprint } from '../src/worktree.js';
import { makeReport } from './fixtures.js';

const scratch = path.join(ROOT, 'work/workflow-tests'); mkdirSync(scratch, { recursive: true });
async function fixture() {
  const root = mkdtempSync(path.join(scratch, 'preferences-')); const repository = path.join(root, 'repo with spaces'); mkdirSync(repository);
  await git(repository, ['init', '-b', 'master']); writeFileSync(path.join(repository, 'value.txt'), 'initial\n');
  await git(repository, ['add', 'value.txt']); await git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const config = ConfigSchema.parse({ executionEnabled: true, maxParallel: 1, maxAttempts: 2, taskTimeoutMinutes: 5,
    providers: { fixture: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', contextLimit: 8192, outputLimit: 1024 } } });
  const worker = { async run(task: Task, session: (id: string) => void) {
    session('fixture-session'); writeFileSync(path.join(task.worktree!, 'value.txt'), 'implemented\n');
    const report = makeReport(task); report.acceptanceResults[0]!.status = 'pending_supervisor';
    return { report, transcript: [], tokens: 0, cost: 0 };
  }, async cancel() {}, async close() {} };
  return { root, repository, config, worker, engine: new Engine(root, config, { ...process.env, FIXTURE_KEY: 'fixture-only' }, worker) };
}
function input(repository: string, id = 'one', patch: Partial<TaskInput> = {}): TaskInput {
  return { id, repository, goal: 'Implement the scoped value change', acceptance: [{ id: 'AC-01', requirement: 'Value is implemented' }], ...patch };
}
function preferences(patch: Record<string, unknown> = {}) {
  return RepositoryPreferencesSchema.parse({ defaults: { provider: 'fixture', verificationPolicy: 'review_allowed' }, ...patch });
}
async function configure(f: Awaited<ReturnType<typeof fixture>>, pref = preferences(), revision = 0) {
  return await callTool(f.engine, 'workflow_repository_config_update', { repository: f.repository, id: 'project', expectedRevision: revision, preferences: pref }) as any;
}
async function reviewed(engine: Engine, id: string) {
  for (let i = 0; i < 500; i++) { const task = engine.store.get(id); if (task.status === 'awaiting_review') return task; if (task.status === 'failed') throw new Error(task.lastError); await delay(10); }
  throw new Error('Fixture did not reach review');
}

test('repository binding is shared across worktrees and does not depend on folder names', async () => {
  const f = await fixture(); const saved = await configure(f);
  const worktree = path.join(f.root, 'another checkout'); await git(f.repository, ['worktree', 'add', '-b', 'feature', worktree, 'master']);
  const found = await callTool(f.engine, 'workflow_repository_config', { repository: worktree }) as any;
  assert.equal(found.profile.value.id, 'project'); assert.equal(found.identity.commonGitDir, saved.identity.commonGitDir);
  const second = path.join(f.root, 'nested', 'repo with spaces'); mkdirSync(second, { recursive: true }); await git(second, ['init', '-b', 'master']);
  const unrelated = await f.engine.profiles.read(second, f.config) as any; assert.equal(unrelated.profile, null);
  if (process.platform === 'win32') assert.equal((await repositoryIdentity(f.repository.toUpperCase())).commonGitDir, found.identity.commonGitDir);
  assert.equal(existsSync(path.join(f.engine.profiles.directory, 'project', 'scripts')), true);
});

test('four-field task input inherits defaults and requirements and stores a complete source-traceable snapshot', async () => {
  const f = await fixture(); const pref = preferences({ defaults: { provider: 'fixture', verificationPolicy: 'review_allowed', baseRef: 'master', branchPrefix: 'feature/',
    constraints: ['Default style'], resources: { workerMemoryLimitMB: 512 } }, requirements: { constraints: ['Preserve author headers', 'Keep CRLF'] } });
  const profile = await configure(f, pref); const request = input(f.repository);
  assert.deepEqual(Object.keys(TaskInputSchema.parse(request)).sort(), ['acceptance', 'goal', 'id', 'repository']);
  await callTool(f.engine, 'workflow_task_create', { spec: request }); const task = f.engine.store.get('one');
  assert.equal(task.spec.branch, 'feature/one'); assert.equal(task.spec.baseRef, 'master'); assert.equal(task.spec.provider, 'fixture');
  assert.equal(task.spec.title, request.goal); assert.equal(task.spec.steps.length, 1); assert.equal(task.spec.autonomy.localDecisions.length, 1);
  assert.deepEqual(task.spec.constraints, ['Default style', 'Preserve author headers', 'Keep CRLF']);
  assert.equal(task.spec.resources!.workerMemoryLimitMB, 512); assert.equal(task.spec.resources!.taskTimeoutMinutes, 5);
  assert.equal(task.configuration!.sources['resources.workerMemoryLimitMB'], 'repository_default');
  assert.equal(task.configuration!.sources.goal, 'task'); assert.equal(task.configuration!.sources['constraints.1'], 'repository_requirement');
  assert.equal(task.configuration!.profile!.hash, profile.profile.hash);
  const snapshot = JSON.parse((f.engine.artifact('one', 'configuration-v1.json') as any).text);
  assert.deepEqual(snapshot.spec, task.spec); assert.deepEqual(snapshot.configuration.profile.value.preferences, pref);
});

test('task overrides replace default arrays while repository requirements always survive', async () => {
  const f = await fixture(); await configure(f, preferences({ defaults: { provider: 'fixture', verificationPolicy: 'review_allowed', constraints: ['Soft default'],
    checks: [{ name: 'default', command: 'unused-command' }], nonGoals: ['Reusable exclusion'] }, requirements: { constraints: ['Required header'] } }));
  const task = await f.engine.createFromInput(input(f.repository, 'one', { constraints: ['Task-specific style'], nonGoals: [], checks: [] }));
  assert.deepEqual(task.spec.constraints, ['Task-specific style', 'Required header']); assert.deepEqual(task.spec.checks, []); assert.deepEqual(task.spec.nonGoals, []);
  assert.equal(task.configuration!.sources.checks, 'task');
});

test('repository and machine hard limits reject overrides and required verification cannot be weakened', async () => {
  const f = await fixture();
  await configure(f, preferences({ defaults: { provider: 'fixture', checks: [{ name: 'targeted', command: process.execPath, args: ['-e', "if(require('fs').readFileSync('value.txt','utf8').trim()!=='implemented')process.exit(1)"] }] },
    limits: { workerMemoryLimitMB: 1024, taskTimeoutMinutes: 2 }, requirements: { verificationPolicy: 'commands_required' } }));
  const task = await f.engine.createFromInput(input(f.repository)); assert.equal(task.spec.resources!.workerMemoryLimitMB, 1024); assert.equal(task.spec.resources!.taskTimeoutMinutes, 2);
  assert.equal(task.configuration!.sources['resources.workerMemoryLimitMB'], 'repository_requirement');
  await assert.rejects(f.engine.createFromInput(input(f.repository, 'large', { resources: { workerMemoryLimitMB: 2048 } })), /hard limit 1024/);
  await assert.rejects(f.engine.createFromInput(input(f.repository, 'relaxed', { verificationPolicy: 'review_allowed' })), /repository requirement/);
  await assert.rejects(f.engine.profiles.update(f.repository, 'project', 1, preferences({ defaults: { resources: { workerMemoryLimitMB: 4096 } } }), f.config), /hard limit 3072/);
  await assert.rejects(f.engine.review('one', 'accept', 'No tests', ['value.txt'], undefined, { mode: 'review_only', omittedCoverage: ['Tests'] }), /not awaiting/);
});

test('profile edits do not alter existing tasks, partial plans stay frozen, and explicit refresh uses the new revision', async () => {
  const f = await fixture(); await configure(f, preferences({ defaults: { provider: 'fixture', verificationPolicy: 'review_allowed', constraints: ['Version one'], branchPrefix: 'old/' } }));
  const original = await f.engine.createFromInput(input(f.repository)); const artifact = readFileSync(path.join(f.engine.store.dir('one'), 'configuration-v1.json'), 'utf8');
  await configure(f, preferences({ defaults: { provider: 'fixture', verificationPolicy: 'review_allowed', constraints: ['Version two'], branchPrefix: 'new/' } }), 1);
  const revised = await f.engine.updatePlan('one', 1, { goal: 'Revised goal' }, 'Clarify goal');
  assert.equal(revised.spec.planRevision, 2); assert.equal(revised.configuration!.profile!.value.revision, 1); assert.deepEqual(revised.spec.constraints, ['Version one']);
  assert.equal(revised.spec.branch, original.spec.branch); assert.equal(revised.spec.title, 'Revised goal');
  const refreshed = await f.engine.updatePlan('one', 2, {}, 'Adopt current repository preferences', true);
  assert.equal(refreshed.configuration!.profile!.value.revision, 2); assert.deepEqual(refreshed.spec.constraints, ['Version two']);
  assert.equal(refreshed.spec.branch, 'old/one'); assert.equal(readFileSync(path.join(f.engine.store.dir('one'), 'configuration-v1.json'), 'utf8'), artifact);
  assert.equal(refreshed.configuration!.sources.branch, 'previous_plan'); assert.equal(refreshed.configuration!.previousPlanRevision, 2);
  const next = await f.engine.createFromInput(input(f.repository, 'two')); assert.equal(next.spec.branch, 'new/two');
  const restarted = new Engine(f.root, f.config, f.engine.env, f.worker); assert.equal(restarted.store.get('one').configuration!.profile!.value.revision, 2);
});

test('partial resource updates retain other explicit values and task overrides survive profile refresh', async () => {
  const f = await fixture(); await configure(f);
  await f.engine.createFromInput(input(f.repository, 'one', { resources: { workerMemoryLimitMB: 512, taskTimeoutMinutes: 2 }, constraints: ['Task choice'] }));
  await configure(f, preferences({ defaults: { provider: 'fixture', verificationPolicy: 'review_allowed', constraints: ['New default'], resources: { workerMemoryLimitMB: 1024 } } }), 1);
  const revised = await f.engine.updatePlan('one', 1, { resources: { workerMemoryLimitMB: 768 } }, 'Adjust budget', true);
  assert.deepEqual(revised.spec.resources, { workerMemoryLimitMB: 768, taskTimeoutMinutes: 2 }); assert.deepEqual(revised.spec.constraints, ['Task choice']);
});

test('stale profile writes, accidental ID reuse and duplicate bindings are rejected', async () => {
  const f = await fixture(); await configure(f);
  await assert.rejects(configure(f), /Stale profile/);
  await assert.rejects(f.engine.profiles.update(f.repository, 'other', 0, preferences(), f.config), /already bound/);
  const other = path.join(f.root, 'other'); mkdirSync(other); await git(other, ['init', '-b', 'master']);
  await assert.rejects(f.engine.profiles.update(other, 'project', 1, preferences(), f.config), /explicit rebind/);
  const moved = await f.engine.profiles.update(other, 'project', 1, preferences(), f.config, true) as any;
  assert.equal(moved.profile.value.revision, 2); assert.equal((await f.engine.profiles.read(f.repository, f.config) as any).profile, null);
  const duplicate = path.join(f.engine.profiles.directory, 'duplicate'); mkdirSync(duplicate);
  writeFileSync(path.join(duplicate, 'profile.json'), JSON.stringify({ ...moved.profile.value, id: 'duplicate' }));
  await assert.rejects(f.engine.profiles.read(other, f.config), /Multiple profiles/);
});

test('profile script references resolve to this repository directory and reject missing or escaping paths', async () => {
  const f = await fixture(); const pref = preferences({ defaults: { provider: 'fixture', verificationPolicy: 'review_allowed',
    checks: [{ name: 'module', command: 'powershell.exe', args: ['-NoProfile', '-File', 'profile://scripts/module check.ps1'] }] } });
  await configure(f, pref);
  await assert.rejects(f.engine.createFromInput(input(f.repository)), /Missing profile script/);
  const script = path.join(f.engine.profiles.directory, 'project', 'scripts', 'module check.ps1');
  writeFileSync(script, "if ((Get-Content value.txt -Raw).Trim() -ne 'implemented') { exit 1 }; Write-Output 'module passed'\n");
  const task = await f.engine.createFromInput(input(f.repository)); assert.equal(task.spec.checks[0]!.args.at(-1), script);
  await f.engine.prepare('one'); await f.engine.dispatch('one'); await reviewed(f.engine, 'one'); await f.engine.verify('one'); const checked = await reviewed(f.engine, 'one');
  assert.equal(checked.checks[0]!.passed, true); assert.match(readFileSync(path.join(f.engine.store.dir('one'), checked.checks[0]!.log), 'utf8'), /module passed/);
  await assert.rejects(f.engine.createFromInput(input(f.repository, 'escape', { checks: [{ name: 'escape', command: 'profile://../elsewhere.ps1', args: [], timeoutMinutes: 1 }] })), /escapes/);
  await assert.rejects(f.engine.createFromInput(input(f.repository, 'directory', { checks: [{ name: 'directory', command: 'profile://scripts', args: [], timeoutMinutes: 1 }] })), /must be a file/);
});

test('review-only acceptance is explicit, policy-controlled and auditable without fake successful checks', async () => {
  const f = await fixture(); await configure(f); await f.engine.createFromInput(input(f.repository));
  await f.engine.prepare('one'); await f.engine.dispatch('one'); const task = await reviewed(f.engine, 'one');
  assert.equal(task.report!.acceptanceResults[0]!.status, 'pending_supervisor');
  await assert.rejects(f.engine.review('one', 'accept', 'Code inspected', ['value.txt']), /independent checks/);
  await assert.rejects(f.engine.verify('one'), /at least one/);
  const result = await callTool(f.engine, 'workflow_review', { id: 'one', decision: 'accept', rationale: 'Code and AC-01 inspected; this repository has no suite',
    evidence: ['value.txt: implementation reviewed against AC-01'], verification: { mode: 'review_only', omittedCoverage: ['Automated regression tests'] } }) as any;
  assert.equal(result.status, 'accepted'); assert.equal(result.acceptanceVerification, 'review_only');
  const accepted = f.engine.store.get('one'); assert.deepEqual(accepted.checks, []); assert.equal(accepted.verificationHistory, undefined);
  assert.equal(accepted.reviews.at(-1)!.verification!.sourceFingerprint, await fingerprint(accepted));
  assert.deepEqual((taskContract({ ...accepted, runId: accepted.runId! }) as any).supervisorVerification.policy, 'review_allowed');
});

test('command-required tasks still reject review-only acceptance and empty planned verification', async () => {
  const f = await fixture(); await configure(f, preferences({ defaults: { provider: 'fixture', checks: [{ name: 'targeted', command: 'unused' }] } }));
  await f.engine.createFromInput(input(f.repository)); await f.engine.prepare('one'); await f.engine.dispatch('one'); await reviewed(f.engine, 'one');
  await assert.rejects(callTool(f.engine, 'workflow_review', { id: 'one', decision: 'accept', rationale: 'Try bypass', evidence: ['value.txt'],
    verification: { mode: 'review_only', omittedCoverage: ['Tests'] } }), /not permitted/);
  await assert.rejects(f.engine.createFromInput(input(f.repository, 'empty', { checks: [] })), /at least one/);
});

test('unbound repositories can create short contracts, and malformed profiles and identity patches fail without creating tasks', async () => {
  const f = await fixture(); const task = await f.engine.createFromInput(input(f.repository, 'one', { provider: 'fixture', verificationPolicy: 'review_allowed' }));
  assert.equal(task.configuration!.profile, undefined); assert.equal(task.spec.branch, 'codex/one');
  await assert.rejects(f.engine.updatePlan('one', 1, { repository: 'C:/other' }, 'Identity change'), /execution identity/);
  assert.equal(f.engine.store.get('one').spec.planRevision, 1);
  const broken = path.join(f.engine.profiles.directory, 'broken'); mkdirSync(broken, { recursive: true }); writeFileSync(path.join(broken, 'profile.json'), '{');
  await assert.rejects(f.engine.createFromInput(input(f.repository, 'two')), /Invalid repository profile/);
  assert.equal(existsSync(f.engine.store.file('two')), false);
});
