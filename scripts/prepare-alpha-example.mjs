import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = path.join(root, 'integrations/local');
const target = path.join(local, 'alpha-244.json');
const task = JSON.parse(readFileSync(existsSync(target) ? target : path.join(root, 'examples/alpha-244.json'), 'utf8'));
for (const check of [...task.spec.checks, ...(task.spec.workerChecks ?? [])]) {
  const index = check.args.indexOf('-File');
  if (index >= 0) check.args[index + 1] = path.join(root, 'scripts/alpha-check.ps1').replaceAll('\\', '/');
}
mkdirSync(local, { recursive: true });
writeFileSync(target, JSON.stringify(task, null, 2) + '\n');
console.log('Prepared integrations/local/alpha-244.json. Review its project path and contract before use. No task was created.');
