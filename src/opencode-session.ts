import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export type OpenCodeRequest = (route: string, method?: string, body?: unknown, timeout?: number) => Promise<any>;
export interface PromptOptions {
  timeoutMs: number; signal: AbortSignal; pollMs?: number;
  // turn holds the assistant messages answering this submission: one per model step.
  onSnapshot?: (transcript: any[], turn: any[]) => void;
}

// No HTTP request waits for model execution. POST is never retried: its outcome can be ambiguous.
export async function promptAsync(request: OpenCodeRequest, sessionID: string, body: Record<string, unknown>, options: PromptOptions): Promise<{ response: any; transcript: any[]; steps: number }> {
  const deadline = Date.now() + options.timeoutMs;
  const pollMs = options.pollMs ?? 1000;
  const messageID = 'msg_' + randomBytes(16).toString('hex');
  const route = '/session/' + sessionID;
  // A timer aborted by the signal rejects with a generic AbortError; surface the signal's own reason
  // (memory limit, process exit, token budget) instead.
  const pause = async (ms: number) => {
    try { await delay(ms, undefined, { signal: options.signal }); }
    catch (error) { options.signal.throwIfAborted(); throw error; }
  };
  const budget = () => {
    options.signal.throwIfAborted();
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('OpenCode task timed out after ' + options.timeoutMs + ' ms');
    return Math.min(left, 15000);
  };
  await request(route + '/prompt_async', 'POST', { ...body, messageID }, budget());
  let failures = 0; let idleSamples = 0;
  for (;;) {
    const timeout = budget();
    let transcript: any[]; let statuses: Record<string, { type: string }>;
    try {
      [transcript, statuses] = await Promise.all([
        request(route + '/message', 'GET', undefined, timeout),
        request('/session/status', 'GET', undefined, timeout),
      ]);
      failures = 0;
    } catch (error) {
      options.signal.throwIfAborted();
      if (++failures >= 3) throw new Error('OpenCode polling failed three times; prompt was not resubmitted. ' + String(error), { cause: error });
      await pause(Math.min(pollMs, budget()));
      continue;
    }
    budget();
    // parentID binds the final answer to this submission, including in a resumed session.
    const turn = transcript.filter(m => m.info?.role === 'assistant' && m.info.parentID === messageID);
    options.onSnapshot?.(transcript, turn);
    // A snapshot observer may abort the run, for example at a token budget.
    options.signal.throwIfAborted();
    const failed = turn.find(m => m.info.error);
    if (failed) throw new Error('Worker failed: ' + JSON.stringify(failed.info.error));
    const state = statuses[sessionID]?.type;
    if (state === 'busy' || state === 'retry') idleSamples = 0;
    else {
      const final = turn.at(-1);
      const finished = final && typeof final.info.time?.completed === 'number';
      if (finished && ['stop', 'end_turn'].includes(final.info.finish)) return { response: final, transcript, steps: turn.length };
      if (finished && final.info.finish && final.info.finish !== 'tool-calls')
        throw new Error('Worker stopped without final completion: ' + final.info.finish);
      const submitted = transcript.some(m => m.info?.id === messageID && m.info.role === 'user');
      if (submitted && ++idleSamples >= 10) throw new Error('OpenCode became idle without a completed final assistant message for this submission');
    }
    await pause(Math.min(pollMs, budget()));
  }
}
