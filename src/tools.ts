import { z } from 'zod';
import { TaskSpecSchema, FeedbackSchema } from './schema.js';
import type { Engine } from './engine.js';
import { configStatus } from './config.js';

export const toolDefinitions = [
  { name: 'workflow_config', description: 'Read the running execution gate, selected on-disk config path, disk execution gate and restartRequired, plus provider/model configuration and key-presence booleans. Does not reload config or return credentials.', schema: z.object({}).strict(), readOnly: true },
  { name: 'workflow_task_create', description: 'Store an explicit task plan only. Does not touch a repository or call an API.', schema: z.object({ spec: TaskSpecSchema }).strict(), readOnly: false },
  { name: 'workflow_prepare', description: 'Fetch the requested remote and create an isolated branch/worktree at a recorded commit. Requires executionEnabled.', schema: z.object({ id: z.string() }).strict(), readOnly: false },
  { name: 'workflow_dispatch', description: 'Start/resume an OpenCode worker asynchronously. Structured criterion-linked feedback is required for interrupted/failed/blocked tasks. needs_replan requires a plan update.', schema: z.object({ id: z.string(), feedback: FeedbackSchema.optional() }).strict(), readOnly: false },
  { name: 'workflow_plan_update', description: 'Supervisor updates the task contract with an expected revision and change reason. Increments planRevision, invalidates old evidence, preserves session/worktree and total attempt limit. Never edits an active/accepted task.', schema: z.object({ id: z.string(), expectedPlanRevision: z.number().int().positive(), spec: TaskSpecSchema, changeReason: z.string().min(1) }).strict(), readOnly: false },
  { name: 'workflow_status', description: 'Read compact task state, result summary and evidence filenames. No raw transcript.', schema: z.object({ id: z.string().optional() }).strict(), readOnly: true },
  { name: 'workflow_wait', description: 'Wait up to 25 seconds for revision changes, then return compact states. Supply last revisions to avoid repeated results.', schema: z.object({ ids: z.array(z.string()).min(1).max(8), after: z.record(z.string(), z.number().int()).default({}), timeoutMs: z.number().min(0).max(25000).default(20000) }).strict(), readOnly: true },
  { name: 'workflow_diff', description: 'List changed files and diff stat; supervisor should read actual code in the indicated worktree.', schema: z.object({ id: z.string() }).strict(), readOnly: true },
  { name: 'workflow_artifact', description: 'Read a bounded portion of one task artifact. Read full transcripts only for a specific diagnostic need.', schema: z.object({ id: z.string(), name: z.string(), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(20000).default(12000) }).strict(), readOnly: true },
  { name: 'workflow_verify', description: 'Run the task verification commands independently of the worker, asynchronously. Captures exit codes and logs; does not accept the task.', schema: z.object({ id: z.string() }).strict(), readOnly: false },
  { name: 'workflow_review', description: 'Supervisor review. Accept requires independent checks on unchanged source. Rework requires feedback with planRevision and criterion-linked findings; continue the same worker session.', schema: z.object({ id: z.string(), decision: z.enum(['accept', 'rework']), rationale: z.string().min(1), evidence: z.array(z.string().min(1)).min(1), feedback: FeedbackSchema.optional() }).strict(), readOnly: false },
  { name: 'workflow_cancel', description: 'Stop a task and its running worker/checks. Preserves worktree, branch and evidence for inspection.', schema: z.object({ id: z.string() }).strict(), readOnly: false },
] as const;

export async function callTool(engine: Engine, name: string, input: unknown): Promise<unknown> {
  const tool = toolDefinitions.find(t => t.name === name); if (!tool) throw new Error('Unknown workflow tool');
  const args = tool.schema.parse(input) as any;
  switch (name) {
    case 'workflow_config': return { projectRoot: engine.root, executionEnabled: engine.config.executionEnabled, ...configStatus(engine.root, engine.config), maxParallel: engine.config.maxParallel, maxAttempts: engine.config.maxAttempts,
      providers: Object.fromEntries(Object.entries(engine.config.providers).map(([id, p]) => [id, { model: p.model, baseURL: p.baseURL, keyPresent: Boolean(engine.env[p.apiKeyEnv]) }])) };
    case 'workflow_task_create': return engine.summary(engine.create(args.spec));
    case 'workflow_prepare': return engine.summary(await engine.prepare(args.id));
    case 'workflow_dispatch': return engine.summary(await engine.dispatch(args.id, args.feedback));
    case 'workflow_plan_update': return engine.summary(await engine.updatePlan(args.id, args.expectedPlanRevision, args.spec, args.changeReason));
    case 'workflow_status': return args.id ? engine.summary(engine.store.get(args.id)) : engine.store.all().map(t => engine.summary(t));
    case 'workflow_wait': return engine.wait(args.ids, args.after, args.timeoutMs);
    case 'workflow_diff': return engine.diff(args.id);
    case 'workflow_artifact': return engine.artifact(args.id, args.name, args.offset, args.length);
    case 'workflow_verify': return engine.summary(await engine.verify(args.id));
    case 'workflow_review': return engine.summary(await engine.review(args.id, args.decision, args.rationale, args.evidence, args.feedback));
    case 'workflow_cancel': return engine.summary(await engine.cancel(args.id));
  }
}
