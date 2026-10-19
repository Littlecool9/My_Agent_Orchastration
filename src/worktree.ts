import path from 'node:path';
import { mkdirSync, readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { git } from './process.js';
import type { Task, TaskSpec } from './schema.js';

export async function prepareWorktree(root: string, spec: TaskSpec): Promise<{ worktree: string; baseCommit: string }> {
  if (!path.isAbsolute(spec.repository)) throw new Error('Repository must be an absolute path');
  const repository = realpathSync(spec.repository);
  await git(repository, ['check-ref-format', '--branch', spec.branch]);
  if (spec.fetchRemote) await git(repository, ['fetch', spec.fetchRemote]);
  const baseCommit = await git(repository, ['rev-parse', '--verify', '--end-of-options', `${spec.baseRef}^{commit}`]);
  const parent = path.join(root, 'worktrees'); mkdirSync(parent, { recursive: true });
  const worktree = path.join(parent, spec.id);
  if (existsSync(worktree)) throw new Error('Worktree destination already exists; inspect it before reusing');
  await git(repository, ['worktree', 'add', '-b', spec.branch, worktree, baseCommit]);
  return { worktree, baseCommit };
}

export async function changedFiles(worktree: string, base: string): Promise<string[]> {
  const tracked = await git(worktree, ['diff', '--name-only', '-z', base, '--']);
  const others = await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...tracked.split('\0'), ...others.split('\0')].filter(Boolean))].sort();
}
export async function fingerprint(task: Task): Promise<string> {
  if (!task.worktree || !task.baseCommit) throw new Error('Task has no prepared worktree');
  const hash = createHash('sha256');
  hash.update(await git(task.worktree, ['rev-parse', 'HEAD']));
  for (const file of await changedFiles(task.worktree, task.baseCommit)) {
    hash.update('\0' + file + '\0'); const absolute = path.join(task.worktree, file);
    if (!existsSync(absolute)) { hash.update('DELETED'); continue; }
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Review unsupported file explicitly: ${file}`);
    hash.update(readFileSync(absolute));
  }
  return hash.digest('hex');
}
export async function assertWorktree(task: Task): Promise<void> {
  if (!task.worktree || !task.baseCommit) throw new Error('Prepare the task first');
  if (await git(task.worktree, ['branch', '--show-current']) !== task.spec.branch) throw new Error('Worktree branch changed unexpectedly');
  const result = await git(task.worktree, ['merge-base', task.baseCommit, 'HEAD']);
  if (result !== task.baseCommit) throw new Error('Task base is no longer an ancestor of HEAD');
}
export async function assertAllowedPaths(task: Task): Promise<void> {
  if (!task.spec.allowedPaths.length || !task.worktree || !task.baseCommit) return;
  const forbidden = (await changedFiles(task.worktree, task.baseCommit)).filter(file =>
    !task.spec.allowedPaths.some(prefix => file === prefix || file.startsWith(prefix.replace(/\/$/, '') + '/')));
  if (forbidden.length) throw new Error(`Changes outside the agreed scope: ${forbidden.join(', ')}`);
}
