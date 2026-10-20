import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const SERVER = 'agent-orchestrator';
const MARKER = '.agent-orchestrator-install.json';
const PACKAGES = { npm: 'npm/bin/npm-cli.js', codex: '@openai/codex/bin/codex.js', claude: '@anthropic-ai/claude-code/cli.js' };

// Resolve npm shims to JavaScript, avoiding cmd.exe and shell interpolation on Windows.
export function findTool(name, env = process.env, platform = process.platform) {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).map(p => p.replace(/^"|"$/g, '')).filter(Boolean);
  if (name === 'npm') dirs.unshift(path.dirname(process.execPath));
  for (const dir of dirs) {
    const native = path.join(dir, platform === 'win32' ? `${name}.exe` : name);
    if (fs.existsSync(native)) return { command: native, args: [] };
    if (PACKAGES[name]) {
      const entry = path.join(dir, 'node_modules', PACKAGES[name]);
      if (fs.existsSync(entry)) return { command: process.execPath, args: [entry] };
    }
  }
  throw new Error(`${name} was not found on PATH. Install it and reopen the terminal before running setup.`);
}

export function runTool(tool, args, options = {}) {
  const result = spawnSync(tool.command, [...tool.args, ...args], {
    cwd: options.cwd, env: options.env ?? process.env, windowsHide: true, shell: false,
    encoding: 'utf8', timeout: options.timeout ?? 30000, maxBuffer: 4 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : 'pipe',
  });
  if (result.error) throw new Error(`Could not run ${path.basename(tool.command)}: ${result.error.message}`);
  return result;
}

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Invalid JSON: ${file}. Fix it before rerunning setup.`); }
}

export function assertBackendStopped(root) {
  const info = readJson(path.join(root, '.runtime/daemon.json'), null);
  if (!Number.isInteger(info?.pid) || info.pid <= 0) return;
  try { process.kill(info.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; throw new Error('Could not check the existing daemon. Stop it before installing backend dependencies.'); }
  throw new Error('A daemon is running. When no task is running or verifying, run npm run stop from this installation, then rerun setup.');
}

function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const normalize = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return normalize(a) === normalize(b);
}
function sameMcp(a, b) {
  return a && b && samePath(a.command, b.command) && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? [])
    && !a.url && (!a.type || a.type === 'stdio') && !a.cwd && Object.keys(a.env ?? {}).length === 0
    && (a.env_vars ?? []).length === 0 && a.enabled !== false;
}

export function integrationPlan(root, client, { home = os.homedir(), env = process.env } = {}) {
  if (!['claude', 'codex'].includes(client)) throw new Error('Client must be claude or codex.');
  const base = client === 'claude' ? (env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')) : path.join(home, '.agents');
  const skillDir = path.resolve(base, 'skills/orchestrate-code');
  const legacy = path.join(env.CODEX_HOME || path.join(home, '.codex'), 'skills/orchestrate-code');
  if (client === 'codex' && !samePath(legacy, skillDir) && fs.existsSync(legacy)) {
    throw new Error(`Legacy Codex skill exists at ${legacy}. Move it out of the skill search path before installing to ${skillDir}; setup will not create duplicates.`);
  }
  const markerFile = path.join(skillDir, MARKER);
  const marker = readJson(markerFile, null);
  if (fs.existsSync(skillDir) && (!marker || typeof marker.projectRoot !== 'string')) {
    throw new Error(`Unmanaged skill exists at ${skillDir}. Move it aside before running setup; it will not be overwritten.`);
  }
  if (marker && !samePath(marker.projectRoot, root) && fs.existsSync(marker.projectRoot)) {
    throw new Error(`Skill is managed by another installation at ${marker.projectRoot}. Use that installation or move its skill aside first.`);
  }
  const mcp = { command: process.execPath, args: [path.join(root, 'dist/src/cli.js'), 'mcp'] };
  const previous = marker?.mcp ?? (marker ? { command: process.execPath, args: [path.join(marker.projectRoot, 'dist/src/cli.js'), 'mcp'] } : null);
  return { root, client, skillDir, markerFile, marker, mcp, previous, env, home,
    source: path.join(root, client === 'claude' ? 'integrations/claude/skills/orchestrate-code' : 'skills/orchestrate-code'),
    claudeConfig: env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(home, '.claude.json') };
}

export function inspectIntegration(plan, tool, run = runTool) {
  let current;
  if (plan.client === 'claude') {
    // Read only the named user entry. Claude's CLI performs all actual config writes.
    current = readJson(plan.claudeConfig, {})?.mcpServers?.[SERVER] ?? null;
  } else {
    const result = run(tool, ['mcp', 'get', SERVER, '--json'], { cwd: plan.home, env: plan.env });
    if (result.status === 0) {
      let data;
      try { data = JSON.parse(result.stdout); } catch { throw new Error('Codex returned an unreadable MCP configuration. No settings were changed.'); }
      current = data.transport ? { ...data.transport, enabled: data.enabled } : data;
    } else if (/no mcp server|not found|does not exist/i.test(`${result.stdout}\n${result.stderr}`)) current = null;
    else throw new Error('Could not inspect Codex MCP configuration. Check `codex mcp get agent-orchestrator --json` before rerunning setup.');
  }
  if (current && !sameMcp(current, plan.mcp) && !sameMcp(current, plan.previous) && !sameMcp(current, plan.marker?.previousMcp)) {
    throw new Error(`Conflicting ${plan.client} MCP entry '${SERVER}'. Inspect it before replacing anything. No client settings were changed.`);
  }
  return { ...plan, current, action: sameMcp(current, plan.mcp) ? 'keep' : current ? 'update' : 'add' };
}

function register(plan, tool, mcp, run) {
  const args = plan.client === 'claude'
    ? ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', SERVER, '--', mcp.command, ...mcp.args]
    : ['mcp', 'add', SERVER, '--', mcp.command, ...mcp.args];
  return run(tool, args, { cwd: plan.home, env: plan.env });
}

export function installIntegration(plan, tool, run = runTool) {
  if (!fs.existsSync(path.join(plan.root, 'dist/src/cli.js')) || !fs.existsSync(path.join(plan.source, 'SKILL.md'))) {
    throw new Error('Run npm run build and node scripts/prepare-integrations.mjs first.');
  }
  fs.mkdirSync(plan.skillDir, { recursive: true });
  const marker = { projectRoot: plan.root, client: plan.client, mcp: plan.mcp, previousMcp: plan.current, installedAt: new Date().toISOString() };
  // Keep enough ownership information to recover if registration or copying is interrupted.
  fs.writeFileSync(plan.markerFile, JSON.stringify(marker, null, 2) + '\n');
  if (plan.action === 'update') {
    const args = plan.client === 'claude' ? ['mcp', 'remove', '--scope', 'user', SERVER] : ['mcp', 'remove', SERVER];
    if (run(tool, args, { cwd: plan.home, env: plan.env }).status !== 0) throw new Error(`Could not remove the managed ${plan.client} MCP entry. Rerun setup after checking the client.`);
  }
  if (plan.action !== 'keep') {
    let result;
    try { result = register(plan, tool, plan.mcp, run); }
    catch { result = { status: 1 }; }
    if (result.status !== 0) {
      let restored = false;
      if (plan.current) {
        try { restored = register(plan, tool, plan.current, run).status === 0; } catch { /* recovery details remain in the marker */ }
      }
      throw new Error(`Could not register ${plan.client} MCP.${plan.current ? restored ? ' Previous entry restored.' : ' Previous entry could not be restored; inspect the client configuration.' : ''} Fix the client and rerun setup.`);
    }
  }
  // Copy only distributed files. Local repository profiles in the source skill are never installed.
  fs.copyFileSync(path.join(plan.source, 'SKILL.md'), path.join(plan.skillDir, 'SKILL.md'));
  if (plan.client === 'codex') {
    fs.mkdirSync(path.join(plan.skillDir, 'agents'), { recursive: true });
    fs.copyFileSync(path.join(plan.source, 'agents/openai.yaml'), path.join(plan.skillDir, 'agents/openai.yaml'));
  }
  delete marker.previousMcp;
  fs.writeFileSync(plan.markerFile, JSON.stringify(marker, null, 2) + '\n');
  return { client: plan.client, skill: plan.skillDir, mcp: plan.action };
}

export function saveApiKey(root, name, value) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !value.trim() || /[\r\n\u0000]/.test(value)) throw new Error('Invalid API key input.');
  const file = path.join(root, '.env.local');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const lines = text.split(/\r?\n/);
  const indexes = lines.map((line, i) => line.startsWith(`${name}=`) ? i : -1).filter(i => i >= 0);
  if (indexes.length > 1) throw new Error(`Duplicate ${name} entries in .env.local. Fix them before rerunning setup.`);
  if (indexes.length) lines[indexes[0]] = `${name}=${value.trim()}`;
  else lines.push(`${name}=${value.trim()}`);
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
}
