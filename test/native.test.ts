import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { OpenCodeWorker } from '../src/opencode.js';
import { ConfigSchema, TaskSpecSchema, type Task } from '../src/schema.js';
import { contractFields, makeReport } from './fixtures.js';
import { validateReport } from '../src/protocol.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { killTree } from '../src/process.js';

const modelDelayMs = Number(process.env.WORKFLOW_TEST_MODEL_DELAY_MS ?? 0);
test('real Windows OpenCode performs a tool call through a local fake model, and resumes its persisted session', { timeout: 120000 + modelDelayMs }, async () => {
  const scratch = path.join(ROOT, 'work/workflow-tests'); mkdirSync(scratch, { recursive: true });
  const worktree = mkdtempSync(path.join(scratch, 'native-')); writeFileSync(path.join(worktree, 'AGENTS.md'), 'Fixture repository. Read marker.txt.\n');
  writeFileSync(path.join(worktree, 'marker.txt'), 'native-fixture\n');
  let toolRequests = 0; let completions = 0; let emptyAssistantRequests = 0;
  let holdNextRequest = false; let onHeldRequest = () => {};
  const observedTools: string[][] = [];
  let roleObserved = false; let forbiddenToolsObserved = false;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); completions++;
    if (holdNextRequest) {
      holdNextRequest = false;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ id: 'interrupted-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Interrupted reasoning without visible text' }, finish_reason: null }] }) + '\n\n');
      onHeldRequest();
      await new Promise<void>(resolve => res.once('close', () => resolve()));
      return;
    }
    if (completions === 1 && modelDelayMs > 0) {
      console.log('Offline model intentionally delays first headers for ' + modelDelayMs + ' ms');
      await delay(modelDelayMs);
    }
    observedTools.push((body.tools ?? []).map((t: any) => t.function?.name));
    const readTool = (body.tools ?? []).find((t: any) => t.function?.name === 'read');
    const messages: any[] = body.messages ?? [];
    const invalid = messages.some(m => m.role === 'assistant' && !(m.tool_calls?.length) &&
      !(typeof m.content === 'string' ? m.content.trim().length : Array.isArray(m.content) && m.content.some((p: any) => typeof p.text === 'string' && p.text.trim().length)));
    if (invalid) {
      emptyAssistantRequests++;
      res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: "role 'assistant' must not be empty", type: 'invalid_request_error' } }));
      return;
    }
    if (readTool) {
      roleObserved ||= messages.some(m => m.role === 'system' && JSON.stringify(m.content).includes('workflow-investigator'));
      forbiddenToolsObserved ||= (body.tools ?? []).some((t: any) => ['task', 'plan_enter', 'plan_exit', 'write', 'edit', 'apply_patch'].includes(t.function?.name));
    }
    const lastUser = messages.findLastIndex(m => m.role === 'user');
    const hasToolResult = messages.slice(lastUser + 1).some((m: any) => m.role === 'tool');
    const toolCall = readTool && !hasToolResult;
    if (toolCall) toolRequests++;
    const text = messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content : m.content.map((p: any) => p.text ?? '').join('\n')).join('\n');
    const matches = [...text.matchAll(/CURRENT_TASK_CONTRACT\n([\s\S]*?)\nEND_TASK_CONTRACT/g)];
    const contract = matches.length ? JSON.parse(matches.at(-1)![1]!) : undefined;
    const report = contract ? { ...makeReport({ spec: { ...contract, id: contract.taskId }, runId: contract.runId, attempts: contract.attempt } as Task), acceptanceResults: contract.acceptance.map((c: any) => ({ id: c.id, status: 'met', evidence: ['marker.txt: native-fixture'] })) } : undefined;
    const toolName = toolCall ? 'read' : undefined;
    const delta = toolName ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_fixture_${completions}`, type: 'function', function: { name: toolName, arguments: JSON.stringify({ filePath: path.join(worktree, 'marker.txt') }) } }] } : { role: 'assistant', content: JSON.stringify(report) };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const item of [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: toolName ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ]) res.write('data: ' + JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture', ...item }) + '\n\n');
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'fixture' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
  const config = ConfigSchema.parse({ executionEnabled: true, maxParallel: 1, maxAttempts: 3, taskTimeoutMinutes: Math.ceil(modelDelayMs / 60000) + 1,
    providers: { fixture: { baseURL: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', contextLimit: 32768, outputLimit: 4096 } } });
  const spec = TaskSpecSchema.parse({ ...contractFields, id: `native-${Date.now()}`, title: 'Native local fixture', repository: worktree, baseRef: 'master', branch: 'fixture', provider: 'fixture', mode: 'investigate', goal: 'Read marker.txt using the read tool, then report briefly.', acceptance: [{ id: 'AC-01', requirement: 'Read marker.txt' }], checks: [] });
  const task: Task = { spec, status: 'running', revision: 1, attempts: 1, runId: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), worktree, checks: [], reviews: [], totalTokens: 0, cost: 0 };
  const worker = new OpenCodeWorker(ROOT, config, { ...process.env, FIXTURE_KEY: 'local-fixture-not-a-real-key' });
  try {
    const first = await worker.run(task, id => { task.sessionID = id; }); assert.ok(validateReport(task, first.report).summary.length); assert.ok(task.sessionID); assert.ok(toolRequests >= 1);
    assert.equal(roleObserved, true); assert.equal(forbiddenToolsObserved, false);
    const text = JSON.stringify(first.transcript); assert.match(text, /native-fixture/);
    const session = task.sessionID; task.spec.planRevision = 2; task.runId = randomUUID(); task.attempts++;
    holdNextRequest = true;
    const held = new Promise<void>(resolve => { onHeldRequest = resolve; });
    const interrupted = assert.rejects(worker.run(task, id => { task.sessionID = id; }), /abort|cancelled|exited/i);
    await held;
    const active = (worker as any).active.get(task.spec.id);
    let partialPersisted = false;
    for (let n = 0; n < 100; n++) {
      const res = await fetch(active.url + '/session/' + task.sessionID + '/message', { headers: { Authorization: active.auth }, signal: AbortSignal.timeout(1000) });
      const messages = await res.json() as any[];
      partialPersisted = messages.some(m => m.info.role === 'assistant' && !m.info.finish && !m.info.error && m.parts.some((p: any) => p.type === 'reasoning'));
      if (partialPersisted) break;
      await delay(50);
    }
    assert.equal(partialPersisted, true, 'Fixture must persist reasoning-only output before the hard crash');
    killTree(active.child); await interrupted;
    assert.equal(task.sessionID, session);
    task.runId = randomUUID(); task.attempts++;
    const second = await worker.run(task, id => { task.sessionID = id; }); assert.equal(task.sessionID, session); assert.equal(validateReport(task, second.report).planRevision, 2);
    const archives = readdirSync(path.join(ROOT, '.runtime/workers', task.spec.id)).filter(name => name.startsWith('history-repair-' + task.attempts + '-'));
    assert.equal(archives.length, 1, 'Normal worker resume must automatically archive and repair the partial history');
    const archive = JSON.parse(readFileSync(path.join(ROOT, '.runtime/workers', task.spec.id, archives[0]!), 'utf8'));
    assert.equal(archive.removed.length, 1); assert.equal(archive.removed[0].reason, 'interrupted-empty-assistant');
    assert.equal(emptyAssistantRequests, 0, 'No empty assistant reaches the strict model endpoint');
    assert.equal(readFileSync(path.join(worktree, 'marker.txt'), 'utf8'), 'native-fixture\n');
  } catch (error) { throw new Error(String(error) + '; observed tool lists: ' + JSON.stringify(observedTools)); }
  finally { await worker.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
