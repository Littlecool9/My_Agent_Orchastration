import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ensureDaemon, rpc } from './daemon.js';
import { toolDefinitions } from './tools.js';

export async function serveMcp(root: string): Promise<void> {
  const server = new McpServer({ name: 'agent-orchestrator', version: '0.2.0' });
  for (const tool of toolDefinitions) server.registerTool(tool.name, {
    description: tool.description, inputSchema: tool.schema,
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: !tool.readOnly },
  }, async (args: unknown) => {
    try {
      const result = await rpc(await ensureDaemon(root), tool.name, args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: String(error) }] }; }
  });
  await server.connect(new StdioServerTransport());
}
