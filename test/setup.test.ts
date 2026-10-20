import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT } from '../src/config.js';
import { checkSetup } from '../src/setup-check.js';

const lib = await import(pathToFileURL(path.join(ROOT, 'scripts/setup-lib.mjs')).href);
const { parseOptions } = await import(pathToFileURL(path.join(ROOT, 'scripts/setup.mjs')).href);
const tool = { command: 'fixture-client', args: [] };

function copyTree(source: string, target: string) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory()) copyTree(path.join(source, entry.name), path.join(target, entry.name));
    else fs.copyFileSync(path.join(source, entry.name), path.join(target, entry.name));
  }
}

function fixture() {
  const parent = path.join(ROOT, 'work/workflow-tests'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'setup space 中文-'));
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  for (const dir of ['scripts', 'skills/orchestrate-code', 'integrations/claude/skills/orchestrate-code', 'dist/src']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ['setup.mjs', 'setup-lib.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(root, 'scripts', file));
  fs.copyFileSync(path.join(ROOT, 'skills/orchestrate-code/SKILL.md'), path.join(root, 'skills/orchestrate-code/SKILL.md'));
  copyTree(path.join(ROOT, 'skills/orchestrate-code/agents'), path.join(root, 'skills/orchestrate-code/agents'));
  fs.copyFileSync(path.join(ROOT, 'integrations/claude/skills/orchestrate-code/SKILL.md'), path.join(root, 'integrations/claude/skills/orchestrate-code/SKILL.md'));
  fs.writeFileSync(path.join(root, 'dist/src/cli.js'), '// fixture');
  fs.writeFileSync(path.join(root, '.env.example'), 'DEEPSEEK_API_KEY=\nMOONSHOT_API_KEY=\n# SDK\nVULKAN_SDK=C:/SDK\n');
  const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') };
  const config = path.join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  const state: Record<string, any> = { unrelated: { command: 'other-server', args: [] } };
  const calls: string[][] = [];
  let failNextAdd = false;
  const run = (_tool: unknown, args: string[]) => {
    calls.push(args);
    const operation = args[1];
    if (operation === 'get') return state['agent-orchestrator']
      ? { status: 0, stdout: JSON.stringify({ enabled: true, transport: { type: 'stdio', ...state['agent-orchestrator'] } }), stderr: '' }
      : { status: 1, stdout: '', stderr: 'No MCP server named agent-orchestrator found.' };
    let settings: any = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')) : { authentication: 'keep-fixture', mcpServers: { unrelated: state.unrelated } };
    if (operation === 'remove') { delete state['agent-orchestrator']; delete settings.mcpServers['agent-orchestrator']; }
    if (operation === 'add') {
      if (failNextAdd) { failNextAdd = false; return { status: 1, stdout: '', stderr: 'fixture failure' }; }
      const separator = args.indexOf('--');
      state['agent-orchestrator'] = { command: args[separator + 1], args: args.slice(separator + 2) };
      settings.mcpServers['agent-orchestrator'] = state['agent-orchestrator'];
    }
    fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, JSON.stringify(settings));
    return { status: 0, stdout: '', stderr: '' };
  };
  return { root, home, env, state, calls, config, run, failAdd: () => { failNextAdd = true; }, plan: (client: string) => lib.integrationPlan(root, client, { home, env }) };
}

for (const client of ['claude', 'codex']) test(`${client} installation is repeatable and preserves other settings and local profiles`, () => {
  const f = fixture();
  const profiles = path.join(f.root, 'skills/orchestrate-code/repositories.local'); fs.mkdirSync(profiles, { recursive: true });
  fs.writeFileSync(path.join(profiles, 'private.json'), 'must not be installed');
  let plan = lib.inspectIntegration(f.plan(client), tool, f.run);
  assert.equal(lib.installIntegration(plan, tool, f.run).mcp, 'add');
  const firstAdds = f.calls.filter(a => a[1] === 'add').length;
  fs.writeFileSync(path.join(plan.skillDir, 'SKILL.md'), 'outdated managed skill');
  plan = lib.inspectIntegration(f.plan(client), tool, f.run);
  assert.equal(lib.installIntegration(plan, tool, f.run).mcp, 'keep');
  assert.equal(f.calls.filter(a => a[1] === 'add').length, firstAdds);
  assert.match(fs.readFileSync(path.join(plan.skillDir, 'SKILL.md'), 'utf8'), /name: orchestrate-code/);
  assert.equal(fs.existsSync(path.join(plan.skillDir, 'repositories.local')), false);
  assert.deepEqual(f.state.unrelated, { command: 'other-server', args: [] });
  assert.equal(JSON.parse(fs.readFileSync(f.config, 'utf8')).authentication, 'keep-fixture');
  if (client === 'codex') assert.equal(fs.existsSync(path.join(plan.skillDir, 'agents/openai.yaml')), true);
  else assert.ok(f.calls.find(a => a[1] === 'add')!.includes('user'));
});

for (const client of ['claude', 'codex']) test(`${client} rejects unmanaged skills and conflicting MCP without writes`, () => {
  const f = fixture(); const initial = f.plan(client);
  fs.mkdirSync(initial.skillDir, { recursive: true }); fs.writeFileSync(path.join(initial.skillDir, 'SKILL.md'), 'user-owned');
  assert.throws(() => f.plan(client), /Unmanaged skill/);
  assert.equal(fs.readFileSync(path.join(initial.skillDir, 'SKILL.md'), 'utf8'), 'user-owned');
  // A separate fixture covers an MCP conflict without a conflicting skill.
  const g = fixture();
  g.state['agent-orchestrator'] = { command: 'different-program', args: [] };
  fs.mkdirSync(path.dirname(g.config), { recursive: true });
  fs.writeFileSync(g.config, JSON.stringify({ mcpServers: g.state }));
  const before = fs.readFileSync(g.config, 'utf8');
  assert.throws(() => lib.inspectIntegration(g.plan(client), tool, g.run), /Conflicting/);
  assert.equal(fs.existsSync(g.plan(client).skillDir), false);
  assert.equal(fs.readFileSync(g.config, 'utf8'), before);
  assert.ok(g.calls.every(a => a[1] === 'get'));
});

for (const client of ['claude', 'codex']) test(`${client} repairs moved installations and restores the old MCP entry on failure`, () => {
  const f = fixture(); let plan = f.plan(client);
  const oldRoot = path.join(f.root, 'old missing installation');
  const old = { command: process.execPath, args: [path.join(oldRoot, 'dist/src/cli.js'), 'mcp'] };
  fs.mkdirSync(plan.skillDir, { recursive: true });
  fs.writeFileSync(plan.markerFile, JSON.stringify({ projectRoot: oldRoot, mcp: old }));
  f.state['agent-orchestrator'] = old;
  fs.mkdirSync(path.dirname(f.config), { recursive: true }); fs.writeFileSync(f.config, JSON.stringify({ mcpServers: f.state }));
  plan = lib.inspectIntegration(f.plan(client), tool, f.run); assert.equal(plan.action, 'update');
  f.failAdd(); assert.throws(() => lib.installIntegration(plan, tool, f.run), /Previous entry restored/);
  assert.deepEqual(f.state['agent-orchestrator'], old);
  plan = lib.inspectIntegration(f.plan(client), tool, f.run);
  lib.installIntegration(plan, tool, f.run);
  assert.deepEqual(f.state['agent-orchestrator'], plan.mcp);
});

test('legacy Codex skills and malformed or unrelated ownership records are not silently replaced', () => {
  const f = fixture(); const legacy = path.join(f.env.CODEX_HOME, 'skills/orchestrate-code'); fs.mkdirSync(legacy, { recursive: true });
  assert.throws(() => f.plan('codex'), /Legacy Codex skill/);
  const g = fixture(); const plan = g.plan('claude'); fs.mkdirSync(plan.skillDir, { recursive: true });
  fs.writeFileSync(plan.markerFile, '{broken'); assert.throws(() => g.plan('claude'), /Invalid JSON/);
  fs.writeFileSync(plan.markerFile, JSON.stringify({ projectRoot: ROOT }));
  assert.throws(() => g.plan('claude'), /another installation/);
});

test('key storage preserves existing settings and refuses ambiguous or multiline input', () => {
  const f = fixture(); const file = path.join(f.root, '.env.local');
  fs.writeFileSync(file, 'DEEPSEEK_API_KEY=\nMOONSHOT_API_KEY=keep-other\n# local SDK\nVULKAN_SDK=C:/my SDK\n');
  lib.saveApiKey(f.root, 'DEEPSEEK_API_KEY', 'fixture-key');
  assert.equal(fs.readFileSync(file, 'utf8'), 'DEEPSEEK_API_KEY=fixture-key\nMOONSHOT_API_KEY=keep-other\n# local SDK\nVULKAN_SDK=C:/my SDK\n');
  assert.throws(() => lib.saveApiKey(f.root, 'DEEPSEEK_API_KEY', 'bad\nOTHER=key'), /Invalid/);
  fs.appendFileSync(file, 'DEEPSEEK_API_KEY=duplicate\n');
  assert.throws(() => lib.saveApiKey(f.root, 'DEEPSEEK_API_KEY', 'replacement'), /Duplicate/);
});

test('Windows npm-installed client shims resolve to Node entrypoints without a shell', () => {
  const f = fixture(); const bin = path.join(f.root, 'tools & spaces'); fs.mkdirSync(bin);
  for (const [name, entry] of Object.entries({ codex: '@openai/codex/bin/codex.js', claude: '@anthropic-ai/claude-code/cli.js' })) {
    const file = path.join(bin, 'node_modules', entry); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '');
    assert.deepEqual(lib.findTool(name, { PATH: bin }, 'win32'), { command: process.execPath, args: [file] });
  }
  const empty = path.join(f.root, 'empty PATH entry'); fs.mkdirSync(empty);
  fs.writeFileSync(path.join(bin, 'git.exe'), 'fixture');
  assert.deepEqual(lib.findTool('git', { PATH: [empty, bin].join(path.delimiter) }, 'win32'), { command: path.join(bin, 'git.exe'), args: [] });
});

test('setup refuses to replace dependencies under a running daemon and leaves its record intact', () => {
  const f = fixture(); const runtime = path.join(f.root, '.runtime'); fs.mkdirSync(runtime);
  const file = path.join(runtime, 'daemon.json'); const text = JSON.stringify({ pid: process.pid, token: 'fixture-private-token' });
  fs.writeFileSync(file, text);
  assert.throws(() => lib.assertBackendStopped(f.root), /daemon is running/);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('setup dry-run works before building and never creates environment, examples or user integrations', () => {
  const f = fixture();
  const script = path.join(f.root, 'scripts/setup.mjs');
  const output = execFileSync(process.execPath, [script, '--client', 'none', '--dry-run'], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.match(output, /No changes/);
  assert.equal(fs.existsSync(path.join(f.root, '.env.local')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'integrations/local')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.agents')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'node_modules')), false);
  const result = spawnSync(process.execPath, [script, '--non-interactive'], { cwd: f.root, env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /Specify --client/);
  assert.throws(() => parseOptions(['--api-key', 'do-not-accept-credentials']), /Unknown option/);
  assert.throws(() => parseOptions(['--provider', 'invalid']), /Invalid --provider/);
});

test('backend setup check verifies the real guard and MCP without starting a daemon or creating project profiles', { timeout: 60000 }, async () => {
  const f = fixture();
  copyTree(path.join(ROOT, 'dist/src'), path.join(f.root, 'dist/src'));
  fs.copyFileSync(path.join(ROOT, 'scripts/worker-job.ps1'), path.join(f.root, 'scripts/worker-job.ps1'));
  fs.copyFileSync(path.join(ROOT, 'scripts/worker-job.cs'), path.join(f.root, 'scripts/worker-job.cs'));
  fs.writeFileSync(path.join(f.root, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(f.root, 'workflow.config.json'), JSON.stringify({ executionEnabled: false, maxParallel: 1, maxAttempts: 1, taskTimeoutMinutes: 1, workerMemoryLimitMB: 3072,
    providers: { fixture: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKeyEnv: 'FIXTURE_SETUP_KEY', contextLimit: 32768, outputLimit: 4096 } } }));
  // Expose only the installed native binary, never a model endpoint.
  fs.mkdirSync(path.join(f.root, 'node_modules'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules', `opencode-windows-${process.arch}`), path.join(f.root, 'node_modules', `opencode-windows-${process.arch}`), 'junction');
  fs.writeFileSync(path.join(f.root, '.env.local'), 'FIXTURE_SETUP_KEY=offline-fixture\n');
  const result: any = await checkSetup(f.root, 'fixture');
  assert.equal(result.passed, true); assert.equal(result.memoryGuard, 'passed'); assert.equal(result.mcpTools, 17);
  assert.equal(fs.existsSync(path.join(f.root, '.runtime/daemon.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'skills/orchestrate-code/repositories.local')), false);
  fs.writeFileSync(path.join(f.root, '.env.local'), 'FIXTURE_SETUP_KEY=\n');
  await assert.rejects(checkSetup(f.root, 'fixture'), /Missing FIXTURE_SETUP_KEY/);
});
