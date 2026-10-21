import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { findTool, runTool, readJson, integrationPlan, inspectIntegration, installIntegration } from './setup-lib.mjs';

const installation = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marker = '.agent-orchestrator-install.json';
const usage = `Usage: npm run update -- [--client auto|claude|codex|both|none] [--check|--dry-run] [--pull]
Default: apply this checkout, rebuild the backend and refresh clients managed by this installation.
--check reports stale source/installed Skills without changing files or starting a daemon.
--dry-run shows the update plan without executing it.
--pull explicitly runs git pull --ff-only; requires a clean branch with an upstream.
Preserves keys, local configuration, repository profiles and tasks. No model request is made.
Active backend operations block updates. Reopen/reconnect clients after updating.`;

export function parseUpdateOptions(args) {
  const options = { client: 'auto', check: false, dryRun: false, pull: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--client') {
      const client = args[++i];
      if (!['auto', 'claude', 'codex', 'both', 'none'].includes(client)) throw new Error('Invalid --client. Expected auto|claude|codex|both|none.');
      options.client = client;
    } else if (arg === '--check') options.check = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--pull') options.pull = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}. Run npm run update -- --help.`);
  }
  if (options.check && (options.pull || options.dryRun)) throw new Error('--check cannot be combined with --pull or --dry-run.');
  return options;
}

function sharedSkill(root) { return fs.readFileSync(path.join(root, 'skills/orchestrate-code/SKILL.md'), 'utf8'); }
function expectedSkill(root, client) { const source = sharedSkill(root); return client === 'claude' ? source.replace('---\nname:', '---\ndisable-model-invocation: true\nname:') : source; }
function matches(file, text) { return fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text; }
function hashFile(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sourceFingerprint(root) {
  const hash = createHash('sha256');
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'repositories.local') continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) { hash.update(file.replaceAll('\\', '/') + '\0'); hash.update(fs.readFileSync(path.join(root, file))); }
    }
  };
  for (const dir of ['src', 'scripts', 'prompts', 'skills/orchestrate-code']) if (fs.existsSync(path.join(root, dir))) walk(dir);
  for (const file of ['package.json', 'package-lock.json', 'AGENTS.md', 'CLAUDE.md', 'workflow.config.json']) {
    if (fs.existsSync(path.join(root, file))) { hash.update(file + '\0'); hash.update(fs.readFileSync(path.join(root, file))); }
  }
  return hash.digest('hex');
}

export function updatePlan(root, options, { home = os.homedir(), env = process.env } = {}) {
  const candidates = options.client === 'auto' || options.client === 'both' ? ['claude', 'codex'] : options.client === 'none' ? [] : [options.client];
  const clients = candidates.flatMap(client => {
    const base = client === 'claude' ? (env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')) : path.join(home, '.agents');
    if (options.client === 'auto' && !fs.existsSync(path.join(base, 'skills/orchestrate-code', marker))) return [];
    if (options.client === 'auto') {
      const owner = readJson(path.join(base, 'skills/orchestrate-code', marker), null);
      if (typeof owner?.projectRoot !== 'string') throw new Error(`Invalid Skill ownership record for ${client}`);
      if (path.resolve(owner.projectRoot).toLowerCase() !== path.resolve(root).toLowerCase()) return [];
    }
    const plan = integrationPlan(root, client, { home, env });
    return [{ client, skill: plan.skillDir, upToDate: matches(path.join(plan.skillDir, 'SKILL.md'), expectedSkill(root, client))
      && (client !== 'codex' || matches(path.join(plan.skillDir, 'agents/openai.yaml'), fs.readFileSync(path.join(root, 'skills/orchestrate-code/agents/openai.yaml'), 'utf8'))) }];
  });
  const fingerprint = sourceFingerprint(root); const state = readJson(path.join(root, '.runtime/update.json'), null);
  const generatedSkillCurrent = matches(path.join(root, 'integrations/claude/skills/orchestrate-code/SKILL.md'), expectedSkill(root, 'claude'));
  const backendCurrent = state?.sourceFingerprint === fingerprint && fs.existsSync(path.join(root, 'dist/src/cli.js'));
  return { root, clients, generatedSkillCurrent, backendCurrent,
    sourceFingerprint: fingerprint, updateRequired: !backendCurrent || !generatedSkillCurrent || clients.some(client => !client.upToDate),
    pull: options.pull, steps: ['stop only an idle daemon', ...(options.pull ? ['git pull --ff-only'] : []), 'npm ci when the dependency lock changed or is not recorded', 'npm run build', 'regenerate client instructions', 'refresh managed Skills/MCP', 'restore the previously running daemon'],
    note: 'Open clients must reconnect/reopen to load new Skills and tool descriptions. Keys, profiles and tasks are preserved.' };
}

export async function stopIdleBackend(root) {
  const info = readJson(path.join(root, '.runtime/daemon.json'), null);
  if (!Number.isInteger(info?.pid) || info.pid <= 0) return false;
  try { process.kill(info.pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  const request = (route, body, headers = {}) => fetch(`http://127.0.0.1:${info.port}${route}`, {
    method: 'POST', headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
  });
  const response = await request('/rpc', { name: 'workflow_config', args: {} });
  if (!response.ok || !(await response.json()).result?.maintenance?.idleShutdown) throw new Error('This older daemon cannot confirm an idle-only shutdown. Finish active work, run npm run stop, then rerun update.');
  const stopped = await request('/shutdown', null, { 'X-Orchestrator-Idle-Only': 'true' });
  if (stopped.status === 409) throw new Error('Workflow is busy. Finish active workers, verification or other operations, then rerun update.');
  if (!stopped.ok) throw new Error('Daemon refused idle shutdown; no update was applied.');
  for (let n = 0; n < 120; n++) {
    if (readJson(path.join(root, '.runtime/daemon.json'), null)?.pid !== info.pid) return true;
    await delay(250);
  }
  throw new Error('Daemon is still stopping; no update was applied. Inspect logs before retrying.');
}

export async function applyUpdate(options, { root = installation, home = os.homedir(), env = process.env, run = runTool, find = findTool, stop = stopIdleBackend, log = console.log } = {}) {
  const settings = { home, env }; const plan = updatePlan(root, options, settings);
  if (options.check || options.dryRun) return plan;
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required.');
  const npm = find('npm', env); const git = find('git', env);
  const tools = new Map(plan.clients.map(({ client }) => [client, find(client, env)]));
  const command = (label, tool, args, inherit = true) => {
    log(label);
    const result = run(tool, args, { cwd: root, env, timeout: 600000, inherit });
    if (result.status !== 0) throw new Error(`${label} failed. Fix the reported error and rerun update; local state is retained.`);
    return result;
  };
  for (const [client, tool] of tools) inspectIntegration(integrationPlan(root, client, settings), tool, run);
  if (options.pull) {
    if (command('Checking the source checkout', git, ['status', '--porcelain'], false).stdout.trim()) throw new Error('--pull requires a clean checkout; commit or preserve your local changes first. No stash/reset is performed.');
    command('Checking the current upstream', git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], false);
  }
  const runtime = path.join(root, '.runtime'); fs.mkdirSync(runtime, { recursive: true });
  const lock = path.join(runtime, 'update.lock');
  try { fs.mkdirSync(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('Another update is in progress. If it crashed, confirm it has exited before removing .runtime/update.lock.'); throw error; }
  let restart = false;
  try {
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    restart = await stop(root);
    if (options.pull) command('Fetching and fast-forwarding the current upstream', git, ['pull', '--ff-only']);
    const lockHash = hashFile(path.join(root, 'package-lock.json'));
    const previous = readJson(path.join(runtime, 'update.json'), null);
    if (previous?.dependencyLockHash !== lockHash || !fs.existsSync(path.join(root, 'node_modules/typescript/bin/tsc'))) {
      command('Installing locked dependencies', npm, ['ci', '--include=dev', '--prefer-offline', '--no-audit', '--no-fund']);
    }
    command('Building the backend', npm, ['run', 'build']);
    command('Refreshing client instruction sources', { command: process.execPath, args: [] }, [path.join(root, 'scripts/prepare-integrations.mjs')]);
    for (const [client, tool] of tools) {
      const fresh = inspectIntegration(integrationPlan(root, client, settings), tool, run);
      log(JSON.stringify(installIntegration(fresh, tool, run)));
    }
  } finally {
    if (fs.existsSync(path.join(lock, 'owner.json'))) fs.unlinkSync(path.join(lock, 'owner.json'));
    fs.rmdirSync(lock);
  }
  if (restart) command('Restarting the idle backend', { command: process.execPath, args: [] }, [path.join(root, 'dist/src/cli.js'), 'start']);
  const state = { updatedAt: new Date().toISOString(), sourceFingerprint: sourceFingerprint(root), dependencyLockHash: hashFile(path.join(root, 'package-lock.json')), clients: [...tools.keys()] };
  const file = path.join(runtime, 'update.json'); const temp = file + `.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n'); fs.renameSync(temp, file);
  return { updated: true, ...updatePlan(root, options, settings) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseUpdateOptions(process.argv.slice(2));
    if (options.help) console.log(usage);
    else console.log(JSON.stringify(await applyUpdate(options), null, 2));
  } catch (error) { console.error(`Update failed: ${error.message}`); process.exitCode = 1; }
}
