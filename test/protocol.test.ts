import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT } from '../src/config.js';
import { ConfigSchema, TaskSpecSchema, type Task } from '../src/schema.js';
import { validateReport, validateFeedback, taskContract } from '../src/protocol.js';
import { Engine } from '../src/engine.js';
import { git } from '../src/process.js';
import { liveProbe } from '../src/probe.js';
import { contractFields, makeReport } from './fixtures.js';

function contractTask(): Task {
  const spec = TaskSpecSchema.parse({ ...contractFields, id: 'protocol', title: 'Protocol fixture', repository: 'C:/fixture', baseRef: 'master', branch: 'master', provider: 'fixture', mode: 'investigate', goal: 'Inspect fixture', acceptance: [{ id: 'AC-01', requirement: 'Inspect fixture' }], checks: [] });
  return { spec, status: 'running', revision: 1, attempts: 1, runId: randomUUID(), worktree: 'C:/fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), checks: [], reviews: [], totalTokens: 0, cost: 0 };
}
test('task contracts reject duplicate IDs and cyclic/forward step dependencies', () => {
  const { spec } = contractTask();
  assert.throws(() => TaskSpecSchema.parse({ ...spec, acceptance: [spec.acceptance[0], spec.acceptance[0]] }), /Duplicate/);
  assert.throws(() => TaskSpecSchema.parse({ ...spec, steps: [{ ...spec.steps[0], dependsOn: ['S1'] }] }), /earlier steps/);
  assert.throws(() => TaskSpecSchema.parse({ ...spec, contractVersion: 2 }));
});
test('worker reports must match task, plan, execution run and attempt', () => {
  const task = contractTask(); const report = makeReport(task);
  for (const patch of [{ taskId: 'other' }, { planRevision: 2 }, { runId: randomUUID() }, { attempt: 2 }])
    assert.throws(() => validateReport(task, { ...report, ...patch }), /does not match/);
  assert.throws(() => validateReport(task, { ...report, outcome: 'accepted' }));
});
test('report coverage is exact and completion claims require evidence', () => {
  const task = contractTask(); const report = makeReport(task);
  assert.throws(() => validateReport(task, { ...report, acceptanceResults: [] }), /exactly once/);
  assert.throws(() => validateReport(task, { ...report, acceptanceResults: [report.acceptanceResults[0], report.acceptanceResults[0]] }), /exactly once/);
  assert.throws(() => validateReport(task, { ...report, acceptanceResults: [{ id: 'AC-01', status: 'met', evidence: [] }] }), /evidence/);
  assert.throws(() => validateReport(task, { ...report, changedFiles: ['x.cpp'] }), /Investigator/);
});
test('blocked/replan is distinct from ready_for_review and requires actionable evidence', () => {
  const task = contractTask(); const replan = makeReport(task, 'needs_replan');
  assert.equal(validateReport(task, replan).outcome, 'needs_replan');
  assert.throws(() => validateReport(task, { ...replan, blockers: [] }), /concrete blockers/);
  assert.throws(() => validateReport(task, { ...replan, outcome: 'ready_for_review' }), /ready_for_review requires/);
  assert.throws(() => validateReport(task, { ...replan, blockers: [{ ...replan.blockers[0], criterionIds: ['UNKNOWN'] }] }), /unknown/);
});
test('feedback is bound to a current plan and known acceptance criteria', () => {
  const task = contractTask();
  const feedback = { planRevision: 1, summary: 'Fix fixture', findings: [{ criterionIds: ['AC-01'], description: 'Missing evidence', evidence: ['fixture'], requestedChange: 'Read it' }] };
  assert.equal(validateFeedback(task, feedback).planRevision, 1);
  assert.throws(() => validateFeedback(task, { ...feedback, planRevision: 2 }), /stale/);
  assert.throws(() => validateFeedback(task, { ...feedback, findings: [{ ...feedback.findings[0], criterionIds: ['AC-99'] }] }), /unknown/);
  assert.throws(() => validateFeedback(task, 'please retry'));
});
test('contract envelope records pinned workspace and structured feedback without flattening', () => {
  const task = contractTask(); task.baseCommit = 'abc';
  const envelope = taskContract(task) as any;
  assert.equal(envelope.planRevision, 1); assert.equal(envelope.workspace.baseCommit, 'abc');
  assert.equal(envelope.steps[0].flexibility, 'adaptable'); assert.equal(envelope.acceptance[0].id, 'AC-01');
});
async function engineFixture(outcome: 'needs_replan' | 'blocked' | 'ready_for_review', stale = false) {
  const parent = path.join(ROOT, 'work/workflow-tests'); mkdirSync(parent, { recursive: true }); const root = mkdtempSync(path.join(parent, 'protocol-'));
  const repository = path.join(root, 'repo'); mkdirSync(repository); await git(repository, ['init', '-b', 'master']);
  writeFileSync(path.join(repository, 'fixture.txt'), 'fixture'); await git(repository, ['add', '.']); await git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  const config = ConfigSchema.parse({ executionEnabled: true, maxParallel: 1, maxAttempts: 3, taskTimeoutMinutes: 1, providers: { fixture: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', contextLimit: 32768, outputLimit: 4096 } } });
  const worker = { async run(t: Task, onSession: (id: string) => void) { onSession(t.sessionID ?? 'same-session'); const report = makeReport(t, outcome); if (stale) report.planRevision++; return { report, transcript: [], tokens: 1, cost: 0 }; }, async cancel() {}, async close() {} };
  const engine = new Engine(root, config, { FIXTURE_KEY: 'test-only' }, worker);
  const spec = { ...contractTask().spec, repository }; engine.create(spec);
  const task = engine.store.get(spec.id); task.worktree = repository; task.baseCommit = await git(repository, ['rev-parse', 'HEAD']); task.status = 'ready'; engine.store.save(task);
  return { engine, spec };
}
async function finished(engine: Engine): Promise<Task> {
  for (let i = 0; i < 200; i++) { const task = engine.store.get('protocol'); if (task.status !== 'running') return task; await delay(10); }
  throw new Error('Fixture did not finish');
}
test('needs_replan prevents dispatch until a versioned supervisor update, preserving session and budget', async () => {
  const { engine, spec } = await engineFixture('needs_replan'); await engine.dispatch('protocol'); const before = await finished(engine);
  assert.equal(before.status, 'needs_replan'); await assert.rejects(engine.dispatch('protocol'), /needs_replan/); await assert.rejects(engine.verify('protocol'), /completed worker/);
  await assert.rejects(engine.updatePlan('protocol', 2, { ...spec, planRevision: 3 }, 'revision'), /Stale/);
  await assert.rejects(engine.updatePlan('protocol', 1, { ...spec, planRevision: 2, provider: 'other' }, 'revision'), /identity/);
  const updated = await engine.updatePlan('protocol', 1, { ...spec, planRevision: 2, goal: 'Revised inspection' }, 'Clarify conflicting invariant');
  assert.equal(updated.status, 'ready'); assert.equal(updated.sessionID, before.sessionID); assert.equal(updated.worktree, before.worktree); assert.equal(updated.attempts, 1);
  assert.equal(updated.report, undefined); assert.equal(updated.feedback, undefined); assert.equal(updated.verifiedFingerprint, undefined);
  const oldContract = JSON.parse(readFileSync(path.join(engine.store.dir('protocol'), `contract-run-${before.runId}.json`), 'utf8')); assert.equal(oldContract.planRevision, 1);
  await engine.dispatch('protocol'); const next = await finished(engine); assert.equal(next.spec.planRevision, 2); assert.equal(next.attempts, 2); assert.notEqual(next.runId, before.runId);
});
test('blocked tasks need explicit structured diagnostic feedback before retrying', async () => {
  const { engine } = await engineFixture('blocked'); await engine.dispatch('protocol'); assert.equal((await finished(engine)).status, 'blocked');
  await assert.rejects(engine.dispatch('protocol'), /structured diagnostic feedback/);
  await engine.dispatch('protocol', { planRevision: 1, summary: 'Environment fixed', findings: [{ criterionIds: ['AC-01'], description: 'Access restored', evidence: ['local inspection'], requestedChange: 'Retry read' }] });
  assert.equal((await finished(engine)).attempts, 2);
});
test('stale reports fail the round rather than becoming reviewable', async () => {
  const { engine } = await engineFixture('ready_for_review', true); await engine.dispatch('protocol'); const task = await finished(engine);
  assert.equal(task.status, 'failed'); assert.match(task.lastError!, /does not match/); assert.equal(task.report, undefined);
});
test('ordinary rework cannot be sent as unversioned free text', async () => {
  const { engine } = await engineFixture('ready_for_review'); await engine.dispatch('protocol'); await finished(engine);
  await assert.rejects(engine.review('protocol', 'rework', 'Please retry', ['fixture']), /criterion-linked structured feedback/);
});
test('live API probe requires the explicit live switch before loading keys or creating a task', async () => {
  await assert.rejects(liveProbe(ROOT, 'kimi', false), /--live/);
});

test('worker contract exposes incremental commands while full-suite commands stay with the supervisor', () => {
  const task = contractTask();
  task.spec.workerChecks = [{ name: 'targeted', command: 'targeted-tests', args: [], timeoutMinutes: 1 }];
  task.spec.checks = [{ name: 'full-suite', command: 'full-regression-command', args: ['all-configurations'], timeoutMinutes: 30 }];
  const envelope = taskContract(task) as any;
  assert.equal(envelope.checks[0].command, 'targeted-tests');
  assert.deepEqual(envelope.supervisorVerification.checkNames, ['full-suite']);
  assert.equal(JSON.stringify(envelope).includes('full-regression-command'), false);
  const report = makeReport(task);
  report.acceptanceResults[0]!.status = 'pending_supervisor';
  assert.equal(validateReport(task, report).outcome, 'ready_for_review');
  assert.deepEqual(report.checks.map(c => c.name), ['targeted']);
  assert.throws(() => validateReport(task, { ...report, checks: [{ name: 'full-suite', result: 'passed', evidence: ['claimed full suite'] }] }), /each check exactly once/);
  task.spec.checks = [];
  assert.throws(() => validateReport(task, report), /configured independent supervisor verification/);
});

test('legacy plans keep their full checks for verification without sending those commands to workers', () => {
  const task = contractTask(); delete (task.spec as any).workerChecks;
  task.spec.checks = [{ name: 'legacy-full', command: 'legacy-full-command', args: [], timeoutMinutes: 1 }];
  const envelope = taskContract(task) as any;
  assert.deepEqual(envelope.checks, []);
  assert.equal(envelope.executionPolicy.supersedesLegacyWorkerFullTestInstructions, true);
  const report = makeReport(task);
  assert.equal(validateReport(task, report).outcome, 'ready_for_review');
  assert.equal(task.spec.checks[0]!.command, 'legacy-full-command');
});
