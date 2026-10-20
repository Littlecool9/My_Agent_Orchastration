import path from 'node:path';
import { mkdirSync, readFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { git } from './process.js';
import type { Task, TaskSpec } from './schema.js';

export function workspaceMode(spec: TaskSpec): 'worktree' | 'branch' | 'current' {
  return spec.workspaceMode ?? 'worktree';
}
export function workspaceKey(directory: string): string {
  const resolved = realpathSync(directory);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
export async function prepareWorkspace(root: string, spec: TaskSpec): Promise<{ worktree: string; baseCommit: string; workspaceWarnings: string[] }> {
  if (!path.isAbsolute(spec.repository)) throw new Error('Repository must be an absolute path');
  const repository = realpathSync(spec.repository);
  await git(repository, ['check-ref-format', '--branch', spec.branch]);
  const mode = workspaceMode(spec);
  const warnings: string[] = [];
  if (mode !== 'worktree') {
    if (workspaceKey(await git(repository, ['rev-parse', '--show-toplevel'])) !== workspaceKey(repository)) throw new Error('In-place workspace must be the repository root');
    if (await git(repository, ['status', '--porcelain'])) throw new Error('In-place workspace has existing changes; preserve them or choose a worktree. No automatic stash or reset is performed.');
    if (mode === 'current') {
      if (await git(repository, ['branch', '--show-current']) !== spec.branch) throw new Error('Current branch does not match the task branch');
      const primary = new Set(['main', 'master', 'trunk']);
      try { primary.add((await git(repository, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).replace(/^refs\/remotes\/origin\//, '')); } catch { /* no locally recorded default branch */ }
      if (primary.has(spec.branch)) {
        if (!spec.mainBranchWarning) throw new Error('Main-branch warning required: supervisor must warn the user before preparation and record the warning in mainBranchWarning. No extra approval is required.');
        warnings.push(spec.mainBranchWarning);
      }
    }
  }
  if (spec.fetchRemote) await git(repository, ['fetch', spec.fetchRemote]);
  const baseCommit = await git(repository, ['rev-parse', '--verify', '--end-of-options', `${spec.baseRef}^{commit}`]);
  if (mode === 'branch') {
    await git(repository, ['switch', '-c', spec.branch, baseCommit]);
    return { worktree: repository, baseCommit, workspaceWarnings: warnings };
  }
  if (mode === 'current') {
    if (await git(repository, ['merge-base', baseCommit, 'HEAD']) !== baseCommit) throw new Error('Current branch does not contain the requested base. Update it explicitly or choose a new branch/worktree; preparation never resets it.');
    return { worktree: repository, baseCommit: await git(repository, ['rev-parse', 'HEAD']), workspaceWarnings: warnings };
  }
  const parent = path.join(root, 'worktrees'); mkdirSync(parent, { recursive: true });
  const worktree = path.join(parent, spec.id);
  if (existsSync(worktree)) throw new Error('Worktree destination already exists; inspect it before reusing');
  await git(repository, ['worktree', 'add', '-b', spec.branch, worktree, baseCommit]);
  return { worktree, baseCommit, workspaceWarnings: warnings };
}

export const prepareWorktree = prepareWorkspace;

export async function changedFiles(worktree: string, base: string): Promise<string[]> {
  const tracked = await git(worktree, ['diff', '--name-only', '-z', base, '--']);
  const others = await git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...tracked.split('\0'), ...others.split('\0')].filter(Boolean))].sort();
}
export async function fingerprint(task: Task): Promise<string> {
  if (!task.worktree || !task.baseCommit) throw new Error('Task has no prepared workspace');
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
  if (await git(task.worktree, ['branch', '--show-current']) !== task.spec.branch) throw new Error('Workspace branch changed unexpectedly');
  const result = await git(task.worktree, ['merge-base', task.baseCommit, 'HEAD']);
  if (result !== task.baseCommit) throw new Error('Task base is no longer an ancestor of HEAD');
}
export async function assertAllowedPaths(task: Task): Promise<void> {
  if (!task.spec.allowedPaths.length || !task.worktree || !task.baseCommit) return;
  const forbidden = (await changedFiles(task.worktree, task.baseCommit)).filter(file =>
    !task.spec.allowedPaths.some(prefix => file === prefix || file.startsWith(prefix.replace(/\/$/, '') + '/')));
  if (forbidden.length) throw new Error(`Changes outside the agreed scope: ${forbidden.join(', ')}`);
}
