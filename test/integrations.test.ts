import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  const connection = JSON.parse(readFileSync(path.join(ROOT, 'integrations/claude.mcp.json'), 'utf8'));
  assert.deepEqual(connection.mcpServers['agent-orchestrator'].args, [path.join(ROOT, 'dist/src/cli.js'), 'mcp']);
});
