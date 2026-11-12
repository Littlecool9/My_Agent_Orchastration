import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { submitReport, ReportValidationError } from '../src/report-submission.js';
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
    const text = kind === 'syntax' ? 'done' : JSON.stringify(kind === 'schema' ? { ...valid, outcome: 'accepted' } : { ...valid, runId: randomUUID() });
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

const noRetry = async (): Promise<never> => { throw new Error('unexpected retry'); };

test('format-only defects are normalized, recorded and never cost a model turn', async () => {
  const t = task(); const valid = makeReport(t); const states: ReportSubmission[] = [];
  const messy = { ...valid, confidence: 'high', summary: '长'.repeat(7000),
    acceptanceResults: [{ ...valid.acceptanceResults[0], evidence_note: 'verified by reading marker.txt', statusNote: 42 }] };
  const report = await submitReport(t, { text: 'Here is the report:\n```json\n' + JSON.stringify(messy) + '\n```\nDone.', tokens: 10, cost: 1 }, noRetry, s => states.push(s));
  assert.equal(report.summary.length <= 6000, true); assert.match(report.summary, /truncated\]$/);
  assert.deepEqual(report.acceptanceResults[0]!.evidence, ['value.txt', 'evidence_note: verified by reading marker.txt']);
  assert.equal(states.length, 1); assert.equal(states[0]!.status, 'passed'); assert.equal(states[0]!.submissions, 1);
  const notes = states[0]!.normalizations!.join('\n');
  for (const expected of [/markdown fence/, /unknown top-level keys: confidence/, /Truncated summary from 7000/, /evidence_note, statusNote/]) assert.match(notes, expected);
  const { deviations, blockers, changedFiles, ...withoutEmptyArrays } = valid;
  assert.deepEqual((await submitReport(t, { text: 'Report: ' + JSON.stringify(withoutEmptyArrays) + ' (end)', tokens: 1, cost: 0 }, noRetry, () => {})).deviations, []);
});

test('check-list bookkeeping is normalized, but an unreported worker check is not_run and can never pass', async () => {
  const t = task(); t.spec.mode = 'implement'; t.spec.checks = [{ name: 'full', command: 'x', args: [], timeoutMinutes: 1 }];
  t.spec.workerChecks = [{ name: 'targeted', command: 'x', args: [], timeoutMinutes: 1 }];
  const valid = makeReport(t);
  const extra = await submitReport(t, { text: JSON.stringify({ ...valid, checks: [...valid.checks, { name: 'my-own-lint', result: 'passed', evidence: ['ruff: ok'] }] }), tokens: 1, cost: 0 }, noRetry, () => {});
  assert.deepEqual(extra.checks.map(c => c.name), ['targeted']); assert.match(extra.deviations[0]!, /Unlisted check reported by worker.*my-own-lint/);
  let diagnostic = '';
  const repaired = await submitReport(t, { text: JSON.stringify({ ...valid, checks: [] }), tokens: 1, cost: 0 }, async d => { diagnostic = d; return { text: JSON.stringify(valid), tokens: 1, cost: 0 }; }, () => {});
  assert.match(diagnostic, /ready_for_review requires/); assert.equal(repaired.checks[0]!.result, 'passed');
});

test('identity and criterion coverage are never normalized', async () => {
  const t = task(); const valid = makeReport(t);
  for (const patch of [{ runId: randomUUID() }, { planRevision: 9 }, { acceptanceResults: [] }, { acceptanceResults: [{ id: 'AC-01', status: 'met', evidence: [] }] }]) {
    let retried = false;
    await submitReport(t, { text: JSON.stringify({ ...valid, ...patch }), tokens: 1, cost: 0 }, async () => { retried = true; return { text: JSON.stringify(valid), tokens: 1, cost: 0 }; }, () => {});
    assert.equal(retried, true, JSON.stringify(patch));
  }
});

test('a second invalid report fails with both diagnostics and cannot become acceptance', async () => {
  const t = task(); let retries = 0; const states: ReportSubmission[] = [];
  await assert.rejects(submitReport(t, { text: 'done', tokens: 10, cost: 1 }, async () => {
    retries++; return { text: JSON.stringify({ ...makeReport(t), acceptanceResults: [] }), tokens: 3, cost: 0.2 };
  }, s => states.push(s)), (error: unknown) => error instanceof ReportValidationError && error.errors.length === 2 && /each acceptance criterion/.test(error.message));
  assert.equal(retries, 1); assert.equal(states.at(-1)!.status, 'failed'); assert.equal(states.at(-1)!.errors.length, 2);
  assert.equal(states.at(-1)!.tokens, 13); assert.equal(t.status, 'running');
});

test('repair transport/cancellation failure is not resubmitted again', async () => {
  const t = task(); let retries = 0; const states: ReportSubmission[] = [];
  await assert.rejects(submitReport(t, { text: 'done', tokens: 10, cost: 1 }, async () => { retries++; throw new Error('cancelled'); }, s => states.push(s)),
    (error: unknown) => !(error instanceof ReportValidationError) && /cancelled/.test(String(error)));
  assert.equal(retries, 1); assert.match(states.at(-1)!.failure!, /cancelled/); assert.equal(states.at(-1)!.status, 'failed');
});
