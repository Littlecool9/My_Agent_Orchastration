import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { git } from './process.js';
import { RepositoryPreferencesSchema, RepositoryProfileSchema, TaskSpecSchema, DEFAULT_PROVIDER,
  type Config, type RepositoryConfiguration, type RepositoryIdentity, type RepositoryPreferences, type ResourceSettings,
  type Task, type TaskPlanPatch, type TaskSpec } from './schema.js';

type ProfileSnapshot = RepositoryConfiguration['profile'];
const identityFields = ['id', 'contractVersion', 'repository', 'baseRef', 'fetchRemote', 'branch', 'provider', 'mode', 'workspaceMode', 'dependencies'] as const;
function key(directory: string): string {
  const absolute = path.resolve(directory); return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
export async function repositoryIdentity(directory: string): Promise<RepositoryIdentity> {
  if (!path.isAbsolute(directory)) throw new Error('Repository must be an absolute path');
  const actual = realpathSync(directory);
  const [common, root] = await Promise.all([
    git(actual, ['rev-parse', '--path-format=absolute', '--git-common-dir']), git(actual, ['rev-parse', '--show-toplevel']),
  ]);
  return { commonGitDir: key(realpathSync(common)), root: realpathSync(root) };
}
export function resourceLimits(config: Config, preferences?: RepositoryPreferences): Required<ResourceSettings> {
  return { workerMemoryLimitMB: Math.min(config.workerMemoryLimitMB, preferences?.limits.workerMemoryLimitMB ?? Infinity),
    taskTimeoutMinutes: Math.min(config.taskTimeoutMinutes, preferences?.limits.taskTimeoutMinutes ?? Infinity) };
}
export function assertResourceLimits(resources: ResourceSettings | undefined, limits: Required<ResourceSettings>): void {
  for (const name of ['workerMemoryLimitMB', 'taskTimeoutMinutes'] as const)
    if (resources?.[name] !== undefined && resources[name]! > limits[name]) throw new Error(`${name} exceeds the effective hard limit ${limits[name]}`);
}

export class RepositoryProfiles {
  readonly directory: string;
  constructor(root: string) { this.directory = path.join(root, 'skills/orchestrate-code/repositories.local'); }
  private entries(): NonNullable<ProfileSnapshot>[] {
    if (!existsSync(this.directory)) return [];
    return readdirSync(this.directory, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d => {
      const file = path.join(this.directory, d.name, 'profile.json'); if (!existsSync(file)) return [];
      let value;
      try { value = RepositoryProfileSchema.parse(JSON.parse(readFileSync(file, 'utf8'))); }
      catch (error) { throw new Error(`Invalid repository profile ${file}: ${error}`); }
      if (value.id !== d.name) throw new Error(`Profile id must match its directory: ${file}`);
      return [{ file, value, hash: createHash('sha256').update(JSON.stringify(value)).digest('hex') }];
    });
  }
  find(identity: RepositoryIdentity): ProfileSnapshot {
    const matches = this.entries().filter(p => key(p.value.repository.commonGitDir) === key(identity.commonGitDir));
    if (matches.length > 1) throw new Error('Multiple profiles are bound to this repository; keep one explicit binding');
    return matches[0];
  }
  async read(repository: string, config: Config): Promise<unknown> {
    const identity = await repositoryIdentity(repository); const profile = this.find(identity);
    return { identity, profile: profile ?? null, effectiveLimits: resourceLimits(config, profile?.value.preferences),
      precedence: ['builtin', 'repository_default', 'task'], requirementsAlwaysApply: true };
  }
  async update(repository: string, id: string, expectedRevision: number, input: RepositoryPreferences, config: Config, rebind = false): Promise<unknown> {
    TaskSpecSchema.shape.id.parse(id);
    const preferences = RepositoryPreferencesSchema.parse(input); const identity = await repositoryIdentity(repository);
    const entries = this.entries(); const bindings = entries.filter(p => key(p.value.repository.commonGitDir) === key(identity.commonGitDir));
    if (bindings.length > 1) throw new Error('Multiple profiles are bound to this repository; keep one explicit binding');
    const bound = bindings[0];
    const existing = entries.find(p => p.value.id === id);
    if (bound && bound.value.id !== id) throw new Error(`Repository is already bound to profile ${bound.value.id}`);
    if ((existing?.value.revision ?? 0) !== expectedRevision) throw new Error('Stale profile update; reread its revision');
    if (existing && key(existing.value.repository.commonGitDir) !== key(identity.commonGitDir) && !rebind)
      throw new Error('Profile id belongs to another repository; use an explicit rebind for a move/import');
    assertResourceLimits(preferences.defaults.resources, resourceLimits(config, preferences));
    if (preferences.requirements.verificationPolicy && preferences.defaults.verificationPolicy === 'review_allowed')
      throw new Error('Default verification policy conflicts with the repository requirement');
    const value = RepositoryProfileSchema.parse({ schemaVersion: 1, id, revision: expectedRevision + 1, repository: identity, preferences });
    const dir = path.join(this.directory, id); mkdirSync(dir, { recursive: true }); mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    const file = path.join(dir, 'profile.json'); const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(value, null, 2) + '\n'); renameSync(temp, file);
    return this.read(repository, config);
  }
}

function resolveCheckPath(value: string, profile: ProfileSnapshot): string {
  if (!value.startsWith('profile://')) return value;
  if (!profile) throw new Error('profile:// references require a bound repository profile');
  const base = realpathSync(path.dirname(profile.file)); const relative = value.slice('profile://'.length);
  const resolved = path.resolve(base, relative);
  if (!relative || !key(resolved).startsWith(key(base) + path.sep)) throw new Error('Profile script reference escapes its repository directory');
  if (!existsSync(resolved)) throw new Error(`Missing profile script reference: ${resolved}`);
  const real = realpathSync(resolved);
  if (!key(real).startsWith(key(base) + path.sep)) throw new Error('Profile script reference resolves outside its repository directory');
  if (!statSync(real).isFile()) throw new Error('Profile script reference must be a file');
  return real;
}

export function resolveTaskInput(input: TaskPlanPatch, identity: RepositoryIdentity, profile: ProfileSnapshot, config: Config, previous?: Task): { spec: TaskSpec; configuration: RepositoryConfiguration } {
  const defaults = profile?.value.preferences.defaults ?? {};
  const { branchPrefix = 'codex/', ...taskDefaults } = defaults;
  const prior = previous?.configuration?.overrides ?? previous?.spec ?? {};
  const overrides = { ...prior, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) } as TaskPlanPatch;
  if (prior.resources || input.resources) overrides.resources = { ...prior.resources, ...input.resources };
  const mode = overrides.mode ?? defaults.mode ?? 'implement';
  const builtin = { contractVersion: 1, planRevision: 1, title: overrides.goal?.slice(0, 120), baseRef: 'HEAD', branch: `${branchPrefix}${overrides.id}`,
    provider: DEFAULT_PROVIDER, mode, workspaceMode: 'worktree', nonGoals: [], decisions: [], contextRefs: [],
    steps: [{ id: 'S1', instruction: mode === 'investigate' ? 'Investigate the goal and provide criterion-linked evidence without modifying files.' : 'Implement the goal within the agreed scope and provide criterion-linked evidence.', dependsOn: [], flexibility: 'adaptable' }],
    autonomy: { localDecisions: ['Local implementation and debugging within the agreed scope'], escalateWhen: ['A repository rule or acceptance criterion conflicts with the plan, or a scope/public-interface change is required'] },
    acceptance: [], constraints: [], allowedPaths: [], dependencies: [], checks: [], workerChecks: [], verificationPolicy: 'commands_required' };
  const frozenIdentity = previous ? Object.fromEntries(identityFields.map(name => [name, previous.spec[name]])) : {};
  const values = { ...builtin, ...taskDefaults, ...frozenIdentity, ...overrides };
  const sources: RepositoryConfiguration['sources'] = Object.fromEntries(Object.keys(builtin).map(name => [name, 'builtin']));
  for (const name of Object.keys(taskDefaults)) sources[name] = 'repository_default';
  for (const name of Object.keys(overrides)) sources[name] = 'task';
  if (previous) for (const name of identityFields) if (!(name in input)) sources[name] = profile?.hash !== previous.configuration?.profile?.hash ? 'previous_plan' : previous.configuration?.sources[name] ?? 'task';
  if (!previous && defaults.branchPrefix && !overrides.branch) sources.branch = 'repository_default';
  const preferences = profile?.value.preferences; const limits = resourceLimits(config, preferences);
  values.resources = { ...limits, ...defaults.resources, ...overrides.resources };
  for (const name of ['workerMemoryLimitMB', 'taskTimeoutMinutes'] as const) {
    sources[`limits.${name}`] = preferences?.limits[name] !== undefined && preferences.limits[name]! <= config[name] ? 'repository_requirement' : 'builtin';
    sources[`resources.${name}`] = overrides.resources?.[name] !== undefined ? 'task' : defaults.resources?.[name] !== undefined ? 'repository_default' : sources[`limits.${name}`]!;
  }
  assertResourceLimits(values.resources, limits);
  const required = preferences?.requirements;
  if (required?.verificationPolicy) {
    if (overrides.verificationPolicy && overrides.verificationPolicy !== required.verificationPolicy) throw new Error('Task verification policy conflicts with the repository requirement');
    values.verificationPolicy = required.verificationPolicy; sources.verificationPolicy = 'repository_requirement';
  }
  values.constraints = [...new Set([...values.constraints, ...(required?.constraints ?? [])])];
  for (let i = 0; i < values.constraints.length; i++) sources[`constraints.${i}`] = required?.constraints.includes(values.constraints[i]!) ? 'repository_requirement' : sources.constraints ?? 'builtin';
  for (const name of ['checks', 'workerChecks'] as const) values[name] = values[name].map(check => ({ ...check,
    command: resolveCheckPath(check.command, profile), args: check.args.map(arg => resolveCheckPath(arg, profile)) }));
  const spec = TaskSpecSchema.parse(values);
  return { spec, configuration: { identity, profile, sources, limits, overrides, previousPlanRevision: previous?.spec.planRevision, resolvedAt: new Date().toISOString() } };
}
