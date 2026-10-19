import { createServer, type Server } from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, openSync, closeSync, mkdirSync, rmdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, loadEnv, runtime, redact } from './config.js';
import { Engine } from './engine.js';
import { OpenCodeWorker } from './opencode.js';
import { callTool } from './tools.js';

export interface DaemonInfo { pid: number; port: number; token: string }
function infoFile(root: string): string { return path.join(runtime(root), 'daemon.json'); }
export function readInfo(root: string): DaemonInfo | undefined {
  try { return JSON.parse(readFileSync(infoFile(root), 'utf8')); } catch { return undefined; }
}
export async function rpc(info: DaemonInfo, name: string, args: unknown): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${info.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args }), signal: AbortSignal.timeout(35000) });
  const body = await res.json() as any; if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`); return body.result;
}
async function alive(info: DaemonInfo): Promise<boolean> {
  try { await rpc(info, 'workflow_config', {}); return true; } catch { return false; }
}
export async function ensureDaemon(root: string): Promise<DaemonInfo> {
  const current = readInfo(root); if (current && await alive(current)) return current;
  const lock = path.join(runtime(root), 'launch.lock');
  let owner = false;
  try { mkdirSync(lock); owner = true; } catch { /* another client is launching */ }
  if (owner) {
    try {
      const log = openSync(path.join(runtime(root), 'daemon.log'), 'a');
      const child = spawn(process.execPath, [path.join(root, 'dist/src/cli.js'), 'daemon'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log], env: process.env });
      let error: Error | undefined; child.on('error', e => { error = e; }); child.unref(); closeSync(log);
      for (let n = 0; n < 120; n++) { if (error) throw error; const info = readInfo(root); if (info && info.pid === child.pid && await alive(info)) return info; await delay(250); }
      throw new Error('Daemon startup failed. Inspect .runtime/daemon.log');
    } finally { rmdirSync(lock); }
  }
  for (let n = 0; n < 120; n++) { const info = readInfo(root); if (info && await alive(info)) return info; await delay(250); }
  throw new Error('Daemon launch lock timed out. If no daemon is starting, remove .runtime/launch.lock and retry.');
}
export async function serveDaemon(root: string): Promise<Server> {
  const env = loadEnv(root); const config = loadConfig(root);
  const previous = readInfo(root); if (previous && await alive(previous)) throw new Error('A daemon is already running');
  const token = randomBytes(32).toString('hex'); const worker = new OpenCodeWorker(root, config, env); const engine = new Engine(root, config, env, worker);
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; shuttingDown = true;
    await engine.close();
    for (const task of engine.store.all()) if (['running', 'verifying'].includes(task.status)) { task.status = 'interrupted'; task.lastError = 'Daemon stopped; inspect artifacts and resume explicitly.'; engine.store.save(task); }
    if (readInfo(root)?.pid === process.pid && existsSync(infoFile(root))) unlinkSync(infoFile(root));
    server.close(); server.closeAllConnections();
  };
  const server = createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${token}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { res.writeHead(401).end(); return; }
    if (req.method === 'POST' && req.url === '/shutdown') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); void shutdown(); return; }
    if (req.method !== 'POST' || req.url !== '/rpc') { res.writeHead(404).end(); return; }
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 1024 * 1024) throw new Error('Request exceeds 1 MB'); }
      const request = JSON.parse(body); const result = await callTool(engine, request.name, request.args);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(redact(JSON.stringify({ result }), env));
    } catch (error) { res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: redact(String(error), env) })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No daemon port');
  writeFileSync(infoFile(root), JSON.stringify({ pid: process.pid, port: address.port, token }), { mode: 0o600 });
  process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
  return server;
}
export async function stopDaemon(root: string): Promise<{ stopped: boolean }> {
  const info = readInfo(root); if (!info || !await alive(info)) return { stopped: false };
  const res = await fetch(`http://127.0.0.1:${info.port}/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error('Daemon refused shutdown');
  for (let n = 0; n < 120; n++) { if (!await alive(info)) return { stopped: true }; await delay(250); }
  throw new Error('Daemon is still stopping worker processes; inspect logs');
}
