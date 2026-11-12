import { z } from 'zod';

export const DEFAULT_PROVIDER = 'deepseek';

// User-maintained list prices per million tokens. Used only to estimate cost when the provider reports none.
export const PricingSchema = z.object({
  currency: z.string().trim().min(1).max(8).default('USD'),
  inputPerMillion: z.number().min(0), outputPerMillion: z.number().min(0),
  cacheReadPerMillion: z.number().min(0).optional(),
}).strict();
export type Pricing = z.infer<typeof PricingSchema>;
export const ProviderSchema = z.object({
  baseURL: z.url(), model: z.string().min(1), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  tags: z.array(z.string().trim().min(1).max(120)).max(32).optional(),
  pricing: PricingSchema.optional(),
  contextLimit: z.number().int().positive(), outputLimit: z.number().int().positive(),
  options: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const ConfigSchema = z.object({
  executionEnabled: z.boolean(), maxParallel: z.number().int().min(1).max(8),
  maxAttempts: z.number().int().min(1).max(10).default(5), taskTimeoutMinutes: z.number().min(1).max(1440),
  workerMemoryLimitMB: z.number().int().min(128).max(1048576).default(3072),
  // workerSteps is the default per-run model-step budget; maxWorkerSteps is the machine ceiling a task may request.
  workerSteps: z.number().int().min(10).max(2000).default(150),
  maxWorkerSteps: z.number().int().min(10).max(2000).default(600),
  // Consecutive step-limit continuations that need no diagnostic feedback and consume no recovery attempt.
  maxStepContinuations: z.number().int().min(0).max(10).default(2),
  providers: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), ProviderSchema),
}).strict().superRefine((config, ctx) => {
  if (config.workerSteps > config.maxWorkerSteps) ctx.addIssue({ code: 'custom', message: 'workerSteps cannot exceed maxWorkerSteps' });
});
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
export const SupervisorNoteSchema = z.object({
  planRevision: z.number().int().positive(),
  kind: z.enum(['decision', 'repair', 'handoff', 'risk', 'next_step']),
  summary: z.string().trim().min(1).max(2000), detail: z.string().max(20000).optional(),
  relatedTaskIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).max(8).default([]),
}).strict();
export type SupervisorNote = z.infer<typeof SupervisorNoteSchema>;
export interface SupervisorNoteReference {
  id: string; artifact: string; planRevision: number; kind: SupervisorNote['kind']; summary: string;
  relatedTaskIds: string[]; at: string;
}
export interface ReportSubmission {
  status: 'passed' | 'repairing' | 'repaired' | 'failed'; submissions: number;
  // Format-only tolerances applied to the accepted report (dropped unknown keys, truncated summary, ...).
  normalizations?: string[];
  errors: { category: 'syntax' | 'schema' | 'semantic'; message: string }[];
  startedAt: string; finishedAt?: string; repairDurationMs: number;
  tokens: number; cost: number; repairTokens: number; repairCost: number;
  failure?: string;
}
export interface ReportSubmissionReference extends ReportSubmission {
  artifact: string; runId: string; planRevision: number; attempt: number;
}
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
  workerSteps: z.number().int().min(10).max(2000).optional(),
  // Cumulative reported tokens for the task across runs; unset means no budget.
  tokenBudget: z.number().int().min(1000).optional(),
}).strict();
export type ResourceSettings = z.infer<typeof ResourceSettingsSchema>;
export interface ResourceLimits { workerMemoryLimitMB: number; taskTimeoutMinutes: number; workerSteps: number; tokenBudget?: number }
// Non-secret variables added to the worker and verification environment. ${NAME} expands from the inherited environment.
export const RESERVED_ENVIRONMENT = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)|^(OPENAI|ANTHROPIC|CLAUDE|CODEX|GH_|GITHUB_|OPENCODE_|XDG_)/i;
export const EnvironmentSchema = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8000)).superRefine((env, ctx) => {
  const names = Object.keys(env);
  if (names.length > 64) ctx.addIssue({ code: 'custom', message: 'At most 64 environment variables' });
  for (const name of names) if (RESERVED_ENVIRONMENT.test(name))
    ctx.addIssue({ code: 'custom', message: `Environment variable ${name} is reserved or looks like a credential; credentials never belong in task contracts` });
});
export function allowedPathIssue(value: string): string | undefined {
  const parts = value.split('/');
  if (!value || /[*?]/.test(value) || value.includes('\\') || /^([A-Za-z]:|\/)/.test(value)
    || parts.some((part, index) => part === '.' || part === '..' || (!part && index < parts.length - 1)))
    return `allowedPaths entry ${JSON.stringify(value)} must be a literal repository-relative file or directory prefix with forward slashes; globs (* ?), absolute paths, backslashes and ./.. segments are not supported`;
  return undefined;
}
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
  modelSelectionReason: z.string().trim().min(1).max(2000).optional(),
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
  environment: EnvironmentSchema.default({}),
}).strict().superRefine((t, ctx) => {
  for (const entry of t.allowedPaths) { const issue = allowedPathIssue(entry); if (issue) ctx.addIssue({ code: 'custom', message: issue }); }
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
  environment: EnvironmentSchema.optional(),
}).strict();
export const TaskInputSchema = TaskDefaultsSchema.omit({ branchPrefix: true }).extend({
  contractVersion: TaskSpecSchema.shape.contractVersion.optional(), planRevision: TaskSpecSchema.shape.planRevision.optional(),
  id: TaskSpecSchema.shape.id, repository: TaskSpecSchema.shape.repository, goal: TaskSpecSchema.shape.goal,
  title: TaskSpecSchema.shape.title.optional(), branch: TaskSpecSchema.shape.branch.optional(),
  acceptance: TaskSpecSchema.shape.acceptance, mainBranchWarning: TaskSpecSchema.shape.mainBranchWarning,
  modelSelectionReason: TaskSpecSchema.shape.modelSelectionReason,
  dependencies: TaskSpecSchema.shape.dependencies.removeDefault().optional(),
}).strict();
export const TaskPlanPatchSchema = TaskInputSchema.partial();
// Supervisor-side fields that can change without a new plan revision: the worker's contract and report stay valid.
export const PlanAmendmentSchema = z.object({
  checks: TaskSpecSchema.shape.checks.removeDefault().optional(), allowedPaths: TaskSpecSchema.shape.allowedPaths.removeDefault().optional(),
  resources: ResourceSettingsSchema.optional(),
}).strict().refine(patch => Object.values(patch).some(value => value !== undefined), { message: 'Amendment must change checks, allowedPaths or resources' });
export type PlanAmendment = z.infer<typeof PlanAmendmentSchema>;
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
  limits: ResourceLimits; overrides: TaskPlanPatch; previousPlanRevision?: number; resolvedAt: string;
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
export type Status = 'planned' | 'ready' | 'queued' | 'running' | 'verifying' | 'awaiting_review' | 'needs_changes' | 'needs_replan' | 'blocked' | 'accepted' | 'integrated' | 'failed' | 'cancelled' | 'interrupted';
export interface IntegrationRecord {
  previousStatus: Status; sourceCommit: string; targetTaskId: string; targetCommit: string;
  rationale: string; evidence: string[]; artifact: string; at: string;
}
export interface CheckResult {
  name: string; exitCode: number | null; passed: boolean; log: string; finishedAt: string; status?: 'passed' | 'failed' | 'stopped';
  durationMs?: number;
  // Failure aids: decoded abnormal exit code and the end of the captured output. The full log stays in the artifact.
  exitDetail?: string; tail?: string;
  // Set when a passed result was carried over from an earlier round on identical source (rerun=failed).
  reusedFrom?: string;
}
export interface VerificationRunSummary {
  id: string; status: 'running' | 'passed' | 'failed' | 'stopped' | 'cancelled' | 'interrupted';
  artifact: string; startedAt: string; finishedAt?: string;
}
export interface VerificationRun extends VerificationRunSummary {
  planRevision: number; workerRunId?: string; selection: VerificationSelection; checks: CheckResult[];
  sourceFingerprint?: string; verifiedFingerprint?: string; error?: string;
  continueOnFailure?: boolean; rerunOf?: string;
}
export interface SupervisorEvidenceReference {
  id: string; artifact: string; kind: SupervisorEvidenceInput['kind']; summary: string;
  planRevision: number; runId?: string; sourceFingerprint: string; at: string;
}
export interface Review { decision: 'accept' | 'rework'; rationale: string; evidence: string[]; at: string; planRevision: number; feedback?: Feedback; verification?: ReviewVerification & { sourceFingerprint: string } }
export interface WorkerProgress {
  phase: 'working' | 'report_repair'; steps: number; stepLimit: number; tokens: number; cost: number;
  lastActivityAt: string; lastTool?: { tool: string; status?: string; title?: string };
}
export interface RunRecord { runId: string; startedAt: string; finishedAt: string; durationMs: number; outcome: Status; steps?: number; stepLimit?: number; tokens?: number }
// A run that ended without a reviewable result for a reason other than an environment failure.
export interface Continuation { reason: 'step_limit' | 'report_invalid'; runId: string; at: string; steps?: number; stepLimit?: number; detail?: string }
export interface Amendment { id: string; artifact: string; planRevision: number; fields: string[]; reason: string; at: string }
export interface Task {
  spec: TaskSpec; status: Status; revision: number; attempts: number; createdAt: string; updatedAt: string;
  worktree?: string; baseCommit?: string; sessionID?: string; runId?: string;
  runStartedAt?: string; lastRun?: RunRecord;
  queued?: { from: Status; feedback?: Feedback; at: string }; queueError?: string;
  continuation?: Continuation; continuedFrom?: Continuation; stepContinuations?: number;
  scopeViolations?: string[]; amendments?: Amendment[];
  workspaceWarnings?: string[];
  executionProvider?: z.infer<typeof ProviderSchema>;
  reportSubmissions?: ReportSubmissionReference[];
  supervisorNotes?: SupervisorNoteReference[];
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
