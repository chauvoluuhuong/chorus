// Chorus's side of the doctor (docs/doctor.md): the checks themselves are in @chauvoluuhuong/chorus-core/doctor; this file keeps
// what Chorus remembers between runs (~/.chorus/doctor/), gives the deeper test a terminal, installs and signs in on request,
// and sends an issue report. Used by `chorus doctor` (src/cli/doctor.ts) and the desktop (src/serve/server.ts).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { AGENTS, buildIssue, deepTest, fastCheck, latestRelease, type DeepEvent, type DeepReport, type FastReport, type Host, type TuiHost } from '@chauvoluuhuong/chorus-core/doctor';
import { nodePtyFactory } from '../app/pty.ts';
import { VirtualScreen } from '../app/screen.ts';
import type { AgentId } from './types.ts';

const require = createRequire(import.meta.url);
export const DOCTOR_DIR = () => path.join(process.env.CHORUS_DOCTOR_HOME ?? path.join(os.homedir(), '.chorus'), 'doctor');
/** Public: buyers file issues and doctor reports here (CLAUDE.md, "Two repos"). */
export const ISSUES_REPO = 'chauvoluuhuong/chorus';

const readJson = (f: string, d: any) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const writeJson = (f: string, v: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
};

export function versions(): { chorus: string; core: string } {
  const own = readJson(path.resolve(import.meta.dirname, '../../package.json'), {});
  let core = '?';
  try {
    core = require('@chauvoluuhuong/chorus-core/package.json').version;
  } catch {
    /* bundled without its package.json */
  }
  return { chorus: own.version ?? '?', core };
}

export function host(): Host {
  const v = versions();
  const install = fs.realpathSync(import.meta.filename).includes('/lib/node_modules/') ? 'npm global (installer or npm install -g)' : 'from a checkout';
  return { app: `chorus ${v.chorus}`, install, core: v.core };
}

/** agent@version entries that passed the deeper test on this machine: Ready from then on (docs/doctor.md §2.1). */
export const known = (): string[] => readJson(path.join(DOCTOR_DIR(), 'known.json'), []);
function addKnown(entry: string) {
  writeJson(path.join(DOCTOR_DIR(), 'known.json'), [...new Set([...known(), entry])]);
}

/** The short test; the last one is kept with its time, so the Doctor page shows it without running it again. */
export async function check(agents?: AgentId[]): Promise<FastReport> {
  const r = await fastCheck({ agents, known: known() });
  if (!agents) writeJson(path.join(DOCTOR_DIR(), 'fast.json'), { at: new Date().toISOString(), report: r });
  return r;
}
export function lastCheck(): { at: string; report: FastReport } | undefined {
  return readJson(path.join(DOCTOR_DIR(), 'fast.json'), undefined);
}

/** Each agent's newest detailed test, from the report folders (survives a restart). */
export function lastDeep(): Partial<Record<AgentId, DeepReport & { at: string }>> {
  const out: Partial<Record<AgentId, DeepReport & { at: string }>> = {};
  const dir = DOCTOR_DIR();
  const runs = fs.existsSync(dir) ? fs.readdirSync(dir).filter(d => /^\d{4}-\d\d-\d\dT/.test(d)).sort() : [];
  for (const run of runs) {
    const r = readJson(path.join(dir, run, 'report.json'), undefined)?.report as DeepReport | undefined;
    if (r?.agent && r.results?.length === 7) out[r.agent] = { ...r, at: fs.statSync(path.join(dir, run, 'report.json')).mtime.toISOString() };
  }
  return out;
}

/** The newest release of each CLI on npm, looked up at most once an hour (none for agy). */
let latest: { at: number; v: Partial<Record<AgentId, string>> } | undefined;
export async function latestReleases(): Promise<Partial<Record<AgentId, string>>> {
  if (latest && Date.now() - latest.at < 3_600_000) return latest.v;
  const v = Object.fromEntries(await Promise.all(AGENTS.map(async a => [a, await latestRelease(a, 2500)] as const)));
  latest = { at: Date.now(), v };
  return v;
}

/** What the last shown check saw; the desktop popup opens again only when one of these changes (docs/doctor.md §6.1). */
interface Seen {
  chorus: string;
  core: string;
  clis: Record<string, string>;
  date: string;
}
const seenFile = () => path.join(DOCTOR_DIR(), 'last.json');
export function isDue(fast: FastReport): boolean {
  const s: Seen | undefined = readJson(seenFile(), undefined);
  if (!s) return true;
  const v = versions();
  if (s.chorus !== v.chorus || s.core !== v.core) return true;
  return fast.agents.some(a => (s.clis[a.agent] ?? '') !== (a.version ?? ''));
}
export function markSeen(fast: FastReport) {
  const v = versions();
  writeJson(seenFile(), { ...v, clis: Object.fromEntries(fast.agents.map(a => [a.agent, a.version ?? ''])), date: new Date().toISOString() } satisfies Seen);
}

/** A real terminal for the approval scenario: node-pty and Chorus's own virtual screen (the same one chats use). */
export const tui: TuiHost = {
  open(bin, args, cwd, env) {
    const screen = new VirtualScreen(120, 40);
    const p = nodePtyFactory(bin, args, { cols: 120, rows: 40, cwd, env: env as Record<string, string> });
    p.onData(d => screen.write(d));
    screen.onReply(d => p.write(d));
    return {
      lines: () => screen.text(),
      write: d => p.write(d),
      close: () => {
        try {
          p.write('\x03');
          p.kill();
        } catch {
          /* gone */
        }
      },
    };
  },
};

export interface DeepRun {
  dir: string;
  report: DeepReport;
}

/** The deeper test for one CLI; evidence in ~/.chorus/doctor/<time>/<agent>/. A pass makes that version Ready here. */
export async function runDeep(agent: AgentId, onEvent?: (e: DeepEvent) => void, only?: string[]): Promise<DeepRun> {
  const dir = path.join(DOCTOR_DIR(), new Date().toISOString().replace(/[:.]/g, '-'));
  const report = await deepTest(agent, { dir, tui, onEvent, only });
  writeJson(path.join(dir, 'report.json'), { ...versions(), report });
  if (report.ok && report.version && !only) addKnown(`${agent}@${report.version}`);
  return { dir, report };
}

export function issue(fast: FastReport, deep: DeepReport[]) {
  return buildIssue(fast, deep, host());
}

const hasGh = () => spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
export const ghReady = hasGh;

/** Send the report the user has read: `gh issue create` when gh is signed in, else the new-issue page with the title only. */
export function sendIssue(title: string, body: string, file: string): { via: 'gh' | 'browser'; url?: string; error?: string } {
  fs.writeFileSync(file, body);
  if (hasGh()) {
    const r = spawnSync('gh', ['issue', 'create', '--repo', ISSUES_REPO, '--title', title, '--body-file', file], { encoding: 'utf8' });
    if (r.status === 0) return { via: 'gh', url: r.stdout.trim().split('\n').pop() };
    return { via: 'gh', error: (r.stderr || r.stdout).trim() };
  }
  // the body never goes in the URL (it can be long and has logs): it is on the clipboard and in the file
  spawnSync('pbcopy', [], { input: body });
  const url = `https://github.com/${ISSUES_REPO}/issues/new?title=${encodeURIComponent(title)}`;
  openUrl(url);
  return { via: 'browser', url };
}

export function openUrl(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
}

/** Run an install or login command the user asked for, with its output streamed to `onOutput`. */
export function runCommand(command: string, onOutput: (s: string) => void): Promise<number | null> {
  return new Promise(resolve => {
    const child = spawn('/bin/bash', ['-lc', command], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    child.stdout.on('data', d => onOutput(String(d)));
    child.stderr.on('data', d => onOutput(String(d)));
    child.on('close', resolve);
    child.on('error', e => (onOutput(String(e)), resolve(null)));
  });
}
