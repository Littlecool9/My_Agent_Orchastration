import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { findTool, runTool, integrationPlan, inspectIntegration, installIntegration, saveApiKey, assertBackendStopped } from './setup-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usage = `Usage: npm run setup -- [--client claude|codex|both|none] [--provider deepseek|kimi] [--non-interactive] [--dry-run]
Requires Windows, Node.js 22+, Git, and the selected supervisor CLI on PATH.
Installs backend dependencies, user skills and MCP. Does not install Node, create project profiles or run model requests.
--client none installs/checks the backend only. API keys are read from .env.local or the environment, never command-line arguments.
--dry-run prints the plan without installing dependencies, writing files or running client commands.`;

export function parseOptions(args) {
  const options = { client: undefined, provider: undefined, nonInteractive: false, dryRun: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--client' || arg === '--provider') {
      const value = args[++i];
      const allowed = arg === '--client' ? ['claude', 'codex', 'both', 'none'] : ['deepseek', 'kimi'];
      if (!allowed.includes(value)) throw new Error(`Invalid ${arg}. Expected ${allowed.join('|')}.`);
      options[arg.slice(2)] = value;
    } else if (arg === '--non-interactive') options.nonInteractive = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}. Run npm run setup -- --help.`);
  }
  return options;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) { console.log(usage); return; }
  if (process.platform !== 'win32') throw new Error('Worker execution currently requires Windows Job Objects. Run setup on Windows.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required. Setup does not install Node.');
  const interactive = !options.nonInteractive && process.stdin.isTTY && process.stdout.isTTY && !options.dryRun;
  let hidden = false;
  const output = new Writable({ write(chunk, encoding, callback) { if (!hidden) process.stdout.write(chunk, encoding); callback(); } });
  output.isTTY = process.stdout.isTTY;
  const rl = interactive ? createInterface({ input: process.stdin, output, terminal: true }) : null;
  rl?.on('SIGINT', () => { rl.close(); process.exit(130); });
  const choose = async (prompt, values, fallback) => {
    const answer = (await rl.question(`${prompt} [${values.join('/')}] (${fallback}): `)).trim().toLowerCase() || fallback;
    if (!values.includes(answer)) throw new Error(`Expected ${values.join('|')}. Rerun setup to try again.`);
    return answer;
  };
  try {
    options.client ??= interactive ? await choose('Supervisor client', ['claude', 'codex', 'both', 'none'], 'claude') : undefined;
    if (!options.client) throw new Error('Specify --client claude|codex|both|none when running without an interactive terminal.');
    options.provider ??= interactive ? await choose('Worker provider', ['deepseek', 'kimi'], 'deepseek') : 'deepseek';
    const clients = options.client === 'both' ? ['claude', 'codex'] : options.client === 'none' ? [] : [options.client];
    const plans = clients.map(client => integrationPlan(root, client));
    if (options.dryRun) {
      console.log(JSON.stringify({ root, provider: options.provider, steps: ['npm ci (including dev dependencies)', 'npm run build', 'prepare generic integrations', 'configure selected API key', 'check backend, Windows memory guard and MCP', 'install selected user integrations'],
        clients: plans.map(p => ({ client: p.client, skill: p.skillDir, mcp: p.mcp })), envFile: path.join(root, '.env.local'),
        note: 'No changes. MCP conflicts and API-key presence are checked during installation. Project examples and profiles are separate.' }, null, 2));
      return;
    }
    assertBackendStopped(root);
    const npm = findTool('npm'); const git = findTool('git');
    if (runTool(git, ['--version'], { cwd: root }).status !== 0) throw new Error('Git could not be started.');
    // Preflight every requested client before changing any client configuration.
    const tools = new Map(clients.map(client => [client, findTool(client)]));
    for (const [client, tool] of tools) {
      if (runTool(tool, ['--version'], { cwd: root }).status !== 0) throw new Error(`${client} could not be started.`);
    }
    const inspected = plans.map(plan => inspectIntegration(plan, tools.get(plan.client)));
    const command = (label, tool, args, timeout = 30000) => {
      console.log(`\n${label}`);
      if (runTool(tool, args, { cwd: root, inherit: true, timeout }).status !== 0) throw new Error(`${label} failed. Fix the error above and rerun setup.`);
    };
    command('Installing backend dependencies', npm, ['ci', '--include=dev'], 600000);
    command('Building backend', npm, ['run', 'build'], 120000);
    command('Preparing generic integrations', { command: process.execPath, args: [] }, [path.join(root, 'scripts/prepare-integrations.mjs')]);
    const { loadConfig, loadEnv } = await import(pathToFileURL(path.join(root, 'dist/src/config.js')).href);
    const config = loadConfig(root);
    const provider = config.providers[options.provider];
    if (!provider) throw new Error(`Provider '${options.provider}' is absent from the effective workflow configuration.`);
    const name = provider.apiKeyEnv;
    if (!loadEnv(root)[name]) {
      let key = process.env[name]?.trim();
      if (!key && interactive) {
        process.stdout.write(`${name} (hidden; saved to .env.local): `);
        hidden = true;
        try { key = await rl.question(''); } finally { hidden = false; console.log(); }
      }
      if (!key?.trim()) throw new Error(`Missing ${name}. Set it in .env.local or the environment, then rerun setup. No client settings were changed.`);
      saveApiKey(root, name, key);
    }
    if (!fs.existsSync(path.join(root, '.env.local'))) fs.copyFileSync(path.join(root, '.env.example'), path.join(root, '.env.local'));
    // Copying a template must not hide a key inherited from the calling terminal.
    if (!loadEnv(root)[name] && process.env[name]) saveApiKey(root, name, process.env[name]);
    command('Checking local backend (no model request)', { command: process.execPath, args: [] }, [path.join(root, 'dist/src/cli.js'), 'setup-check', '--provider', options.provider], 60000);
    for (const plan of inspected) {
      // Check again after dependency installation in case another process changed a client entry.
      const fresh = inspectIntegration(integrationPlan(root, plan.client), tools.get(plan.client));
      console.log(JSON.stringify(installIntegration(fresh, tools.get(plan.client)), null, 2));
    }
    console.log(`\nSetup complete. Backend checks passed; ${clients.length ? 'open a new ' + clients.join(' / ') + ' session and check MCP tools before invoking the skill.' : 'no client integration was requested.'}`);
    console.log(`Provider: ${options.provider}; model: ${provider.model}; executionEnabled: ${config.executionEnabled}. API connectivity has not been tested.`);
    if (options.provider !== 'deepseek') console.log('New tasks still default to deepseek. Explicitly request Kimi when using this key.');
    console.log('Project profiles and examples are configured separately. No task was dispatched.');
  } finally { rl?.close(); output.destroy(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Setup failed: ${error.message}`); process.exitCode = 1; });
}
