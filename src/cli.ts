import path from 'node:path';
import { readFileSync } from 'node:fs';
import { ROOT, loadConfig, loadEnv, redact } from './config.js';
import { ensureDaemon, rpc, serveDaemon, stopDaemon } from './daemon.js';
import { opencodeExecutable } from './opencode.js';
import { runCommand } from './process.js';
import { serveMcp } from './mcp.js';
import { liveProbe } from './probe.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'probe': {
      if (args[0] !== '--provider' || !args[1] || args.some((x, i) => i > 1 && x !== '--live')) throw new Error('Usage: probe --provider kimi|deepseek --live');
      console.log(JSON.stringify(await liveProbe(ROOT, args[1], args.includes('--live')), null, 2)); break;
    }
    case 'daemon': await serveDaemon(ROOT); break;
    case 'start': { const info = await ensureDaemon(ROOT); console.log(JSON.stringify({ running: true, pid: info.pid, executionEnabled: (await rpc(info, 'workflow_config', {})).executionEnabled }, null, 2)); break; }
    case 'stop': console.log(JSON.stringify(await stopDaemon(ROOT))); break;
    case 'mcp': await serveMcp(ROOT); break;
    case 'connections': {
      const cli = path.join(ROOT, 'dist/src/cli.js');
      console.log('Claude Code .mcp.json (merge the server entry; keep existing servers):\n' + JSON.stringify({ mcpServers: { 'agent-orchestrator': { command: process.execPath, args: [cli, 'mcp'] } } }, null, 2));
      console.log('\nCodex config.toml (append only this table):\n[mcp_servers.agent-orchestrator]\ncommand = ' + JSON.stringify(process.execPath.replaceAll('\\', '/')) + '\nargs = [' + JSON.stringify(cli.replaceAll('\\', '/')) + ', "mcp"]');
      break;
    }
    case 'doctor': {
      const config = loadConfig(ROOT); const env = loadEnv(ROOT); const bin = opencodeExecutable(ROOT);
      const version = await runCommand(bin.command, [...bin.args, '--version'], ROOT, env, 20000);
      const git = await runCommand('git', ['--version'], ROOT, env, 10000);
      console.log(JSON.stringify({ node: process.version, opencode: version.output.trim(), opencodeExitCode: version.code, git: git.output.trim(), executionEnabled: config.executionEnabled,
        providers: Object.fromEntries(Object.entries(config.providers).map(([id, p]) => [id, { model: p.model, baseURL: p.baseURL, apiKeyPresent: Boolean(env[p.apiKeyEnv]) }])),
        note: 'Local checks only. No model request or repository mutation.' }, null, 2));
      if (version.code || git.code) process.exitCode = 1;
      break;
    }
    case 'call': {
      const [name, flag, file] = args;
      if (!name || flag !== '--file' || !file) throw new Error('Usage: node dist/src/cli.js call TOOL_NAME --file request.json');
      const input = JSON.parse(readFileSync(path.resolve(file), 'utf8'));
      console.log(JSON.stringify(await rpc(await ensureDaemon(ROOT), name, input), null, 2)); break;
    }
    default: console.log('Commands: doctor | connections | start | stop | mcp | probe --provider NAME --live | call TOOL_NAME --file request.json');
  }
}
main().catch(error => { console.error(redact(String(error), loadEnv(ROOT))); process.exitCode = 1; });
