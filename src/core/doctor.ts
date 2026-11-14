// Chorus's side of the doctor (docs/doctor.md): the checks themselves are in @chauvoluuhuong/chorus-core/doctor; this file keeps
// what Chorus remembers between runs (~/.chorus/doctor/), gives the deeper test a terminal, installs and signs in on request,
// and sends an issue report. Used by `chorus doctor` (src/cli/doctor.ts) and the desktop (src/serve/server.ts).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { AGENTS, buildIssue, deepTest, fastCheck, latestRelease, redact, type DeepEvent, type DeepReport, type FastReport, type Host, type TuiHost } from '@chauvoluuhuong/chorus-core/doctor';
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
/** Versions the version matrix tested after this build, per CLI, from the backend at launch (chorus-admin
 *  docs/client-contract.md); the doctor counts them like its built-in list. */
export const remoteTested = (): Partial<Record<AgentId, string[]>> => readJson(path.join(DOCTOR_DIR(), 'tested.json'), {});
export function saveRemoteTested(tested: Partial<Record<AgentId, string[]>>) {
  if (JSON.stringify(tested) === JSON.stringify(remoteTested())) return;
  // the desktop server checks again when the list changes (src/serve/server.ts, start)
  writeJson(path.join(DOCTOR_DIR(), 'tested.json'), tested);
}
function addKnown(entry: string) {
  writeJson(path.join(DOCTOR_DIR(), 'known.json'), [...new Set([...known(), entry])]);
}

/** The short test. Nothing is kept on disk: in the desktop the server runs it and holds the one answer every screen reads
 *  (ChorusServer.checkAgents); `chorus doctor` runs it each time. */
export async function check(agents?: AgentId[]): Promise<FastReport> {
  return fastCheck({ agents, known: known(), tested: remoteTested() });
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
/** No check was ever shown here: the desktop opens the doctor screen at once, before the short check is done. */
export const firstLaunch = () => !fs.existsSync(seenFile());
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
  // one folder per agent: the desktop tests the agents side by side, and two runs can start in the same millisecond
  const dir = path.join(DOCTOR_DIR(), `${new Date().toISOString().replace(/[:.]/g, '-')}-${agent}`);
  const report = await deepTest(agent, { dir, tui, onEvent, only });
  writeJson(path.join(dir, 'report.json'), { ...versions(), report });
  if (report.ok && report.version && !only) addKnown(`${agent}@${report.version}`);
  return { dir, report };
}

export function issue(fast: FastReport, deep: DeepReport[]) {
  return buildIssue(fast, deep, host());
}

/** What the user says the report is about. Every report from the app is a user report with the lowest priority; the labels are
 *  put on by .github/workflows/issue-labels.yml from the marker in the body (a user without access to the repo can't set them). */
export const ISSUE_KINDS = {
  bug: { name: 'Bug', labels: ['bug'] },
  cli: { name: 'An agent does not work with Chorus', labels: ['bug', 'cli-compat'] },
  feature: { name: 'Feature request', labels: ['enhancement'] },
  question: { name: 'Question', labels: ['question'] },
  other: { name: 'Other', labels: [] },
} as const;
export type IssueKind = keyof typeof ISSUE_KINDS;
export const USER_LABELS = ['user report', 'priority: low'];
export const isIssueKind = (k: unknown): k is IssueKind => typeof k === 'string' && Object.hasOwn(ISSUE_KINDS, k);

/** What the app knows besides the doctor's own report: filled in by the server (chats, errors) and the page (window, errors). */
export interface ReportContext {
  /** this session's detailed tests; the newest one on disk counts for an agent not tested this session */
  deep?: DeepReport[];
  chats?: { agent: string; state: string; cli_version: string | null }[];
  projects?: number;
  /** the page: native window or browser, screen and window size, language, the page it was on */
  client?: Record<string, unknown>;
  /** the short check to report: the desktop passes the server's (one check for every screen); a new one otherwise */
  fast?: FastReport;
  /** the newest errors the server and the page saw */
  errors?: string[];
  update?: { currentVersion: string; version: string } | null;
  /** the paid module, when it is there: its version and state (never the account) */
  pro?: { version?: string; state: string } | null;
}

/** The small structured part of a report, for the admin list: nothing the details text does not say too. */
export interface ReportSetup {
  appVersion: string;
  channel: 'preview' | 'production' | 'dev';
  os: string;
  arch: string;
  clis: Partial<Record<AgentId, { version: string | null; state: string }>>;
}

const gb = (n: number) => `${(n / 2 ** 30).toFixed(1)} GB`;
const count = (xs: string[]) => Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {})).map(([k, n]) => `${k} ${n}`).join(', ') || 'none';
const CLI_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' };
/** The Doctor's word for a CLI's state: the same as the desktop's (agentStatus in src/desktop/app.js). */
export const STATE_LABEL: Record<string, string> = { ready: 'Ready', 'needs-login': 'Not logged in', untested: 'New version', missing: 'Not installed' };

/** How this copy of Chorus was installed: the installer keeps versions/<v>/app (src/serve/updates.ts), npm a global module. */
export function installMethod(file = import.meta.filename): string {
  const real = (() => {
    try {
      return fs.realpathSync(file);
    } catch {
      return file;
    }
  })();
  if (/\/versions\/[^/]+\/app\//.test(real)) return 'curl installer';
  if (real.includes('/lib/node_modules/')) return 'npm global';
  return 'from a checkout';
}
export const channelOf = (version: string, install = installMethod()): ReportSetup['channel'] => (/-preview\.\d+$/.test(version) ? 'preview' : install === 'from a checkout' ? 'dev' : 'production');

/** The OS by its product name and version (macOS 15.2, Ubuntu 24.04.1 LTS), not the kernel's; nothing that names the machine. */
export function osName(): string {
  if (process.platform === 'darwin') {
    const v = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 2000 }).stdout?.trim();
    return `macOS ${v || '?'}`;
  }
  if (process.platform === 'linux') {
    const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec((() => { try { return fs.readFileSync('/etc/os-release', 'utf8'); } catch { return ''; } })())?.[1];
    return pretty || 'Linux';
  }
  return `${os.type()} ${os.release()}`;
}

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** The report the dialog shows: the doctor's (a fresh short check, the detailed tests on file) and everything else the app can
 *  tell without the user's prompts, code or file names, and without what names the machine or the person (no host name, user
 *  name, serial or hardware id). The user reads and edits it before it is sent. `setup` and `chips` are the same facts, short. */
export async function reportDetails(ctx: ReportContext = {}): Promise<{ title: string; details: string; kind: IssueKind; setup: ReportSetup; chips: string[] }> {
  const fast = ctx.fast ?? (await check());
  const onDisk = lastDeep();
  const deep = [...(ctx.deep ?? [])];
  for (const a of AGENTS) if (!deep.some(d => d.agent === a) && onDisk[a]) deep.push(onDisk[a]!);
  const base = issue(fast, deep);
  const v = versions();
  const install = installMethod();
  const channel = channelOf(v.chorus, install);
  const cpus = os.cpus();
  const c = ctx.client ?? {};
  const latest = await latestReleases().catch(() => ({}) as Partial<Record<AgentId, string>>);
  const osn = osName();
  const label = (a: FastReport['agents'][number]) => STATE_LABEL[a.state] ?? a.state;
  const str = (k: string) => (typeof c[k] === 'string' || typeof c[k] === 'number' ? String(c[k]) : '');
  const window = [str('window') === 'native' ? 'native app' : str('window') ? `${str('window')}` : '', str('screen') || str('size'), str('language') && `language ${str('language')}`, str('view') && `on the ${str('view')} page`].filter(Boolean).join(', ');
  const deepLines = deep.flatMap(d => {
    const when = 'at' in d ? ` ${day(String((d as { at: string }).at))}` : '';
    const rs = d.results ?? [];
    const passed = rs.filter(r => r.status === 'pass' || r.status === 'skip').length;
    if (d.ok) return [`- ${d.agent} ${d.version ?? '?'}: passed${when} (${passed} of ${rs.length})`];
    const bad = rs.filter(r => r.status === 'fail' || r.status === 'blocked');
    return [
      `- ${d.agent} ${d.version ?? '?'}: failed${when} (${passed} of ${rs.length})${bad.map(r => ` · ✖ ${r.id} ${r.title}${r.reason ? ` (${r.reason})` : ''}`).join('')}`,
      ...bad.flatMap(r => (r.evidence ? [`  evidence of ${r.id} (last 40 lines):`, ...r.evidence.split('\n').slice(-40).map(l => `    ${l.slice(0, 300)}`)] : [])),
    ];
  });
  const lines = [
    '### Chorus',
    `- App: Chorus ${v.chorus} (${channel} channel), installed ${install === 'from a checkout' ? 'from a checkout' : `with the ${install}`}`,
    `- chorus-core ${v.core}${ctx.pro ? ` · paid module ${ctx.pro.version ?? '?'} (${ctx.pro.state})` : ' · paid module: not loaded'}`,
    ...(window ? [`- Window: ${window}`] : []),
    `- Server up ${Math.round(process.uptime() / 60)} min · update: ${ctx.update ? `${ctx.update.version} waiting` : 'none waiting'}`,
    '',
    '### This machine',
    `- ${osn} (${os.type()} ${os.release()}), ${os.arch()}, ${cpus[0]?.model?.trim() ?? '?'} × ${cpus.length}, ${gb(os.totalmem())} RAM (${gb(os.freemem())} free)`,
    `- Node ${process.versions.node} · shell ${process.env.SHELL ?? '?'} · terminal: ${process.env.TERM_PROGRAM ?? (str('window') === 'native' ? 'Chorus' : '?')}`,
    `- Locale ${Intl.DateTimeFormat().resolvedOptions().locale}, time zone ${Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    '',
    '### AI CLIs (short check, just now)',
    '| CLI | Installed | State | Newest tested | Newest release | Install | Login |',
    '|---|---|---|---|---|---|---|',
    ...fast.agents.map(a => `| ${CLI_NAMES[a.agent] ?? a.name} | ${a.version ?? '–'} | ${label(a)} | ${a.newestTested ?? '–'} | ${latest[a.agent] ?? '–'} | ${a.version ? (a.method ?? '?') : '–'} | ${a.state === 'missing' ? '–' : a.login === 'yes' ? 'ok' : a.login === 'no' ? 'no' : '?'} |`),
    `- Binaries: ${fast.agents.map(a => `${a.agent} ${a.bin ?? '–'}`).join(' · ')}`,
    ...fast.agents.filter(a => a.updatesItself).map(a => `- ${a.agent} updates itself: ${a.updatesItself}`),
    '',
    '### Detailed tests on file',
    ...(deepLines.length ? deepLines : ['- none']),
    `- Passed here before: ${known().join(', ') || 'none'}; tested after this build: ${Object.entries(remoteTested()).filter(([, vs]) => vs?.length).map(([a, vs]) => `${a} ${vs!.join(', ')}`).join('; ') || 'none'}`,
    '',
    '### Use',
    ...(ctx.chats ? [`- Chats: ${ctx.chats.length} (${count(ctx.chats.map(t => t.agent))}; ${count(ctx.chats.map(t => t.state))}) · CLI versions used: ${count(ctx.chats.map(t => `${t.agent} ${t.cli_version ?? '?'}`))}`] : []),
    ...(ctx.projects !== undefined ? [`- Projects: ${ctx.projects}`] : []),
    ...(!ctx.chats && ctx.projects === undefined ? ['- not known here'] : []),
  ];
  if (ctx.errors?.length) lines.push('', '### Recent errors (last 30 lines)', ...ctx.errors.slice(-30).map(e => e.replace(/\s+/g, ' ').slice(0, 500)));
  const failed = deep.some(d => !d.ok);
  const setup: ReportSetup = {
    appVersion: v.chorus,
    channel,
    os: osn,
    arch: os.arch(),
    clis: Object.fromEntries(fast.agents.map(a => [a.agent, { version: a.version ?? null, state: label(a) }])),
  };
  const chips = [`Chorus ${v.chorus} · ${channel}`, `core ${v.core}`, install, `${osn} · ${os.arch()}`, ...fast.agents.map(a => `${CLI_NAMES[a.agent] ?? a.name}${a.version ? ` ${a.version}` : ''} · ${label(a)}`)];
  return { title: base.title === 'doctor: report' ? '' : base.title, details: redact(lines.join('\n')).slice(0, 60_000), kind: failed ? 'cli' : 'bug', setup, chips };
}

/** The issue as it is sent: the kind and what the user wrote first, then the details they read. */
export function composeIssue(o: { kind: IssueKind; summary: string; what: string; details: string }): { title: string; body: string; labels: string[] } {
  const k = ISSUE_KINDS[o.kind];
  const summary = o.summary.trim().replace(/\s+/g, ' ').slice(0, 200) || 'report from the app';
  const body = [
    `<!-- chorus-report kind=${o.kind} -->`,
    `**Type:** ${k.name} · sent from the Chorus app (user report)`,
    '',
    '### What happened',
    '',
    o.what.trim() || '_Not filled in._',
    '',
    o.details,
  ].join('\n');
  return { title: `[${k.name}] ${summary}`, body: redact(body).slice(0, 65_000), labels: [...k.labels, ...USER_LABELS] };
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
  // no opener here (a container, a server): nothing opens, and chorus serve must not stop over it (it did, 2026-11-08)
  spawn(cmd, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

/** agy has no login command: its first start signs in, so it starts in a Terminal window (macOS) where the user can do it. */
export function openInTerminal(command: string): boolean {
  if (process.platform !== 'darwin') return false;
  const script = `tell application "Terminal"\n activate\n do script ${JSON.stringify(command)}\nend tell`;
  return spawnSync('osascript', ['-e', script], { stdio: 'ignore' }).status === 0;
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
