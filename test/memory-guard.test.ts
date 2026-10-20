import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT } from '../src/config.js';
import { memoryGuardLaunch, readMemoryReport, workerExitError } from '../src/memory-guard.js';
import { runCommand } from '../src/process.js';
import { OpenCodeWorker } from '../src/opencode.js';
import { ConfigSchema, TaskSpecSchema, type Task } from '../src/schema.js';
import { contractFields } from './fixtures.js';
import { randomUUID } from 'node:crypto';

function fixture() {
  const parent = path.join(ROOT, 'work/workflow-tests'); mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'memory-'));
  return { root, report: path.join(root, 'report.json'), request: path.join(root, 'request.json') };
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitFor(check: () => boolean, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error('Memory fixture timed out'); await delay(50); }
}

test('Windows job guard preserves arguments, stdout and a normal child exit', async () => {
  const f = fixture(); const script = path.join(f.root, 'argument fixture.js');
  writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const args = [script, 'with space', 'quote"value', 'trailing slash\\', '中文'];
  const launch = memoryGuardLaunch(ROOT, f.request, f.report, 192, process.execPath, args);
  const result = await runCommand(launch.command, launch.args, f.root, process.env, 30000);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(JSON.parse(result.stdout.trim()), args.slice(1));
  const report = readMemoryReport(f.report)!;
  assert.equal(report.status, 'exited'); assert.equal(report.limitMB, 192); assert.ok(report.peakBytes > 0);
});

test('aggregate job memory limit terminates a worker and its allocating children', async () => {
  const f = fixture(); const script = path.join(f.root, 'allocate.cjs'); const pids = path.join(f.root, 'pids.txt');
  writeFileSync(script, `const fs=require('fs');fs.appendFileSync(${JSON.stringify(pids)},process.pid+'\\n');
if(process.argv[2]){global.keep=Buffer.alloc(128*1024*1024,1);setInterval(()=>{},1000);}
else{const{spawn}=require('child_process');spawn(process.execPath,[__filename,'child'],{stdio:'inherit'});spawn(process.execPath,[__filename,'child'],{stdio:'inherit'});setInterval(()=>{},1000);}`);
  const launch = memoryGuardLaunch(ROOT, f.request, f.report, 192, process.execPath, [script]);
  const result = await runCommand(launch.command, launch.args, f.root, process.env, 30000);
  assert.notEqual(result.code, 0);
  const report = readMemoryReport(f.report)!;
  assert.equal(report.status, 'memory_limit', result.output + JSON.stringify(report));
  assert.equal(report.exitCode, 137); assert.ok(report.peakBytes > 0);
  assert.match(workerExitError(f.report).message, /WORKER_MEMORY_LIMIT/);
  const all = readFileSync(pids, 'utf8').trim().split(/\r?\n/).map(Number);
  assert.ok(all.length >= 2);
  await waitFor(() => all.every(pid => !alive(pid)), 5000);
});

test('killing the guard itself closes the job and leaves no surviving child', async () => {
  const f = fixture(); const pidFile = path.join(f.root, 'pid.txt'); const script = path.join(f.root, 'hold.cjs');
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`);
  const launch = memoryGuardLaunch(ROOT, f.request, f.report, 192, process.execPath, [script]);
  const guard = spawn(launch.command, launch.args, { cwd: f.root, windowsHide: true, stdio: 'ignore' });
  const closed = new Promise<void>(resolve => guard.once('close', () => resolve()));
  try {
    await waitFor(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8')); assert.equal(alive(pid), true);
    guard.kill(); await closed; await waitFor(() => !alive(pid), 5000);
  } finally { guard.kill(); }
});

test('guard setup errors fail closed and are separately diagnosable', async () => {
  const f = fixture();
  const launch = memoryGuardLaunch(ROOT, f.request, f.report, 192, path.join(f.root, 'does-not-exist.exe'), []);
  const result = await runCommand(launch.command, launch.args, f.root, process.env, 30000);
  assert.notEqual(result.code, 0);
  assert.equal(readMemoryReport(f.report)?.status, 'guard_error');
  assert.match(workerExitError(f.report).message, /WORKER_MEMORY_GUARD_FAILED/);
});

test('an actual OpenCode startup memory failure is reported as a memory limit with preserved evidence', { timeout: 45000 }, async () => {
  const f = fixture();
  const config = ConfigSchema.parse({ executionEnabled: true, maxParallel: 1, maxAttempts: 3, taskTimeoutMinutes: 1, workerMemoryLimitMB: 128,
    providers: { fixture: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', contextLimit: 32768, outputLimit: 4096 } } });
  const spec = TaskSpecSchema.parse({ ...contractFields, id: 'memory-native-' + Date.now(), title: 'Memory fixture', repository: f.root, baseRef: 'master', branch: 'fixture', provider: 'fixture', mode: 'investigate', goal: 'Offline memory fixture', acceptance: [{ id: 'AC-01', requirement: 'No model request' }], checks: [] });
  const task: Task = { spec, status: 'running', revision: 1, attempts: 1, runId: randomUUID(), worktree: f.root,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), checks: [], reviews: [], totalTokens: 0, cost: 0 };
  const worker = new OpenCodeWorker(ROOT, config, { ...process.env, FIXTURE_KEY: 'offline-fixture' });
  try {
    await assert.rejects(worker.run(task, () => {}), /WORKER_MEMORY_LIMIT/);
    const failure = JSON.parse(readFileSync(path.join(ROOT, '.runtime/workers', spec.id, 'failure-1.json'), 'utf8'));
    assert.equal(failure.memoryGuard.status, 'memory_limit'); assert.equal(failure.memoryGuard.limitMB, 128);
  } finally { await worker.close(); }
});
