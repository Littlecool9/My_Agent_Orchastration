import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export type OpenCodeRequest = (route: string, method?: string, body?: unknown, timeout?: number) => Promise<any>;
export interface PromptOptions {
  timeoutMs: number; signal: AbortSignal; pollMs?: number;
  onSnapshot?: (transcript: any[]) => void;
}

// No HTTP request waits for model execution. POST is never retried: its outcome can be ambiguous.
export async function promptAsync(request: OpenCodeRequest, sessionID: string, body: Record<string, unknown>, options: PromptOptions): Promise<{ response: any; transcript: any[] }> {
  const deadline = Date.now() + options.timeoutMs;
  const pollMs = options.pollMs ?? 1000;
  const messageID = 'msg_' + randomBytes(16).toString('hex');
  const route = '/session/' + sessionID;
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
      await delay(Math.min(pollMs, budget()), undefined, { signal: options.signal });
      continue;
    }
    budget();
    options.onSnapshot?.(transcript);
    // parentID binds the final answer to this submission, including in a resumed session.
    const turn = transcript.filter(m => m.info?.role === 'assistant' && m.info.parentID === messageID);
    const failed = turn.find(m => m.info.error);
    if (failed) throw new Error('Worker failed: ' + JSON.stringify(failed.info.error));
    const state = statuses[sessionID]?.type;
    if (state === 'busy' || state === 'retry') idleSamples = 0;
    else {
      const final = turn.at(-1);
      const finished = final && typeof final.info.time?.completed === 'number';
      if (finished && ['stop', 'end_turn'].includes(final.info.finish)) return { response: final, transcript };
      if (finished && final.info.finish && final.info.finish !== 'tool-calls')
        throw new Error('Worker stopped without final completion: ' + final.info.finish);
      const submitted = transcript.some(m => m.info?.id === messageID && m.info.role === 'user');
      if (submitted && ++idleSamples >= 10) throw new Error('OpenCode became idle without a completed final assistant message for this submission');
    }
    await delay(Math.min(pollMs, budget()), undefined, { signal: options.signal });
  }
}
