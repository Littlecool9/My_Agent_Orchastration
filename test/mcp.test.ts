import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ROOT } from '../src/config.js';
import { readInfo, rpc, stopDaemon } from '../src/daemon.js';
import { runCommand } from '../src/process.js';

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
    const listed = await client.listTools(); assert.equal(listed.tools.length, 17);
    assert.ok(listed.tools.some(t => t.name === 'workflow_dispatch'));
    assert.ok(listed.tools.some(t => t.name === 'workflow_verify_stop'));
    assert.ok(listed.tools.some(t => t.name === 'workflow_evidence_add'));
    assert.ok(listed.tools.some(t => t.name === 'workflow_repository_init'));
    const response = await client.callTool({ name: 'workflow_config', arguments: {} });
    assert.equal(response.isError, undefined);
    const content = response.content as { type: string; text: string }[];
    const initialConfig = JSON.parse(content[0]!.text);
    assert.equal(initialConfig.executionEnabled, false);
    assert.equal(initialConfig.guidance.repositoryInstructions, path.join(root, 'AGENTS.md'));
    const repository = path.join(root, 'repository'); mkdirSync(repository);
    const initialized = await runCommand('git', ['init', '-b', 'master'], repository); assert.equal(initialized.code, 0, initialized.output);
    const initialResponse = await client.callTool({ name: 'workflow_repository_init', arguments: { repository } });
    assert.equal(initialResponse.isError, undefined);
    const initial = JSON.parse((initialResponse.content as { text: string }[])[0]!.text);
    assert.equal(initial.created, true);
    const configured = await client.callTool({ name: 'workflow_repository_config_update', arguments: { repository, id: initial.profile.value.id, expectedRevision: 1,
      preferences: { defaults: { provider: 'fixture', verificationPolicy: 'review_allowed' } } } });
    assert.equal(configured.isError, undefined);
    const preferences = await client.callTool({ name: 'workflow_repository_config', arguments: { repository } });
    assert.equal(JSON.parse((preferences.content as { text: string }[])[0]!.text).profile.value.id, initial.profile.value.id);
    const firstUseRepository = path.join(root, 'first-use'); mkdirSync(firstUseRepository);
    assert.equal((await runCommand('git', ['init', '-b', 'master'], firstUseRepository)).code, 0);
    const firstTask = await client.callTool({ name: 'workflow_task_create', arguments: { spec: { id: 'first-use', repository: firstUseRepository,
      provider: 'fixture', mode: 'investigate', goal: 'Create without an explicit init call', acceptance: [{ id: 'AC-01', requirement: 'No execution' }] } } });
    assert.equal(firstTask.isError, undefined);
    const automatic = await client.callTool({ name: 'workflow_repository_config', arguments: { repository: firstUseRepository } });
    assert.deepEqual(JSON.parse((automatic.content as { text: string }[])[0]!.text).profile.value.preferences.defaults, {});
    const spec = { id: 'wait-fixture', repository, mode: 'investigate', goal: 'Offline CLI wait', acceptance: [{ id: 'AC-01', requirement: 'No execution' }] };
    await client.callTool({ name: 'workflow_task_create', arguments: { spec } });
    const cli = path.join(root, 'dist/src/cli.js');
    const timed = await runCommand(process.execPath, [cli, 'wait', 'wait-fixture', '--timeout-ms', '150', '--json'], root, process.env, 10000);
    assert.equal(timed.code, 2, timed.output); assert.equal(JSON.parse(timed.stdout).reason, 'timeout');
    const waiting = runCommand(process.execPath, [cli, 'wait', 'wait-fixture', '--until', 'change', '--after', 'wait-fixture=1', '--timeout-ms', '5000'], root, process.env, 10000);
    await client.callTool({ name: 'workflow_plan_update', arguments: { id: 'wait-fixture', expectedPlanRevision: 1,
      spec: { goal: 'Updated while waiting' }, changeReason: 'Exercise revision notification' } });
    const changed = await waiting; assert.equal(changed.code, 0, changed.output);
    assert.equal(JSON.parse(changed.stdout).reason, 'changed'); assert.equal(JSON.parse(changed.stdout).tasks[0].planRevision, 2);
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
