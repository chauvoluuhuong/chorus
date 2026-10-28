// Shared helpers for the risk harness (docs/risks/README.md).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type Status = 'pass' | 'fail' | 'risk' | 'skip' | 'unknown';
export interface Result {
  status: Status;
  summary: string;
  /** measured facts, written to result.json */
  facts: Record<string, unknown>;
}
export interface Ctx {
  /** where this run's evidence goes */
  out: string;
  agents: string[];
  log: (s: string) => void;
}
export interface Case {
  id: string;
  title: string;
  /** free = no model call; cheap = a few real model calls; manual = cannot run here */
  cost: 'free' | 'cheap' | 'manual';
  run(ctx: Ctx): Promise<Result>;
}

export const SCRUB_ENV = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID'];
export const cleanEnv = () => {
  const e = { ...process.env };
  for (const k of SCRUB_ENV) delete e[k];
  return e as Record<string, string>;
};

export function tmpWorkspace(tag: string) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `chorus-risk-${tag}-`)));
  spawnSync('git', ['init', '-q'], { cwd: ws });
  return ws;
}

export function cliVersion(cli: string): string | undefined {
  const r = spawnSync(cli, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) return undefined;
  return r.stdout.trim().replace(/^codex-cli /, '').replace(/ \(.*/, '');
}

/**
 * Same idea as tools/probe: home path, user name and e-mail addresses never reach a fixture. Claude's `system` init events list the
 * user's own skills and plugins, so they are replaced by a stub.
 */
export function redact(s: string) {
  const user = os.userInfo().username;
  return s
    .split('\n')
    .map(l => (/"type":"system","subtype":"(init|commands_changed|notification)"/.test(l) ? '{"type":"system","redacted":"user skill and plugin lists"}' : l))
    .join('\n')
    .split(os.homedir()).join('~')
    .replace(new RegExp(`\\b${user}\\b`, 'g'), 'user')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>');
}

export function save(ctx: Ctx, name: string, data: string | object) {
  fs.mkdirSync(ctx.out, { recursive: true });
  fs.writeFileSync(path.join(ctx.out, name), redact(typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
}

import { spawn } from 'node:child_process';
export interface RunOut { stdout: string; stderr: string; code: number | null; timedOut: boolean; ms: number }
/** Run a CLI with stdin closed and a clean env (rule 5 in the README). */
export function runCli(bin: string, args: string[], cwd: string, timeoutMs = 240_000): Promise<RunOut> {
  const t0 = Date.now();
  return new Promise(resolve => {
    const c = spawn(bin, args, { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const t = setTimeout(() => { timedOut = true; c.kill('SIGKILL'); }, timeoutMs);
    c.stdout.on('data', d => (stdout += d));
    c.stderr.on('data', d => (stderr += d));
    c.on('close', code => { clearTimeout(t); resolve({ stdout, stderr, code, timedOut, ms: Date.now() - t0 }); });
    c.on('error', e => { clearTimeout(t); resolve({ stdout, stderr: stderr + String(e), code: null, timedOut, ms: Date.now() - t0 }); });
  });
}
