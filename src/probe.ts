import path from 'node:path';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadConfig, loadEnv } from './config.js';
import { TaskSpecSchema, type Task } from './schema.js';
import { OpenCodeWorker } from './opencode.js';
import { validateReport } from './protocol.js';

export async function liveProbe(root: string, provider: string, confirmed: boolean): Promise<unknown> {
  if (!confirmed) throw new Error('Probe makes a small billable model request. Invoke explicitly with probe --provider NAME --live. It never starts alpha.');
  const config = loadConfig(root); const env = loadEnv(root); const p = config.providers[provider];
  if (!p) throw new Error('Unknown provider'); if (!env[p.apiKeyEnv]) throw new Error(`Missing ${p.apiKeyEnv}`);
  const parent = path.join(root, '.runtime/probes'); mkdirSync(parent, { recursive: true });
  const folder = mkdtempSync(path.join(parent, 'api-')); const marker = 'probe-' + randomUUID();
  writeFileSync(path.join(folder, 'marker.txt'), marker);
  writeFileSync(path.join(folder, 'AGENTS.md'), 'Read-only connection probe. Only inspect marker.txt. Do not modify files.\n');
  const spec = TaskSpecSchema.parse({ contractVersion: 1, planRevision: 1, id: 'probe-' + randomUUID(), title: 'Read-only API connection probe',
    repository: folder, baseRef: 'master', branch: 'probe', provider, mode: 'investigate',
    goal: 'Use the read tool to read marker.txt and include its exact contents in AC-01 evidence. Then return a structured report. Do not inspect other directories.',
    nonGoals: ['Editing alpha', 'Implementing any GitHub issue', 'Making any code changes'],
    decisions: [], contextRefs: [{ location: 'marker.txt', purpose: 'Only evidence needed for this connection probe' }],
    steps: [{ id: 'S1', instruction: 'Read marker.txt using the read tool and submit the strict JSON report.', dependsOn: [], flexibility: 'fixed' }],
    autonomy: { localDecisions: ['How to summarize the read result'], escalateWhen: ['The marker cannot be read or a requested operation needs writes'] },
    acceptance: [{ id: 'AC-01', requirement: 'Read marker.txt through a tool and include its exact contents in evidence' }], checks: [], constraints: ['No file modifications'],
  });
  const task: Task = { spec, status: 'running', revision: 1, attempts: 1, runId: randomUUID(), worktree: folder, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), checks: [], reviews: [], totalTokens: 0, cost: 0 };
  const worker = new OpenCodeWorker(root, { ...config, taskTimeoutMinutes: 2 }, env);
  try {
    const result = await worker.run(task, id => { task.sessionID = id; }); const report = validateReport(task, result.report);
    const transcript = result.transcript as any[];
    const readObserved = transcript.some(m => m.parts?.some((part: any) => part.type === 'tool' && part.tool === 'read' && part.state?.status === 'completed' && JSON.stringify(part.state.output).includes(marker)));
    if (!readObserved || report.outcome !== 'ready_for_review' || !report.acceptanceResults.some(c => c.evidence.some(e => e.includes(marker))) || readFileSync(path.join(folder, 'marker.txt'), 'utf8') !== marker)
      throw new Error('Probe did not demonstrate a completed read tool, exact marker evidence and a valid ready_for_review report');
    writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report, null, 2));
    return { passed: true, provider, model: p.model, planRevision: report.planRevision, role: 'investigator', toolCallObserved: true, structuredReportValidated: true,
      sessionID: task.sessionID, report: path.join(folder, 'report.json'), note: 'Small billable connection probe only; alpha was not accessed. Cost reported by custom providers is not an invoice.' };
  } finally { await worker.close(); }
}
