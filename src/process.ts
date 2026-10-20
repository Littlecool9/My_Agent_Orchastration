import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { redact } from './config.js';

export async function runCommand(command: string, args: string[], cwd: string, env = process.env, timeoutMs = 120000, log?: string, signal?: AbortSignal): Promise<{ code: number | null; output: string; stdout: string }> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let stdout = ''; let error: Error | undefined;
    let stopping: Promise<void> | undefined;
    const stop = () => { stopping ??= killTree(child); };
    const stream = log ? createWriteStream(log, { flags: 'w' }) : undefined;
    stream?.on('error', e => { error = e; stop(); });
    const collect = (chunk: Buffer) => {
      const clean = redact(chunk.toString(), env); output += clean; stream?.write(clean);
      if (log) output = output.slice(-32000);
      else if (output.length > 16000000) { error = new Error('Command output exceeded 16 MB'); stop(); }
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (log) stdout = stdout.slice(-32000); collect(chunk); }); child.stderr.on('data', collect);
    const timer = setTimeout(() => { error = new Error('Command timed out'); stop(); }, timeoutMs);
    const abort = () => { error = new Error('Command cancelled'); stop(); };
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.on('error', (e) => { error = e; });
    child.on('close', async (code) => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      await stopping;
      if (stream && !stream.destroyed) await new Promise<void>(done => { stream.once('close', done); stream.end(); });
      if (error) reject(error); else resolve({ code, output, stdout });
    });
  });
}
export async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { child.kill(); resolve(); });
      killer.on('close', () => resolve());
    });
  } else child.kill('SIGTERM');
}
export async function git(cwd: string, args: string[]): Promise<string> {
  const r = await runCommand('git', args, cwd);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.output.slice(-3000)}`);
  // Git writes line-ending warnings to stderr; never treat them as filenames.
  return args.includes('-z') ? r.stdout : r.stdout.trim();
}
