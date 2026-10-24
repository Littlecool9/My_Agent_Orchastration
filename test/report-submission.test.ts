import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { submitReport } from '../src/report-submission.js';
import { TaskSpecSchema, type ReportSubmission, type Task } from '../src/schema.js';
import { contractFields, makeReport } from './fixtures.js';

function task(): Task {
  return { spec: TaskSpecSchema.parse({ ...contractFields, id: 'report', title: 'Report', repository: 'C:/fixture', baseRef: 'HEAD', branch: 'fixture', provider: 'fixture',
    mode: 'investigate', goal: 'Inspect', acceptance: [{ id: 'AC-01', requirement: 'Inspect' }] }), status: 'running', revision: 1, attempts: 1,
    runId: randomUUID(), createdAt: '', updatedAt: '', checks: [], reviews: [], totalTokens: 0, cost: 0 };
}

test('valid report does not incur another model turn', async () => {
  const t = task(); const states: ReportSubmission[] = [];
  const report = await submitReport(t, { text: JSON.stringify(makeReport(t)), tokens: 10, cost: 1 }, async () => { throw new Error('unexpected retry'); }, s => states.push(s));
  assert.equal(report.taskId, t.spec.id); assert.equal(states.length, 1);
  assert.equal(states[0]!.status, 'passed'); assert.equal(states[0]!.submissions, 1);
});

for (const kind of ['syntax', 'schema', 'semantic'] as const) {
  test(`${kind} report error gets one diagnosed resubmission with unchanged identity and separate accounting`, async () => {
    const t = task(); const valid = makeReport(t); const states: ReportSubmission[] = []; let retries = 0;
    const text = kind === 'syntax' ? 'done' : JSON.stringify(kind === 'schema' ? { ...valid, extra: true } : { ...valid, runId: randomUUID() });
    const result = await submitReport(t, { text, tokens: 10, cost: 1 }, async diagnostic => {
      retries++; assert.ok(diagnostic.length); return { text: JSON.stringify(valid), tokens: 3, cost: 0.2 };
    }, s => states.push(s));
    assert.equal(retries, 1); assert.deepEqual(result, valid); assert.equal(t.attempts, 1); assert.equal(t.recoveryAttempts, undefined);
    const final = states.at(-1)!;
    assert.equal(final.status, 'repaired'); assert.equal(final.errors[0]!.category, kind);
    assert.equal(final.tokens, 13); assert.equal(final.repairTokens, 3); assert.equal(final.cost, 1.2); assert.equal(final.repairCost, 0.2);
    assert.ok(final.finishedAt); assert.ok(final.repairDurationMs >= 0);
  });
}

test('a second invalid report fails with both diagnostics and cannot become acceptance', async () => {
  const t = task(); let retries = 0; const states: ReportSubmission[] = [];
  await assert.rejects(submitReport(t, { text: 'done', tokens: 10, cost: 1 }, async () => {
    retries++; return { text: JSON.stringify({ ...makeReport(t), acceptanceResults: [] }), tokens: 3, cost: 0.2 };
  }, s => states.push(s)), /each acceptance criterion/);
  assert.equal(retries, 1); assert.equal(states.at(-1)!.status, 'failed'); assert.equal(states.at(-1)!.errors.length, 2);
  assert.equal(states.at(-1)!.tokens, 13); assert.equal(t.status, 'running');
});

test('repair transport/cancellation failure is not resubmitted again', async () => {
  const t = task(); let retries = 0; const states: ReportSubmission[] = [];
  await assert.rejects(submitReport(t, { text: 'done', tokens: 10, cost: 1 }, async () => { retries++; throw new Error('cancelled'); }, s => states.push(s)), /cancelled/);
  assert.equal(retries, 1); assert.match(states.at(-1)!.failure!, /cancelled/); assert.equal(states.at(-1)!.status, 'failed');
});
