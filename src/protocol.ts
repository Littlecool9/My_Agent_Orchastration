import { z } from 'zod';
import { FeedbackSchema, WorkerReportSchema, type Feedback, type Task, type WorkerReport } from './schema.js';

export function taskContract(task: Task): unknown {
  if (!task.runId) throw new Error('Task has no execution run ID');
  return { ...task.spec, taskId: task.spec.id, runId: task.runId, attempt: task.attempts,
    checks: task.spec.workerChecks ?? [], workerChecks: task.spec.workerChecks ?? [],
    executionPolicy: { workerTesting: 'incremental_only', supervisorTesting: 'supervisor_selected', supersedesLegacyWorkerFullTestInstructions: true, supersedesLegacySupervisorFullTestInstructions: true },
    supervisorVerification: { required: task.spec.verificationPolicy !== 'review_allowed' && task.spec.checks.length > 0, policy: task.spec.verificationPolicy ?? 'commands_required', checkNames: task.spec.checks.map(c => c.name) },
    repositoryProfile: task.configuration?.profile ? { id: task.configuration.profile.value.id, revision: task.configuration.profile.value.revision, hash: task.configuration.profile.hash } : null,
    workspace: { path: task.worktree, worktree: task.worktree, mode: task.spec.workspaceMode ?? 'worktree', baseCommit: task.baseCommit, branch: task.spec.branch }, feedback: task.feedback ?? null };
}
export function validateFeedback(task: Task, input: unknown): Feedback {
  const feedback = FeedbackSchema.parse(input);
  if (feedback.planRevision !== task.spec.planRevision) throw new Error('Feedback refers to a stale planRevision');
  const ids = new Set(task.spec.acceptance.map(x => x.id));
  if (feedback.findings.some(f => f.criterionIds.some(id => !ids.has(id)))) throw new Error('Feedback references an unknown acceptance criterion');
  return feedback;
}
export function validateReport(task: Task, input: unknown): WorkerReport {
  const report = WorkerReportSchema.parse(input);
  if (task.spec.mode === 'investigate' && report.changedFiles.length) throw new Error('Investigator reports cannot claim file changes');
  if (report.taskId !== task.spec.id || report.planRevision !== task.spec.planRevision || report.runId !== task.runId || report.attempt !== task.attempts)
    throw new Error('Worker report does not match the current task, planRevision, runId and attempt');
  const ids = task.spec.acceptance.map(x => x.id);
  const actual = report.acceptanceResults.map(x => x.id);
  if (new Set(actual).size !== actual.length || actual.length !== ids.length || actual.some(id => !ids.includes(id)))
    throw new Error('Worker report must cover each acceptance criterion exactly once');
  if (report.acceptanceResults.some(x => ['met', 'pending_supervisor'].includes(x.status) && !x.evidence.length)) throw new Error('Met or pending-supervisor criteria require evidence');
  if (report.acceptanceResults.some(x => x.status === 'pending_supervisor') && !task.spec.checks.length && task.spec.verificationPolicy !== 'review_allowed') throw new Error('Pending supervisor criteria require configured independent supervisor verification');
  if (report.blockers.some(b => b.criterionIds.some(id => !ids.includes(id)))) throw new Error('Blocker references an unknown acceptance criterion');
  const checkNames = (task.spec.workerChecks ?? []).map(c => c.name); const reported = report.checks.map(c => c.name);
  if (new Set(reported).size !== reported.length || reported.length !== checkNames.length || reported.some(n => !checkNames.includes(n))) throw new Error('Worker report must cover each check exactly once');
  if (report.checks.some(c => c.result !== 'not_run' && !c.evidence.length)) throw new Error('Executed checks require evidence');
  if (report.outcome !== 'ready_for_review' && !report.blockers.length) throw new Error('Blocked/replan reports require concrete blockers');
  if (report.outcome === 'ready_for_review' && (report.blockers.length || report.acceptanceResults.some(x => !['met', 'pending_supervisor'].includes(x.status)) || report.checks.some(c => c.result !== 'passed')))
    throw new Error('ready_for_review requires implemented criteria (met or pending_supervisor), passed incremental checks and no unresolved blockers');
  return report;
}
export function reportJsonSchema(): Record<string, unknown> {
  const { $schema, ...schema } = z.toJSONSchema(WorkerReportSchema); return schema;
}
export function renderReport(report: WorkerReport): string {
  return [`# ${report.taskId} — ${report.outcome}`, `Plan ${report.planRevision}; attempt ${report.attempt}; run ${report.runId}`, report.summary,
    ...report.acceptanceResults.map(x => `- ${x.id}: ${x.status} — ${x.evidence.join(', ')}`),
    ...report.checks.map(x => `- ${x.name}: ${x.result} — ${x.evidence.join(', ')}`),
    ...report.blockers.map(x => `- Blocker (${x.criterionIds.join(', ')}): ${x.reason}\n  Evidence: ${x.evidence.join(', ')}\n  Proposal: ${x.proposedChange}`),
    ...report.deviations.map(x => `- Deviation: ${x}`)].join('\n\n');
}
