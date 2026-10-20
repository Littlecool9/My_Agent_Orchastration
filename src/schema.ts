import { z } from 'zod';

export const DEFAULT_PROVIDER = 'deepseek';

export const ProviderSchema = z.object({
  baseURL: z.url(), model: z.string().min(1), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  contextLimit: z.number().int().positive(), outputLimit: z.number().int().positive(),
  options: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const ConfigSchema = z.object({
  executionEnabled: z.boolean(), maxParallel: z.number().int().min(1).max(8),
  maxAttempts: z.number().int().min(1).max(10), taskTimeoutMinutes: z.number().min(1).max(1440),
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
export const FindingSchema = z.object({
  criterionIds: z.array(Identifier).min(1), description: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1), requestedChange: z.string().min(1),
}).strict();
export const FeedbackSchema = z.object({
  planRevision: z.number().int().positive(), summary: z.string().min(1),
  findings: z.array(FindingSchema).min(1),
}).strict();
export type Feedback = z.infer<typeof FeedbackSchema>;

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
}).strict().superRefine((t, ctx) => {
  if (t.mode === 'implement' && t.checks.length === 0)
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
export type Status = 'planned' | 'ready' | 'running' | 'verifying' | 'awaiting_review' | 'needs_changes' | 'needs_replan' | 'blocked' | 'accepted' | 'failed' | 'cancelled' | 'interrupted';
export interface CheckResult { name: string; exitCode: number | null; passed: boolean; log: string; finishedAt: string }
export interface Review { decision: 'accept' | 'rework'; rationale: string; evidence: string[]; at: string; planRevision: number; feedback?: Feedback }
export interface Task {
  spec: TaskSpec; status: Status; revision: number; attempts: number; createdAt: string; updatedAt: string;
  worktree?: string; baseCommit?: string; sessionID?: string; runId?: string;
  workspaceWarnings?: string[];
  infrastructureRetryCredits?: number;
  lastError?: string; summary?: string; feedback?: Feedback; report?: WorkerReport; checks: CheckResult[];
  verifiedFingerprint?: string; reviews: Review[]; totalTokens: number; cost: number;
  verificationSelection?: VerificationSelection;
}
