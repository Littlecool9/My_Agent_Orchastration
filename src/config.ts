import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { ConfigSchema, type Config } from './schema.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function configFile(root = ROOT): string {
  return path.join(root, existsSync(path.join(root, 'workflow.local.json')) ? 'workflow.local.json' : 'workflow.config.json');
}
export function loadConfig(root = ROOT): Config {
  return ConfigSchema.parse(JSON.parse(readFileSync(configFile(root), 'utf8')));
}
export function configStatus(root: string, active: Config): {
  configFile: string; diskExecutionEnabled: boolean | null; restartRequired: boolean | null; configError?: string;
} {
  const file = configFile(root);
  try {
    const disk = loadConfig(root);
    return { configFile: file, diskExecutionEnabled: disk.executionEnabled, restartRequired: !isDeepStrictEqual(active, disk) };
  } catch (error) {
    return { configFile: file, diskExecutionEnabled: null, restartRequired: null, configError: String(error) };
  }
}
export function loadEnv(root = ROOT): NodeJS.ProcessEnv {
  const result = { ...process.env };
  const file = path.join(root, '.env.local');
  if (!existsSync(file)) return result;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error('Invalid .env.local syntax. Use NAME=value; no shell expansion.');
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]!] = value;
  }
  return result;
}
export function redact(value: string, env: NodeJS.ProcessEnv): string {
  let out = value;
  for (const [key, secret] of Object.entries(env)) {
    if (/(KEY|TOKEN|SECRET|PASSWORD)/i.test(key) && secret && secret.length >= 6) out = out.split(secret).join('[REDACTED]');
  }
  return out;
}
export function executionGuard(config: Config, root = ROOT): void {
  if (config.executionEnabled) return;
  const status = configStatus(root, config);
  const advice = status.diskExecutionEnabled === true
    ? 'The selected config file already enables execution. Restart the daemon to load it; no new local override is needed.'
    : status.configError
      ? 'The selected config file is invalid or unreadable. Fix it before restarting. See workflow_config.configError.'
      : 'After user authorization, set executionEnabled=true in the selected config file, then restart the daemon.';
  throw new Error('Execution is disabled in the running daemon. ' + advice
    + ' Selected config: ' + status.configFile
    + '. Run npm run stop, then npm run start from the workflow installation directory only when no task is running/verifying.'
    + ' workflow.local.json is optional; if present it must contain a complete configuration, not a partial override.'
    + ' A daemon restart preserves stored plans and does not dispatch tasks.');
}
export function runtime(root = ROOT): string {
  const dir = path.join(root, '.runtime'); mkdirSync(dir, { recursive: true }); return dir;
}
