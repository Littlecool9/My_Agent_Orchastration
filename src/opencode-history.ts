import { isDeepStrictEqual } from 'node:util';
import type { OpenCodeRequest } from './opencode-session.js';

export interface HistoryRepairArchive {
  sessionID: string; at: string;
  removed: { id: string; reason: string }[];
  originalTranscript: any[];
}
export function emptyAssistantReason(message: any): string | undefined {
  if (message.info?.role !== 'assistant') return;
  const parts: any[] = message.parts ?? [];
  // Tool-only turns are valid, including tool errors and interrupted tool execution.
  if (parts.some(p => p.type === 'tool')) return;
  if (parts.some(p => p.type === 'text' && !p.ignored && typeof p.text === 'string' && p.text.trim().length > 0)) return;
  if (parts.some(p => p.type === 'file' && typeof p.url === 'string' && p.url.length > 0)) return;
  if (message.info.error) return 'empty-error-assistant';
  if (!message.info.finish) return 'interrupted-empty-assistant';
  return 'empty-assistant';
}

// Delete only empty assistant messages. Revert would also roll back workspace files.
export async function repairSessionHistory(
  request: OpenCodeRequest, sessionID: string, before: any[],
  archive: (record: HistoryRepairArchive) => void | Promise<void>,
): Promise<{ transcript: any[]; removed: { id: string; reason: string }[] }> {
  const removed = before.flatMap(message => {
    const reason = emptyAssistantReason(message);
    return reason ? [{ id: message.info.id as string, reason }] : [];
  });
  if (!removed.length) return { transcript: before, removed };
  const statuses = await request('/session/status');
  if (['busy', 'retry'].includes(statuses[sessionID]?.type)) throw new Error('Cannot repair an active OpenCode session');
  const original = await request('/session/' + sessionID + '/message');
  if (!isDeepStrictEqual(original, before)) throw new Error('Session history changed before repair; inspect and retry maintenance');
  await archive({ sessionID, at: new Date().toISOString(), removed, originalTranscript: before });
  for (const message of removed) await request('/session/' + sessionID + '/message/' + encodeURIComponent(message.id), 'DELETE');
  const transcript: any[] = await request('/session/' + sessionID + '/message');
  const removedIDs = new Set(removed.map(m => m.id));
  const retained = before.filter(m => !removedIDs.has(m.info.id));
  if (!isDeepStrictEqual(transcript, retained)) throw new Error('Session repair did not preserve the expected message history; refusing to submit a prompt');
  return { transcript, removed };
}
