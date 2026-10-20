import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, configStatus, executionGuard } from '../src/config.js';
import { ConfigSchema } from '../src/schema.js';

const scratch = path.join(ROOT, 'work/workflow-tests'); mkdirSync(scratch, { recursive: true });
const base = ConfigSchema.parse({ executionEnabled: false, maxParallel: 2, maxAttempts: 3, taskTimeoutMinutes: 90,
  providers: { fixture: { baseURL: 'http://127.0.0.1:1/v1', model: 'fixture', apiKeyEnv: 'FIXTURE_KEY', contextLimit: 32768, outputLimit: 4096 } } });
function fixture() {
  const root = mkdtempSync(path.join(scratch, 'config-'));
  writeFileSync(path.join(root, 'workflow.config.json'), JSON.stringify(base));
  return root;
}

test('recovery budget defaults to five and the bundled config uses five', () => {
  assert.equal(ConfigSchema.parse({ ...base, maxAttempts: undefined }).maxAttempts, 5);
  assert.equal(loadConfig(ROOT).maxAttempts, 5);
});

test('worker process-tree memory budget defaults to 3 GiB and rejects invalid limits', () => {
  assert.equal(base.workerMemoryLimitMB, 3072);
  assert.equal(loadConfig(ROOT).workerMemoryLimitMB, 3072);
  assert.throws(() => ConfigSchema.parse({ ...base, workerMemoryLimitMB: 0 }));
});
test('base config works without a local override; disk changes do not silently reload an active gate', () => {
  const root = fixture(); const active = loadConfig(root);
  assert.equal(configStatus(root, active).restartRequired, false);
  writeFileSync(path.join(root, 'workflow.config.json'), JSON.stringify({ ...base, executionEnabled: true }));
  const status = configStatus(root, active);
  assert.equal(status.configFile, path.join(root, 'workflow.config.json'));
  assert.equal(status.diskExecutionEnabled, true); assert.equal(status.restartRequired, true);
  assert.equal(active.executionEnabled, false);
  assert.throws(() => executionGuard(active, root), /already enables execution.*Restart the daemon/);
  assert.equal(configStatus(root, loadConfig(root)).restartRequired, false);
});
test('a full local config takes precedence and partial local config is rejected without hiding diagnostics', () => {
  const root = fixture();
  writeFileSync(path.join(root, 'workflow.local.json'), JSON.stringify({ ...base, executionEnabled: true }));
  assert.equal(loadConfig(root).executionEnabled, true);
  assert.equal(configStatus(root, base).configFile, path.join(root, 'workflow.local.json'));
  writeFileSync(path.join(root, 'workflow.local.json'), JSON.stringify({ executionEnabled: true }));
  assert.throws(() => loadConfig(root));
  const status = configStatus(root, base);
  assert.equal(status.restartRequired, null); assert.equal(status.diskExecutionEnabled, null); assert.ok(status.configError);
  assert.throws(() => executionGuard(base, root), /invalid or unreadable/);
});
test('restart diagnostics include provider changes and removal of a local override', () => {
  const root = fixture();
  const local = { ...base, providers: { fixture: { ...base.providers.fixture!, model: 'other-fixture' } } };
  writeFileSync(path.join(root, 'workflow.local.json'), JSON.stringify(local));
  assert.equal(configStatus(root, base).restartRequired, true);
  const active = loadConfig(root);
  assert.equal(configStatus(root, active).restartRequired, false);
  unlinkSync(path.join(root, 'workflow.local.json'));
  assert.equal(configStatus(root, active).configFile, path.join(root, 'workflow.config.json'));
  assert.equal(configStatus(root, active).restartRequired, true);
});
