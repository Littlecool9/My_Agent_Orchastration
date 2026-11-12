import { z } from 'zod';
import { FeedbackSchema, WorkerReportSchema, type Feedback, type Task, type WorkerReport } from './schema.js';

export function taskContract(task: Task): unknown {
  if (!task.runId) throw new Error('Task has no execution run ID');
  return { ...task.spec, taskId: task.spec.id, runId: task.runId, attempt: task.attempts,
    checks: task.spec.workerChecks ?? [], workerChecks: task.spec.workerChecks ?? [],
    executionPolicy: { workerTesting: 'incremental_only', supervisorTesting: 'supervisor_selected', supersedesLegacyWorkerFullTestInstructions: true, supersedesLegacySupervisorFullTestInstructions: true,
      ...(task.spec.resources?.workerSteps ? { stepBudget: task.spec.resources.workerSteps } : {}) },
    // Present only when this run continues one that ended at its step budget or with an invalid report.
    continuation: task.continuedFrom ? { reason: task.continuedFrom.reason, previousRunId: task.continuedFrom.runId, detail: task.continuedFrom.detail ?? null,
      instruction: 'Continue from the current workspace and session state. Do not redo finished work; complete what remains, run the incremental checks and submit the report.' } : null,
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
// Locate the report object in a final answer. Fences and surrounding prose are tolerated; the object itself is still fully validated.
export function extractReportJson(text: string): { value: unknown; note?: string } {
  const plain = (candidate: string): unknown => {
    try { const value = JSON.parse(candidate); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; } catch { return undefined; }
  };
  const trimmed = text.trim(); const direct = plain(trimmed);
  if (direct) return { value: direct };
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => plain(match[1]!.trim())).filter(Boolean).at(-1);
  if (fenced) return { value: fenced, note: 'Extracted the report object from a markdown fence' };
  const first = trimmed.indexOf('{'); const last = trimmed.lastIndexOf('}');
  const embedded = first >= 0 && last > first ? plain(trimmed.slice(first, last + 1)) : undefined;
  if (embedded) return { value: embedded, note: 'Extracted the report object from surrounding text' };
  throw new SyntaxError('Worker final output does not contain a JSON report object.');
}
const SUMMARY_LIMIT = 6000;
// Repair format-only defects that carry no claim: unknown keys, an oversized summary, omitted empty arrays and
// check-list bookkeeping. Identity, criterion coverage, statuses and evidence requirements are never repaired here.
export function normalizeReport(task: Task, input: unknown): { value: unknown; notes: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { value: input, notes: [] };
  const notes: string[] = []; const source = input as Record<string, unknown>;
  const keys = ['contractVersion', 'taskId', 'planRevision', 'runId', 'attempt', 'outcome', 'summary', 'acceptanceResults', 'changedFiles', 'checks', 'deviations', 'blockers'];
  const out: Record<string, unknown> = Object.fromEntries(keys.filter(key => key in source).map(key => [key, source[key]]));
  const dropped = Object.keys(source).filter(key => !keys.includes(key));
  if (dropped.length) notes.push(`Dropped unknown top-level keys: ${dropped.join(', ')}`);
  if (typeof out.summary === 'string' && out.summary.length > SUMMARY_LIMIT) {
    notes.push(`Truncated summary from ${out.summary.length} to ${SUMMARY_LIMIT} characters`);
    out.summary = out.summary.slice(0, SUMMARY_LIMIT - 14) + ' …[truncated]';
  }
  for (const key of ['changedFiles', 'checks', 'deviations', 'blockers']) if (out[key] === undefined) { out[key] = []; notes.push(`Added missing empty ${key}`); }
  // Extra string fields on an entry are notes the model wanted to attach: keep their text as evidence instead of failing the schema.
  const entries = (key: string, known: string[]) => {
    if (!Array.isArray(out[key])) return;
    out[key] = (out[key] as unknown[]).map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const entry = item as Record<string, unknown>; const kept: Record<string, unknown> = Object.fromEntries(known.filter(name => name in entry).map(name => [name, entry[name]]));
      if (typeof kept.evidence === 'string') kept.evidence = [kept.evidence];
      const extra = Object.keys(entry).filter(name => !known.includes(name));
      if (extra.length) {
        notes.push(`Moved unknown ${key} keys into evidence or dropped them: ${extra.join(', ')}`);
        const text = extra.filter(name => typeof entry[name] === 'string' && (entry[name] as string).trim()).map(name => `${name}: ${entry[name]}`);
        if (text.length) kept.evidence = [...(Array.isArray(kept.evidence) ? kept.evidence : []), ...text];
      }
      return kept;
    });
  };
  entries('acceptanceResults', ['id', 'status', 'evidence']); entries('checks', ['name', 'result', 'evidence']);
  entries('blockers', ['criterionIds', 'reason', 'evidence', 'proposedChange']);
  if (Array.isArray(out.deviations)) out.deviations = out.deviations.map(item => typeof item === 'string' ? item : JSON.stringify(item));
  if (Array.isArray(out.checks) && Array.isArray(out.deviations)) {
    const expected = (task.spec.workerChecks ?? []).map(check => check.name); const reported = out.checks as { name?: unknown; result?: unknown }[];
    const unlisted = reported.filter(check => !check || typeof check.name !== 'string' || !expected.includes(check.name));
    if (unlisted.length) {
      notes.push(`Moved ${unlisted.length} check(s) not listed in workerChecks into deviations`);
      out.deviations = [...out.deviations, ...unlisted.map(check => `Unlisted check reported by worker: ${JSON.stringify(check).slice(0, 400)}`)];
      out.checks = reported.filter(check => !unlisted.includes(check));
    }
    const present = (out.checks as { name: string }[]).map(check => check.name);
    const missing = expected.filter(name => !present.includes(name));
    // An omitted check is recorded as not run; it can never satisfy ready_for_review.
    if (missing.length) { notes.push(`Recorded unreported worker checks as not_run: ${missing.join(', ')}`); out.checks = [...(out.checks as unknown[]), ...missing.map(name => ({ name, result: 'not_run', evidence: [] }))]; }
  }
  return { value: out, notes };
}
// A fill-in skeleton with this run's identity, criterion IDs and check names already in place.
export function reportTemplate(task: Task): unknown {
  return { contractVersion: 1, taskId: task.spec.id, planRevision: task.spec.planRevision, runId: task.runId, attempt: task.attempts,
    outcome: 'ready_for_review | blocked | needs_replan', summary: '<concise Chinese summary, at most 6000 characters>',
    acceptanceResults: task.spec.acceptance.map(c => ({ id: c.id, status: 'met | pending_supervisor | unmet | not_checked', evidence: ['<file:line, command and result>'] })),
    changedFiles: ['<repository-relative path>'],
    checks: (task.spec.workerChecks ?? []).map(c => ({ name: c.name, result: 'passed | failed | not_run', evidence: ['<command and result>'] })),
    deviations: [], blockers: [] };
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
