import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from '../src/config.js';
import { readInfo, rpc, stopDaemon } from '../src/daemon.js';

test('isolated MCP handshake, authentication, reconnect and stale-config recovery without reconnecting the client', { timeout: 60000 }, async () => {
  const scratch = path.join(ROOT, 'work/workflow-tests'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, 'mcp-'));
  cpSync(path.join(ROOT, 'dist/src'), path.join(root, 'dist/src'), { recursive: true });
  // A separate installation prevents this test from stopping the user's daemon or reading their local config.
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const config = { executionEnabled: false, maxParallel: 1, maxAttempts: 1, taskTimeoutMinutes: 1,
    providers: { fixture: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', contextLimit: 32768, outputLimit: 4096 } } };
  writeFileSync(path.join(root, 'workflow.config.json'), JSON.stringify(config));
  const client = new Client({ name: 'offline-workflow-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/src/cli.js'), 'mcp'], stderr: 'pipe' });
  try {
    await client.connect(transport);
    const listed = await client.listTools(); assert.equal(listed.tools.length, 12);
    assert.ok(listed.tools.some(t => t.name === 'workflow_dispatch'));
    const response = await client.callTool({ name: 'workflow_config', arguments: {} });
    assert.equal(response.isError, undefined);
    const content = response.content as { type: string; text: string }[];
    assert.equal(JSON.parse(content[0]!.text).executionEnabled, false);
    writeFileSync(path.join(root, 'workflow.config.json'), JSON.stringify({ ...config, executionEnabled: true }));
    const stale = await client.callTool({ name: 'workflow_config', arguments: {} });
    const staleConfig = JSON.parse((stale.content as { text: string }[])[0]!.text);
    assert.equal(staleConfig.executionEnabled, false); assert.equal(staleConfig.diskExecutionEnabled, true);
    assert.equal(staleConfig.restartRequired, true); assert.equal(staleConfig.configFile, path.join(root, 'workflow.config.json'));
    const blocked = await client.callTool({ name: 'workflow_prepare', arguments: { id: 'does-not-exist' } });
    assert.equal(blocked.isError, true);
    assert.match((blocked.content as { text: string }[])[0]!.text, /already enables execution.*Restart the daemon/);
    const info = readInfo(root)!; assert.ok(info);
    const unauthenticated = await fetch(`http://127.0.0.1:${info.port}/rpc`, { method: 'POST', body: '{}' });
    assert.equal(unauthenticated.status, 401);
    await client.close();
    assert.equal((await rpc(info, 'workflow_config', {})).executionEnabled, false);
    const another = new Client({ name: 'reconnect-test', version: '1' });
    try {
      await another.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/src/cli.js'), 'mcp'], stderr: 'pipe' }));
      await another.callTool({ name: 'workflow_status', arguments: {} });
      assert.equal(readInfo(root)!.pid, info.pid);
      await stopDaemon(root);
      const refreshed = await another.callTool({ name: 'workflow_config', arguments: {} });
      const loaded = JSON.parse((refreshed.content as { text: string }[])[0]!.text);
      assert.equal(loaded.executionEnabled, true); assert.equal(loaded.diskExecutionEnabled, true);
      assert.equal(loaded.restartRequired, false);
      assert.notEqual(readInfo(root)!.pid, info.pid);
    } finally { await another.close(); }
  } finally { await client.close(); await stopDaemon(root); }
});
