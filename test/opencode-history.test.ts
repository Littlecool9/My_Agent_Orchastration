import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyAssistantReason, repairSessionHistory, type HistoryRepairArchive } from '../src/opencode-history.js';
import type { OpenCodeRequest } from '../src/opencode-session.js';

const message = (id: string, parts: any[], info: Record<string, unknown> = {}) => ({ info: { id, role: 'assistant', ...info }, parts });
const interrupted = message('interrupted', [{ type: 'step-start' }, { type: 'reasoning', text: 'unfinished thought' }]);
const apiError = message('error', [], { error: { name: 'APIError' }, time: { completed: 1 } });
const user = { info: { id: 'user', role: 'user' }, parts: [{ type: 'text', text: 'Keep coding' }] };
const tool = message('tool', [{ type: 'step-start' }, { type: 'tool', tool: 'bash', state: { status: 'completed', output: 'result' } }], { finish: 'tool-calls' });

test('empty assistant classification preserves visible text, tool turns, tool errors and file payloads', () => {
  assert.equal(emptyAssistantReason(interrupted), 'interrupted-empty-assistant');
  assert.equal(emptyAssistantReason(apiError), 'empty-error-assistant');
  assert.equal(emptyAssistantReason(message('empty', [{ type: 'text', text: '' }], { finish: 'stop' })), 'empty-assistant');
  assert.equal(emptyAssistantReason(user), undefined);
  for (const m of [tool, message('text', [{ type: 'text', text: 'partial useful content' }]),
    message('file', [{ type: 'file', url: 'data:image/png;base64,fixture' }]),
    message('tool-error', [{ type: 'tool', state: { status: 'error' } }], { error: { name: 'AbortedError' } }),
    message('tool-running', [{ type: 'tool', state: { status: 'running' } }])]) assert.equal(emptyAssistantReason(m), undefined);
});
test('repair archives original history before deleting only empty assistant records and is idempotent', async () => {
  const before = [user, tool, interrupted, apiError]; let transcript = structuredClone(before);
  let archived: HistoryRepairArchive | undefined; const deleted: string[] = [];
  const request: OpenCodeRequest = async (route, method) => {
    if (route === '/session/status') return { fixture: { type: 'idle' } };
    if (method === 'DELETE') {
      assert.deepEqual(archived?.originalTranscript, before);
      const id = route.split('/').at(-1)!; deleted.push(id);
      transcript = transcript.filter(m => m.info.id !== id); return true;
    }
    return structuredClone(transcript);
  };
  const result = await repairSessionHistory(request, 'fixture', before, record => { archived = record; });
  assert.deepEqual(result.transcript, [user, tool]); assert.deepEqual(deleted, ['interrupted', 'error']);
  let extraArchives = 0;
  const again = await repairSessionHistory(request, 'fixture', result.transcript, () => { extraArchives++; });
  assert.deepEqual(again.removed, []); assert.equal(extraArchives, 0);
});
test('active sessions and history changes fail closed before backup or deletion', async () => {
  for (const changed of [false, true]) {
    let deletions = 0; let archives = 0;
    const request: OpenCodeRequest = async (route, method) => {
      if (method === 'DELETE') { deletions++; return true; }
      if (route === '/session/status') return { fixture: { type: changed ? 'idle' : 'busy' } };
      return [user, interrupted];
    };
    await assert.rejects(repairSessionHistory(request, 'fixture', [interrupted], () => { archives++; }), /active|history changed/);
    assert.equal(deletions, 0); assert.equal(archives, 0);
  }
});
test('backup failure never mutates the session and deletion failure is not ignored', async () => {
  let deletes = 0;
  const request: OpenCodeRequest = async (route, method) => {
    if (method === 'DELETE') { deletes++; throw new Error('delete failed'); }
    return route === '/session/status' ? {} : [interrupted];
  };
  await assert.rejects(repairSessionHistory(request, 'fixture', [interrupted], () => { throw new Error('archive failed'); }), /archive failed/);
  assert.equal(deletes, 0);
  await assert.rejects(repairSessionHistory(request, 'fixture', [interrupted], () => {}), /delete failed/);
  assert.equal(deletes, 1);
});
test('post-deletion verification rejects unexpected loss or modification of retained messages', async () => {
  let reads = 0;
  const request: OpenCodeRequest = async (route, method) => {
    if (route === '/session/status') return {};
    if (method === 'DELETE') return true;
    return reads++ === 0 ? [user, tool, interrupted] : [user];
  };
  await assert.rejects(repairSessionHistory(request, 'fixture', [user, tool, interrupted], () => {}), /did not preserve/);
});
