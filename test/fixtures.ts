import { WorkerReportSchema, type Task } from '../src/schema.js';

export const contractFields = {
  contractVersion: 1 as const, planRevision: 1,
  nonGoals: ['Change unrelated features'], decisions: [], contextRefs: [],
  steps: [{ id: 'S1', instruction: 'Complete the scoped fixture task', dependsOn: [], flexibility: 'adaptable' as const }],
  autonomy: { localDecisions: ['Local implementation and debugging'], escalateWhen: ['The task conflicts with a repository invariant'] },
};
export function makeReport(task: Task, outcome: 'ready_for_review' | 'needs_replan' | 'blocked' = 'ready_for_review') {
  return WorkerReportSchema.parse({ contractVersion: 1, taskId: task.spec.id, planRevision: task.spec.planRevision, runId: task.runId,
    attempt: task.attempts, outcome, summary: '完成本地 fixture 检查。',
    acceptanceResults: task.spec.acceptance.map(c => ({ id: c.id, status: outcome === 'ready_for_review' ? 'met' : 'not_checked', evidence: ['value.txt'] })),
    changedFiles: task.spec.mode === 'investigate' ? [] : ['value.txt'],
    checks: (task.spec.workerChecks ?? []).map(c => ({ name: c.name, result: outcome === 'ready_for_review' ? 'passed' : 'not_run', evidence: outcome === 'ready_for_review' ? ['fixture log'] : [] })),
    deviations: [], blockers: outcome === 'ready_for_review' ? [] : [{ criterionIds: [task.spec.acceptance[0]!.id], reason: 'Fixture blocker', evidence: ['AGENTS.md'], proposedChange: 'Revise the fixture decision' }],
  });
}
