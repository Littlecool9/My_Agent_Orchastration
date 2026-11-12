import { ZodError } from 'zod';
import { extractReportJson, normalizeReport, validateReport } from './protocol.js';
import type { ReportSubmission, Task, WorkerReport } from './schema.js';

export interface ReportTurn { text: string; tokens: number; cost: number }
// The model turn completed but its report stayed invalid after the single resubmission. The work in the
// workspace is intact, so the engine treats this differently from a transport, memory or process failure.
export class ReportValidationError extends Error {
  constructor(message: string, readonly errors: ReportSubmission['errors']) { super(message); this.name = 'ReportValidationError'; }
}

// Only report validation reaches this retry. Transport, timeout, memory and model
// execution failures still follow the normal recovery path.
export async function submitReport(task: Task, initial: ReportTurn,
  repair: (diagnostic: string) => Promise<ReportTurn>, observe: (state: ReportSubmission) => void): Promise<WorkerReport> {
  const state: ReportSubmission = { status: 'passed', submissions: 1, errors: [], startedAt: new Date().toISOString(),
    repairDurationMs: 0, tokens: initial.tokens, cost: initial.cost, repairTokens: 0, repairCost: 0 };
  const parse = (text: string) => {
    const extracted = extractReportJson(text); const normalized = normalizeReport(task, extracted.value);
    const report = validateReport(task, normalized.value);
    const notes = [...(extracted.note ? [extracted.note] : []), ...normalized.notes];
    if (notes.length) state.normalizations = notes;
    return report;
  };
  const invalid = (error: unknown) => {
    state.errors.push({ category: error instanceof SyntaxError ? 'syntax' : error instanceof ZodError ? 'schema' : 'semantic', message: String(error) });
  };
  try {
    try { return parse(initial.text); }
    catch (error) { invalid(error); }
    state.status = 'repairing'; observe(structuredClone(state));
    const started = Date.now();
    try {
      state.submissions = 2;
      const turn = await repair(state.errors[0]!.message);
      state.tokens += turn.tokens; state.cost += turn.cost;
      state.repairTokens = turn.tokens; state.repairCost = turn.cost;
      try {
        const report = parse(turn.text); state.status = 'repaired'; return report;
      } catch (error) {
        invalid(error);
        throw new ReportValidationError('Final report is still invalid after one resubmission: ' + String(error), structuredClone(state.errors));
      }
    } finally { state.repairDurationMs = Date.now() - started; }
  } catch (error) { state.status = 'failed'; state.failure = String(error); throw error; }
  finally { state.finishedAt = new Date().toISOString(); observe(structuredClone(state)); }
}
