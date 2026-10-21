import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { ROOT } from '../src/config.js';
import { serveDaemon, readInfo, rpc, stopDaemon } from '../src/daemon.js';
import { Store } from '../src/store.js';
import { TaskSpecSchema } from '../src/schema.js';
import { git } from '../src/process.js';
import { contractFields } from './fixtures.js';
import { setTimeout as delay } from 'node:timers/promises';

const updater = await import(pathToFileURL(path.join(ROOT, 'scripts/update.mjs')).href);
const parent = path.join(ROOT, 'work/workflow-tests'); fs.mkdirSync(parent, { recursive: true });
function fixture() {
  const root = fs.mkdtempSync(path.join(parent, 'update space 中文-')); const home = path.join(root, 'home');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') };
  for (const dir of ['scripts', 'skills/orchestrate-code/agents', 'integrations/claude/skills/orchestrate-code', '.runtime/tasks/old', 'src']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ['SKILL.md', 'agents/openai.yaml']) fs.copyFileSync(path.join(ROOT, 'skills/orchestrate-code', file), path.join(root, 'skills/orchestrate-code', file));
  fs.writeFileSync(path.join(root, 'integrations/claude/skills/orchestrate-code/SKILL.md'), 'old generated skill');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}'); fs.writeFileSync(path.join(root, 'package-lock.json'), '{"lockfileVersion":3}');
  fs.writeFileSync(path.join(root, '.env.local'), 'PRIVATE_FIXTURE_KEY=preserve-this\n'); fs.writeFileSync(path.join(root, 'workflow.local.json'), '{"local":"preserve"}');
  fs.writeFileSync(path.join(root, '.runtime/tasks/old/task.json'), '{"status":"accepted","evidence":"preserve"}');
  const profile = path.join(root, 'skills/orchestrate-code/repositories.local/project'); fs.mkdirSync(profile, { recursive: true }); fs.writeFileSync(path.join(profile, 'profile.json'), '{"local":"profile"}');
  const mcp = { command: process.execPath, args: [path.join(root, 'dist/src/cli.js'), 'mcp'] };
  for (const client of ['claude', 'codex']) {
    const dir = path.join(home, client === 'claude' ? '.claude' : '.agents', 'skills/orchestrate-code'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `old ${client} skill`);
    fs.writeFileSync(path.join(dir, '.agent-orchestrator-install.json'), JSON.stringify({ projectRoot: root, mcp }));
  }
  const claudeConfig = path.join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  fs.writeFileSync(claudeConfig, JSON.stringify({ userPreference: 'keep', mcpServers: { 'agent-orchestrator': mcp, unrelated: { command: 'keep' } } }));
  const calls: string[][] = []; let failBuild = false; let dirty = false;
  const run = (tool: { command: string }, args: string[]) => {
    calls.push([tool.command, ...args]);
    if (tool.command === 'codex') return { status: 0, stdout: JSON.stringify({ transport: { type: 'stdio', ...mcp } }), stderr: '' };
    if (tool.command === 'git') return { status: 0, stdout: args[0] === 'status' ? dirty ? ' M local.txt\n' : '' : 'origin/main\n', stderr: '' };
    if (args[0] === 'ci') { const dir = path.join(root, 'node_modules/typescript/bin'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'tsc'), 'fixture'); }
    if (args.join(' ') === 'run build') {
      if (failBuild) return { status: 1, stdout: '', stderr: 'fixture compiler error' };
      fs.mkdirSync(path.join(root, 'dist/src'), { recursive: true }); fs.writeFileSync(path.join(root, 'dist/src/cli.js'), '// fixture build');
    }
    if (args[0]?.endsWith('prepare-integrations.mjs')) {
      const skill = fs.readFileSync(path.join(root, 'skills/orchestrate-code/SKILL.md'), 'utf8').replace('---\nname:', '---\ndisable-model-invocation: true\nname:');
      fs.writeFileSync(path.join(root, 'integrations/claude/skills/orchestrate-code/SKILL.md'), skill);
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const preserved = ['.env.local', 'workflow.local.json', '.runtime/tasks/old/task.json', 'skills/orchestrate-code/repositories.local/project/profile.json'].map(file => [file, fs.readFileSync(path.join(root, file), 'utf8')]);
  const dependencies = { root, home, env, run, find: (name: string) => ({ command: name, args: [] }), stop: async () => true, log: () => {} };
  const checkPreserved = () => { for (const [file, contents] of preserved) assert.equal(fs.readFileSync(path.join(root, file!), 'utf8'), contents); };
  return { root, home, env, calls, dependencies, checkPreserved, claudeConfig, failBuild: () => { failBuild = true; }, dirty: () => { dirty = true; } };
}

test('update check and preview find stale installed entries without mutations or daemon access', async () => {
  const f = fixture();
  for (const flag of ['--check', '--dry-run']) {
    const result = await updater.applyUpdate(updater.parseUpdateOptions([flag]), { ...f.dependencies, stop: () => { throw new Error('must not stop'); } });
    assert.equal(result.updateRequired, true); assert.equal(result.clients.length, 2); assert.ok(result.clients.every((c: any) => !c.upToDate));
    assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(path.join(f.root, '.runtime/update.lock')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.runtime/update.json')), false); f.checkPreserved();
  }
});

test('explicit update refreshes both managed clients, restores the backend and preserves local state', async () => {
  const f = fixture(); const config = fs.readFileSync(f.claudeConfig, 'utf8');
  const result = await updater.applyUpdate(updater.parseUpdateOptions([]), f.dependencies);
  assert.equal(result.updated, true); assert.equal(result.updateRequired, false); assert.equal(result.backendCurrent, true);
  assert.ok(result.clients.every((c: any) => c.upToDate)); f.checkPreserved(); assert.equal(fs.readFileSync(f.claudeConfig, 'utf8'), config);
  assert.ok(f.calls.some(c => c[1] === 'ci')); assert.ok(f.calls.some(c => c.at(-1) === 'start'));
  assert.equal(fs.existsSync(path.join(f.home, '.agents/skills/orchestrate-code/repositories.local')), false);
  assert.equal(fs.existsSync(path.join(f.root, '.runtime/update.lock')), false);
  f.calls.length = 0;
  await updater.applyUpdate(updater.parseUpdateOptions([]), f.dependencies);
  assert.equal(f.calls.some(c => c[1] === 'ci'), false);
  fs.writeFileSync(path.join(f.root, 'src/new.ts'), 'export const changed = true;');
  assert.equal(updater.updatePlan(f.root, updater.parseUpdateOptions([]), f.dependencies).backendCurrent, false);
});

test('busy backend and failed builds do not replace Skills or record successful updates', async () => {
  for (const mode of ['busy', 'build-failure']) {
    const f = fixture(); if (mode === 'build-failure') f.failBuild();
    await assert.rejects(updater.applyUpdate(updater.parseUpdateOptions([]), { ...f.dependencies,
      ...(mode === 'busy' ? { stop: async () => { throw new Error('Workflow is busy'); } } : {}),
    }), mode === 'busy' ? /busy/ : /Building the backend failed/);
    assert.equal(fs.readFileSync(path.join(f.home, '.claude/skills/orchestrate-code/SKILL.md'), 'utf8'), 'old claude skill');
    assert.equal(fs.existsSync(path.join(f.root, '.runtime/update.json')), false);
    assert.equal(fs.existsSync(path.join(f.root, '.runtime/update.lock')), false); f.checkPreserved();
    if (mode === 'busy') assert.equal(f.calls.some(c => c[0] === 'npm'), false);
  }
});

test('remote pull is opt-in, refuses dirty work before stopping, and updates serialize with a lock', async () => {
  const f = fixture(); f.dirty();
  await assert.rejects(updater.applyUpdate(updater.parseUpdateOptions(['--pull']), { ...f.dependencies, stop: () => { throw new Error('must not stop'); } }), /clean checkout/);
  assert.equal(f.calls.some(c => c[1] === 'pull'), false); f.checkPreserved();
  fs.mkdirSync(path.join(f.root, '.runtime/update.lock'));
  await assert.rejects(updater.applyUpdate(updater.parseUpdateOptions([]), f.dependencies), /Another update/);
  assert.equal(fs.existsSync(path.join(f.root, '.runtime/update.lock')), true);
  const clean = fixture();
  await updater.applyUpdate(updater.parseUpdateOptions(['--pull']), clean.dependencies);
  assert.ok(clean.calls.some(c => c.join(' ') === 'git pull --ff-only'));
});

test('automatic client selection skips foreign installations and explicit selection retains ownership checks', () => {
  const f = fixture(); const foreign = path.join(f.root, 'foreign'); fs.mkdirSync(foreign);
  const marker = path.join(f.home, '.claude/skills/orchestrate-code/.agent-orchestrator-install.json');
  fs.writeFileSync(marker, JSON.stringify({ projectRoot: foreign }));
  const plan = updater.updatePlan(f.root, updater.parseUpdateOptions([]), f.dependencies);
  assert.deepEqual(plan.clients.map((c: any) => c.client), ['codex']);
  assert.throws(() => updater.updatePlan(f.root, updater.parseUpdateOptions(['--client', 'claude']), f.dependencies), /another installation/);
  for (const args of [['--client', 'invalid'], ['--check', '--pull'], ['--api-key', 'forbidden']]) assert.throws(() => updater.parseUpdateOptions(args));
});

test('idle shutdown requires backend support and never falls back to stopping a busy or legacy daemon', async () => {
  for (const legacy of [true, false]) {
    const f = fixture(); let shutdowns = 0;
    const server = createServer((req, res) => {
      assert.equal(req.headers.authorization, 'Bearer fixture-only');
      if (req.url === '/rpc') res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ result: { maintenance: legacy ? {} : { idleShutdown: true } } }));
      else { shutdowns++; assert.equal(req.headers['x-orchestrator-idle-only'], 'true'); res.writeHead(409).end('busy'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address === 'object');
    fs.writeFileSync(path.join(f.root, '.runtime/daemon.json'), JSON.stringify({ pid: process.pid, port: address.port, token: 'fixture-only' }));
    try { await assert.rejects(updater.stopIdleBackend(f.root), legacy ? /older daemon/ : /busy/); assert.equal(shutdowns, legacy ? 0 : 1); }
    finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }
});

test('real daemon refuses update during verification, preserves the round and stops after it is idle', { timeout: 30000 }, async () => {
  const f = fixture(); const repository = path.join(f.root, 'repository'); fs.mkdirSync(repository);
  await git(repository, ['init', '-b', 'master']); fs.writeFileSync(path.join(repository, 'value.txt'), 'fixture');
  await git(repository, ['add', 'value.txt']); await git(repository, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']);
  fs.writeFileSync(path.join(f.root, 'workflow.local.json'), JSON.stringify({ executionEnabled: true, maxParallel: 1, taskTimeoutMinutes: 1,
    providers: { fixture: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKeyEnv: 'NO_MODEL_CALL', contextLimit: 32768, outputLimit: 4096 } } }));
  const store = new Store(path.join(f.root, '.runtime/tasks'));
  // Remove only this fixture's placeholder record before creating a real task store.
  fs.unlinkSync(path.join(f.root, '.runtime/tasks/old/task.json')); fs.rmdirSync(path.join(f.root, '.runtime/tasks/old'));
  const started = path.join(f.root, 'verification-started');
  const task = store.create(TaskSpecSchema.parse({ ...contractFields, id: 'maintenance', title: 'Maintenance guard', repository, baseRef: 'HEAD', branch: 'master', workspaceMode: 'current', provider: 'fixture', goal: 'Verify idle-only maintenance', acceptance: [{ id: 'AC1', requirement: 'Guard active verification' }],
    checks: [{ name: 'hold', command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(started)}, 'started'); setTimeout(() => {}, 20000)`], timeoutMinutes: 1 }] }));
  task.status = 'awaiting_review'; task.worktree = repository; task.baseCommit = await git(repository, ['rev-parse', 'HEAD']); store.save(task);
  const server = await serveDaemon(f.root);
  try {
    const info = readInfo(f.root)!;
    await rpc(info, 'workflow_verify', { id: 'maintenance' });
    const end = Date.now() + 10000;
    while (!fs.existsSync(started) && Date.now() < end) await delay(20);
    assert.ok(fs.existsSync(started));
    await assert.rejects(updater.stopIdleBackend(f.root), /busy/);
    assert.equal(store.get('maintenance').status, 'verifying');
    await rpc(info, 'workflow_verify_stop', { id: 'maintenance', reason: 'Fixture finished testing maintenance exclusion' });
    assert.equal(store.get('maintenance').status, 'awaiting_review');
    assert.equal(store.get('maintenance').verificationHistory?.[0]?.status, 'stopped');
    assert.equal(await updater.stopIdleBackend(f.root), true);
  } finally { await stopDaemon(f.root); server.closeAllConnections(); server.close(); }
});
