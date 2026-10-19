import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const skillDir = path.join(claudeDir, 'skills', 'orchestrate-code');
const cli = path.join(root, 'dist/src/cli.js');
const source = path.join(root, 'integrations/claude/skills/orchestrate-code/SKILL.md');
if (!fs.existsSync(cli) || !fs.existsSync(source)) throw new Error('Run npm run build and node scripts/prepare-integrations.mjs first.');
if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ scope: 'user', server: 'agent-orchestrator', command: process.execPath, args: [cli, 'mcp'], skill: path.join(skillDir, 'SKILL.md'), entry: '/orchestrate-code' }, null, 2));
  process.exit(0);
}
const marker = path.join(skillDir, '.agent-orchestrator-install.json');
if (fs.existsSync(skillDir) && !fs.existsSync(marker)) throw new Error('A skill named orchestrate-code already exists. Inspect it before replacing anything.');
// Let Claude merge the user-scope MCP entry; never rewrite settings/authentication.
const result = spawnSync(process.platform === 'win32' ? 'claude.exe' : 'claude',
  ['mcp', 'add', '--scope', 'user', '--transport', 'stdio', 'agent-orchestrator', '--', process.execPath, cli, 'mcp'],
  { cwd: root, windowsHide: true, shell: false, encoding: 'utf8' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error('Could not register user MCP. Existing entries are not overwritten automatically. ' + result.stderr);
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), fs.readFileSync(source));
fs.writeFileSync(marker, JSON.stringify({ projectRoot: root, installedAt: new Date().toISOString() }, null, 2));
console.log('Installed user MCP and explicit /orchestrate-code skill. Open a NEW normal claude session from any project.');
