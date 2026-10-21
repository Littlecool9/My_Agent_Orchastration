import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { parseWaitArgs, waitForTasks, type WaitTask } from '../src/wait.js';

test('blocking wait ignores heartbeats and intermediate revisions until supervisor attention is needed', async () => {
  const snapshots: WaitTask[][] = [
    [{ id: 'one', status: 'running', revision: 2 }],
    [{ id: 'one', status: 'running', revision: 2 }],
    [{ id: 'one', status: 'running', revision: 3 }],
    [{ id: 'one', status: 'awaiting_review', revision: 4 }],
  ];
  const cursors: Record<string, number>[] = [];
  const result = await waitForTasks(['one'], async args => { cursors.push(args.after); return snapshots.shift()!; },
    { until: 'attention', after: {}, timeoutMs: 0 });
  assert.equal(result.reason, 'attention'); assert.equal(result.tasks[0]!.status, 'awaiting_review');
  assert.deepEqual(cursors, [{}, { one: 2 }, { one: 2 }, { one: 3 }]);
});

test('change wait establishes a baseline and supports reconnecting with an explicit revision cursor', async () => {
  let calls = 0;
  const changed = await waitForTasks(['one'], async () => [{ id: 'one', status: 'verifying', revision: ++calls }],
    { until: 'change', after: {}, timeoutMs: 0 });
  assert.equal(changed.reason, 'changed'); assert.equal(calls, 2);
  const resumed = await waitForTasks(['one'], async () => [{ id: 'one', status: 'verifying', revision: 5 }],
    { until: 'change', after: { one: 3 }, timeoutMs: 0 });
  assert.equal(resumed.tasks[0]!.revision, 5); assert.equal(resumed.reason, 'changed');
});

test('multiple-task wait returns when any task is blocked rather than waiting for acceptance', async () => {
  const result = await waitForTasks(['one', 'two'], async () => [
    { id: 'one', status: 'running', revision: 1 }, { id: 'two', status: 'needs_replan', revision: 2 },
  ], { until: 'attention', after: {}, timeoutMs: 0 });
  assert.equal(result.reason, 'attention'); assert.equal(result.tasks[1]!.status, 'needs_replan');
});

test('a reconciled integration is terminal for a blocking wait', async () => {
  let reads = 0;
  const result = await waitForTasks(['one'], async () => {
    assert.equal(++reads, 1);
    return [{ id: 'one', status: 'integrated', revision: 8 }];
  }, { until: 'attention', after: {}, timeoutMs: 0 });
  assert.equal(result.reason, 'attention'); assert.equal(result.tasks[0]!.status, 'integrated');
});

test('a cursor ahead of the initial snapshot remains a lower bound across heartbeats', async () => {
  let revision = 1;
  const result = await waitForTasks(['one'], async () => [{ id: 'one', status: 'verifying', revision: revision++ }],
    { until: 'change', after: { one: 3 }, timeoutMs: 0 });
  assert.equal(result.tasks[0]!.revision, 4);
});

test('overall timeout interrupts an in-flight read and returns the latest known snapshot', async () => {
  let calls = 0;
  const result = await waitForTasks(['one'], async (_, signal) => {
    if (calls++) await delay(10000, undefined, { signal });
    return [{ id: 'one', status: 'running', revision: 1 }];
  }, { until: 'attention', after: {}, timeoutMs: 40 });
  assert.equal(result.reason, 'timeout'); assert.equal(result.tasks[0]!.revision, 1);
});

test('interrupting a wait and daemon application errors propagate without retrying or changing tasks', async () => {
  const controller = new AbortController();
  const waiting = waitForTasks(['one'], async (_, signal) => {
    await delay(10000, undefined, { signal }); return [];
  }, { until: 'attention', after: {}, timeoutMs: 0 }, controller.signal);
  controller.abort(new Error('user interruption'));
  await assert.rejects(waiting, /user interruption/);
  await assert.rejects(waitForTasks(['missing'], async () => { throw new Error('Unknown task'); },
    { until: 'attention', after: {}, timeoutMs: 0 }), /Unknown task/);
});

test('wait CLI accepts multiple IDs and revision cursors and rejects ambiguous or invalid input', () => {
  assert.deepEqual(parseWaitArgs(['one', 'two', '--until', 'change', '--after', 'one=4', '--timeout-ms', '500', '--json']), {
    ids: ['one', 'two'], options: { until: 'change', after: { one: 4 }, timeoutMs: 500 },
  });
  for (const args of [[], ['one', 'one'], ['../one'], ['one', '--timeout-ms', '-1'], ['one', '--until', 'unknown'],
    ['one', '--after', 'two=4'], ['one', '--after', 'one=NaN'], ['one', '--timeout-ms', '2147483648']]) {
    assert.throws(() => parseWaitArgs(args), /wait TASK_ID/);
  }
});
