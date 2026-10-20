import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, mkdtempSync, cpSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../src/config.js';

test('portable skill metadata and explicit-only client variants stay consistent', () => {
  const source = readFileSync(path.join(ROOT, 'skills/orchestrate-code/SKILL.md'), 'utf8');
  const front = /^---\n([\s\S]+?)\n---\n/.exec(source); assert.ok(front);
  assert.match(front[1]!, /^name: orchestrate-code$/m); assert.match(front[1]!, /^description: .+/m);
  assert.ok(!front[1]!.includes('disable-model-invocation'));
  const claude = readFileSync(path.join(ROOT, 'integrations/claude/skills/orchestrate-code/SKILL.md'), 'utf8');
  assert.equal(claude, source.replace('---\nname:', '---\ndisable-model-invocation: true\nname:'));
  const metadata = readFileSync(path.join(ROOT, 'skills/orchestrate-code/agents/openai.yaml'), 'utf8');
  assert.match(metadata, /allow_implicit_invocation: false/); assert.match(metadata, /\$orchestrate-code/);
  const short = /short_description: "([^"]+)"/.exec(metadata)![1]!; assert.ok(short.length >= 25 && short.length <= 64);
  const connection = JSON.parse(readFileSync(path.join(ROOT, 'integrations/claude.mcp.example.json'), 'utf8'));
  assert.equal(connection.mcpServers['agent-orchestrator'].command, 'node');
  assert.deepEqual(connection.mcpServers['agent-orchestrator'].args, ['C:/path/to/agent-orchestrator/dist/src/cli.js', 'mcp']);
});

test('integration preparation localizes a clean installation without rewriting the shared task example or local task settings', () => {
  const scratch = path.join(ROOT, 'work/workflow-tests'); mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, 'integrations-'));
  for (const dir of ['scripts', 'skills', 'examples']) mkdirSync(path.join(root, dir), { recursive: true });
  cpSync(path.join(ROOT, 'scripts/prepare-integrations.mjs'), path.join(root, 'scripts/prepare-integrations.mjs'));
  cpSync(path.join(ROOT, 'skills/orchestrate-code'), path.join(root, 'skills/orchestrate-code'), { recursive: true });
  const template = readFileSync(path.join(ROOT, 'examples/alpha-244.json'), 'utf8');
  writeFileSync(path.join(root, 'examples/alpha-244.json'), template);
  const prepare = () => execFileSync(process.execPath, [path.join(root, 'scripts/prepare-integrations.mjs')], { cwd: root, windowsHide: true });
  prepare();
  const local = path.join(root, 'integrations/local');
  const connection = JSON.parse(readFileSync(path.join(local, 'claude.mcp.json'), 'utf8'));
  assert.equal(connection.mcpServers['agent-orchestrator'].command, process.execPath);
  assert.deepEqual(connection.mcpServers['agent-orchestrator'].args, [path.join(root, 'dist/src/cli.js'), 'mcp']);
  assert.ok(readFileSync(path.join(local, 'codex.mcp.toml'), 'utf8').includes(path.join(root, 'dist/src/cli.js').replaceAll('\\', '/')));
  assert.equal(existsSync(path.join(root, 'integrations/claude.mcp.json')), false);
  const taskFile = path.join(local, 'alpha-244.json');
  const task = JSON.parse(readFileSync(taskFile, 'utf8'));
  for (const check of [...task.spec.checks, ...task.spec.workerChecks]) {
    assert.equal(check.args[check.args.indexOf('-File') + 1], path.join(root, 'scripts/alpha-check.ps1').replaceAll('\\', '/'));
  }
  task.spec.repository = 'C:/my-project/alpha';
  task.spec.goal = 'Retain a locally reviewed goal';
  writeFileSync(taskFile, JSON.stringify(task));
  prepare();
  const regenerated = JSON.parse(readFileSync(taskFile, 'utf8'));
  assert.equal(regenerated.spec.repository, task.spec.repository);
  assert.equal(regenerated.spec.goal, task.spec.goal);
  assert.equal(readFileSync(path.join(root, 'examples/alpha-244.json'), 'utf8'), template);
  assert.equal(readFileSync(path.join(root, 'integrations/claude/skills/orchestrate-code/SKILL.md'), 'utf8'),
    readFileSync(path.join(root, 'skills/orchestrate-code/SKILL.md'), 'utf8').replace('---\nname:', '---\ndisable-model-invocation: true\nname:'));
});
