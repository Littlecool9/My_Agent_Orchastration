import { z } from 'zod';

export const DEFAULT_PROVIDER = 'deepseek';

export const ProviderSchema = z.object({
  baseURL: z.url(), model: z.string().min(1), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  contextLimit: z.number().int().positive(), outputLimit: z.number().int().positive(),
  options: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const ConfigSchema = z.object({
  executionEnabled: z.boolean(), maxParallel: z.number().int().min(1).max(8),
  maxAttempts: z.number().int().min(1).max(10).default(5), taskTimeoutMinutes: z.number().min(1).max(1440),
  workerMemoryLimitMB: z.number().int().min(128).max(1048576).default(3072),
  providers: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), ProviderSchema),
}).strict();
export type Config = z.infer<typeof ConfigSchema>;

export const CheckSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  command: z.string().min(1), args: z.array(z.string()).default([]),
  timeoutMinutes: z.number().min(0.01).max(180).default(30),
}).strict();

export const VerificationSelectionSchema = z.object({
  strategy: z.enum(['planned', 'targeted', 'affected', 'smoke', 'full', 'custom']),
  rationale: z.string().min(1), checks: z.array(CheckSchema),
  omittedCoverage: z.array(z.string().min(1)).default([]),
}).strict().superRefine((selection, ctx) => {
  const names = selection.checks.map(c => c.name);
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Duplicate verification check names' });
});
export type VerificationSelection = z.infer<typeof VerificationSelectionSchema>;

const Identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const SupervisorEvidenceSchema = z.object({
  planRevision: z.number().int().positive(), kind: z.enum(['integration', 'verification', 'note']).default('note'),
  summary: z.string().trim().min(1).max(6000), criterionIds: z.array(Identifier).min(1),
  evidence: z.array(z.string().trim().min(1)).min(1), log: z.string().max(200000).optional(),
}).strict();
export type SupervisorEvidenceInput = z.infer<typeof SupervisorEvidenceSchema>;
export const FindingSchema = z.object({
  criterionIds: z.array(Identifier).min(1), description: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1), requestedChange: z.string().min(1),
}).strict();
export const FeedbackSchema = z.object({
  planRevision: z.number().int().positive(), summary: z.string().min(1),
  findings: z.array(FindingSchema).min(1),
}).strict();
export type Feedback = z.infer<typeof FeedbackSchema>;
export const ResourceSettingsSchema = z.object({
  workerMemoryLimitMB: z.number().int().min(128).max(1048576).optional(),
  taskTimeoutMinutes: z.number().min(1).max(1440).optional(),
}).strict();
export type ResourceSettings = z.infer<typeof ResourceSettingsSchema>;
export const ReviewVerificationSchema = z.object({
  mode: z.literal('review_only'), omittedCoverage: z.array(z.string().trim().min(1)).min(1),
}).strict();
export type ReviewVerification = z.infer<typeof ReviewVerificationSchema>;

export const TaskSpecSchema = z.object({
  contractVersion: z.literal(1), planRevision: z.number().int().positive(),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), title: z.string().min(1),
  repository: z.string().min(1), baseRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/),
  fetchRemote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/).optional(),
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/), provider: z.string().min(1).default(DEFAULT_PROVIDER),
  workspaceMode: z.enum(['worktree', 'branch', 'current']).default('worktree'),
  mainBranchWarning: z.string().min(1).optional(),
  mode: z.enum(['investigate', 'implement']).default('implement'),
  goal: z.string().min(1), nonGoals: z.array(z.string().min(1)),
  decisions: z.array(z.object({ id: Identifier, decision: z.string().min(1), rationale: z.string().min(1) }).strict()),
  contextRefs: z.array(z.object({ location: z.string().min(1), purpose: z.string().min(1) }).strict()),
  steps: z.array(z.object({ id: Identifier, instruction: z.string().min(1), dependsOn: z.array(Identifier), flexibility: z.enum(['fixed', 'adaptable']) }).strict()).min(1),
  autonomy: z.object({ localDecisions: z.array(z.string().min(1)).min(1), escalateWhen: z.array(z.string().min(1)).min(1) }).strict(),
  acceptance: z.array(z.object({ id: Identifier, requirement: z.string().min(1) }).strict()).min(1),
  constraints: z.array(z.string()).default([]), allowedPaths: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]), checks: z.array(CheckSchema).default([]),
  workerChecks: z.array(CheckSchema).default([]),
  verificationPolicy: z.enum(['commands_required', 'review_allowed']).default('commands_required'),
  resources: ResourceSettingsSchema.optional(),
}).strict().superRefine((t, ctx) => {
  if (t.mode === 'implement' && t.verificationPolicy === 'commands_required' && t.checks.length === 0)
    ctx.addIssue({ code: 'custom', message: 'Implementation tasks require at least one independent verification check.' });
  for (const [label, ids] of [['acceptance', t.acceptance.map(x => x.id)], ['steps', t.steps.map(x => x.id)], ['decisions', t.decisions.map(x => x.id)], ['checks', t.checks.map(x => x.name)], ['workerChecks', t.workerChecks.map(x => x.name)]] as const) {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: `Duplicate ${label} identifiers` });
  }
  const seen = new Set<string>();
  for (const step of t.steps) {
    if (step.dependsOn.some(id => !seen.has(id))) ctx.addIssue({ code: 'custom', message: `Step ${step.id} must depend only on earlier steps` });
    seen.add(step.id);
  }
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

// Preferences contain reusable defaults; task identity and acceptance remain per-task inputs.
export const TaskDefaultsSchema = z.object({
  baseRef: TaskSpecSchema.shape.baseRef.optional(), fetchRemote: TaskSpecSchema.shape.fetchRemote,
  branchPrefix: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*\/$/).optional(),
  provider: TaskSpecSchema.shape.provider.removeDefault().optional(),
  workspaceMode: TaskSpecSchema.shape.workspaceMode.removeDefault().optional(), mode: TaskSpecSchema.shape.mode.removeDefault().optional(),
  nonGoals: TaskSpecSchema.shape.nonGoals.optional(), decisions: TaskSpecSchema.shape.decisions.optional(),
  contextRefs: TaskSpecSchema.shape.contextRefs.optional(), steps: TaskSpecSchema.shape.steps.optional(), autonomy: TaskSpecSchema.shape.autonomy.optional(),
  constraints: TaskSpecSchema.shape.constraints.removeDefault().optional(), allowedPaths: TaskSpecSchema.shape.allowedPaths.removeDefault().optional(),
  checks: TaskSpecSchema.shape.checks.removeDefault().optional(), workerChecks: TaskSpecSchema.shape.workerChecks.removeDefault().optional(),
  verificationPolicy: TaskSpecSchema.shape.verificationPolicy.removeDefault().optional(), resources: ResourceSettingsSchema.optional(),
}).strict();
export const TaskInputSchema = TaskDefaultsSchema.omit({ branchPrefix: true }).extend({
  contractVersion: TaskSpecSchema.shape.contractVersion.optional(), planRevision: TaskSpecSchema.shape.planRevision.optional(),
  id: TaskSpecSchema.shape.id, repository: TaskSpecSchema.shape.repository, goal: TaskSpecSchema.shape.goal,
  title: TaskSpecSchema.shape.title.optional(), branch: TaskSpecSchema.shape.branch.optional(),
  acceptance: TaskSpecSchema.shape.acceptance, mainBranchWarning: TaskSpecSchema.shape.mainBranchWarning,
  dependencies: TaskSpecSchema.shape.dependencies.removeDefault().optional(),
}).strict();
export const TaskPlanPatchSchema = TaskInputSchema.partial();
export type TaskInput = z.infer<typeof TaskInputSchema>;
export type TaskPlanPatch = z.infer<typeof TaskPlanPatchSchema>;
export const RepositoryPreferencesSchema = z.object({
  defaults: TaskDefaultsSchema.default({}), limits: ResourceSettingsSchema.default({}),
  requirements: z.object({ constraints: z.array(z.string().min(1)).default([]), verificationPolicy: z.literal('commands_required').optional() }).strict().default({ constraints: [] }),
}).strict();
export const RepositoryIdentitySchema = z.object({ commonGitDir: z.string().min(1), root: z.string().min(1) }).strict();
export const RepositoryProfileSchema = z.object({
  schemaVersion: z.literal(1), id: TaskSpecSchema.shape.id, revision: z.number().int().positive(),
  repository: RepositoryIdentitySchema, preferences: RepositoryPreferencesSchema,
}).strict();
export type RepositoryPreferences = z.infer<typeof RepositoryPreferencesSchema>;
export type RepositoryIdentity = z.infer<typeof RepositoryIdentitySchema>;
export type RepositoryProfile = z.infer<typeof RepositoryProfileSchema>;
export interface RepositoryConfiguration {
  identity: RepositoryIdentity; profile?: { file: string; hash: string; value: RepositoryProfile };
  sources: Record<string, 'builtin' | 'repository_default' | 'task' | 'repository_requirement' | 'previous_plan'>;
  limits: Required<ResourceSettings>; overrides: TaskPlanPatch; previousPlanRevision?: number; resolvedAt: string;
}
export const WorkerReportSchema = z.object({
  contractVersion: z.literal(1), taskId: z.string(), planRevision: z.number().int().positive(),
  runId: z.string().uuid(), attempt: z.number().int().positive(),
  outcome: z.enum(['ready_for_review', 'blocked', 'needs_replan']), summary: z.string().min(1).max(6000),
  acceptanceResults: z.array(z.object({ id: Identifier, status: z.enum(['met', 'pending_supervisor', 'unmet', 'not_checked']), evidence: z.array(z.string().min(1)) }).strict()),
  changedFiles: z.array(z.string()),
  checks: z.array(z.object({ name: z.string(), result: z.enum(['passed', 'failed', 'not_run']), evidence: z.array(z.string().min(1)) }).strict()),
  deviations: z.array(z.string()),
  blockers: z.array(z.object({ criterionIds: z.array(Identifier), reason: z.string().min(1), evidence: z.array(z.string().min(1)).min(1), proposedChange: z.string().min(1) }).strict()),
}).strict();
export type WorkerReport = z.infer<typeof WorkerReportSchema>;
export type Status = 'planned' | 'ready' | 'running' | 'verifying' | 'awaiting_review' | 'needs_changes' | 'needs_replan' | 'blocked' | 'accepted' | 'integrated' | 'failed' | 'cancelled' | 'interrupted';
export interface IntegrationRecord {
  previousStatus: Status; sourceCommit: string; targetTaskId: string; targetCommit: string;
  rationale: string; evidence: string[]; artifact: string; at: string;
}
export interface CheckResult { name: string; exitCode: number | null; passed: boolean; log: string; finishedAt: string; status?: 'passed' | 'failed' | 'stopped' }
export interface VerificationRunSummary {
  id: string; status: 'running' | 'passed' | 'failed' | 'stopped' | 'cancelled' | 'interrupted';
  artifact: string; startedAt: string; finishedAt?: string;
}
export interface VerificationRun extends VerificationRunSummary {
  planRevision: number; workerRunId?: string; selection: VerificationSelection; checks: CheckResult[];
  sourceFingerprint?: string; verifiedFingerprint?: string; error?: string;
}
export interface SupervisorEvidenceReference {
  id: string; artifact: string; kind: SupervisorEvidenceInput['kind']; summary: string;
  planRevision: number; runId?: string; sourceFingerprint: string; at: string;
}
export interface Review { decision: 'accept' | 'rework'; rationale: string; evidence: string[]; at: string; planRevision: number; feedback?: Feedback; verification?: ReviewVerification & { sourceFingerprint: string } }
export interface Task {
  spec: TaskSpec; status: Status; revision: number; attempts: number; createdAt: string; updatedAt: string;
  worktree?: string; baseCommit?: string; sessionID?: string; runId?: string;
  workspaceWarnings?: string[];
  infrastructureRetryCredits?: number;
  recoveryAttempts?: number;
  recoveryPending?: boolean;
  lastError?: string; summary?: string; feedback?: Feedback; report?: WorkerReport; checks: CheckResult[];
  verifiedFingerprint?: string; reviews: Review[]; totalTokens: number; cost: number;
  verificationSelection?: VerificationSelection;
  verificationRunId?: string; verificationHistory?: VerificationRunSummary[];
  supervisorEvidence?: SupervisorEvidenceReference[];
  integration?: IntegrationRecord;
  configuration?: RepositoryConfiguration;
}
