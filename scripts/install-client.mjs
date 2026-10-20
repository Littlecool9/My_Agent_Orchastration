import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrationPlan, findTool, inspectIntegration, installIntegration } from './setup-lib.mjs';

export async function installClient(client) {
  try {
    if (process.argv.slice(2).some(arg => arg !== '--dry-run')) throw new Error('Only --dry-run is supported.');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const plan = integrationPlan(root, client);
    if (process.argv.includes('--dry-run')) {
      console.log(JSON.stringify({ client, scope: 'user', server: 'agent-orchestrator', skill: plan.skillDir, ...plan.mcp, note: 'Preview only; MCP conflicts are checked during installation.' }, null, 2));
      return;
    }
    const tool = findTool(client);
    console.log(JSON.stringify(installIntegration(inspectIntegration(plan, tool), tool), null, 2));
    console.log(`Open a new ${client} session and check MCP tools before invoking the skill.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
