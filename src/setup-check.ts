import path from 'node:path';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig, loadEnv, redact } from './config.js';
import { memoryGuardLaunch, readMemoryReport } from './memory-guard.js';
import { opencodeExecutable } from './opencode.js';
import { runCommand } from './process.js';

export async function checkSetup(root: string, provider: string): Promise<unknown> {
  if (process.platform !== 'win32') throw new Error('Setup checks require Windows Job Objects.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ is required.');
  const config = loadConfig(root); const env = loadEnv(root); const selected = config.providers[provider];
  if (!selected) throw new Error('Provider is not configured: ' + provider);
  if (!env[selected.apiKeyEnv]?.trim()) throw new Error('Missing ' + selected.apiKeyEnv);
  const git = await runCommand('git', ['--version'], root, env, 10000);
  if (git.code !== 0) throw new Error('Git version check failed.');
  const parent = path.join(root, 'work/setup-checks'); mkdirSync(parent, { recursive: true });
  const scratch = mkdtempSync(path.join(parent, 'check-')); const report = path.join(scratch, 'memory.json');
  const bin = opencodeExecutable(root);
  const launch = memoryGuardLaunch(root, path.join(scratch, 'request.json'), report, config.workerMemoryLimitMB, bin.command, [...bin.args, '--version']);
  const version = await runCommand(launch.command, launch.args, root, env, 30000);
  if (version.code !== 0 || readMemoryReport(report)?.status !== 'exited') throw new Error('OpenCode / Windows memory guard check failed: ' + version.output);
  const client = new Client({ name: 'orchestrator-setup-check', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/src/cli.js'), 'mcp'], cwd: root, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-3000); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const tools = await Promise.race([
      (async () => { await client.connect(transport); return client.listTools(); })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('MCP setup handshake timed out.')), 15000); }),
    ]);
    for (const name of ['workflow_config', 'workflow_task_create', 'workflow_dispatch']) {
      if (!tools.tools.some(tool => tool.name === name)) throw new Error('MCP tool missing: ' + name);
    }
    return { passed: true, provider, model: selected.model, apiKeyPresent: true, executionEnabled: config.executionEnabled,
      node: process.version, git: git.stdout.trim(), opencode: version.stdout.trim(), memoryGuard: 'passed', mcpTools: tools.tools.length,
      note: 'Local checks only. No model request, daemon startup, task creation or project profile initialization. Client/account loading still requires a new client session.' };
  } catch (error) { throw new Error('MCP setup check failed: ' + String(error) + (stderr ? '\n' + redact(stderr, env) : '')); }
  finally { clearTimeout(timer); await client.close(); await transport.close(); }
}
