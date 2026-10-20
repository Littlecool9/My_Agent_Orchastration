import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { TaskSpecSchema, type Task, type TaskSpec, type RepositoryConfiguration } from './schema.js';

export class Store {
  private changes = new EventEmitter().setMaxListeners(0);
  constructor(readonly root: string) { mkdirSync(root, { recursive: true }); }
  dir(id: string): string {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid task ID');
    return path.join(this.root, id);
  }
  file(id: string): string { return path.join(this.dir(id), 'task.json'); }
  get(id: string): Task { return JSON.parse(readFileSync(this.file(id), 'utf8')) as Task; }
  all(): Task[] {
    return readdirSync(this.root, { withFileTypes: true }).filter(d => d.isDirectory() && existsSync(this.file(d.name))).map(d => this.get(d.name));
  }
  create(input: TaskSpec, configuration?: RepositoryConfiguration): Task {
    const spec = TaskSpecSchema.parse(input);
    if (existsSync(this.dir(spec.id))) throw new Error('Task ID already exists');
    mkdirSync(this.dir(spec.id));
    if (configuration) this.writeConfiguration(spec, configuration);
    const now = new Date().toISOString();
    return this.save({ spec, configuration, status: 'planned', revision: 0, attempts: 0, createdAt: now, updatedAt: now, checks: [], reviews: [], totalTokens: 0, cost: 0 });
  }
  writeConfiguration(spec: TaskSpec, configuration: RepositoryConfiguration): void {
    writeFileSync(path.join(this.dir(spec.id), `configuration-v${spec.planRevision}.json`), JSON.stringify({ spec, configuration }, null, 2));
  }
  save(task: Task): Task {
    task.updatedAt = new Date().toISOString(); task.revision++;
    const temp = `${this.file(task.spec.id)}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(task, null, 2)); renameSync(temp, this.file(task.spec.id));
    this.changes.emit('change', task.spec.id);
    return task;
  }
  onChange(listener: (id: string) => void): () => void {
    this.changes.on('change', listener);
    return () => { this.changes.off('change', listener); };
  }
  event(id: string, kind: string, detail: unknown): void {
    writeFileSync(path.join(this.dir(id), 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, detail }) + '\n', { flag: 'a' });
  }
}
