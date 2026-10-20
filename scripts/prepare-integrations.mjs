import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'skills/orchestrate-code/SKILL.md'), 'utf8');
const claude = source.replace('---\nname:', '---\ndisable-model-invocation: true\nname:');
const target = path.join(root, 'integrations/claude/skills/orchestrate-code');
mkdirSync(target, { recursive: true }); writeFileSync(path.join(target, 'SKILL.md'), claude);
const cli = path.join(root, 'dist/src/cli.js');
const alphaFile = path.join(root, 'examples/alpha-244.json');
if (existsSync(alphaFile)) {
  const task = JSON.parse(readFileSync(alphaFile, 'utf8'));
  for (const check of [...task.spec.checks, ...(task.spec.workerChecks ?? [])]) {
    const index = check.args.indexOf('-File');
    if (index >= 0) check.args[index + 1] = path.join(root, 'scripts/alpha-check.ps1').replaceAll('\\', '/');
  }
  writeFileSync(alphaFile, JSON.stringify(task, null, 2) + '\n');
}
writeFileSync(path.join(root, 'integrations/claude.mcp.json'), JSON.stringify({ mcpServers: { 'agent-orchestrator': { command: process.execPath, args: [cli, 'mcp'] } } }, null, 2) + '\n');
writeFileSync(path.join(root, 'integrations/codex.mcp.toml'), '[mcp_servers.agent-orchestrator]\ncommand = ' + JSON.stringify(process.execPath.replaceAll('\\', '/')) + '\nargs = [' + JSON.stringify(cli.replaceAll('\\', '/')) + ', "mcp"]\n');
console.log('Prepared local integration files only; no client configuration was installed.');
