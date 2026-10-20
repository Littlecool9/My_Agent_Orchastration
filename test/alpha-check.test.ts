import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/config.js';
import { runCommand } from '../src/process.js';

test('alpha helper selects targeted build/tests only for workers and full checks only for supervisors', async () => {
  const parent = path.join(ROOT, 'work/workflow-tests'); mkdirSync(parent, { recursive: true });
  const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  for (const mode of ['incremental', 'full', 'incomplete'] as const) {
    const root = mkdtempSync(path.join(parent, 'alpha-script-')); const log = path.join(root, 'calls.jsonl');
    writeFileSync(path.join(root, 'CMakePresets.json'), '{}');
    const script = path.join(root, 'driver.ps1');
    const extra = mode === 'full' ? '' : mode === 'incremental' ? " -Target engine_prefab_tests -TestRegex prefab" : ' -Target engine_prefab_tests';
    writeFileSync(script, `
$ErrorActionPreference = 'Stop'
function cl.exe {}
function cmake { [IO.File]::AppendAllText(${quote(log)}, (ConvertTo-Json -InputObject @('cmake', $args) -Compress) + [Environment]::NewLine); $global:LASTEXITCODE = 0 }
function ctest { [IO.File]::AppendAllText(${quote(log)}, (ConvertTo-Json -InputObject @('ctest', $args) -Compress) + [Environment]::NewLine); $global:LASTEXITCODE = 0 }
$env:VCPKG_ROOT = 'fixture'
$env:VULKAN_SDK = 'fixture'
Set-Location -LiteralPath ${quote(root)}
& ${quote(path.join(ROOT, 'scripts/alpha-check.ps1'))} -Preset windows-msvc-debug${extra}
exit $LASTEXITCODE
`);
    const result = await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], root, process.env, 30000);
    if (mode === 'incomplete') {
      assert.notEqual(result.code, 0); assert.match(result.output, /both Target and TestRegex/);
      assert.equal(existsSync(log), false); continue;
    }
    assert.equal(result.code, 0, result.output);
    const calls = readFileSync(log, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line).flat() as string[]);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], ['cmake', '--preset', 'windows-msvc-debug']);
    assert.equal(calls[1]!.includes('--target'), mode === 'incremental');
    assert.equal(calls[2]!.includes('-R'), mode === 'incremental');
    if (mode === 'incremental') {
      assert.ok(calls[1]!.includes('engine_prefab_tests')); assert.ok(calls[2]!.includes('prefab'));
    }
    assert.ok(calls[2]!.includes('--no-tests=error'));
  }
});
