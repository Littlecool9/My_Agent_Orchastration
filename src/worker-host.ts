import { spawn } from 'node:child_process';
import { killTree } from './process.js';

// IPC is the lifetime lease: an unexpected daemon exit stops its worker server.
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Missing worker executable');
const child = spawn(command, args, { env: process.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.on('error', () => process.exit(1));
child.on('close', code => process.exit(code ?? 1));
process.on('disconnect', () => killTree(child));
process.on('SIGTERM', () => killTree(child));
process.on('SIGINT', () => killTree(child));
