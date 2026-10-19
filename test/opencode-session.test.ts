import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { promptAsync, type OpenCodeRequest } from '../src/opencode-session.js';

function fixture(snapshot: (poll: number, id: string) => { messages: any[]; status: string }) {
  let id = ''; let posts = 0; let polls = 0;
  const request: OpenCodeRequest = async (route, method = 'GET', body?: any, timeout?: number) => {
    assert.ok(timeout! <= 15000);
    if (method === 'POST') {
      assert.equal(route, '/session/fixture/prompt_async');
      id = body.messageID; posts++; return null;
    }
    if (route.endsWith('/message')) return snapshot(++polls, id).messages;
    assert.equal(route, '/session/status'); return { fixture: { type: snapshot(polls, id).status } };
  };
  return { request, counts: () => ({ posts, polls }) };
}
function assistant(parentID: string, finish = 'stop', complete = true) {
  return { info: { id: 'assistant-' + parentID, role: 'assistant', parentID, finish, time: complete ? { completed: 1 } : {} }, parts: [{ type: 'text', text: '{"fixture":true}' }] };
}
const options = () => ({ timeoutMs: 500, pollMs: 1, signal: new AbortController().signal });

test('async polling ignores old turns, partial answers and busy sessions before selecting a terminal response', async () => {
  const f = fixture((poll, id) => ({
    messages: [assistant('previous-turn'), ...(poll >= 2 ? [assistant(id, 'stop', poll >= 3)] : [])],
    status: poll === 3 ? 'busy' : 'idle',
  }));
  const result = await promptAsync(f.request, 'fixture', {}, options());
  assert.notEqual(result.response.info.parentID, 'previous-turn');
  assert.deepEqual(f.counts(), { posts: 1, polls: 4 });
});
test('temporary polling failures retry reads without resubmitting the prompt', async () => {
  const f = fixture((_, id) => ({ messages: [assistant(id)], status: 'idle' }));
  let failures = 0;
  const request: OpenCodeRequest = async (...args) => {
    if (args[0].endsWith('/message') && failures++ < 2) throw new TypeError('fetch failed');
    return f.request(...args);
  };
  await promptAsync(request, 'fixture', {}, options());
  assert.equal(f.counts().posts, 1); assert.equal(failures, 3);
});
test('ambiguous submission failure is never automatically retried', async () => {
  let calls = 0;
  await assert.rejects(promptAsync(async () => { calls++; throw new TypeError('fetch failed'); }, 'fixture', {}, options()), /fetch failed/);
  assert.equal(calls, 1);
});
test('a stalled worker hits the total deadline and cancellation interrupts the polling wait', async () => {
  const f = fixture(() => ({ messages: [], status: 'busy' }));
  await assert.rejects(promptAsync(f.request, 'fixture', {}, { ...options(), timeoutMs: 25 }), /timed out/);
  const controller = new AbortController();
  const waiting = promptAsync(f.request, 'fixture', {}, { timeoutMs: 10000, pollMs: 1000, signal: controller.signal });
  await delay(5); controller.abort(new Error('fixture cancelled'));
  await assert.rejects(waiting, /abort|cancelled/i);
});
test('model errors and persistent polling errors cannot become completion', async () => {
  const f = fixture((_, id) => ({ messages: [{ ...assistant(id), info: { ...assistant(id).info, error: { message: 'model refused' } } }], status: 'idle' }));
  await assert.rejects(promptAsync(f.request, 'fixture', {}, options()), /model refused/);
  const broken = fixture(() => ({ messages: [], status: 'busy' }));
  const request: OpenCodeRequest = async (...args) => {
    if (args[0].endsWith('/message')) throw new Error('offline transport');
    return broken.request(...args);
  };
  await assert.rejects(promptAsync(request, 'fixture', {}, options()), /polling failed three times.*not resubmitted/);
  assert.equal(broken.counts().posts, 1);
});
test('tool-only completion and output length exhaustion are rejected', async () => {
  const tools = fixture((_, id) => ({ messages: [{ info: { id, role: 'user' } }, assistant(id, 'tool-calls')], status: 'idle' }));
  await assert.rejects(promptAsync(tools.request, 'fixture', {}, options()), /without a completed final/);
  const length = fixture((_, id) => ({ messages: [assistant(id, 'length')], status: 'idle' }));
  await assert.rejects(promptAsync(length.request, 'fixture', {}, options()), /without final completion: length/);
});
test('short HTTP requests survive work lasting longer than the individual response deadline', async () => {
  let messageID = ''; let submittedAt = 0; let posts = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url?.endsWith('/prompt_async')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      messageID = JSON.parse(raw).messageID; submittedAt = Date.now(); posts++;
      res.writeHead(204).end(); return;
    }
    const ready = Date.now() - submittedAt >= 300;
    if (req.url === '/session/status') res.writeHead(200).end(JSON.stringify({ fixture: { type: ready ? 'idle' : 'busy' } }));
    else if (req.method === 'GET' && req.url?.endsWith('/message')) res.writeHead(200).end(JSON.stringify(ready ? [assistant(messageID)] : []));
    else res.writeHead(500).end('Synchronous execution endpoint must never be used');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const request: OpenCodeRequest = async (route, method = 'GET', body) => {
    const res = await fetch('http://127.0.0.1:' + port + route, { method, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(100) });
    assert.ok(res.ok); const text = await res.text(); return text ? JSON.parse(text) : null;
  };
  try {
    const result = await promptAsync(request, 'fixture', {}, { ...options(), timeoutMs: 3000, pollMs: 5 });
    assert.equal(result.response.info.parentID, messageID); assert.equal(posts, 1);
    assert.ok(Date.now() - submittedAt >= 300);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
