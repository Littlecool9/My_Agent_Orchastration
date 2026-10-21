import type { Status } from './schema.js';

export const WAIT_USAGE = 'wait TASK_ID [TASK_ID ...] [--until attention|change] [--after TASK_ID=REVISION] [--timeout-ms MS] [--json]';
export interface WaitTask { id: string; status: Status; revision: number; [key: string]: unknown }
export interface WaitOptions { until: 'attention' | 'change'; after: Record<string, number>; timeoutMs: number }
export interface WaitRequest { ids: string[]; after: Record<string, number>; timeoutMs: number }
export type WaitResult = { reason: 'attention' | 'changed' | 'timeout'; tasks: WaitTask[] };
const attention = new Set<Status>(['awaiting_review', 'needs_changes', 'needs_replan', 'blocked', 'accepted', 'integrated', 'failed', 'cancelled', 'interrupted']);

export function parseWaitArgs(args: string[]): { ids: string[]; options: WaitOptions } {
  const ids: string[] = []; const options: WaitOptions = { until: 'attention', after: {}, timeoutMs: 0 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--until') {
      const value = args[++i];
      if (value !== 'attention' && value !== 'change') throw new Error(WAIT_USAGE);
      options.until = value;
    } else if (arg === '--timeout-ms') {
      const value = args[++i];
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw new Error(WAIT_USAGE);
      options.timeoutMs = Number(value);
    } else if (arg === '--after') {
      const match = /^([a-z0-9][a-z0-9-]{0,63})=(\d+)$/.exec(args[++i] ?? '');
      if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error(WAIT_USAGE);
      options.after[match[1]!] = Number(match[2]);
    } else if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(arg)) ids.push(arg);
    else throw new Error(WAIT_USAGE);
  }
  if (!ids.length || ids.length > 8 || new Set(ids).size !== ids.length || Object.keys(options.after).some(id => !ids.includes(id))) throw new Error(WAIT_USAGE);
  return { ids, options };
}

// One process retains only the latest snapshot. Each RPC remains bounded for MCP compatibility.
export async function waitForTasks(ids: string[], request: (args: WaitRequest, signal: AbortSignal) => Promise<WaitTask[]>,
  options: WaitOptions, signal?: AbortSignal): Promise<WaitResult> {
  const timeout = options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined;
  const combined = AbortSignal.any([...(signal ? [signal] : []), ...(timeout ? [timeout] : [])]);
  let tasks: WaitTask[] = []; let after = { ...options.after };
  const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : Infinity;
  try {
    combined.throwIfAborted();
    tasks = await request({ ids, after: {}, timeoutMs: 0 }, combined);
    // Without a cursor, change means a change after this initial snapshot.
    for (const task of tasks) after[task.id] ??= task.revision;
    for (;;) {
      combined.throwIfAborted();
      if (options.until === 'attention' && tasks.some(t => attention.has(t.status))) return { reason: 'attention', tasks };
      if (options.until === 'change' && tasks.some(t => t.revision > after[t.id]!)) return { reason: 'changed', tasks };
      after = Object.fromEntries(tasks.map(t => [t.id, Math.max(after[t.id] ?? -1, t.revision)]));
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { reason: 'timeout', tasks };
      tasks = await request({ ids, after, timeoutMs: Math.min(25000, remaining) }, combined);
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (timeout?.aborted) return { reason: 'timeout', tasks };
    throw error;
  }
}
