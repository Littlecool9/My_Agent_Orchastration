import path from 'node:path';
import { existsSync, mkdirSync, createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { killTree } from './process.js';
import { redact } from './config.js';
import type { Config, Task } from './schema.js';
import { reportJsonSchema, taskContract } from './protocol.js';
import { promptAsync } from './opencode-session.js';
import { repairSessionHistory } from './opencode-history.js';
import { memoryGuardLaunch, readMemoryReport, workerExitError } from './memory-guard.js';

export interface WorkerResult { report: unknown; transcript: unknown; tokens: number; cost: number }
export interface Worker {
  run(task: Task, onSession: (id: string) => void): Promise<WorkerResult>;
  cancel(id: string): Promise<void>;
  close(): Promise<void>;
}
export function opencodeExecutable(root: string): { command: string; args: string[] } {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const native = path.join(root, 'node_modules', `opencode-${platform}-${process.arch}`, 'bin', process.platform === 'win32' ? 'opencode.exe' : 'opencode');
  if (existsSync(native)) return { command: native, args: [] };
  const windowsLauncher = path.join(root, 'node_modules/opencode-ai/bin/opencode.exe');
  if (process.platform === 'win32' && existsSync(windowsLauncher)) return { command: windowsLauncher, args: [] };
  const script = path.join(root, 'node_modules', 'opencode-ai', 'bin', 'opencode');
  if (!existsSync(script)) throw new Error('OpenCode is not installed locally. Run npm ci first.');
  return { command: process.execPath, args: [script] };
}
export function workerEnv(root: string, config: Config, providerID: string, input: NodeJS.ProcessEnv, password: string, stateRoot: string): NodeJS.ProcessEnv {
  const p = config.providers[providerID]; if (!p) throw new Error('Unknown provider');
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) || /^(OPENAI|ANTHROPIC|CLAUDE|CODEX|GH_|GITHUB_|OPENCODE_)/i.test(key)) continue;
    env[key] = value;
  }
  for (const dir of ['data', 'config', 'cache', 'state']) mkdirSync(path.join(stateRoot, dir), { recursive: true });
  Object.assign(env, {
    WORKFLOW_API_KEY: input[p.apiKeyEnv] ?? '',
    XDG_DATA_HOME: path.join(stateRoot, 'data'), XDG_CONFIG_HOME: path.join(stateRoot, 'config'),
    XDG_CACHE_HOME: path.join(stateRoot, 'cache'), XDG_STATE_HOME: path.join(stateRoot, 'state'),
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode',
    OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true', OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
  });
  // Use one named provider per worker; no subscription credentials or fallback models.
  const provider = {
    npm: '@ai-sdk/openai-compatible', name: `Workflow ${providerID}`,
    options: { baseURL: p.baseURL, apiKey: '{env:WORKFLOW_API_KEY}' },
    models: { [p.model]: { name: p.model, limit: { context: p.contextLimit, output: p.outputLimit }, options: p.options } },
  };
  const readOnly = ['git status*', 'git diff*', 'git log*', 'git show*', 'git ls-files*', 'git rev-parse*'];
  const permission: Record<string, unknown> = {
    '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', lsp: 'allow', task: 'deny', plan_enter: 'deny', plan_exit: 'deny', question: 'deny',
    edit: 'deny', bash: Object.fromEntries([['*', 'deny'], ...readOnly.map(x => [x, 'allow'])]),
  };
  const workerPermission = {
    ...permission, edit: 'allow',
    bash: { '*': 'allow', 'git push*': 'deny', 'gh *': 'deny', 'git reset --hard*': 'deny', 'git clean*': 'deny', 'git checkout*': 'deny', 'git switch*': 'deny' },
  };
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    $schema: 'https://opencode.ai/config.json', model: `workflow/${p.model}`, small_model: `workflow/${p.model}`,
    enabled_providers: ['workflow'], provider: { workflow: provider }, autoupdate: false, share: 'disabled',
    plugin: [], mcp: {}, permission, default_agent: 'executor',
    agent: { build: { disable: true }, plan: { disable: true }, general: { disable: true }, explore: { disable: true }, scout: { disable: true },
      executor: { mode: 'primary', description: 'Scoped implementation worker', prompt: readFileSync(path.join(root, 'prompts/executor.txt'), 'utf8'), permission: workerPermission, steps: 150 },
      investigator: { mode: 'primary', description: 'Read-only repository investigator', prompt: readFileSync(path.join(root, 'prompts/investigator.txt'), 'utf8'), permission, steps: 50 } },
  });
  return env;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; server.close(() => resolve(port)); });
  });
}
export function workerPrompt(task: Task): string {
  return 'CURRENT_TASK_CONTRACT\n' + JSON.stringify(taskContract(task), null, 2) + '\nEND_TASK_CONTRACT\nREQUIRED_REPORT_SCHEMA\n' + JSON.stringify(reportJsonSchema()) + '\nEND_REPORT_SCHEMA\nFollow this revision. Finish with exactly one JSON report object, no markdown fences or extra text.';
}

export class OpenCodeWorker implements Worker {
  private active = new Map<string, { child: ChildProcess; url: string; auth: string; session?: string; controller: AbortController }>();
  constructor(readonly root: string, readonly config: Config, readonly env: NodeJS.ProcessEnv) {}
  async repairSession(task: Task): Promise<WorkerResult> {
    if (!task.sessionID) throw new Error('Session repair requires an existing session');
    return this.run(task, () => { throw new Error('Session repair must not create a session'); }, true);
  }
  async run(task: Task, onSession: (id: string) => void, repairOnly = false): Promise<WorkerResult> {
    const stateRoot = path.join(this.root, '.runtime', 'workers', task.spec.id);
    mkdirSync(stateRoot, { recursive: true });
    const password = randomBytes(24).toString('hex');
    const env = workerEnv(this.root, this.config, task.spec.provider, this.env, password, stateRoot);
    const port = await freePort(); const executable = opencodeExecutable(this.root);
    const memoryReport = path.join(stateRoot, 'memory-' + task.attempts + '-' + (repairOnly ? 'repair-' + Date.now() : task.runId) + '.json');
    const guarded = memoryGuardLaunch(this.root, memoryReport + '.launch.json', memoryReport, this.config.workerMemoryLimitMB ?? 3072,
      executable.command, [...executable.args, 'serve', '--hostname', '127.0.0.1', '--port', String(port)]);
    const stream = createWriteStream(path.join(stateRoot, 'server.log'), { flags: 'a' });
    const child = spawn(process.execPath, [path.join(this.root, 'dist/src/worker-host.js'), guarded.command, ...guarded.args], {
      cwd: task.worktree!, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let launchError: Error | undefined; child.on('error', e => { launchError = e; });
    const log = (chunk: Buffer) => stream.write(redact(chunk.toString(), { ...this.env, ...env }));
    child.stdout!.on('data', log); child.stderr!.on('data', log);
    child.once('close', () => stream.end());
    const entry = { child, url: `http://127.0.0.1:${port}`, auth: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'), session: task.sessionID, controller: new AbortController() };
    this.active.set(task.spec.id, entry);
    child.once('close', () => entry.controller.abort(workerExitError(memoryReport)));
    let lastTranscript: any[] = [];
    const request = async (route: string, method = 'GET', body?: unknown, timeout = 15000): Promise<any> => {
      try {
        const res = await fetch(entry.url + route, { method, headers: { Authorization: entry.auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(timeout)]) });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 3000));
        const text = await res.text(); return text ? JSON.parse(text) : null;
      } catch (error) {
        const cause = error instanceof Error ? error.cause as { code?: string; message?: string } | undefined : undefined;
        throw new Error(redact('OpenCode ' + method + ' ' + route + ': ' + String(error) + (cause ? ' [' + (cause.code ?? '') + '] ' + (cause.message ?? '') : ''), { ...this.env, ...env }), { cause: error });
      }
    };
    try {
      let healthy = false;
      for (let n = 0; n < 120; n++) {
        if (launchError) throw launchError;
        entry.controller.signal.throwIfAborted();
        if (child.exitCode !== null || child.signalCode !== null) throw workerExitError(memoryReport);
        try { healthy = Boolean((await request('/global/health', 'GET', undefined, 1000)).healthy); if (healthy) break; } catch { entry.controller.signal.throwIfAborted(); }
        await delay(250);
      }
      if (!healthy) throw new Error('OpenCode startup timed out; inspect server.log');
      if (entry.session) await request(`/session/${entry.session}`);
      else { entry.session = (await request('/session', 'POST', { title: task.spec.title })).id; onSession(entry.session!); }
      let before: any[] = await request(`/session/${entry.session}/message`);
      if (before.some(m => m.info?.agent === 'plan')) throw new Error('Session contains built-in Plan history; do not resume it as an execution session');
      let archiveFile: string | undefined;
      const repaired = await repairSessionHistory(request, entry.session!, before, record => {
        archiveFile = path.join(stateRoot, 'history-repair-' + task.attempts + '-' + Date.now() + '.json');
        writeFileSync(archiveFile, redact(JSON.stringify({ taskId: task.spec.id, planRevision: task.spec.planRevision, runId: task.runId, attempt: task.attempts, ...record }, null, 2), { ...this.env, ...env }));
      });
      before = repaired.transcript;
      if (repairOnly) return { report: { sessionID: entry.session, removed: repaired.removed, archiveFile }, transcript: before, tokens: 0, cost: 0 };
      const seen = new Set(before.map(m => m.info.id));
      const model = this.config.providers[task.spec.provider]!;
      const { response, transcript } = await promptAsync(request, entry.session!, {
        model: { providerID: 'workflow', modelID: model.model }, agent: task.spec.mode === 'investigate' ? 'investigator' : 'executor',
        // OpenCode 1.19.3 native format=json_schema breaks persisted message reads
        // (OutputFormatJsonSchema Class encoding). Keep plain transport and enforce
        // the identical report schema in our own protocol, including on resume.
        parts: [{ type: 'text', text: workerPrompt(task) }],
      }, { timeoutMs: this.config.taskTimeoutMinutes * 60000, signal: entry.controller.signal, onSnapshot: value => { lastTranscript = value; } });
      writeFileSync(path.join(stateRoot, `response-${task.attempts}.json`), redact(JSON.stringify(response, null, 2), { ...this.env, ...env }));
      if (response.info?.error) throw new Error(`Worker failed: ${JSON.stringify(response.info.error)}`);
      if (response.info?.finish && !['stop', 'end_turn'].includes(response.info.finish)) throw new Error(`Worker stopped without final completion: ${response.info.finish}`);
      const finalText = (response.parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n');
      let report: unknown;
      try { report = JSON.parse(finalText); } catch { throw new Error('Worker final output is not a strict JSON report; refusing free text as completion. Inspect response artifact.'); }
      const fresh = transcript.filter(m => !seen.has(m.info.id) && m.info.role === 'assistant');
      return { report, transcript, tokens: fresh.reduce((sum, m) => sum + (m.info.tokens?.input ?? 0) + (m.info.tokens?.output ?? 0) + (m.info.tokens?.reasoning ?? 0), 0), cost: fresh.reduce((sum, m) => sum + (m.info.cost ?? 0), 0) };
    } catch (error) {
      writeFileSync(path.join(stateRoot, repairOnly ? 'history-repair-failure-' + task.attempts + '-' + Date.now() + '.json' : 'failure-' + task.attempts + '.json'), redact(JSON.stringify({
        taskId: task.spec.id, planRevision: task.spec.planRevision, runId: task.runId, attempt: task.attempts,
        sessionID: entry.session, error: String(error), transcript: lastTranscript,
        memoryGuard: readMemoryReport(memoryReport), memoryReport,
      }, null, 2), { ...this.env, ...env }));
      throw error;
    } finally {
      entry.controller.abort(new Error('Worker closed'));
      const closed = child.exitCode !== null ? Promise.resolve() : new Promise<void>(resolve => child.once('close', () => resolve()));
      killTree(child); this.active.delete(task.spec.id);
      await Promise.race([closed, delay(5000)]);
    }
  }
  async cancel(id: string): Promise<void> {
    const entry = this.active.get(id); if (!entry) return;
    entry.controller.abort(new Error('Worker cancelled'));
    if (entry.session) {
      try { await fetch(`${entry.url}/session/${entry.session}/abort`, { method: 'POST', headers: { Authorization: entry.auth }, signal: AbortSignal.timeout(3000) }); } catch { /* process termination follows */ }
    }
    killTree(entry.child);
  }
  async close(): Promise<void> { await Promise.all([...this.active.keys()].map(id => this.cancel(id))); }
}
