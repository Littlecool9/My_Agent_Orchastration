import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

export interface MemoryReport { status: string; limitMB: number; peakBytes: number; workerPID: number; exitCode: number; error?: string }
export function memoryGuardLaunch(root: string, requestFile: string, reportFile: string, memoryLimitMB: number, command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') throw new Error('Worker memory guard currently requires Windows Job Objects; refusing unguarded launch');
  writeFileSync(requestFile, JSON.stringify({ command, args, memoryLimitMB, reportFile }));
  return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/worker-job.ps1'), '-RequestFile', requestFile] };
}
export function readMemoryReport(file: string): MemoryReport | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}
export function workerExitError(reportFile: string): Error {
  const report = readMemoryReport(reportFile);
  if (report?.status === 'memory_limit') return new Error('WORKER_MEMORY_LIMIT: ' + report.error + '; peakBytes=' + report.peakBytes);
  if (report?.status === 'guard_error') return new Error('WORKER_MEMORY_GUARD_FAILED: ' + report.error);
  return new Error('OpenCode process exited; inspect server.log and memory report');
}
