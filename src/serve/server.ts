// chorus serve: the local API the desktop app runs on (Phase 5, architecture §2). It hosts the same Controller as the CLI app,
// without a terminal: the agents run in PTYs here, their screens stream to the desktop over a WebSocket, and every operation
// (new chat, handoff, approvals, memory, skills, artifacts) is the Controller's. The desktop has no business logic of its own.
//
// Security: 127.0.0.1 only; a random token (in the first URL, then an HttpOnly SameSite=Strict cookie) on every request;
// the Host header must be ours (no DNS rebinding); WebSocket upgrades must come from our own origin; writes need X-Chorus: 1.
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { App, projectName, type AppIO, type Entry } from '../app/app.ts';
import { AGENTS, type Controller } from '../app/controller.ts';
import type { ItemState, RichLine } from '../app/compositor.ts';
import { effortsFor } from '../app/models.ts';
import { listWatchesText, PROJECT_TOOL_NAMES, readMailText, SERVE_TOOL_NAMES } from '../mcp/server.ts';
import { MCP_TOKEN_ENV, SERVE_URL_ENV } from '../mcp/pro.ts';
import { clearKeys, inputState, latestModels, menuShown, NATIVE_COMMANDS, liveAddDirDone, liveAddDirInput, liveAddDirKeys, codexGrantMessage, Mailbox, NEWLINE_KEYS, transcriptHas, TurnWatch, type ChatLook, type MailEvent, type Transport } from '@chauvoluuhuong/chorus-core';
import { computerDir } from '../app/screens.ts';
import type { ThreadHost } from '../app/thread-host.ts';
import { transcriptPath } from '../core/capture.ts';
import type { ThreadRow } from '../core/store.ts';
import { buildHandoff, handoffPrompt } from '../core/handoff.ts';
import { exportAll, exportProject } from '../core/export.ts';
import { SKIP_FLAG } from '../core/launch.ts';
import { defaultOpener } from '../core/opener.ts';
import { disabledSkills, expandSkillMentions, findNativeSkills, importSkill, listSkills, setSkillEnabled, sourceDir, syncSkills } from '../core/skills.ts';
import { matchFiles, projectFiles } from '../core/files.ts';
import { addSource, allSkills, CLI_NAMES, removeSource, scanSkills, SYNC_CLIS, syncSkill, tilde, unsyncSkill, type Cli } from '../core/skillsync.ts';
import type { AgentId } from '../core/types.ts';
import { CLIS, type AgentCheck, type DeepReport, type FastReport } from '@chauvoluuhuong/chorus-core/doctor';
import { check, firstLaunch, ghReady, host, isDue, lastDeep, latestReleases, markSeen, openInTerminal, openUrl, recordDeep, remoteTested, reportDetails, runCommand, runDeep, versions } from '../core/doctor.ts';
import { fileNote, MEDIA_MAX, viewFile } from './fileview.ts';
import { NotificationInbox } from './notifications.ts';
import { imageType, parseReport, ReportSender } from './reports.ts';
import { ChatLaunch, ProHost, type ProLoader } from './pro.ts';
import { SubThreads, TOOLS as SUB_TOOLS, TOOL_NAMES as SUB_TOOL_NAMES } from './subthreads.ts';
import { ProjectSettings } from '../core/projects.ts';
import { ProjectRuntime, type LiveWay } from './project-runtime.ts';
import { APPROVE_RESTART, CREATE_OPEN, DECLINE, appliedLine, checkNewProject, checkProposal, getProject, isComputer, needsRestart, newProjectCard, parseProposal, placeName, proposalCard, type AskerResult } from './project-tools.ts';
import { answerChannelWarning, CHANNEL_WAIT_MS, ChannelHub, makeTransports, screenRows, typeLine, wakeFor, type ChatSession } from './mail.ts';
import { TermLocks } from './termlock.ts';
import { callDetail, delta, heldInInput, KEYS, turnsPage, turnText, typedText, type CvDeps, type CvSent } from './chatview.ts';
import { SignIns } from './signin.ts';
import { skillSlug } from './slug.ts';
import { inContainer } from '../cli/screen.ts';
import type { UpdateCheck } from './updates.ts';
import type { ChatStart } from '@chauvoluuhuong/chorus-core/pro-loader';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '../..');
const UI_DIR = path.join(ROOT, 'src/desktop');
/** files of npm packages the page loads (no bundler, no CDN: the desktop works offline) */
const VENDOR: Record<string, string> = {
  'xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  'xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  'addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
  'addon-webgl.js': 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js',
};
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const DEFAULT_SIZE = { cols: 120, rows: 36 };
/** Follow Chorus: the channels the page's follow modal links to (the same two as FOLLOW_LINKS in src/desktop/follow.js) */
export const FOLLOW_LINKS: Record<string, string> = { youtube: 'https://www.youtube.com/@luuhuongtech?sub_confirmation=1', facebook: 'https://www.facebook.com/luuhuongtech/' };
/** a reported artifact served to a device: what a browser can show by itself */
const FILE_TYPES: Record<string, string> = { '.md': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.csv': 'text/plain; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf' };
/** The system's open command for a file or a link (macOS open, Linux xdg-open): an argument, never a shell string. */
const openOnThisComputer = (target: string): Promise<{ ok: boolean; error?: string }> => (process.env.CHORUS_NO_OPEN === '1' ? Promise.resolve({ ok: true }) : defaultOpener({ mode: 'default' }, /^https?:/i.test(target) ? { url: target, path: target } : { path: target }));
/**
 * How to sign in an AI CLI inside the Chorus box, from the computer's own terminal: Claude Code prints a link and waits for the code
 * pasted back; Codex needs --device-auth (its usual sign-in waits for the browser on the box's localhost:1455); agy asks on its first
 * start. Seen in the box on 2026-11-08 with Claude Code 2.1.310, Codex 0.164.0, agy 1.4.5 (sign-in not completed there yet).
 */
export function boxLoginCommand(agent: AgentId, name = 'chorus') {
  const login = { claude: 'claude auth login', codex: 'codex login --device-auth', agy: 'agy' }[agent];
  return `docker exec -it -u chorus ${name} ${login}`;
}

/** --host values that mean every address of this machine */
/** A chat with no turn and no tool call yet (Store.activityMark). */
const NO_ACTIVITY = '0/0/0';
/** A resumed chat whose row says working and that recorded nothing since its CLI started this long ago is idle (look()). */
export const STALE_TURN_MS = 15_000;

/** A home folder as one string, whatever link or relative path led to it. */
const realHome = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const WILDCARD = new Set(['0.0.0.0', '::', '[::]']);

/**
 * The names a request may use for this server, as they appear in a Host header (IPv6 in brackets). 127.0.0.1 and localhost always;
 * `--host <name>` adds that name; a wildcard (0.0.0.0, ::) adds this machine's own addresses, so another computer can open it by IP.
 */
export function hostNames(host?: string, interfaces: ReturnType<typeof os.networkInterfaces> = os.networkInterfaces()): string[] {
  const names = new Set(['127.0.0.1', 'localhost']);
  const add = (a: string) => names.add(a.includes(':') && !a.startsWith('[') ? `[${a}]` : a);
  if (host && WILDCARD.has(host)) for (const list of Object.values(interfaces)) for (const i of list ?? []) add(i.address.split('%')[0]);
  else if (host) add(host);
  return [...names];
}
const LITERAL = new Set(['POST ui', 'POST folders/pick', 'POST skills/import', 'GET skills/all', 'POST skills/sync', 'POST skills/sources', 'POST skills/sources/pick', 'POST skills/sources/remove', 'GET doctor/first', 'POST doctor/check', 'POST doctor/refresh', 'POST doctor/seen', 'POST doctor/open', 'POST doctor/run', 'POST doctor/issue', 'POST doctor/issue/image', 'POST doctor/issue/send', 'GET projects', 'GET projects/one', 'POST projects/folders', 'DELETE projects/folders', 'POST projects/variables', 'DELETE projects/variables', 'POST projects/restart-idle', 'POST projects/note']);

/** The App without a terminal: input and output go nowhere, the Controller drives it as usual. */
export function headlessIO(): AppIO {
  const stdin = Object.assign(new PassThrough(), { setRawMode: () => {}, isTTY: false });
  const stdout = new Writable({ write: (_c, _e, cb) => cb() });
  return { stdin, stdout, size: () => ({ cols: 160, rows: 48 }), onResize: () => () => {} };
}

export function headlessApp(): App {
  return new App(headlessIO(), { mouse: false, repaintMs: 0 });
}

/** A question the Controller asks the user (delete?, limit reached, how to open a file): the desktop shows it and answers. */
export interface Dialog {
  id: string;
  kind: 'alert' | 'prompt' | 'choose';
  title: string;
  lines: string[];
  options?: { key: string; label: string }[];
  initial?: string;
}

export interface ServeOpts {
  controller: Controller;
  notifications?: NotificationInbox;
  /** where a report from the Doctor's dialog goes (tests); the backend otherwise, with the notifications' installation ID */
  reports?: ReportSender;
  updates?: UpdateCheck;
  onUpdateOpen?: (url: string) => void;
  onNotificationLink?: (url: string) => void;
  port?: number;
  /** the address to listen on: 127.0.0.1 unless `chorus serve --host` asks for another (opt-in: a container, a server). Its name is
   *  then accepted in the Host and Origin checks too; the token is still needed on every request. */
  host?: string;
  /** where Export writes (tests); the Downloads folder otherwise */
  exportDir?: string;
  /** shows an export in the file manager (tests) */
  onReveal?: (file: string) => void;
  /** fixed token (tests); random otherwise */
  token?: string;
  /** called when the last client asks the server to stop (the desktop window closing) */
  onQuit?: () => void;
  /** the doctor's short check and the install/login command runner (tests); the real ones otherwise */
  check?: () => Promise<FastReport>;
  /** the detailed test (tests: a stub that never runs a CLI); its report's off mark is kept as runDeep keeps it */
  deep?: typeof runDeep;
  runCommand?: typeof runCommand;
  /** the optional module's loader (tests); the real one otherwise */
  proLoader?: ProLoader;
  /** read by the launcher given to the Controller */
  chatLaunch?: ChatLaunch;
  /** opens the sign-up page in the user's browser (tests); the system's opener otherwise */
  openLink?: (url: string) => void;
  /** opens a reported artifact on this computer (tests); the system's open command otherwise (macOS open, Linux xdg-open) */
  openFile?: (target: string) => Promise<{ ok: boolean; error?: string }>;
  /** the system's folder picker (tests); the real one otherwise */
  pickFolder?: typeof pickFolder;
  /** runs the CLIs' sign-ins in a container (tests: a fake PTY); the real one otherwise */
  signIns?: SignIns;
  /** Chorus runs in a container (tests); CHORUS_BOX=1 or /.dockerenv otherwise */
  container?: boolean;
  /** whether the CLI still has a chat's session (tests); its transcript on disk otherwise */
  sessionExists?: (row: ThreadRow) => boolean;
  /** the Chat view's `say`: how long after the Enter it looks whether the CLI kept the text in its input (tests: 0) */
  sayCheckMs?: number;
  /** the Chat view's `say` types only when the CLI shows its input box (default on; the tests' fake agent draws none) */
  sayNeedsInput?: boolean;
  /** sub threads' watchdog (tests: a short one); the watcher's QUIET_MS otherwise */
  subQuietMs?: number;
  /** the watcher's and the mailbox's clock (tests: a fake one) */
  now?: () => number;
  /** the mail transports, one per CLI (tests: fakes); the real ones otherwise (src/serve/mail.ts) */
  transports?: Partial<Record<AgentId, Transport>>;
  /** how long Claude's push waits for the chat's `chorus mcp` stream (tests: short) */
  channelWaitMs?: number;
}

const plain = (l: RichLine): string => (typeof l === 'string' ? l : l.map(s => s[0]).join(''));

interface DoctorJob {
  id: string;
  agent: AgentId;
  action: string;
  command?: string;
  done: boolean;
  ok?: boolean;
  output: string;
  results: unknown[];
  /** the finished detailed test (the page reads its results and the failures' reasons) */
  report?: DeepReport;
  dir?: string;
}

export class ChorusServer {
  readonly c: Controller;
  readonly app: App;
  readonly token: string;
  /** the last export, for Show in Finder */
  private lastExport: string | undefined;
  /** what `chorus mcp` holds: it opens /api/pro/mcp/ and nothing else */
  readonly mcpToken = crypto.randomBytes(24).toString('hex');
  readonly pro: ProHost;
  /** main thread and sub threads: free, so the tools are served also when the paid module is locked or absent */
  readonly subs: SubThreads;
  /** the one watcher (chorus-core TurnWatch): ticked by the 500 ms ticker, shared with SubThreads and the paid module */
  readonly watch: TurnWatch;
  /** the one mailbox (chorus-core Mailbox): every message to a chat, delivered by its CLI's transport, never typed */
  readonly mail: Mailbox;
  /** the projects' folders and variables, and what each running chat got of them (task #11) */
  readonly projects: ProjectRuntime;
  /** the projects' folders, variable names and values files (src/core/projects.ts): the page's routes and Delete write it */
  readonly projectSettings: ProjectSettings;
  /** the watcher's and the mailbox's clock */
  private now: () => number = Date.now;
  /** each running Claude chat's `chorus mcp` stream, for its channel pushes */
  readonly channels = new ChannelHub();
  private transports: Partial<Record<AgentId, Transport>>;
  /** sub threads the user unlocked (watch-only otherwise: their keys are dropped), and the line each is typing */
  private unlocked = new Map<string, string>();
  readonly reports: ReportSender;
  private ownInbox: NotificationInbox | undefined;
  url = '';
  /** in a container (the Chorus box): the CLIs sign in from the page (signin.ts), not in a terminal */
  readonly container: boolean;
  readonly signIns: SignIns;
  /** the names a request may carry in Host and Origin (with our port): 127.0.0.1 and localhost, and what --host added */
  private hostNames: string[] = ['127.0.0.1', 'localhost'];
  private o: ServeOpts;
  private http: http.Server | undefined;
  private wss: WebSocketServer | undefined;
  private clients = new Set<Client>();
  private dialogs = new Map<string, { d: Dialog; resolve: (v: unknown) => void }>();
  private lastState = '';
  private ticker: NodeJS.Timeout | undefined;
  /** the desktop's terminal size: every agent screen takes it */
  size = { ...DEFAULT_SIZE };
  private flashes: { text: string; ts: number }[] = [];
  private closed = false;
  /** install, sign-in and deeper-test runs the doctor popup started; polled by the page */
  private doctorJobs = new Map<string, DoctorJob>();
  private deepReports: DeepReport[] = [];
  /** The doctor's short check: the one answer to "is each agent installed, tested, logged in" for every screen (the sidebar,
   *  New chat, the Doctor page and the first-launch screen). Runs at start, on Run test and Check again, and after an install,
   *  a login or a detailed test; each answer goes to every window with the state. */
  private agentCheck: { at: string; report: FastReport } | undefined;
  private checking: Promise<{ at: string; report: FastReport }> | undefined;
  /** the running check shows "Checking…" on every screen; a quiet one (the window came back) leaves the statuses as they are */
  private checkShown = false;
  /** the newest failed requests, for the issue report (Report on the Doctor page) */
  private errors: string[] = [];
  private noteError(where: string, e: unknown) {
    this.errors = [...this.errors, `${new Date().toISOString()} ${where}: ${String((e as Error)?.message ?? e)}`].slice(-30);
  }

  constructor(o: ServeOpts) {
    this.o = o;
    this.c = o.controller;
    this.app = o.controller.app;
    this.token = o.token ?? crypto.randomBytes(24).toString('hex');
    this.container = o.container ?? (process.env.CHORUS_BOX === '1' || inContainer());
    // a sign-in that finished: check again, so the Doctor shows the agent ready
    this.signIns = o.signIns ?? new SignIns({ onChange: s => { if (s.state === 'done') void this.checkAgents({ quiet: true }).catch(e => this.noteError('doctor check', e)); } });
    // the notifications' installation ID; with notifications off (CHORUS_NOTIFICATIONS=0) the same file, made on first use
    this.reports = o.reports ?? new ReportSender({ version: versions().chorus, credentials: () => (this.o.notifications ?? (this.ownInbox ??= new NotificationInbox({ directory: path.join(process.env.CHORUS_HOME ?? path.join(os.homedir(), '.chorus'), 'notifications'), version: versions().chorus }))).credentials() });
    const now = o.now ?? Date.now;
    this.now = now;
    this.transports = o.transports ?? makeTransports({ session: id => this.chatSession(id), hub: this.channels, channelWaitMs: o.channelWaitMs });
    this.watch = new TurnWatch({ look: id => this.look(id), store: this.c.store.watchStore(), now });
    const courierMs = Number(process.env.CHORUS_COURIER_MS) > 0 ? Number(process.env.CHORUS_COURIER_MS) : undefined;
    this.mail = new Mailbox({
      store: this.c.store.mailStore(), watch: this.watch, transports: this.transports, agentOf: id => this.c.store.getThread(id)?.agent, now, on: e => this.mailEvent(e),
      // the watchdog's hooks (task #14): it runs on this TurnWatch, ticked below; no loop or timer of its own
      courierMs, transportUp: id => this.transportUp(id), seen: (id, ids) => this.seenInTranscript(id, ids), typeIn: (id, line) => this.typeIn(id, line),
    });
    if (o.chatLaunch) o.chatLaunch.wake = (agent, thread) => wakeFor(this.transports, agent, thread);
    // each chat's `chorus mcp` finds this serve through its launch env, not the shared serve.json (task #14)
    if (o.chatLaunch) o.chatLaunch.serveEnv = () => (this.url ? { [SERVE_URL_ENV]: this.url, [MCP_TOKEN_ENV]: this.mcpToken } : undefined);
    this.pro = new ProHost({ watch: this.watch, mail: this.mail, homeDir: this.c.store.root, appVersion: versions().chorus, skills: project => listSkills(project || this.c.project).map(s => s.name), signedIn: () => this.agentCheck?.report.agents.filter(a => a.state === 'ready' || a.state === 'untested').map(a => a.agent), emit: (event, data) => this.broadcast({ t: 'pro', event, data }), startChat: x => this.startChat(x), stopChat: id => this.app.entry(id)?.host?.kill(), sendToChat: (id, text) => this.locks.run(id, () => this.c.sendToChat(id, text, row => (this.o.sessionExists ?? sessionOnDisk)(row))), dismissApproval: (thread, request) => this.dismissApproval(thread, request), handoffPrompt: id => handoffPrompt(this.c.store.getThread(id)!), resumeChat: id => { if (!this.c.store.getThread(id)?.native_session_id || this.app.entry(id)?.state !== 'parked') return false; this.select(id); return true; }, approvals: () => this.approvalsNow().filter(a => !a.hidden).map((a: any) => ({ thread: a.id, kind: a.kind, what: a.what ?? a.question ?? '', request: a.request, options: a.options, details: a.details, waiting: a.waiting })), answerApproval: (id, answer, request, note) => void (request && parseProposal(this.c.store.getRequest(request)) ? this.answerProposal(request, answer, {}).catch(e => this.noteError('proposal answer', e)) : this.typedVia(id, () => (request ? this.c.answerRequest(request, answer, note) : this.c.answer(answer === 'ok', id)))), chatInfo: id => { const t = this.c.store.getThread(id); return t ? { title: t.title, cwd: t.cwd, agent: t.agent, state: t.state } : undefined; }, port: () => (this.http?.address() as AddressInfo | null)?.port, chats: () => this.c.store.listThreads().map(t => ({ id: t.id, title: t.title, cwd: t.cwd, agent: t.agent, state: t.state, ...(t.parent_thread_id ? { parent: t.parent_thread_id } : {}), ...(t.sub_status ? { sub: (t.sub_status as string) === 'task' ? 'task' : 'sub' } : {}) })), chatRecord: id => { const t = this.c.store.getThread(id); return t ? buildHandoff(this.c.store, t).text : undefined; }, projects: () => [...new Set(this.c.store.listThreads().map(t => t.cwd).filter(Boolean))], watchOnly: (thread, mainThread) => this.subs.watchOnly(thread, mainThread), deleteChat: id => this.deleteChatQuietly(id), threadKind: id => { const t = this.c.store.getThread(id); if (!t) return undefined; return !t.sub_status ? 'main' : (t.sub_status as string) === 'task' ? 'task' : 'sub'; } }, () => this.broadcast({ t: 'pro-status', status: this.pro.status() }), o.proLoader);
    if (o.chatLaunch) o.chatLaunch.host = this.pro;
    this.subs = new SubThreads({
      store: this.c.store,
      watch: this.watch,
      mail: this.mail,
      now,
      start: x => {
        // its start text names its main thread and what it was started to do (startText line 2b): the row gets its brief only after
        const launch = this.o.chatLaunch;
        if (launch) launch.nextSub = x.brief;
        try {
          return this.c.newThread({ agent: x.agent, model: x.model, effort: x.effort, title: x.title, prompt: x.prompt, cwd: x.cwd, skipPermissions: x.skipPermissions, parent: x.parent }).id;
        } finally {
          if (launch) launch.nextSub = undefined;
        }
      },
      stop: id => this.app.entry(id)?.host?.kill(),
      usable: () => this.agentCheck?.report.agents.filter(a => a.state === 'ready' || a.state === 'untested').map(a => a.agent as AgentId),
      quietMs: o.subQuietMs,
      changed: () => this.pushState(),
    });
    const settings = o.chatLaunch?.projects ?? new ProjectSettings(this.c.store.root);
    this.projectSettings = settings;
    this.projects = new ProjectRuntime({
      settings,
      running: () => this.app.entries.filter(e => e.host?.state === 'running').map(e => e.id),
      chat: id => {
        const t = this.c.store.getThread(id);
        return t ? { agent: t.agent, project: t.project ?? t.cwd, skip: !!t.skip_permissions } : undefined;
      },
      idle: id => this.watch.isIdle(id),
      typing: id => this.isTyping(id),
      restart: id => this.restartChat(id),
      liveAdd: (id, agent, dir, way) => this.liveAddDir(id, agent, dir, way),
      onTurnEnd: (id, fn, again) => this.onTurnEnd(id, fn, again),
    });
    if (o.chatLaunch) o.chatLaunch.launched = (id, project, dirs, env) => this.projects.launched(id, project, dirs, env);
    this.bridge();
    this.c.store.recorded.add(id => this.cvRecorded(id));
  }

  /* ---------- project settings and running chats (task #11 step 6) ---------- */

  /** what the user has typed into each chat's input since its last line end, and when */
  private typed = new Map<string, { line: string; at: number }>();
  private turnEndSeq = 0;

  private noteTyped(id: string, data: string) {
    let line = this.typed.get(id)?.line ?? '';
    for (const ch of data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[O\]P].?|\x1b\[20[01]~/g, '')) {
      if (ch === '\r' || ch === '\n' || ch === '\x03') line = '';
      else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1);
      else if (ch >= ' ') line += ch;
    }
    this.typed.set(id, { line: line.slice(-2000), at: Date.now() });
  }

  /** The user has text in the chat's input, or pressed a key in it in the last 3 s. */
  private isTyping(id: string) {
    const t = this.typed.get(id);
    return !!t && (t.line.length > 0 || Date.now() - t.at < 3000);
  }

  /** Calls fn once, when the chat is idle with nothing waited on (#10's watcher): at once if it is now; `again` after 5 s more of it. */
  private onTurnEnd(id: string, fn: () => void, again?: boolean) {
    const key = `projects:${id}:${++this.turnEndSeq}`;
    this.watch.watch({ key, thread: id, belongsTo: id, kind: 'thread', owner: 'projects', expect: 'its turn ends, then it gets the project settings', ...(again ? { idleFor: 5000 } : {}), on: (e, w) => {
      if (e.type === 'idle') {
        this.watch.unwatch(w.key, 'turn ended');
        fn();
      } else if (e.type === 'gone') this.watch.unwatch(w.key, 'chat ended');
    } });
  }

  /** Claude's "Adding a new directory" screen for a folder the chat was launched with: "Yes, add it" for this session (ProjectRuntime). */
  private answerLaunchScreens() {
    for (const e of this.app.entries) {
      const host = e.host;
      if (host?.state !== 'running' || e.agent !== 'claude') continue;
      const keys = this.projects.launchScreenKeys(e.id, (host.screen.text() ?? []).join('\n'), os.homedir());
      if (keys) void this.locks.run(e.id, () => host.write(keys));
    }
  }

  /** Stops the chat's process and resumes it (conversation kept), the way #10 continues an agy chat: it launches with the current settings. */
  private restartChat(id: string) {
    const host = this.app.entry(id)?.host;
    if (!host || host.state !== 'running' || this.closed) return;
    host.once('exit', () => setTimeout(() => this.resumeChat(id), 500));
    host.kill();
  }

  /**
   * A new working folder reaches a running chat through its CLI's own way (chorus-core src/livedir.ts): Claude and agy get
   * `/add-dir <dir>` typed into their empty input and their screens answered with the session-only choice; Codex (default mode) is
   * asked through its transport to request the folder, and its grant card is answered "for this session". True once the CLI says so.
   */
  private async liveAddDir(id: string, agent: AgentId, dir: string, way: LiveWay, timeoutMs = way === 'grant' ? 180_000 : 30_000): Promise<boolean> {
    const host = this.app.entry(id)?.host;
    if (!host || host.state !== 'running' || way === 'none') return way === 'none';
    const screen = () => (host.screen.text() ?? []).join('\n');
    if (way === 'slash') {
      const input = liveAddDirInput(agent, dir);
      if (!input) return false;
      await this.locks.run(id, async () => {
        host.write(input);
        await sleep(400);
        host.write('\r');
      });
    } else {
      this.mail.send({ from: { who: 'chorus' }, to: { thread: id }, kind: 'note', subject: 'Working folder added', body: codexGrantMessage([dir]), refs: {} });
    }
    const end = Date.now() + timeoutMs;
    let last = '', lastAt = 0;
    while (Date.now() < end && host.state === 'running' && !this.closed) {
      await sleep(300);
      const sc = screen();
      if (liveAddDirDone(agent, sc, dir)) return true;
      const keys = liveAddDirKeys(agent, sc);
      if (keys && (keys !== last || Date.now() - lastAt > 1500)) {
        await this.locks.run(id, () => host.write(keys));
        last = keys;
        lastAt = Date.now();
      }
    }
    return false;
  }

  private startChat(x: ChatStart): string {
    const launch = this.o.chatLaunch;
    if (launch) launch.next = { role: x.role, readOnly: x.readOnly, skills: x.skills };
    try {
      return this.c.newThread({ agent: x.agent, model: x.model, effort: x.effort, title: x.title, prompt: x.prompt, cwd: x.cwd, skipPermissions: x.skipPermissions, parent: x.parent ? this.c.store.getThread(x.parent) : undefined }).id;
    } finally {
      if (launch) launch.next = undefined;
    }
  }

  /* ---------- the one watcher and the one mailbox (task #10) ---------- */

  /** chats with an approval or question card open, worked out once per tick */
  private cardsAt = -1;
  private cards = new Set<string>();
  /** agy chats resumed in this run whose screen has not shown the conversation yet: id → the text to look for */
  private agyResumed = new Map<string, string>();
  /** when each chat was last continued for its mail (one try at a time) */
  private woken = new Map<string, number>();
  private mailScanAt = 0;

  private openCard(id: string) {
    const t = Date.now();
    if (t - this.cardsAt > 400) {
      this.cards = new Set([...this.approvalsNow().map(a => a.id), ...this.c.store.pendingRequests().map(r => r.thread_id)]);
      this.cardsAt = t;
    }
    return this.cards.has(id);
  }

  /**
   * One look at a chat for the watcher: its state, an activity mark, and 'card' while an approval or question card of it is open.
   * Working sub threads are not in the look: a wait in the look holds every watch of that chat, so a main chat's mail (another sub
   * thread's report, a Worker's report to its Planner) would wait for all of them. The watch that needs them adds them itself
   * (chorus-core's action watch: Watch.waits() from ctx.chats() parent).
   */
  look(id: string): ChatLook | undefined {
    const st = this.c.store;
    const t = st.getThread(id);
    if (!t) return undefined;
    const host = this.app.entry(id)?.host;
    const ended = t.state === 'ended' || host?.state === 'ended';
    const activity = st.activityMark(id);
    let state = ended ? 'ended' : t.state;
    if (!ended && host?.state === 'running') {
      // A turn recorded before this CLI process started can't still be running: a CLI killed mid-turn (a Chorus restart) never wrote
      // that turn's end, so its transcript says "working" for good, while the resumed CLI waits for input (task #14: four chats stuck
      // at working for hours). With history, nothing new since the process started, and past a grace window (a resumed chat with a
      // prompt records its turn within a second or two): idle.
      let start = this.processMarks.get(host);
      if (!start) this.processMarks.set(host, (start = { mark: activity, at: this.now() }));
      if (state === 'working' && activity === start.mark && start.mark !== NO_ACTIVITY && this.now() - start.at >= STALE_TURN_MS) state = 'waiting';
    }
    return { state, activity, ...(this.openCard(id) ? { waitsOn: ['card'] } : {}) };
  }

  /* ---------- the Chat view (plan 2026-11-22, src/serve/chatview.ts) ---------- */

  get cvDeps(): CvDeps {
    return { store: this.c.store, reported: id => this.reported(id) };
  }
  /** the clients that show a chat in the Chat view, and what each was last sent */
  private cvSent = new Map<Client, CvSent>();

  /** A client opened a chat in the Chat view (after its GET turns): from now on it gets what is new, nothing else. */
  cvWatch(cl: Client, id: string | undefined, seq: number) {
    if (!id || !this.c.store.getThread(id)) return void this.cvSent.delete(cl);
    // the rows of its last turns are sent once more (a call may have finished between its GET and this message)
    const sent: CvSent = { id, seq: Math.max(0, seq | 0), calls: new Map(), cards: '' };
    this.cvSent.set(cl, sent);
    this.cvSend(cl, sent);
  }

  private cvSend(cl: Client, sent: CvSent) {
    const d = delta(this.cvDeps, sent);
    if (d) cl.send(JSON.stringify({ t: 'cv', id: sent.id, ...d }));
  }

  /** The tailer recorded a chat's session (Store.recorded): each client showing it gets the new turns and changed rows. */
  private cvRecorded(threadId: string) {
    for (const [cl, sent] of this.cvSent) if (sent.id === threadId) this.cvSend(cl, sent);
  }

  /** A chat some page shows in the Chat view, idle, whose CLI shows a menu or panel of its own (the "Open Terminal" banner). */
  private cvMenu(e: Entry): boolean {
    const host = e.host;
    if (!host || host.state !== 'running' || ![...this.cvSent.values()].some(x => x.id === e.id)) return false;
    if (this.c.store.getThread(e.id)?.state === 'working') return false;
    try {
      return menuShown(e.agent as AgentId, screenRows(host.screen), host.screen.cols);
    } catch {
      return false;
    }
  }

  /** What `say` and `key` answer for a chat the user may not type into now, else undefined. */
  private typingRefused(id: string): string | undefined {
    const t = this.c.store.getThread(id);
    if (t?.sub_status && !this.isUnlocked(id)) return 'This sub thread is watch-only: tell its main chat, or Unlock it first.';
    return undefined;
  }

  /**
   * The Chat view's message box (phone): the user typing a message into the chat's CLI, through the same gates as keys from the
   * page (watch-only, the mail watchdog's hold, what typing resets). Skills become the sentence each CLI understands; the text is
   * typed by the rule probed per CLI (typedText). `held`: the CLI kept the text in its input (an unknown command in Codex).
   */
  private async say(id: string, raw: unknown): Promise<{ result: 'sent' | 'ended' | 'gone' | 'held'; message?: string } | { error: string }> {
    const text = typeof raw === 'string' ? raw.trim() : '';
    if (!text) return { error: 'Type a message first.' };
    if (text.length > 20_000) return { error: 'That message is too long to type into the agent (20,000 characters at most).' };
    const refused = this.typingRefused(id);
    if (refused) return { error: refused };
    const row = this.c.store.getThread(id)!;
    const agent = row.agent as AgentId;
    const typed = typedText(agent, expandSkillMentions(text, this.skillNames()));
    const name = CLIS[agent]?.name ?? agent;
    // the line counts as the user's: a sub thread's main chat is told, an open card is answered by typing (as keys from the page)
    // a running CLI that shows something of its own (a start-up question, a permission dialog, a menu) takes no text: typed keys and
    // the Enter after them would answer it (chatview-probe M and S: inputState reads the input box per CLI)
    const running = this.app.entry(id)?.host;
    if (this.o.sayNeedsInput !== false && running?.state === 'running' && !inputState(agent, screenRows(running.screen), running.screen.cols).ready) return { result: 'ended', message: `${CLIS[agent]?.name ?? agent} is showing something on its own screen. Open Terminal to answer it.` };
    const line = text.replace(/\s+/g, ' ') + '\r';
    this.watchOnlyLets(id, line);
    const r = await this.locks.run(id, () => this.c.sendToChat(id, typed, x => (this.o.sessionExists ?? sessionOnDisk)(x)));
    if (r === 'sent') {
      this.noteTyped(id, line);
      this.typedTo(id, '\r');
      this.pushState();
      // the CLI may keep the text in its input instead of sending it (chatview-probe S: Codex and an unknown /command): say so
      const host = this.app.entry(id)?.host;
      await new Promise(res => setTimeout(res, this.o.sayCheckMs ?? 1500));
      if (host && host.state === 'running' && heldInInput(agent, screenRows(host.screen), host.screen.cols, typed)) {
        // only what Chorus typed is there: it is cleared, so the next message is not added to it (Ctrl+U per line, typein-probe A)
        const st = inputState(agent, screenRows(host.screen), host.screen.cols);
        const flat = (x: string) => x.replace(/\s+/g, ' ').trim();
        if (flat(st.draft) === flat(typedText(agent, text).split(NEWLINE_KEYS[agent] ?? '\x1b\r').join(' ')) || flat(st.draft) === flat(text)) await this.locks.run(id, () => host.write(clearKeys(agent, st)));
        return { result: 'held', message: `${name} did not take the message: its own screen says why. Open Terminal to see it.` };
      }
      return { result: 'sent' };
    }
    if (r === 'gone') return { result: 'gone', message: 'This chat cannot be continued: its session is gone. Hand it off to start again from its record.' };
    return { result: 'ended', message: `${name} is showing something on its own screen. Open Terminal to answer it.` };
  }

  /** The key row's Esc and Shift+Tab: fixed bytes into the running CLI, through the same gates. A parked chat is not resumed. */
  private async chatKey(id: string, key: unknown): Promise<{ ok: true } | { error: string }> {
    const bytes = typeof key === 'string' && Object.hasOwn(KEYS, key) ? KEYS[key] : undefined;
    if (!bytes) return { error: 'key must be esc or shift-tab' };
    const refused = this.typingRefused(id);
    if (refused) return { error: refused };
    const host = this.app.entry(id)?.host;
    if (!host || host.state !== 'running') return { error: 'The agent is not running in this chat.' };
    const held = this.keyHold.get(id);
    if (held) held.push(bytes);
    else host.write(bytes);
    this.noteTyped(id, bytes);
    return { ok: true };
  }

  /* ---------- the mail watchdog's hooks (task #14) ---------- */

  /** One lock per chat for every write into its CLI that is not the user's (src/serve/termlock.ts). */
  readonly locks = new TermLocks();
  /** chats the watchdog is typing into: the user's keys pressed meanwhile, to send after it */
  private keyHold = new Map<string, string[]>();
  /** the sender of the mail the watchdog is about to type for, per receiving chat (its courier 'typing' event) */
  private typingFrom = new Map<string, string | undefined>();

  /**
   * A write into a chat's CLI that is not the user's own keys: one at a time with the chat's other writers, and the lock is kept
   * `tailMs` after it so a delayed Enter stays inside (the Controller's answer types its text, then Enter 700 ms later). Resolves with
   * fn's result as soon as it ran.
   */
  private typedVia<T>(thread: string | undefined, fn: () => T, tailMs = 800): Promise<T> {
    if (!thread) return Promise.resolve(fn());
    return new Promise<T>((resolve, reject) => {
      void this.locks.run(thread, async () => {
        try {
          resolve(fn());
        } catch (e) {
          return reject(e);
        }
        await sleep(tailMs);
      });
    });
  }

  /** False for a running Claude chat whose `chorus mcp` stream is still not open CHANNEL_WAIT_MS after its CLI started. */
  private transportUp(id: string): boolean {
    const t = this.c.store.getThread(id), host = this.app.entry(id)?.host;
    if (t?.agent !== 'claude' || host?.state !== 'running') return true;
    if (this.channels.connected(id)) return true;
    const start = this.processMarks.get(host);
    return !start || this.now() - start.at < CHANNEL_WAIT_MS;
  }

  /** The chat's transcript holds a user message with every id (the typed line or a delivery reached the model). Its last 4 MB. */
  private seenInTranscript(id: string, ids: string[]): boolean {
    const t = this.c.store.getThread(id);
    if (!t?.transcript_path) return false;
    try {
      const size = fs.statSync(t.transcript_path).size;
      const from = Math.max(0, size - 4_000_000);
      const fd = fs.openSync(t.transcript_path, 'r');
      try {
        const buf = Buffer.alloc(size - from);
        fs.readSync(fd, buf, 0, buf.length, from);
        return transcriptHas(t.agent, buf.toString('utf8'), ids);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  /**
   * The watchdog's last resort: one short line typed into the chat's CLI, the user's draft put back (typeLine). Under the chat's
   * terminal lock, never while a dialog is on screen; the user's keys pressed meanwhile are held and replayed through the user path.
   * The open page dims the window while it types (mail-typing).
   */
  private async typeIn(id: string, line: string): Promise<'typed' | 'not-ready' | 'gone'> {
    const row = this.c.store.getThread(id);
    if (!row) return 'gone';
    const host = this.app.entry(id)?.host;
    if (host?.state !== 'running') {
      // not running: it is continued first (its CLI's resume), then typed into at a next try
      this.wakeChat(id);
      return 'not-ready';
    }
    const raw = this.locks.guard(id, host);
    const from = this.typingFrom.get(id);
    const sender = from ? this.c.store.getThread(from) : undefined;
    return this.locks.run(id, () =>
      typeLine(
        {
          agent: row.agent,
          running: () => host.state === 'running',
          cols: () => host.screen.cols,
          rows: () => screenRows(host.screen),
          write: raw,
        },
        line,
        {
          sleep,
          hold: () => {
            this.keyHold.set(id, []);
            this.locks.hold(id);
          },
          release: () => {
            this.locks.release(id, host);
            const keys = this.keyHold.get(id) ?? [];
            this.keyHold.delete(id);
            // the user's keys go out after the line and the draft, as the user's: they count as typed
            for (const d of keys) {
              host.write(d);
              this.noteTyped(id, d);
              this.typedTo(id, d);
            }
          },
          start: () => this.broadcast({ t: 'mail-typing', thread: id, phase: 'start', from: { title: sender?.title ?? 'Chorus', agent: sender?.agent ?? null } }),
          end: ok => this.broadcast({ t: 'mail-typing', thread: id, phase: 'end', ok }),
          log: l => console.error(`[mail] type-in ${id}: ${l}`),
        },
      ),
    );
  }

  /** Each chat CLI process, as serve first saw it: its chat's activity mark then (look()). */
  private processMarks = new WeakMap<object, { mark: string; at: number }>();

  /** How a chat stands for the transports. */
  private chatSession(id: string): ChatSession | undefined {
    const row = this.c.store.getThread(id);
    if (!row) return undefined;
    const host = this.app.entry(id)?.host;
    const running = host?.state === 'running';
    const lost = !running && (!row.native_session_id || !(this.o.sessionExists ?? sessionOnDisk)(row));
    return { agent: row.agent, native: row.native_session_id ?? undefined, running, pid: running ? host!.pid : undefined, cwd: row.cwd, lost, unconfirmed: row.agent === 'agy' && running && !this.agyShows(id) };
  }

  /** agy after a resume: confirmed once its screen shows the conversation (its last turn), or new activity was recorded. */
  private agyShows(id: string) {
    const want = this.agyResumed.get(id);
    if (want === undefined) return true;
    const screen = (this.app.entry(id)?.host?.screen.text() ?? []).join(' ').replace(/\s+/g, ' ');
    if (!want || screen.includes(want)) {
      this.agyResumed.delete(id);
      return true;
    }
    return false;
  }

  /** What the mailbox says: the paid module raises its cards from it; 'ended' asks for the chat to be continued. */
  private mailEvent(e: MailEvent) {
    // the watchdog's steps go to the log only; the page gets 'mail-typing' from the type-in itself
    if (e.type === 'courier') {
      if (e.phase === 'typing') this.typingFrom.set(e.to, e.from);
      console.error(`[mail] watchdog ${e.phase}: ${e.message.id} ${e.from ?? 'chorus'} → ${e.to}`);
      return;
    }
    this.pro.chatEvent({ type: 'mail', event: e } as { type: string });
    if (e.type === 'ended') this.wakeChat(e.message.to.thread);
  }

  /**
   * A chat has mail but its CLI is not running: it is continued the way a send continued it before (its CLI's resume), with no
   * message typed; the mailbox delivers once it is idle. A lost session is left to the Restore card. An agy chat whose resume came
   * up empty is closed and resumed again once its old process has exited.
   */
  private wakeChat(id: string) {
    const at = Date.now();
    if (at - (this.woken.get(id) ?? -Infinity) < 20_000 || this.closed) return;
    const row = this.c.store.getThread(id), e = this.app.entry(id);
    if (!row || !e) return;
    const host = e.host;
    if (host?.state === 'running') {
      if (row.agent !== 'agy' || this.agyShows(id)) return;
      this.woken.set(id, at);
      host.once('exit', () => setTimeout(() => this.resumeChat(id), 500));
      host.kill();
      return;
    }
    if (!row.native_session_id || !(this.o.sessionExists ?? sessionOnDisk)(row)) return;
    this.woken.set(id, at);
    this.resumeChat(id);
  }

  private resumeChat(id: string) {
    const e = this.app.entry(id);
    if (!e || e.host?.state === 'running' || this.closed || !this.c.store.getThread(id)) return;
    // the Controller's own resume (as its send did): the CLI app's code stays as it is
    (this.c as unknown as { resume(e: Entry): void }).resume(e);
    this.pushState();
  }

  /** Every 2 s: mail queued for a chat whose CLI is not running continues that chat. */
  private scanMail() {
    const at = Date.now();
    if (at - this.mailScanAt < 2000) return;
    this.mailScanAt = at;
    for (const to of new Set(this.mail.list({ state: ['queued'] }).map(m => m.to.thread))) {
      if (this.app.entry(to)?.host?.state !== 'running') this.wakeChat(to);
    }
  }

  /** A chat was deleted: its mail is dropped (its senders told), and the watches on it and kept for it end. */
  private chatDeleted(id: string) {
    this.mail.drop(id);
    this.subs.forget(id);
    for (const w of [...this.watch.list({ thread: id }), ...this.watch.list({ belongsTo: id })]) this.watch.unwatch(w.key, 'chat deleted');
    this.pro.chatEvent({ type: 'deleted', thread: id } as { type: string });
  }

  /** Command prompts deleted from Approvals: hidden there until the prompt changes; their Approve/Deny line stays in the chat. */
  private hiddenPrompts = new Map<string, string>();

  /**
   * Approvals' delete (plan 2026-11-13, item 4): the item only, the agent is not answered. An agent's question is cancelled; a
   * command prompt is hidden from Approvals until it changes.
   */
  dismissApproval(thread: string, request?: string) {
    const c = this.c;
    if (request) {
      const r = c.store.getRequest(request);
      if (r && r.thread_id === thread) c.store.answerRequest(r.id, '', undefined, 'cancelled');
    } else {
      const p = c.approvalItems('all').find(a => a.id === thread && a.kind === 'permission');
      if (p) this.hiddenPrompts.set(thread, p.what);
    }
    this.pushState();
  }

  /**
   * What waits on the user now: the controller's prompts and cards, with each card's kind (question or approval). A card the store
   * no longer has pending (answered by typing, skipped, deleted) is left out at once; a command prompt deleted from Approvals is
   * marked hidden until it changes.
   */
  private approvalsNow(): (ReturnType<Controller['approvalItems']>[number] & { hidden: boolean; askKind?: 'question' | 'approval'; other?: boolean })[] {
    const c = this.c;
    const items = c.approvalItems('all').flatMap((a): (ReturnType<Controller['approvalItems']>[number] & { hidden: boolean; askKind?: 'question' | 'approval'; other?: boolean })[] => {
      if (a.kind !== 'ask') return [{ ...a, hidden: this.hiddenPrompts.get(a.id) === a.what }];
      const r = c.store.getRequest(a.request);
      const proposal = parseProposal(r);
      return r && r.status === 'pending' ? [{ ...a, askKind: r.kind ?? 'approval', other: r.other !== 0, hidden: false, ...(proposal ? { proposal } : {}) }] : [];
    });
    for (const [id, what] of this.hiddenPrompts) if (!items.some(a => a.kind === 'permission' && a.id === id && a.what === what)) this.hiddenPrompts.delete(id);
    return items;
  }

  /**
   * Whether keys for this chat go through: always for a chat that is not a sub thread; for a sub thread only while unlocked, and
   * then each typed line is passed on to the main chat as a note. A sub thread whose chat ended is locked again.
   */
  /** Why no chat can start on this agent now: a failed critical check of its installed version turned it off (the Doctor says more). */
  private offReason(agent: AgentId): string | undefined {
    const a = this.agentCheck?.report.agents.find(x => x.agent === agent && x.state === 'off');
    return a ? `${a.name} ${a.version ?? ''} can't be used with Chorus: ${a.off?.reason ?? 'a critical check failed'}. See Doctor.`.replace(/ {2,}/g, ' ') : undefined;
  }

  /** Unlocked, and still running: a sub thread whose chat ended is locked again. */
  private isUnlocked(id: string) {
    if (!this.unlocked.has(id)) return false;
    if (this.c.store.getThread(id)?.sub_status === 'ended' || this.app.entry(id)?.host?.state === 'ended') {
      this.unlocked.delete(id);
      return false;
    }
    return true;
  }

  private watchOnlyLets(id: string, data: string): boolean {
    const t = this.c.store.getThread(id);
    if (!t?.sub_status) return true;
    if (!this.isUnlocked(id)) return false;
    // the line being typed: printable text, Backspace takes one off, a line end sends it
    let line = this.unlocked.get(id) ?? '';
    for (const ch of data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[O\]P].?|\x1b\[20[01]~/g, '')) {
      if (ch === '\r' || ch === '\n') {
        if (line.trim()) this.subs.userTyped(id, line);
        line = '';
      } else if (ch === '\x7f' || ch === '\b') line = line.slice(0, -1);
      else if (ch >= ' ') line += ch;
    }
    this.unlocked.set(id, line.slice(-2000));
    return true;
  }

  /**
   * Typing to the agent while a card is open answers it by typing: its question cards leave the chat and Approvals at once, and the
   * module closes its own cards for that chat (the "Start <action>?" suggestion, the goal question). Shift+Enter (the CLI's new-line
   * bytes, NEWLINE_KEYS) only adds a line, so it is not sending.
   */
  private typedTo(id: string, data: string) {
    const nl = NEWLINE_KEYS[this.c.store.getThread(id)?.agent as AgentId];
    if (!/[\r\n]/.test(nl ? data.split(nl).join('') : data)) return;
    const open = this.c.store.pendingRequests(id);
    for (const r of open) this.c.store.answerRequest(r.id, '', undefined, 'cancelled');
    this.pro.chatEvent({ type: 'typed', thread: id } as { type: string });
    if (open.length) this.pushState();
  }

  /** The Controller's questions, flashes and bell reach the desktop instead of a terminal. */
  private bridge() {
    const app = this.app;
    // while a project is being deleted (DELETE projects, after its one warning), or a chat is deleted quietly (deleteChatQuietly),
    // the chat's own "Delete this chat?" is answered here
    app.alert = (title, lines, options) => ((this.deletingProject || this.quietDelete > 0) && title === 'Delete this chat?' ? Promise.resolve('y') : (this.ask({ kind: 'alert', title, lines, options }) as Promise<string | undefined>));
    app.prompt = (title, lines, initial = '') => this.ask({ kind: 'prompt', title, lines, initial }) as Promise<string | undefined>;
    app.choose = (title, options) => this.ask({ kind: 'choose', title, lines: [], options: options.map((label, i) => ({ key: String(i), label })) }).then(v => (v === undefined ? undefined : Number(v)));
    const flash = app.setFlash.bind(app);
    app.setFlash = (msg: string) => {
      // deleting a project: one summary on the page, not a line per chat
      if (this.deletingProject && msg.startsWith('deleted "')) return;
      flash(msg);
      this.flashes.push({ text: msg, ts: Date.now() });
      this.flashes = this.flashes.slice(-20);
      this.broadcast({ t: 'flash', text: msg });
    };
    app.bell = () => this.broadcast({ t: 'bell' });
    // a new process for a chat (new, resumed): it takes the desktop's terminal size, and clients looking at that chat follow it
    app.on('thread-started', (e: Entry, host: ThreadHost) => {
      // `chorus mcp` finds its chat by its CLI's pid (src/mcp/identity.ts)
      try { this.c.store.setCliPid(e.id, host.pid); } catch { /* a chat without a row (the doctor) */ }
      // every write to this chat's CLI that is not the user's waits while the mail watchdog holds its terminal (src/serve/termlock.ts)
      this.locks.guard(e.id, host);
      // Claude's development-channels warning (its mail transport's flag): answered once per launch, only when it shows
      if (e.agent === 'claude') answerChannelWarning({ on: (ev, cb) => host.on(ev, cb), off: (ev, cb) => host.off(ev, cb), screen: host.screen, write: d => void this.locks.run(e.id, () => host.write(d)) });
      // agy: a resume must show the conversation before mail goes to it (antigravity-agy.md §16)
      const row = this.c.store.getThread(e.id);
      if (e.agent === 'agy' && row && this.c.store.getTurns(e.id, { limit: 1 }).length) {
        const last = this.c.store.getTurns(e.id, { limit: 1 })[0];
        this.agyResumed.set(e.id, (last?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 24));
      }
      host.resize(this.size.cols, this.size.rows);
      for (const cl of this.clients) if (cl.attached === e.id) void cl.attach(e.id);
      this.pushState();
    });
    app.on('thread-exit', (e: Entry) => {
      if (e?.id) try { this.c.store.setCliPid(e.id, null); } catch { /* gone */ }
      if (e?.id) {
        this.projects.exited(e.id);
        this.typed.delete(e.id);
      }
      this.pro.chatEvent({ type: 'exit', thread: e?.id } as { type: string });
      this.pushState();
    });
  }

  /** Set while DELETE projects removes a project's chats one by one. */
  private deletingProject = false;
  /** How many deleteChatQuietly calls are running: their "Delete this chat?" was already asked (or needs no asking). */
  private quietDelete = 0;

  /**
   * Deletes a chat without its own "Delete this chat?": after the Planner-chat dialog, or when the paid module deletes a deleted
   * task's chats (ProCtx.deleteChat). The Controller stops a running chat first, as DELETE chats/:id does; the module hears it.
   */
  private async deleteChatQuietly(id: string) {
    if (!this.c.store.getThread(id)) return;
    this.quietDelete++;
    try {
      this.unlocked.delete(id);
      await this.c.deleteThread(id);
    } finally {
      this.quietDelete--;
    }
    if (!this.c.store.getThread(id)) this.chatDeleted(id);
    this.pushState();
  }

  /* ---------- Settings › Projects (task #11 step 7) ---------- */

  /** A project's folder from a request: absolute after ~ is expanded, or undefined. */
  private projectDir(folder: unknown): string | undefined {
    if (typeof folder !== 'string' || !folder.trim()) return undefined;
    const dir = expand(folder.trim());
    return path.isAbsolute(dir) ? path.resolve(dir) : undefined;
  }

  /** Every chat of each project (its folder: the chat's project, or its own folder), "This computer" left out. */
  private projectChats(): Map<string, { id: string; updated: string }[]> {
    const m = new Map<string, { id: string; updated: string }[]>();
    const none = computerDir();
    for (const t of this.c.store.listThreads()) {
      const p = t.project ?? t.cwd;
      if (!p || p === none || isComputer(p)) continue;
      (m.get(p) ?? m.set(p, []).get(p)!).push({ id: t.id, updated: String(t.updated ?? t.created ?? '') });
    }
    return m;
  }

  /** GET projects: every project that has a chat or was created by a card (0 chats), newest activity first; tasks only with Pro. */
  async listProjects() {
    const out = [];
    const all = this.projectChats();
    for (const folder of this.projectSettings.registered()) if (!all.has(folder) && !isComputer(folder)) all.set(folder, []);
    for (const [folder, chats] of all) {
      const counts = await this.pro.projectCounts(folder);
      const rec = this.projectSettings.get(folder);
      const last = chats.reduce((a, c) => (c.updated > a ? c.updated : a), rec.registered_at ?? '');
      out.push({ folder, name: path.basename(folder) || folder, chats: chats.length, ...(counts ? { tasks: counts.tasks } : {}), last });
    }
    return out.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0)).map(({ last, ...p }) => p);
  }

  /** GET projects/one: the project's page. Names only: no variable's value ever leaves the values file here. */
  async oneProject(folder: string) {
    const ids = (this.projectChats().get(folder) ?? []).map(c => c.id);
    const rec = this.projectSettings.get(folder);
    if (!ids.length && !rec.version) return { error: `No project at ${folder}` };
    const running = new Set(this.app.entries.filter(e => e.host?.state === 'running').map(e => e.id));
    const counts = await this.pro.projectCounts(folder);
    const artifacts = ids.length ? (this.c.store.db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE thread_id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { n: number }).n : 0;
    return {
      folder,
      name: path.basename(folder) || folder,
      chats: { total: ids.length, running: ids.filter(id => running.has(id)).length },
      ...(counts ? { tasks: { total: counts.tasks, open: counts.open } } : {}),
      artifacts,
      note: rec.note,
      note_by: rec.note_by,
      folders: rec.folders.map(f => {
        const d = this.projectSettings.describeFolder(f.path);
        return { path: f.path, why: f.why, by: f.by, at: f.at, created: !!f.created, exists: d.exists && d.is_dir, git: d.git };
      }),
      variables: rec.variables.map(v => ({ name: v.name, why: v.why, by: v.by, at: v.at })),
      stale: this.projects.staleChats(folder).length,
    };
  }

  /**
   * The page's own changes (by "you"), decisions 1 and 13: a new folder reaches every running chat of the project live (the CLI's own
   * way, or a restart at its turn end); a removed folder or any variable change only marks them stale (`restart: false`), so the page's
   * banner offers "Restart idle ones". Open pages update through the state push.
   */
  private async changeProject(folder: string, change: Parameters<ProjectRuntime['applyToRunning']>[1], apply: () => void) {
    try {
      apply();
    } catch (e) {
      return { error: (e as Error).message };
    }
    await this.projects.applyToRunning(folder, change, change.kind === 'add_folder' ? {} : { restart: false }).catch(e => this.noteError('project change', e));
    this.pushState();
    return this.oneProject(folder);
  }

  /* ---------- the model's project tools (task #11 step 8) ---------- */

  /** get_project, propose_project_change, reload_project_settings and rename_chat for the chat `threadId`: its own project only. */
  async projectTool(name: string, args: Record<string, unknown>, threadId: string): Promise<{ text: string; isError?: boolean }> {
    const t = this.c.store.getThread(threadId);
    if (!t) return { text: 'This chat is not a Chorus thread.', isError: true };
    const folder = path.resolve(t.project ?? t.cwd);
    if (name === 'get_project') {
      const running = () => new Set(this.app.entries.filter(e => e.host?.state === 'running').map(e => e.id));
      const info = await getProject({ store: this.c.store, settings: this.projectSettings, runtime: this.projects, running, counts: f => this.pro.projectCounts(f), tasks: f => this.pro.projectTasks(f, 20) }, t);
      return { text: JSON.stringify(info, null, 1) };
    }
    if (name === 'propose_project_change') {
      const ok = checkProposal(this.projectSettings, folder, args.changes);
      if ('error' in ok) return { text: ok.error, isError: true };
      const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 1000) : undefined;
      const card = proposalCard(folder, ok.changes, reason);
      // always the user's card: from a main chat, a sub thread or a Worker alike, never a Planner's
      const r = this.c.store.createRequest({ threadId: t.id, ...card, kind: 'approval', other: false, proposal: { project: folder, name: placeName(folder), changes: ok.changes, ...(reason ? { reason } : {}) } });
      this.pushState();
      return { text: `Shown to the user as card ${r.id} with the options: ${r.options.join(' / ')}. End your turn now; the answer arrives as your next message: "Chorus approval ${r.id}: approved: <what was done>" or "Chorus approval ${r.id}: declined". Values the user types are never shown to you.` };
    }
    if (name === 'propose_new_project') {
      // any chat, This computer too; always the user's card, never a Planner's
      const chatsIn = new Set(this.c.store.listThreads().map(x => path.resolve(x.project ?? x.cwd)));
      const ok = checkNewProject(this.projectSettings, args, dir => chatsIn.has(dir));
      if ('error' in ok) return { text: ok.error, isError: true };
      const r = this.c.store.createRequest({ threadId: t.id, ...newProjectCard(ok.proposal), kind: 'approval', other: false, proposal: ok.proposal });
      this.pushState();
      return { text: `Shown to the user as card ${r.id} with the options: ${r.options.join(' / ')}. End your turn now; the answer arrives as your next message: "Chorus approval ${r.id}: approved: created project …" or "Chorus approval ${r.id}: declined". Values the user types are never shown to you. This chat stays where it is.` };
    }
    if (name === 'reload_project_settings') {
      if (this.app.entry(t.id)?.host?.state !== 'running') return { text: 'This chat is not running in Chorus, so it cannot be restarted from here.', isError: true };
      this.projects.restartAtTurnEnd(t.id);
      return { text: "This chat restarts with the project's current folders and variables when this turn ends; the conversation is kept." };
    }
    if (name === 'rename_chat') {
      const r = this.renameChat(t.id, args.title, 'model');
      return 'error' in r ? { text: r.error, isError: true } : { text: `This chat is now named "${r.to}".` };
    }
    return { text: `Unknown tool ${name}`, isError: true };
  }

  /**
   * A chat's new name (rename_chat, and Undo on its toast): trimmed, whitespace collapsed, one line, 1–60 characters. The store row
   * and the app's entry change at once; every window gets {t: 'renamed', id, from, to, by}, which shows the toast with Undo.
   */
  renameChat(id: string, raw: unknown, by: 'model' | 'you'): { ok: true; from: string; to: string } | { error: string } {
    const t = this.c.store.getThread(id);
    if (!t) return { error: 'No such chat.' };
    if (typeof raw !== 'string') return { error: 'The title must be text.' };
    if (/[\r\n]/.test(raw.trim())) return { error: 'The title must be one line.' };
    const to = raw.replace(/\s+/g, ' ').trim();
    if (!to) return { error: 'The title is empty: give the chat a short name.' };
    if (to.length > 60) return { error: `The title is too long: ${to.length} characters, at most 60.` };
    const from = t.title;
    if (to !== from) {
      this.c.store.updateThread(id, { title: to });
      const e = this.app.entry(id);
      if (e) e.title = to;
    }
    this.broadcast({ t: 'renamed', id, from, to, by });
    this.pushState();
    return { ok: true, from, to };
  }

  /**
   * The user's answer to a propose_project_change card. Decline: nothing changes. Approve: every change is applied with its why, who
   * asked and this card; a new folder goes live to every running chat of the project (the asking one too), a removed folder and
   * variable changes only mark the other running chats stale, and "Approve and restart this chat" restarts the asking chat when the
   * turn the answer starts has ended. Then the chat reads a text built here: what was done, never a value. A set_variable without a
   * typed value refuses the whole answer: nothing is applied and the card stays.
   */
  async answerProposal(requestId: string, option: string, o: { values?: unknown; note?: unknown }): Promise<{ ok: boolean; text?: string; error?: string }> {
    const c = this.c;
    const r = c.store.getRequest(requestId);
    const p = parseProposal(r);
    if (!r || !p) return { ok: false, error: 'No such card.' };
    if (r.status !== 'pending') return { ok: false, error: 'This card was already answered.' };
    if (this.app.entry(r.thread_id)?.host?.state !== 'running') return { ok: false, error: 'That chat is not running: open it, then answer.' };
    if (!r.options.includes(option)) return { ok: false, error: `Choose one of: ${r.options.join(', ')}.` };
    if (option === DECLINE) {
      const ok = await this.typedVia(r.thread_id, () => c.answerRequest(r.id, 'declined'));
      this.pushState();
      return { ok, text: 'declined' };
    }
    const values = (o.values && typeof o.values === 'object' ? o.values : {}) as Record<string, unknown>;
    const missing = p.changes.filter(ch => ch.kind === 'set_variable' && !(typeof values[ch.name!] === 'string' && (values[ch.name!] as string).length)).map(ch => ch.name!);
    if (missing.length) return { ok: false, error: `Type a value for ${missing.join(', ')}, or decline.` };
    const asker = c.store.getThread(r.thread_id);
    const origin = { by: asker ? `${asker.title} (${asker.agent})` : 'a chat', by_thread: r.thread_id, approval: r.id };
    const folder = p.project;
    const s = this.projectSettings;
    if (p.kind === 'new_project') return this.createProject(r.id, option, p, values, o.note, origin);
    const lines: string[] = [];
    let restartNeeded = false;
    for (const ch of p.changes) {
      let result: AskerResult;
      try {
        if (ch.kind === 'set_note') {
          const note = typeof o.note === 'string' && o.note.trim() ? o.note : ch.note!;
          s.setNote(folder, note, origin.by);
        } else if (ch.kind === 'add_folder' || ch.kind === 'create_folder') {
          s.addFolder(folder, ch.path!, { ...origin, why: ch.why, create: ch.kind === 'create_folder' });
          result = (await this.projects.applyToRunning(folder, { kind: 'add_folder', path: ch.path! }).catch(e => (this.noteError('proposal folder', e), {} as Record<string, AskerResult>)))[r.thread_id];
        } else if (ch.kind === 'remove_folder') {
          s.removeFolder(folder, ch.path!);
          await this.projects.applyToRunning(folder, { kind: 'remove_folder', path: ch.path! }, { restart: false });
          restartNeeded = true;
        } else if (ch.kind === 'set_variable') {
          s.setVariable(folder, ch.name!, values[ch.name!] as string, { ...origin, why: ch.why });
          await this.projects.applyToRunning(folder, { kind: 'set_variable', name: ch.name! }, { restart: false });
          restartNeeded = true;
        } else {
          s.removeVariable(folder, ch.name!);
          await this.projects.applyToRunning(folder, { kind: 'remove_variable', name: ch.name! }, { restart: false });
          restartNeeded = true;
        }
        lines.push(appliedLine(ch, result));
      } catch (e) {
        // the message names a path or a variable name, never a value
        lines.push(`not done: ${(e as Error).message}`);
      }
    }
    const restart = option === APPROVE_RESTART && needsRestart(p.changes);
    const tail = !restartNeeded ? '' : restart ? '. This chat restarts when this turn ends to get them; other running chats get them when they restart.' : '. This chat and the other running chats get them when they restart: call reload_project_settings to restart this one when your turn ends.';
    const text = `approved: ${lines.join('; ')}${tail}`;
    const ok = await this.typedVia(r.thread_id, () => c.answerRequest(r.id, text));
    if (ok && restart) this.projects.restartAtTurnEnd(r.thread_id, { settle: true });
    this.pushState();
    return { ok, text };
  }

  /**
   * An approved propose_new_project card: the main folder is made (with create) and registered, then the note, the folders (made
   * when asked) and the variables (the values typed on the card, straight to project-env.json) are set, all with who asked and this
   * card. No chat is started: "Create and open New chat there" only tells the answering page to open New chat with that folder. The
   * asking chat stays where it is and reads a text built here, never a value.
   */
  private async createProject(requestId: string, option: string, p: NonNullable<ReturnType<typeof parseProposal>>, values: Record<string, unknown>, note: unknown, origin: { by: string; by_thread: string; approval: string }): Promise<{ ok: boolean; text?: string; error?: string; open?: string }> {
    const c = this.c;
    const s = this.projectSettings;
    const folder = p.project;
    const chatsIn = c.store.listThreads().some(x => path.resolve(x.project ?? x.cwd) === folder);
    try {
      s.register(folder, { ...origin, create: !!p.create, hasChat: chatsIn });
    } catch (e) {
      // the folder became a project or appeared since the card was made: nothing is made; the chat hears why (a path, never a value)
      const text = `not done: ${(e as Error).message}`;
      const ok = await this.typedVia(c.store.getRequest(requestId)?.thread_id, () => c.answerRequest(requestId, text));
      this.pushState();
      return { ok, text, error: (e as Error).message };
    }
    const failed: string[] = [];
    let folders = 0, vars = 0;
    for (const ch of p.changes) {
      try {
        if (ch.kind === 'set_note') s.setNote(folder, typeof note === 'string' && note.trim() ? note : ch.note!, origin.by);
        else if (ch.kind === 'add_folder' || ch.kind === 'create_folder') (s.addFolder(folder, ch.path!, { ...origin, why: ch.why, create: ch.kind === 'create_folder' }), folders++);
        else if (ch.kind === 'set_variable') (s.setVariable(folder, ch.name!, values[ch.name!] as string, { ...origin, why: ch.why }), vars++);
      } catch (e) {
        failed.push(`not done: ${(e as Error).message}`);
      }
    }
    const n = (k: number, one: string) => `${k} ${one}${k === 1 ? '' : 's'}`;
    const text = `approved: created project ${placeName(folder)} at ${tilde(folder)} with ${n(folders, 'folder')} and ${n(vars, 'variable')} (values hidden). Chats started there get them.${failed.length ? ` ${failed.join('; ')}.` : ''}`;
    const ok = await this.typedVia(c.store.getRequest(requestId)?.thread_id, () => c.answerRequest(requestId, text));
    this.pushState();
    return { ok, text, ...(option === CREATE_OPEN ? { open: folder } : {}) };
  }

  /**
   * Deletes everything Chorus keeps for one project (the × on a project, after its warning): each chat whose folder is exactly
   * this one is stopped and deleted as DELETE chats/:id does (its rows in every table go, the paid module hears each one), the
   * project leaves the sidebar's lists, the skill sources the user added inside it are forgotten (rows only), and the paid
   * module is told once. Nothing on disk is deleted: not the folder, not a file in it, not its .chorus/.
   */
  async deleteProject(folder: string): Promise<{ removed: number } | { error: string }> {
    const c = this.c;
    const dir = path.resolve(expand(folder));
    if (!folder || !path.isAbsolute(dir)) return { error: 'the project folder is needed' };
    const chats = c.store.listThreads().filter(t => t.cwd === dir || t.project === dir);
    let removed = 0;
    this.deletingProject = true;
    try {
      for (const t of chats) {
        this.unlocked.delete(t.id);
        await c.deleteThread(t.id);
        if (c.store.getThread(t.id)) continue;
        removed++;
        this.chatDeleted(t.id);
      }
    } finally {
      this.deletingProject = false;
    }
    // the sidebar's own lists (ui.json): taken off, folded
    const ui = this.ui() as { hidden?: Record<string, unknown>; folded?: unknown };
    if (ui.hidden && dir in ui.hidden) delete ui.hidden[dir];
    if (Array.isArray(ui.folded)) ui.folded = ui.folded.filter(f => f !== dir);
    fs.writeFileSync(path.join(c.store.root, 'ui.json'), JSON.stringify(ui, null, 2));
    // Chorus's own records of skill folders inside it (never a file, never a link)
    for (const src of c.store.skillSources()) if (src.path === dir || src.path.startsWith(dir + path.sep)) c.store.removeSkillSource(src.path);
    // its working folders, variable names and values (projects.json, project-env.json); the folders themselves stay on disk
    this.projectSettings.forget(dir);
    this.pro.chatEvent({ type: 'project-deleted', project: dir } as { type: string });
    this.pushState();
    return { removed };
  }

  private ask(d: Omit<Dialog, 'id'>): Promise<unknown> {
    const id = crypto.randomBytes(6).toString('hex');
    return new Promise(resolve => {
      this.dialogs.set(id, { d: { id, ...d }, resolve });
      this.pushState();
    });
  }

  answer(id: string, value: unknown) {
    const p = this.dialogs.get(id);
    if (!p) return false;
    this.dialogs.delete(id);
    p.resolve(value === null ? undefined : value);
    this.pushState();
    return true;
  }

  async start(port = this.o.port ?? 0): Promise<string> {
    this.http = http.createServer((req, res) => void this.handle(req, res).catch(e => (this.noteError(`${req.method} ${req.url?.split('?')[0]}`, e), send(res, 500, { error: String((e as Error)?.message ?? e) }))));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, sock, head) => {
      if (this.isRemote(req)) {
        // another device, through the private link: only one this Mac allowed, from its own page (stage 7)
        return void this.pro.remote({ method: 'GET', url: req.url ?? '/', headers: req.headers }).then(
          d => (d && 'pass' in d && d.origins.includes(String(req.headers.origin ?? '')) ? this.wss!.handleUpgrade(req, sock, head, ws => this.connect(ws, true)) : sock.destroy()),
          () => sock.destroy(),
        );
      }
      if (!this.allowed(req) || !this.sameOrigin(req)) return sock.destroy();
      // the native window says so (/ws?window=native): while it is open, only it sets the agents' screen size
      const native = new URL(req.url ?? '/', 'http://x').searchParams.get('window') === 'native';
      this.wss!.handleUpgrade(req, sock, head, ws => this.connect(ws, false, native));
    });
    const listen = (p: number) =>
      new Promise<void>((resolve, reject) => {
        this.http!.once('error', reject);
        this.http!.listen(p, this.o.host ?? '127.0.0.1', () => resolve());
      });
    // the usual port when it is free, any free one otherwise
    await listen(port).catch(() => listen(0));
    const bound = (this.http.address() as AddressInfo).port;
    const named = this.o.host && !WILDCARD.has(this.o.host) ? this.o.host : '127.0.0.1';
    this.url = `http://${named.includes(':') ? `[${named}]` : named}:${bound}`;
    this.hostNames = hostNames(this.o.host);
    // before the first tick: the mailbox's and the sub threads' watches are registered again (the watcher kept their data)
    try {
      this.mail.restore();
      this.subs.restore();
    } catch (e) {
      this.noteError('watch restore', e);
    }
    this.ticker = setInterval(() => {
      try {
        this.watch.tick();
      } catch (e) {
        this.noteError('watch', e);
      }
      try {
        this.answerLaunchScreens();
      } catch (e) {
        this.noteError('launch folders', e);
      }
      try {
        this.subs.tick();
        this.scanMail();
      } catch (e) {
        this.noteError('sub threads', e);
      }
      this.pushState();
    }, 500);
    // openUrl: the page's address with its token, printed by `chorus` after the window opens (a browser tab on the same Chorus).
    // A second serve on the same home leaves a running one's file alone (it never wrote it, so close() never deletes it): the chats
    // of the first find their serve through their launch env, and the window still opens the first (task #14)
    const other = await this.otherServe();
    if (other) console.error(`[serve] another Chorus is running on this home (${other}): its serve.json is kept`);
    else fs.writeFileSync(this.serveFile, JSON.stringify({ url: this.url, openUrl: this.openUrl, mcpToken: this.mcpToken }), { mode: 0o600 });
    void this.pro.start();
    const tested = JSON.stringify(remoteTested());
    if (this.o.notifications)
      void this.o.notifications.startup().then(() => {
        this.pushState();
        // the backend's answer came after the check at start and changed the tested versions: check again against the new list
        if (this.agentCheck && JSON.stringify(remoteTested()) !== tested) void this.checkAgents({ quiet: true }).catch(e => this.noteError('doctor check', e));
      });
    if (this.o.updates) {
      this.o.updates.onChange(() => this.pushState());
      void this.o.updates.startup().then(() => this.pushState());
    }
    void this.checkAgents().catch(e => this.noteError('doctor check', e));
    return this.url;
  }

  /** Runs the short check (one at a time: a second ask waits for the running one) and pushes the answer to every window. */
  checkAgents(o: { quiet?: boolean } = {}): Promise<{ at: string; report: FastReport }> {
    if (!o.quiet) this.checkShown = true;
    this.checking ??= (async () => {
      // the first check waits briefly for this launch's backend answer, which may add versions tested after this build
      if (!this.agentCheck) await Promise.race([this.o.notifications?.startup(), new Promise(r => setTimeout(r, 3000))]);
      const report = await (this.o.check ?? (() => check()))();
      this.agentCheck = { at: new Date().toISOString(), report };
      this.pro.chatEvent({ type: 'doctor' });
      return this.agentCheck;
    })().finally(() => {
      this.checking = undefined;
      this.checkShown = false;
      this.pushState();
    });
    this.pushState();
    return this.checking;
  }

  /** The window came back to the front, or (`waiting`) the page's 30 s loop while an agent waits for the user: a quiet check,
   *  so a login or an install done in a terminal shows without Check again. At most one every 10 s, however many windows ask;
   *  none before the check at start; the loop's asks run only while some agent is not Ready. */
  refreshAgents(o: { waiting?: boolean } = {}): boolean {
    if (this.checking || !this.agentCheck || Date.now() - Date.parse(this.agentCheck.at) < 10_000) return false;
    if (o.waiting && this.agentCheck.report.agents.every(a => a.state === 'ready')) return false;
    void this.checkAgents({ quiet: true }).catch(e => this.noteError('doctor check', e));
    return true;
  }

  private agentNow(agent: AgentId): AgentCheck | undefined {
    return this.agentCheck?.report.agents.find(a => a.agent === agent);
  }

  /** The address to open: the token goes in once, then lives in a cookie. */
  get openUrl() {
    return `${this.url}/?token=${this.token}`;
  }

  private get serveFile() {
    return path.join(this.c.store.root, 'serve.json');
  }

  /** The address of another serve that serve.json names, when it answers serve's health route for this same home. */
  private async otherServe(): Promise<string | undefined> {
    let info: { url?: string; mcpToken?: string };
    try {
      info = JSON.parse(fs.readFileSync(this.serveFile, 'utf8'));
    } catch {
      return undefined;
    }
    if (!info.url || !info.mcpToken || info.url === this.url) return undefined;
    try {
      const r = await fetch(`${info.url}/api/pro/mcp/health`, { headers: { authorization: `Bearer ${info.mcpToken}`, 'x-chorus': '1' }, signal: AbortSignal.timeout(1500) });
      if (!r.ok) return undefined;
      const j = (await r.json()) as { home?: string };
      return j.home === realHome(this.c.store.root) ? info.url : undefined;
    } catch {
      return undefined;
    }
  }

  close() {
    this.closed = true;
    this.channels.close();
    this.pro.close();
    this.signIns.close();
    try {
      if ((JSON.parse(fs.readFileSync(this.serveFile, 'utf8')) as { url: string }).url === this.url) fs.rmSync(this.serveFile);
    } catch {
      /* already gone */
    }
    this.o.notifications?.close();
    this.o.updates?.close();
    clearInterval(this.ticker);
    for (const cl of this.clients) cl.ws.close();
    this.wss?.close();
    this.http?.close();
    this.http?.closeAllConnections?.();
  }

  /* ---------- auth ---------- */

  private hostOk(req: http.IncomingMessage) {
    // --host 0.0.0.0 (the Chorus box): any address this machine is reached by (a LAN address, a host name); the token guards every
    // request until Chorus has a login (owner's decision, 2026-11-08)
    if (this.o.host && WILDCARD.has(this.o.host)) return !!req.headers.host;
    const port = (this.http?.address() as AddressInfo | null)?.port;
    return this.hostNames.some(h => req.headers.host === `${h}:${port}`);
  }

  /** Cookies are shared by every port of a host: the name carries the port, so two servers (or a restarted one) never mix. */
  private get cookieName() {
    return `chorus_token_${(this.http?.address() as AddressInfo | null)?.port ?? 0}`;
  }

  /** Every token the request carries: the header, our cookie, the address. One right token is enough. */
  private tokensOf(req: http.IncomingMessage) {
    const auth = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const cookie = req.headers.cookie?.split(/;\s*/).find(c => c.startsWith(this.cookieName + '='))?.slice(this.cookieName.length + 1);
    const query = new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? undefined;
    return [auth, cookie, query].filter((t): t is string => !!t);
  }

  private allowed(req: http.IncomingMessage) {
    const ok = (t: string) => t.length === this.token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(this.token));
    return this.hostOk(req) && this.tokensOf(req).some(ok);
  }

  private sameOrigin(req: http.IncomingMessage) {
    const origin = req.headers.origin;
    // no Origin: not a browser (tests, scripts with the token); a browser must be on our page
    const port = (this.http?.address() as AddressInfo | null)?.port;
    // any address allowed (--host 0.0.0.0): the page must still be ours, at the very address it was asked by
    if (this.o.host && WILDCARD.has(this.o.host)) return !origin || origin === `http://${req.headers.host}`;
    return !origin || origin === 'tauri://localhost' || this.hostNames.some(h => origin === `http://${h}:${port}`);
  }

  /* ---------- HTTP ---------- */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url ?? '/', this.url);
    if (this.isRemote(req)) return this.remoteHttp(req, res, u);
    if (!this.hostOk(req)) return send(res, 403, { error: 'wrong host' });
    // the first visit carries the token in the URL: the page comes with it in a cookie and drops it from the address bar.
    // No redirect: a window that navigates here from another origin (the desktop app's tauri://) is a cross-site
    // navigation, and a SameSite=Strict cookie set on a redirect would not come back on the redirected request.
    if (u.pathname === '/' && u.searchParams.get('token')) {
      if (!this.allowed(req)) return send(res, 401, { error: 'bad token' });
      res.setHeader('set-cookie', `${this.cookieName}=${this.token}; HttpOnly; SameSite=Strict; Path=/`);
      return this.file('/', res);
    }
    if (u.pathname.startsWith('/api/pro/mcp/') && this.mcpAllowed(req)) return this.proMcp(req, res, u.pathname.slice(13));
    // the browser coming back from sign-up (plan stage 6): another browser, so no token cookie; the single-use state it carries,
    // made by an authenticated Try Pro, is what lets it in
    if (req.method === 'GET' && u.pathname === '/api/pro/signed-in') return this.signedIn(res, u);
    // the browser coming back from the payment page (plan stage 8): it only makes the app ask the server again, so it needs no token
    if (req.method === 'GET' && u.pathname === '/api/pro/paid') return this.paid(res);
    if (!this.allowed(req)) return send(res, 401, { error: 'open the address chorus serve printed (it carries the token)' });
    if (req.method !== 'GET' && (req.headers['x-chorus'] !== '1' || !this.sameOrigin(req))) return send(res, 403, { error: 'missing X-Chorus header' });
    return this.authed(req, res, u);
  }

  /**
   * Came through a proxy (Tailscale Serve or Funnel) or for another host name. chorus serve still listens on 127.0.0.1 only; such a request
   * goes to the optional module, which lets a device this Mac allowed in, or answers itself. With no module there is nothing to reach.
   */
  isRemote(req: http.IncomingMessage) {
    const h = req.headers;
    return !!(h['x-forwarded-for'] || h['forwarded'] || h['tailscale-user-login'] || h['tailscale-funnel-request']) || (!!h.host && !this.hostOk(req));
  }

  private async remoteHttp(req: http.IncomingMessage, res: http.ServerResponse, u: URL) {
    const withBody = req.method === 'POST' && (u.pathname === '/mcp' || u.pathname.startsWith('/mcp/') || u.pathname.startsWith('/_remote/'));
    const body = withBody ? await readRaw(req, 1_000_000).catch(() => undefined) : undefined;
    if (withBody && !body) return send(res, 413, { error: 'too large' });
    // for the Tailscale probe (docs/integrations/tailscale.md): which headers a proxied request carries, cookies and keys left out
    if (process.env.CHORUS_PRO_LOG) console.error(`[pro] remote ${req.method} ${u.pathname} ${JSON.stringify(Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['cookie', 'authorization'].includes(k))))}`);
    const d = await this.pro.remote({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body });
    if (!d) return this.hostOk(req) ? send(res, 404, { error: 'not found' }) : send(res, 403, { error: 'wrong host' });
    if ('answer' in d) {
      res.writeHead(d.answer.status, d.answer.headers ?? {});
      return res.end(d.answer.body ?? '');
    }
    if (req.method !== 'GET' && (req.headers['x-chorus'] !== '1' || !d.origins.includes(String(req.headers.origin ?? '')))) return send(res, 403, { error: 'missing X-Chorus header' });
    // which devices may come in is decided on the Mac itself, never from a device
    if (u.pathname === '/api/pro/remote' && req.method !== 'GET') return send(res, 403, { error: 'Change remote access on the Mac itself.' });
    // so is updating Chorus: only the Mac's own window installs and restarts it
    if (/^\/api\/updates\/(install|restart)$/.test(u.pathname)) return send(res, 403, { error: 'Update Chorus on the Mac.' });
    return this.authed(req, res, u);
  }

  /** Past the checks: a request from this Mac's window, or from a device it allowed. */
  private async authed(req: http.IncomingMessage, res: http.ServerResponse, u: URL) {
    if (!u.pathname.startsWith('/api/')) return this.file(u.pathname, res);
    if (u.pathname.startsWith('/api/pro/')) return this.proHttp(req, res, u);
    // a dropped file with no path (a browser gives the bytes only, or an image dragged from a page): the raw bytes, its name in
    // the address; saved in the chat's attachments folder and its path put into the agent's input (docs/phase5.md §8.3)
    const upload = req.method === 'POST' && u.pathname.match(/^\/api\/chats\/([\w-]+)\/attachments$/);
    if (upload) {
      // a locked sub thread takes no dropped files, as it takes no keys
      if (this.c.store.getThread(upload[1])?.sub_status && !this.isUnlocked(upload[1])) return send(res, 409, { error: 'This sub thread is watch-only: give the file to its main chat, or Unlock it first' });
      const bytes = await readRaw(req, UPLOAD_LIMIT).catch(() => undefined);
      if (!bytes) return send(res, 413, { error: `a dropped file can be at most ${UPLOAD_LIMIT / 1_000_000} MB` });
      const r = this.c.dropFiles(upload[1], [{ name: u.searchParams.get('name') ?? 'file', bytes }]);
      return send(res, 'error' in r ? 409 : 200, r);
    }
    // the file viewer (plan 2026-11-25): what a file is and its content (view), or its bytes (raw); a reported file (?r=) or a file in
    // the chat's artifacts folder (?p=). Through the private link only files inside the chat's project; nothing is ever opened here
    const fv = req.method === 'GET' && u.pathname.match(/^\/api\/chats\/([\w-]+)\/files\/(view|raw)$/);
    if (fv) return this.fileRoute(req, res, u, fv[1], fv[2] === 'raw');
    // reported artifacts (plan 2026-11-13, item 5): a device on the private link opens only files inside the chat's project, served
    // to it here; it never opens anything on the Mac. Links and files elsewhere say "Open on the Mac"
    const rep = u.pathname.match(/^\/api\/chats\/([\w-]+)\/(?:reported\/(\d+)|open-report|open-path|open)$/);
    if (rep) {
      const remote = this.isRemote(req);
      if (req.method === 'POST' && remote) return send(res, 403, { error: 'Open it on the Mac.' });
      if (req.method === 'GET' && rep[2]) {
        const a = this.reported(rep[1]).find(x => x.id === Number(rep[2]));
        if (!a || a.link || (remote && !a.inside)) return send(res, a ? 403 : 404, { error: a ? 'Open it on the Mac.' : 'not found' });
        res.writeHead(200, { 'content-type': TYPES[path.extname(a.target).toLowerCase()] ?? FILE_TYPES[path.extname(a.target).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" });
        return void fs.createReadStream(a.target).pipe(res);
      }
    }
    // a report carries up to 4 screenshots of about 1 MB each, as base64
    // reading a dropped image by its path is for this Mac's own window, never a device on the private link
    if (u.pathname === '/api/doctor/issue/image' && this.isRemote(req)) return send(res, 403, { error: 'Add it on the Mac.' });
    let body: Record<string, any>;
    try {
      body = req.method === 'GET' ? {} : await readJson(req, u.pathname === '/api/doctor/issue/send' ? 8_000_000 : 1_000_000);
    } catch (e) {
      return send(res, (e as Error).message === 'too large' ? 413 : 400, { error: (e as Error).message });
    }
    const out = await this.route(req.method ?? 'GET', u.pathname.slice(5).split('/').map(decodeURIComponent), u.searchParams, body);
    if (out === undefined) return send(res, 404, { error: 'not found' });
    send(res, 200, out);
  }

  /** GET …/files/view and …/files/raw: one file of a chat for the viewer (src/serve/fileview.ts). */
  private fileRoute(req: http.IncomingMessage, res: http.ServerResponse, u: URL, id: string, raw: boolean) {
    const f = this.chatFile(id, u.searchParams);
    if ('status' in f) return send(res, f.status, { error: f.error });
    const meta = { title: f.title, ...(f.rel ? { rel: f.rel } : {}) };
    if (f.gone) return raw ? send(res, 404, { error: 'That file is no longer there.' }) : send(res, 200, fileNote(f.abs, meta, 'gone'));
    if (this.isRemote(req) && !f.inside) return raw ? send(res, 403, { error: 'This file stays on your Mac.' }) : send(res, 200, fileNote(f.abs, { title: f.title }, 'outside'));
    if (!raw) return send(res, 200, viewFile(f.abs, meta));
    let size: number;
    try {
      size = fs.statSync(f.abs).size;
    } catch {
      return send(res, 404, { error: 'That file is no longer there.' });
    }
    if (size > MEDIA_MAX) return send(res, 413, { error: `Files over ${MEDIA_MAX / 1_000_000} MB are not sent here.` });
    const ext = path.extname(f.abs).toLowerCase();
    res.writeHead(200, { 'content-type': TYPES[ext] ?? FILE_TYPES[ext] ?? 'application/octet-stream', 'content-length': String(size), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" });
    fs.createReadStream(f.abs).on('error', () => res.destroy()).pipe(res);
  }

  /**
   * The file a viewer request names: ?r=<reported id> (a file the chat reported; `inside` when it is in the chat's project) or
   * ?p=<path in the chat's artifacts folder> (resolved with realpath; anything that leaves the folder, by .. or a link, is refused).
   */
  private chatFile(id: string, q: URLSearchParams): { abs: string; title: string; rel?: string; inside: boolean; gone: boolean } | { status: number; error: string } {
    const c = this.c, t = c.store.getThread(id);
    if (!t) return { status: 404, error: 'no such chat' };
    const real = (p: string) => fs.realpathSync(p);
    const isFile = (p: string) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    };
    const within = (dir: string, p: string) => {
      const rel = path.relative(dir, p);
      return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    const r = q.get('r');
    if (r !== null) {
      const a = c.store.reportedArtifacts(id).find(x => x.id === Number(r));
      if (!a) return { status: 404, error: 'not found' };
      if (/^https?:\/\//i.test(a.target)) return { status: 400, error: 'That is a link, not a file.' };
      const title = a.title ?? path.basename(a.target);
      if (!isFile(a.target)) return { abs: a.target, title, inside: false, gone: true };
      let project: string;
      try {
        project = real(t.project ?? t.cwd);
      } catch {
        project = t.project ?? t.cwd;
      }
      const target = real(a.target);
      const inside = within(project, target);
      return { abs: a.target, title, ...(inside ? { rel: path.relative(project, target) } : {}), inside, gone: false };
    }
    // ?f=: a path the agent wrote in its reply (phone e2e 2026-11-25), absolute, ~/…, or relative to the chat's project. The Mac's own page
    // may view any file of this Mac (it reads them anyway); a device only files inside the project, as for reported files
    const f = q.get('f');
    if (f !== null) {
      if (!f || f.includes('\0') || f.length > 1000) return { status: 400, error: 'f is a path' };
      const base = t.project ?? t.cwd;
      const abs = f.startsWith('~/') ? path.join(os.homedir(), f.slice(2)) : path.resolve(base, f);
      const title = path.basename(abs);
      if (!isFile(abs)) return { abs, title, inside: false, gone: true };
      let project: string;
      try {
        project = real(base);
      } catch {
        project = base;
      }
      const target = real(abs);
      const inside = within(project, target);
      return { abs, title, ...(inside ? { rel: path.relative(project, target) } : {}), inside, gone: false };
    }
    const p = q.get('p');
    if (p === null || !p || p.includes('\0') || path.isAbsolute(p)) return { status: 400, error: 'r, f or p is needed' };
    const dir = c.store.artifactsDir(id);
    const abs = path.resolve(dir, p);
    if (!within(dir, abs)) return { status: 403, error: "That is not in this chat's files." };
    const title = path.basename(abs);
    if (!isFile(abs)) return { abs, title, rel: p, inside: true, gone: true };
    // a link inside the folder that points out of it is refused like a .. path
    if (!within(real(dir), real(abs))) return { status: 403, error: "That is not in this chat's files." };
    return { abs, title, rel: path.relative(dir, abs), inside: true, gone: false };
  }

  private mcpAllowed(req: http.IncomingMessage) {
    const t = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const ok = !!t && t.length === this.mcpToken.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(this.mcpToken));
    return ok && this.hostOk(req) && !req.headers.origin && (req.method === 'GET' || req.headers['x-chorus'] === '1');
  }

  private async proMcp(req: http.IncomingMessage, res: http.ServerResponse, route: string) {
    // a second `chorus serve` on the same home asks whether this one is alive before it touches serve.json (task #14)
    if (req.method === 'GET' && route === 'health') return send(res, 200, { home: realHome(this.c.store.root), url: this.url });
    if (req.method === 'GET' && route === 'tools') {
      const app = new URL(req.url ?? '/', 'http://x').searchParams.get('app') === '1';
      // a chat gets the sub thread tools whatever the paid module's state; an AI app the user connected does not
      const paid = await this.pro.mcpTools(app);
      return send(res, 200, { tools: app ? paid : [...SUB_TOOLS, ...paid.filter(t => !SUB_TOOL_NAMES.includes(t.name))] });
    }
    if (req.method === 'GET' && route === 'role') {
      // the chat's role from the bundle, for current_thread and the request_approval guard (`chorus mcp` is its own process)
      const thread = new URL(req.url ?? '/', 'http://x').searchParams.get('thread') ?? '';
      const role = this.pro.roleOf(thread) ?? null;
      return send(res, 200, { role, readOnly: !!this.pro.chatExtras(thread)?.readOnly, actionLabels: this.pro.allActionLabels() ?? [] });
    }
    if (req.method === 'GET' && route.startsWith('channel')) {
      // a Claude chat's `chorus mcp` holds this open: its channel pushes come down it (src/serve/mail.ts ChannelHub)
      const thread = new URL(req.url ?? '/', 'http://x').searchParams.get('thread') ?? '';
      if (!this.c.store.getThread(thread)) return send(res, 404, { error: 'no such chat' });
      return this.channels.open(thread, res);
    }
    if (req.method === 'POST' && route === 'call') {
      const b = await readJson(req);
      if (process.env.CHORUS_PRO_LOG) console.error(`[pro] mcp ${String(b.name)} thread ${String(b.threadId)}`);
      if ((SERVE_TOOL_NAMES as readonly string[]).includes(String(b.name))) {
        // read_mail and list_watches: free, every chat; the mailbox and the watcher live here
        const thread = typeof b.threadId === 'string' ? b.threadId : '';
        if (!this.c.store.getThread(thread)) return send(res, 400, { error: 'This chat is not a Chorus thread.' });
        const args = (b.args ?? {}) as { id?: string; all?: boolean; key?: string; ended?: boolean };
        const r = b.name === 'read_mail' ? readMailText(this.mail, thread, args) : listWatchesText({ store: this.c.store, watch: this.watch, thread, now: this.now() }, args);
        return r.isError ? send(res, 400, { error: r.text }) : send(res, 200, { text: r.text });
      }
      if ((PROJECT_TOOL_NAMES as readonly string[]).includes(String(b.name))) {
        // get_project, propose_project_change, reload_project_settings, rename_chat: free, every chat, its own project only
        const r = await this.projectTool(String(b.name), (b.args ?? {}) as Record<string, unknown>, typeof b.threadId === 'string' ? b.threadId : '');
        return r.isError ? send(res, 400, { error: r.text }) : send(res, 200, { text: r.text });
      }
      if (SUB_TOOL_NAMES.includes(String(b.name))) {
        const r = await this.subs.call(String(b.name), (b.args ?? {}) as Record<string, unknown>, typeof b.threadId === 'string' ? b.threadId : undefined);
        return 'error' in r ? send(res, 400, r) : send(res, 200, r);
      }
      const r = await this.pro.mcpCall(String(b.name), (b.args ?? {}) as Record<string, unknown>, typeof b.threadId === 'string' ? b.threadId : undefined);
      return send(res, r.status, r.json);
    }
    send(res, 404, { error: 'not found' });
  }

  /** Try Pro states waiting for the browser to come back: each works once, for 30 minutes. */
  private tries = new Map<string, number>();
  private plansWords: unknown;

  private async signedIn(res: http.ServerResponse, u: URL) {
    const state = u.searchParams.get('state') ?? '', code = u.searchParams.get('code') ?? '', then = u.searchParams.get('then') === 'upgrade' ? 'upgrade' : '';
    const ok = (this.tries.get(state) ?? 0) > Date.now();
    this.tries.delete(state);
    const page = (title: string, text: string) => {
      res.writeHead(ok ? 200 : 403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>:root{color-scheme:light dark}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:light-dark(#faf9f5,#262624);color:light-dark(#141413,#f5f4ee)}main{max-width:420px;margin:12vh auto;padding:26px;border:1px solid light-dark(#e5e2d9,#3c3b38);border-radius:16px;background:light-dark(#fff,#30302e);text-align:center}h1{font:400 26px/1.2 Georgia,serif;margin:0 0 8px}p{margin:0;color:light-dark(#73726c,#a6a39a)}</style><main><h1>${title}</h1><p>${text}</p></main>`);
    };
    if (!ok || !code) return page('Sign in again from Chorus', 'This sign-in link was already used or has expired. Open Chorus and choose Try Pro free again.');
    const st = await this.pro.signIn(code, state);
    // Buy Pro: this tab goes straight on to the payment page (owner, 2026-11-19: it stopped at "Go back to Chorus"). The page
    // can't open it itself in the Docker box: a tab it opens without a click is blocked. Chorus's page shows "Finish paying".
    if (st.unlocked && then === 'upgrade') {
      const r = await this.pro.upgrade(Number(new URL(this.url).port) || undefined).catch((e: Error) => ({ error: e.message }) as { url?: string; pro?: boolean; error?: string });
      if (r.url && /^https:\/\//.test(r.url)) {
        this.broadcast({ t: 'pro-signed-in', status: st, then: 'paying' });
        res.writeHead(302, { location: r.url, 'cache-control': 'no-store' });
        return void res.end();
      }
      if (r.pro) {
        this.broadcast({ t: 'pro-signed-in', status: this.pro.status(), then: '' });
        return page('You have Chorus Pro', 'This account has paid already. Go back to Chorus: it is ready. You can close this tab.');
      }
    }
    this.broadcast({ t: 'pro-signed-in', status: st, then });
    if (!st.unlocked) return page('Something went wrong', `${st.message ?? 'Chorus could not finish signing you in.'} Open Chorus and try again.`);
    page('You\'re signed in', 'Go back to Chorus: it is ready. You can close this tab.');
  }

  private lastPaid = 0;

  /** Back from paying: ask the server, once every few seconds at most, and say what it answered. The page changes nothing itself. */
  private async paid(res: http.ServerResponse) {
    const st = Date.now() - this.lastPaid < 3000 ? this.pro.status() : ((this.lastPaid = Date.now()), await this.pro.recheck());
    this.broadcast({ t: 'pro-status', status: st });
    const pro = st.unlocked && st.plan === 'pro';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chorus</title><style>:root{color-scheme:light dark}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:light-dark(#faf9f5,#262624);color:light-dark(#141413,#f5f4ee)}main{max-width:420px;margin:12vh auto;padding:26px;border:1px solid light-dark(#e5e2d9,#3c3b38);border-radius:16px;background:light-dark(#fff,#30302e);text-align:center}h1{font:400 26px/1.2 Georgia,serif;margin:0 0 8px}p{margin:0;color:light-dark(#73726c,#a6a39a)}</style><main>${pro ? '<h1>You have Chorus Pro</h1><p>Thank you. Go back to Chorus: it is ready. You can close this tab.</p>' : '<h1>Not confirmed yet</h1><p>The payment can take a few seconds to confirm. Go back to Chorus and choose <b>Check again</b>.</p>'}</main>`);
  }

  /** /api/pro/*: the status and Unlock always answer; everything else is the module's, or 402 from ProHost. */
  private async proHttp(req: http.IncomingMessage, res: http.ServerResponse, u: URL) {
    const route = u.pathname.slice(9);
    if (req.method === 'POST' && route === 'try') {
      // Try Pro free: the sign-up page in the user's own browser; it comes back to /api/pro/signed-in with a one-time code
      const { tryUrl } = this.pro.links();
      if (!tryUrl) return send(res, 200, { error: 'Pro sign-up is not available in this build' });
      const state = crypto.randomBytes(24).toString('base64url');
      this.tries.set(state, Date.now() + 30 * 60_000);
      // then=upgrade: Buy Pro, so the page comes back to payment after signing in (plan 2026-11-09)
      const body: Record<string, unknown> = await readJson(req).catch(() => ({}));
      const q: Record<string, string> = { state, port: new URL(this.url).port };
      if (body.then === 'upgrade') q.then = 'upgrade';
      const url = `${tryUrl}?${new URLSearchParams(q)}`;
      // in a container the browser is on another computer: the page opens it
      if (!this.container) (this.o.openLink ?? openUrl)(url);
      return send(res, 200, { ok: true, url, ...(this.container ? { open: url } : {}) });
    }
    if (req.method === 'GET' && route === 'plans') {
      // the Welcome screen's words come from the backend (no sales text in this repo); fetched once, only when it shows
      if (!this.plansWords) {
        const { plansUrl } = this.pro.links();
        this.plansWords = plansUrl ? await fetch(plansUrl, { signal: AbortSignal.timeout(6000) }).then(r => (r.ok ? r.json() : undefined)).catch(() => undefined) : undefined;
      }
      return send(res, 200, this.plansWords ?? { offline: true });
    }
    if (req.method === 'GET' && route === 'status') return send(res, 200, this.pro.status());
    if (req.method === 'POST' && route === 'upgrade') {
      // Upgrade (plan stage 8): the server's payment page in the user's own browser; it links back to /api/pro/paid
      const r = await this.pro.upgrade(Number(new URL(this.url).port) || undefined);
      // in a container (the Docker box) the browser is on another computer: the page opens it, as for Try Pro (2026-11-19: Upgrade
      // in the box opened nothing)
      if (r.url && !this.container) (this.o.openLink ?? openUrl)(r.url);
      return send(res, 200, { ...r, ...(r.url && this.container ? { open: r.url } : {}) });
    }
    if (req.method === 'POST' && route === 'recheck') return send(res, 200, await this.pro.recheck());
    if (req.method === 'POST' && route === 'activate') return send(res, 200, await this.pro.activate(String((await readJson(req)).key ?? '')));
    if (req.method === 'GET' && (route === 'ui.js' || route === 'ui.css')) {
      const ui = await this.pro.ui();
      if (!ui) return send(res, 402, { locked: true });
      res.writeHead(200, { 'content-type': route === 'ui.js' ? TYPES['.js'] : TYPES['.css'], 'cache-control': 'no-store' });
      return res.end(route === 'ui.js' ? ui.js : ui.css);
    }
    const r = await this.pro.call(req.method ?? 'GET', route, Object.fromEntries(u.searchParams), req.method === 'GET' ? {} : await readJson(req));
    send(res, r.status, r.json);
  }

  private file(p: string, res: http.ServerResponse) {
    let file: string | undefined;
    if (p === '/' || p === '/index.html') file = path.join(UI_DIR, 'index.html');
    else if (p.startsWith('/vendor/') && VENDOR[p.slice(8)]) file = path.join(ROOT, VENDOR[p.slice(8)]);
    else {
      const f = path.join(UI_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (f.startsWith(UI_DIR + path.sep)) file = f;
    }
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' });
    // a vendored library with its version in its name (src/desktop/vendor/mermaid-<v>.min.js) never changes: kept by the browser
    const pinned = /^\/vendor\/[\w.-]+-\d+\.\d+\.\d+\.min\.js$/.test(p);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': pinned ? 'public, max-age=31536000, immutable' : 'no-store' });
    fs.createReadStream(file).pipe(res);
  }

  /** A web page for the user: opened here in their browser, or, in a container (their browser is on the host), handed to the page,
   *  which opens it (`open` in the answer; api() in app.js). */
  private openLink(url: string, opener: (url: string) => void = openUrl) {
    if (this.container) return { ok: true, open: url };
    opener(url);
    return { ok: true };
  }

  /** Every operation of the desktop. Returns undefined for an unknown route (404). */
  /** Start what the user clicked in the doctor popup: install (pinned to the newest tested version when it can be), the
   *  tested version, a sign-in, or the deeper test. Only commands from the install table run here. */
  private async doctorRun(agent: AgentId, action: string): Promise<unknown> {
    const info = CLIS[agent];
    if (!info) return { error: 'unknown agent' };
    const a = this.agentNow(agent) ?? (await this.checkAgents()).report.agents.find(x => x.agent === agent)!;
    const command = action === 'install' ? a.install?.command : action === 'tested' ? a.testedInstall : action === 'login' ? info.login.join(' ') : undefined;
    if (action !== 'deep' && !command) return { error: `nothing to ${action} for ${info.name}` };
    // the Chorus box (docker/box): no terminal app to open, and a sign-in needs one (a code to paste back), so the Doctor shows the
    // command to run from the computer's own terminal (plan 2026-11-07 part B)
    if (action === 'login' && this.container) {
      // the sign-in runs here and the page opens its link (signin.ts); the docker exec command stays as the fallback it shows
      const si = this.signIns.start(agent);
      return { id: '', agent, action, command, done: true, ok: false, output: '', results: [], signIn: si.id, hostCommand: boxLoginCommand(agent, process.env.CHORUS_BOX_NAME) };
    }
    if (action === 'login' && agent === 'agy') {
      if (!openInTerminal('agy')) return { error: 'agy signs in when it starts: run `agy` once in a terminal' };
      return { id: '', agent, action, command, done: true, ok: true, output: '', results: [], terminal: true };
    }
    const job: DoctorJob = { id: crypto.randomBytes(4).toString('hex'), agent, action, command, done: false, output: '', results: [] };
    this.doctorJobs.set(job.id, job);
    void (async () => {
      if (action === 'deep') {
        const run = await (this.o.deep ?? runDeep)(agent, e => e.type === 'scenario-end' && job.results.push(e.result));
        recordDeep(run.report); // a failed critical scenario turns this version off (the short check below reads it)
        this.deepReports = [...this.deepReports.filter(d => d.agent !== agent), run.report];
        job.ok = run.report.ok;
        job.report = run.report;
        job.dir = run.dir;
      } else {
        job.ok = (await (this.o.runCommand ?? runCommand)(command!, s => (job.output = (job.output + s).slice(-20_000)))) === 0;
      }
      // what the install, login or test changed is on every screen (also when the Doctor is closed by now) before the job ends
      await this.checkAgents().catch(e => this.noteError('doctor check', e));
      job.done = true;
    })();
    return job;
  }

  private async route(method: string, parts: string[], q: URLSearchParams, b: Record<string, any>): Promise<unknown> {
    const [a, id, sub] = parts;
    const c = this.c;
    if (a === 'export' && method === 'POST') {
      // the top bar's Export: everything, in one .zip in Downloads (plan stage 11, free for everyone)
      if (!id && b.project !== undefined) {
        // Settings › Projects › <project> › Export: only its chats and artifacts, and its tasks with Pro (never pro.db, never a value)
        const project = this.projectDir(b.project);
        if (!project) return { error: 'the project folder is needed' };
        try {
          const r = exportProject({ home: c.store.root, version: versions().chorus, dir: this.o.exportDir, project, pro: await this.pro.exportProject(project) });
          this.lastExport = r.file;
          return r;
        } catch (e) {
          return { error: `Could not export: ${(e as Error).message}` };
        }
      }
      if (!id) {
        try {
          const r = exportAll({ home: c.store.root, version: versions().chorus, dir: this.o.exportDir });
          this.lastExport = r.file;
          return r;
        } catch (e) {
          return { error: `Could not export: ${(e as Error).message}` };
        }
      }
      if (id === 'reveal' && this.lastExport) return (this.o.onReveal ?? reveal)(this.lastExport), { ok: true };
      return undefined;
    }
    if (a === 'updates') {
      if (method === 'POST' && id === 'skip' && parts.length === 2) { this.o.updates?.skip(); this.pushState(); return { ok: true }; }
      if (method === 'POST' && id === 'open' && parts.length === 2) {
        const url = this.o.updates?.updateUrl();
        if (!url) return { error: 'No update is available for this platform' };
        return this.openLink(url, this.o.onUpdateOpen);
      }
      // Update Chorus in the app: the official installer, then Restart (requests through the private link never get here)
      if (method === 'POST' && id === 'install' && parts.length === 2) {
        if (!this.o.updates) return { error: 'No update is available' };
        if (this.container) return { error: 'Update the container instead: Chorus runs in it.' };
        return this.o.updates.install();
      }
      if (method === 'POST' && id === 'restart' && parts.length === 2) return this.o.updates?.restart() ?? { error: 'Nothing is installed yet' };
      return undefined;
    }
    if (a === 'signin') {
      // the sign-in Chorus runs for the page in a container: its link, its code, the code typed back, closing it
      const si = id ? this.signIns.get(id) : undefined;
      if (method === 'GET' && parts.length === 2) return si ?? { error: 'This sign-in is over. Click Log in again.' };
      if (method === 'POST' && sub === 'code' && parts.length === 3) return si ? this.signIns.sendCode(id, String(b.code ?? '')) : { error: 'This sign-in is over. Click Log in again.' };
      if (method === 'POST' && sub === 'close' && parts.length === 3) { this.signIns.cancel(id, !!b.done); void this.checkAgents({ quiet: true }).catch(e => this.noteError('doctor check', e)); return { ok: true }; }
      return undefined;
    }
    if (a === 'notifications') {
      const inbox = this.o.notifications;
      if (method === 'GET' && parts.length === 1) return inbox?.snapshot() ?? { items: [], unread: 0, checkedAt: null, checking: false, offline: false };
      if (method === 'POST' && id === 'read-all' && parts.length === 2) { inbox?.markAllRead(); this.pushState(); return inbox?.snapshot() ?? { items: [], unread: 0 }; }
      if (method === 'POST' && id === 'link' && parts.length === 2) {
        if (typeof b.url !== 'string' || !inbox?.allowsLink(typeof b.id === 'string' ? b.id : undefined, b.url)) return { error: 'This link is not in the notification' };
        return this.openLink(b.url, this.o.onNotificationLink);
      }
      if (method === 'POST' && sub === 'open' && parts.length === 3 && inbox?.content(id)) {
        void inbox.opened(id).catch(() => {}); this.pushState(); return { item: inbox.content(id), inbox: inbox.snapshot() };
      }
      return undefined;
    }
    if (a === 'follow' && method === 'POST' && id === 'open' && parts.length === 2) {
      // Follow Chorus from the native window (src/desktop/follow.js): only its two channels open
      const url = Object.hasOwn(FOLLOW_LINKS, String(b.to)) ? FOLLOW_LINKS[String(b.to)] : undefined;
      return url ? this.openLink(url, this.o.openLink) : { error: 'unknown channel' };
    }
    const thread = id ? c.store.getThread(id) : undefined;
    // literal routes first ("skills/import"), then the ones with an id ("skills/:id/toggle")
    const literal = `${method} ${parts.join('/')}`;
    const key = LITERAL.has(literal) ? literal : `${method} ${a}${id ? '/:id' : ''}${sub ? '/' + sub : ''}`;
    switch (key) {
      case 'POST ui': {
        // the page's own choices (projects taken off the sidebar, folded ones, the last agent): kept here, not in the browser,
        // because the window's server takes a new port each launch and a browser keeps storage per address
        if (typeof b.key !== 'string' || !UI_KEYS.has(b.key)) return { error: 'unknown setting' };
        const ui = { ...this.ui(), [b.key]: b.value };
        fs.writeFileSync(path.join(c.store.root, 'ui.json'), JSON.stringify(ui, null, 2));
        return { ok: true };
      }
      case 'GET state':
        return this.state();
      case 'GET newchat':
        return this.newChatInfo(q.get('from') ?? undefined);
      case 'GET folders':
        return listFolders(q.get('dir') ?? c.project);
      case 'POST folders/pick':
        return (this.o.pickFolder ?? pickFolder)(path.resolve(expand(String(b.dir ?? c.project))), String(b.title ?? 'Choose a project folder'));
      case 'POST folders': {
        // a new folder, only inside the folder the dialog shows; what went wrong is said in the dialog
        const parent = path.resolve(expand(String(b.dir ?? '')));
        const name = String(b.name ?? '').trim();
        if (!name || /[/\\]/.test(name) || name === '.' || name === '..') return { error: 'Name the folder without slashes' };
        try {
          if (!fs.statSync(parent).isDirectory()) return { error: `${parent} is not a folder` };
        } catch {
          return { error: `${parent} is not a folder` };
        }
        const dir = path.join(parent, name);
        if (fs.existsSync(dir)) return { error: `${name} already exists here` };
        try {
          fs.mkdirSync(dir);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          return { error: code === 'EACCES' || code === 'EPERM' ? `Chorus may not make a folder in ${parent}` : (e as Error).message };
        }
        return listFolders(dir);
      }
      case 'DELETE projects':
        return this.deleteProject(String(b.folder ?? q.get('folder') ?? ''));
      case 'GET projects':
        return this.listProjects();
      case 'GET projects/one': {
        const folder = this.projectDir(q.get('folder'));
        return folder ? this.oneProject(folder) : { error: 'the project folder is needed' };
      }
      case 'POST projects/folders':
      case 'DELETE projects/folders': {
        const folder = this.projectDir(b.folder);
        const dir = this.projectDir(b.dir);
        if (!folder) return { error: 'the project folder is needed' };
        if (!dir) return { error: 'the folder must be an absolute path' };
        return method === 'POST'
          ? this.changeProject(folder, { kind: 'add_folder', path: dir }, () => this.projectSettings.addFolder(folder, dir, { by: 'you', why: typeof b.why === 'string' ? b.why.trim().slice(0, 500) : '' }))
          : this.changeProject(folder, { kind: 'remove_folder', path: dir }, () => this.projectSettings.removeFolder(folder, dir));
      }
      case 'POST projects/variables':
      case 'DELETE projects/variables': {
        const folder = this.projectDir(b.folder);
        if (!folder) return { error: 'the project folder is needed' };
        const name = typeof b.name === 'string' ? b.name.trim() : '';
        if (method === 'DELETE') return this.changeProject(folder, { kind: 'remove_variable', name }, () => this.projectSettings.removeVariable(folder, name));
        if (typeof b.value !== 'string') return { error: 'the value must be text' };
        const why = typeof b.why === 'string' ? b.why.trim().slice(0, 500) : '';
        // Edit on the page with the value left empty: the value stays (the page never has it), only its why changes
        if (b.keep === true && b.value === '') {
          const kept = this.projectSettings.env(folder)[name];
          if (kept === undefined) return { error: `Type a value for ${name}.` };
          return this.changeProject(folder, { kind: 'note' }, () => this.projectSettings.setVariable(folder, name, kept, { by: 'you', why }));
        }
        return this.changeProject(folder, { kind: 'set_variable', name }, () => this.projectSettings.setVariable(folder, name, b.value, { by: 'you', why }));
      }
      case 'POST projects/note': {
        const folder = this.projectDir(b.folder);
        if (!folder) return { error: 'the project folder is needed' };
        if (typeof b.note !== 'string') return { error: 'the note must be text' };
        return this.changeProject(folder, { kind: 'note' }, () => this.projectSettings.setNote(folder, b.note, 'you'));
      }
      case 'POST projects/restart-idle': {
        const folder = this.projectDir(b.folder);
        if (!folder) return { error: 'the project folder is needed' };
        const r = this.projects.restartIdle(folder);
        this.pushState();
        return r;
      }
      case 'POST chats': {
        const agent = asAgent(b.agent);
        if (!agent) return { error: 'agent must be claude, codex or agy' };
        if (this.offReason(agent)) return { error: this.offReason(agent) };
        const dir = path.resolve(expand(String(b.folder ?? c.project)));
        if (dir === computerDir()) fs.mkdirSync(dir, { recursive: true }); // "This computer": a chat that belongs to no project
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: `${b.folder} is not a folder` };
        const prompt = typeof b.prompt === 'string' ? expandSkillMentions(b.prompt.trim(), this.skillNames()) : undefined;
        const e = c.newThread({ agent, model: b.model, effort: b.effort, cwd: dir, skipPermissions: !!b.skip, prompt: prompt || undefined });
        this.pushState();
        return { id: e.id };
      }
      case 'GET chats/:id':
        return thread && this.chatDetail(id);
      case 'DELETE chats/:id':
        if (!thread) return undefined;
        void (async () => {
          // the Planner chat of a task (the paid module knows): one dialog that can delete the task too
          const r = await this.pro.call('GET', 'chat-task', { thread: id }, undefined).catch(() => undefined);
          const own = r?.status === 200 ? (r.json as { id?: string; number?: number; title?: string; state?: string; chats?: number }) : undefined;
          if (!own?.id) {
            // once it is gone, the optional module closes its waiting items (plan approvals, gates) and withdraws what it asked
            await c.deleteThread(id);
            if (!c.store.getThread(id)) this.chatDeleted(id);
            this.pushState();
            return;
          }
          const plan = own.state === 'planning';
          const what = plan ? `the plan "${own.title}"` : `task #${own.number} "${own.title}"`;
          const n = own.chats ?? 0;
          const key = await this.ask({
            kind: 'alert',
            title: `Delete this chat and its ${plan ? 'plan' : 'task'}?`,
            lines: [
              `"${thread.title}" is the Planner of ${what}.`,
              `Deleting it also deletes the ${plan ? 'plan' : 'task'}: its steps, comments and waiting items${n ? `, and its ${n} Worker chat${n === 1 ? '' : 's'}` : ''}.`,
              "Files in the project and the agent's own session log stay.",
            ],
            // owner, 2026-11-17: no "Delete only the chat"; a task never stays without its Planner
            options: [
              { key: 't', label: plan ? 'Delete the chat and its plan' : `Delete the chat and task #${own.number}` },
              { key: 'w', label: 'Keep it' },
            ],
          });
          if (key === 't') {
            // the module stops the task's chats, deletes it and asks for each chat to go (ProCtx.deleteChat), the Planner's included
            await this.pro.call('POST', 'task/remove', {}, { id: own.id, planner: true }).catch(() => undefined);
            await this.deleteChatQuietly(id);
            this.pushState();
          }
        })();
        return { asked: true };
      case 'POST chats/:id/unlock': {
        // a sub thread's chat is watch-only; Unlock lets keys through until it is locked again or the chat ends
        if (!thread?.sub_status) return { error: 'only a sub thread is watch-only' };
        if (b.on === false) this.unlocked.delete(id);
        else if (!this.unlocked.has(id)) this.unlocked.set(id, '');
        this.pushState();
        return { ok: true, unlocked: this.unlocked.has(id) };
      }
      case 'POST chats/:id/select':
        return this.select(id) ? { ok: true } : undefined;
      case 'POST chats/:id/handoff': {
        const to = asAgent(b.to);
        if (!thread || !to) return undefined;
        if (this.offReason(to)) return { error: this.offReason(to) };
        const opts = { model: b.model, effort: b.effort, skipPermissions: !!b.skip };
        const typed = typeof b.note === 'string' ? b.note : typeof b.prompt === 'string' ? b.prompt : '';
        const note = expandSkillMentions(typed.trim(), this.skillNames());
        // a note (the paid Hand off's "Anything to add?") goes after the record, in the same first message
        const e = note ? c.newThread({ agent: to, title: `${thread.title} → ${to}`, prompt: `${handoffPrompt(thread)}\n\n${note}`, parent: thread, cwd: thread.cwd, ...opts }) : await c.handoff(id, to, opts);
        this.pushState();
        return { id: e?.id };
      }
      case 'POST chats/:id/approve':
      case 'POST chats/:id/deny': {
        // "Always allow in this chat": the prompt's own always key, when its CLI offers one (approvalItems says so)
        const ok = await this.typedVia(id, () => c.answer(sub === 'approve', id, sub === 'approve' && b.always === true));
        this.pushState();
        return { ok };
      }
      case 'POST chats/:id/answer': {
        // a propose_project_change card: applied here first; the values typed on it go only to the values file
        if (typeof b.request === 'string' && typeof b.option === 'string' && parseProposal(c.store.getRequest(b.request))) {
          return this.answerProposal(b.request, b.option, { values: b.values, note: b.note });
        }
        // a request_approval card: the option (and note) becomes the user's next message to that agent
        const ok = typeof b.request === 'string' && typeof b.option === 'string' && (await this.typedVia(c.store.getRequest(b.request)?.thread_id, () => c.answerRequest(b.request, b.option, typeof b.note === 'string' ? b.note : undefined)));
        this.pushState();
        return { ok };
      }
      case 'POST chats/:id/title': {
        // rename_chat (by "model") and the Undo on its toast (by "you")
        if (!thread) return undefined;
        return this.renameChat(id, b.title, b.by === 'model' ? 'model' : 'you');
      }
      case 'POST chats/:id/dismiss':
        // Approvals' delete (the page warned first): the item only, the agent is not answered
        if (!thread) return undefined;
        this.dismissApproval(id, typeof b.request === 'string' && b.request ? b.request : undefined);
        return { ok: true };
      case 'POST chats/:id/retry':
        this.select(id);
        c.retryContext();
        return { ok: true };
      // the Chat view (src/serve/chatview.ts, docs/features/chat-view.md): a page of turns with short tool call rows and the cards
      case 'GET chats/:id/turns': {
        if (!thread) return undefined;
        // one quiet line's whole text (a background job's notice, a shortened conversation's summary), read when it is opened
        if (parts[3]) return turnText(c.store, id, Number(parts[3]));
        const before = Number(q.get('before'));
        const limit = Number(q.get('limit'));
        // with the first page, the agent's own commands for the "/" list (probed, chorus-core NATIVE_COMMANDS)
        return { ...turnsPage(this.cvDeps, id, { before: before > 0 ? before : undefined, limit: limit > 0 ? limit : undefined }), ...(before > 0 ? {} : { nativeCommands: NATIVE_COMMANDS[thread.agent as AgentId] ?? [] }) };
      }
      // one call's input and output, read from the transcript only now (a tap on its row); ?full=1 for "Show all"
      case 'GET chats/:id/calls':
        return thread && parts[3] ? callDetail(c.store, id, parts[3], q.get('full') === '1') : undefined;
      case 'POST chats/:id/say':
        return thread ? this.say(id, b.text) : undefined;
      case 'POST chats/:id/key':
        return thread ? this.chatKey(id, b.key) : undefined;
      case 'GET chats/:id/activity':
        return thread && c.activityRows(id);
      case 'GET chats/:id/artifacts':
        return thread && this.artifacts(id);
      case 'POST chats/:id/open-report': {
        // a reported file or link, opened on this computer with the system's open command, never through a shell
        const a = thread && this.reported(id).find(x => x.id === Number(b.id));
        if (!a) return { error: 'That artifact is no longer there.' };
        const r = await (this.o.openFile ?? openOnThisComputer)(a.target);
        return r.ok ? { ok: true } : { error: r.error ?? 'Could not open it.' };
      }
      case 'POST chats/:id/open-path': {
        // a file named in a reply that the viewer can't show, opened on this computer (Mac only: devices get 403 above)
        const f = thread && typeof b.path === 'string' ? this.chatFile(id, new URLSearchParams({ f: b.path })) : undefined;
        if (!f || 'status' in f || f.gone) return { error: 'That file is no longer there.' };
        const r = await (this.o.openFile ?? openOnThisComputer)(f.abs);
        return r.ok ? { ok: true } : { error: r.error ?? 'Could not open it.' };
      }
      case 'POST chats/:id/open':
        if (!thread) return undefined;
        await c.openArtifact(id, String(b.path), b.via);
        return { ok: true };
      case 'POST chats/:id/preview':
        return thread && { url: await c.openPreview(id, String(b.path), false) };
      case 'GET memory':
        return { where: c.store.shared ? c.store.root.replace(process.env.HOME ?? '\0', '~') + '/chorus.db' : '.chorus/chorus.db', items: c.memoryItems(q.get('q') ?? '') };
      case 'GET approvals':
        return { pending: this.approvalsNow().filter(a => !a.hidden), decided: c.decidedItems() };
      case 'GET skills':
        return this.skills();
      case 'GET skills/all': {
        // ?folder=: the project the chat will run in; a skill in that project's own folders for a CLI counts as there
        const folder = q.get('folder');
        return allSkills(c.store, c.project, undefined, folder && path.isAbsolute(folder) ? path.resolve(folder) : c.project);
      }
      case 'POST skills/sync': {
        // a tick on Sync skills, or "Sync and use" in the "/" picker: one link in that CLI's home skills folder, or its removal
        const cli = SYNC_CLIS.includes(b.cli) ? (b.cli as Cli) : undefined;
        if (!cli || typeof b.dir !== 'string') return { error: 'dir and cli (claude, codex or agy) are needed' };
        if (!c.store.storedSkills().some(s => s.dir === b.dir)) scanSkills(c.store, c.project);
        const skill = c.store.storedSkills().find(s => s.dir === b.dir);
        if (!skill) return { error: 'Chorus does not know this skill' };
        const r = b.on === false ? unsyncSkill(c.store, skill.dir, cli) : syncSkill(c.store, skill.dir, cli);
        if (!r.ok) return { error: r.error, ...allSkills(c.store, c.project) };
        const flash = b.on === false ? `Removed ${skill.name} from ${CLI_NAMES[cli]}` : `Synced ${skill.name} to ${CLI_NAMES[cli]} · ${tilde(r.path)}`;
        return { flash, path: r.path, ...allSkills(c.store, c.project) };
      }
      case 'POST skills/sources': {
        if (typeof b.path !== 'string' || !b.path.trim()) return { error: 'path is needed' };
        const r = addSource(c.store, expand(b.path.trim()), c.project);
        return r.ok ? allSkills(c.store, c.project) : { error: r.error };
      }
      case 'POST skills/sources/pick': {
        // the system folder chooser, as for a project folder; what was chosen is added (a skill or a folder of skills)
        const pick = await (this.o.pickFolder ?? pickFolder)(os.homedir(), 'Choose a folder of skills, or one skill');
        if (!pick.dir) return { ...pick };
        const r = addSource(c.store, pick.dir, c.project);
        return r.ok ? { added: pick.dir, kind: r.kind, ...allSkills(c.store, c.project) } : { error: r.error };
      }
      case 'POST skills/sources/remove': {
        if (typeof b.path !== 'string') return { error: 'path is needed' };
        const r = removeSource(c.store, b.path);
        return r.ok ? { unsynced: r.unsynced, ...allSkills(c.store, c.project) } : { error: r.error };
      }
      case 'GET files': {
        // the New chat form's "@" list: the files of a folder Chorus offers for a chat
        const folder = path.resolve(expand(String(q.get('folder') ?? '')));
        if (!q.get('folder') || !this.offeredFolder(folder)) return { error: 'not a folder Chorus offers for a chat', files: [] };
        return { files: matchFiles(projectFiles(folder), String(q.get('q') ?? '')) };
      }
      case 'POST skills': {
        const slug = skillSlug(String(b.name ?? ''));
        if (!slug) return { error: 'name it with lowercase words and dashes' };
        const dir = path.join(sourceDir(c.project), slug);
        if (fs.existsSync(dir)) return { error: `${slug} already exists` };
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${String(b.description || 'Say here when an agent should use this skill.')}\n---\n\nWrite the instructions here.\n`);
        syncSkills(c.project);
        return this.skills();
      }
      case 'POST skills/:id/toggle': {
        const s = listSkills(c.project).find(x => path.basename(x.dir) === id);
        if (!s) return undefined;
        const on = disabledSkills(c.project).includes(id);
        setSkillEnabled(c.project, id, on);
        if (fs.existsSync(sourceDir(c.project))) syncSkills(c.project);
        this.app.setFlash(`${on ? 'Turned on' : 'Turned off'} ${s.name} for claude, codex and agy`);
        return this.skills();
      }
      case 'POST skills/:id/edit': {
        const s = listSkills(c.project).find(x => path.basename(x.dir) === id);
        if (!s) return undefined;
        const file = path.join(s.dir, 'SKILL.md');
        const r = process.env.CHORUS_NO_OPEN === '1' ? { ok: true } : await defaultOpener({ mode: 'default' }, { path: file });
        this.app.setFlash(r.ok ? `opened ${s.name}/SKILL.md in your editor` : `could not open it; the file is ${file}`);
        return { ok: r.ok };
      }
      case 'POST skills/import': {
        const f = findNativeSkills(c.project).find(x => x.dir === b.dir);
        if (!f) return { error: 'nothing to import' };
        importSkill(c.project, f);
        syncSkills(c.project);
        this.app.setFlash(`Imported ${f.name}: now in the library, seen by all three`);
        return this.skills();
      }
      case 'GET doctor':
      case 'POST doctor/check': {
        // the short test for the popup and the Doctor page (docs/doctor.md §6, docs/mockups/desktop-doctor.html). GET shows
        // the newest one (waiting for the one at start; ?fresh=1 runs one); POST doctor/check is "Run test" and "Check again".
        const { report: fast, at } = method === 'GET' && !q.get('fresh') && this.agentCheck ? this.agentCheck : await this.checkAgents();
        return { lines: c.doctorLines().map(plain), chorus: host(), fast, at, due: isDue(fast), gh: ghReady(), latest: await latestReleases(), lastDeep: lastDeep(), jobs: [...this.doctorJobs.values()] };
      }
      case 'POST doctor/refresh':
        return { ran: this.refreshAgents({ waiting: b.waiting === true }) };
      case 'GET doctor/first':
        return { first: firstLaunch() };
      case 'POST doctor/seen':
        markSeen((this.agentCheck ?? (await this.checkAgents())).report);
        return { ok: true };
      case 'POST doctor/open': {
        const a = b.agent as AgentId;
        if (!CLIS[a]) return { error: 'unknown agent' };
        return this.openLink(CLIS[a].page);
      }
      case 'POST doctor/run':
        return this.doctorRun(b.agent as AgentId, b.action);
      case 'GET doctor/:id':
        return this.doctorJobs.get(id) ?? { error: 'no such job' };
      case 'POST doctor/issue': {
        // Report on the Doctor page, with or without a test run: the doctor's report plus what the app can tell
        const threads = c.store.listThreads();
        const chats = threads.map(t => ({ agent: t.agent, state: t.state, cli_version: t.cli_version }));
        const errors = [...this.errors, ...(Array.isArray(b.errors) ? b.errors.filter((e: unknown) => typeof e === 'string').slice(-30).map((e: string) => `page: ${e}`) : [])];
        const client = b.client && typeof b.client === 'object' ? b.client : undefined;
        // a new check for the report, quiet, and the same one every screen gets
        const { report: fast } = await this.checkAgents({ quiet: true });
        const ps = this.pro.status();
        const pro = ps.unlocked ? { version: ps.version, state: ps.plan ?? 'active' } : ps.reason ? { state: `not active: ${ps.reason}` } : null;
        return reportDetails({ fast, deep: this.deepReports, chats, projects: new Set(threads.map(t => t.project ?? t.cwd)).size, client, errors, update: this.o.updates?.snapshot() ?? null, pro });
      }
      case 'POST doctor/issue/image': {
        // an image dropped on the report dialog in the native window, which gives its path: only a PNG, JPEG or WebP is read
        const f = typeof b.path === 'string' && path.isAbsolute(b.path) ? b.path : '';
        const st = f ? fs.statSync(f, { throwIfNoEntry: false }) : undefined;
        if (!st?.isFile()) return { error: 'not a file' };
        if (st.size > 30_000_000) return { error: 'larger than 30 MB' };
        const bytes = fs.readFileSync(f);
        const type = imageType(bytes);
        return type ? { type, data: bytes.toString('base64') } : { error: 'only PNG, JPEG or WebP images' };
      }
      case 'POST doctor/issue/send': {
        // to the Chorus team's admin page (plan 2026-11-13); `chorus doctor --report` in a terminal still files a GitHub issue
        const r = parseReport(b);
        if ('error' in r) return r;
        return this.reports.send(r);
      }
      case 'POST dialogs/:id':
        return { ok: this.answer(id, b.value) };
      case 'POST quit':
        setTimeout(() => this.o.onQuit?.(), 50);
        return { ok: true };
    }
    return undefined;
  }

  /** Puts a chat in front, like a click in the sidebar: a parked chat resumes its agent. */
  private select(id: string) {
    const at = this.app.entries.findIndex(e => e.id === id);
    if (at < 0) return false;
    // a parked chat resumes in its folder: when that folder is not here (deleted, or a chat from another computer, as in a box
    // sharing the user's home), it is shown but not started; starting it failed and stopped chorus serve (2026-11-08)
    const row = this.c.store.getThread(id);
    const e = this.app.entries[at];
    if (!e.host && e.state === 'parked' && row?.cwd && !fs.existsSync(row.cwd)) {
      this.app.setFlash(`"${row.title}" can't open: its folder ${row.cwd} is not on this computer`);
      return true;
    }
    this.app.select(at);
    this.pushState();
    return true;
  }

  /* ---------- data ---------- */

  private stateOf(e: Entry): ItemState {
    if (e.state) return e.host?.state === 'ended' ? 'ended' : e.state;
    if (!e.host) return 'parked';
    return e.host.state === 'ended' ? 'ended' : e.host.busy() ? 'busy' : 'idle';
  }

  state() {
    const c = this.c;
    const chats = this.app.entries.map(e => {
      const t = c.store.getThread(e.id);
      return {
        id: e.id,
        title: e.title,
        agent: e.agent,
        cwd: e.cwd,
        project: projectName(e.cwd),
        state: this.stateOf(e),
        live: e.host?.state === 'running',
        parentId: e.parentId ?? null,
        model: e.meta?.model ?? t?.model ?? null,
        effort: e.meta?.effort ?? t?.effort ?? null,
        skip: !!t?.skip_permissions,
        usage: e.meta?.usage ?? null,
        artifacts: (e.meta?.artifacts ?? 0) + c.store.reportedArtifacts(e.id).length,
        // grows on a new artifact and on every new version of one (plan 2026-11-14, Package 5A): the Artifacts button flashes
        artifactsRev: this.artifactsRev(e.id),
        toast: e.meta?.toast ?? null,
        updated: t?.updated ?? null,
        // a sub thread: its main chat and its status (null for any other chat)
        sub: this.subs.info(t, this.isUnlocked(e.id)),
        // the Chat view's "Open Terminal" banner: the CLI shows its own menu (probed per CLI, menuShown), looked at only for a chat a
        // page shows in the Chat view
        ...(this.cvMenu(e) ? { menu: true } : {}),
      };
    });
    return {
      project: c.project,
      // in a container: the Doctor signs the CLIs in from the page, and offers agy's sign-in even when it looks ready
      container: this.container,
      update: this.o.updates?.snapshot() ?? null,
      notifications: this.o.notifications?.summary() ?? { unread: 0, checkedAt: null, checking: false, offline: false },
      current: this.app.current?.id ?? null,
      chats,
      // Shift+Enter in a chat's terminal: the bytes that add a new line in each CLI's input (probed, docs/integrations)
      keys: NEWLINE_KEYS,
      // CHORUS_DEBUG_IME=<file>: the page turns its typing recorder on (localStorage chorus.debugIme) and posts every key event
      ...(process.env.CHORUS_DEBUG_IME ? { debugIme: true } : {}),
      // when each request appeared (whole seconds), not "seconds waiting": the state must not change every push, or the
      // window would redraw the inbox under the mouse
      approvals: this.approvalsNow().map(({ waiting, ...x }) => ({ ...x, since: Math.round(Date.now() / 1000 - waiting) })),
      ui: this.ui(),
      // projects the sidebar lists with no chat yet (made by a propose_new_project card), and each project's extra folders: the sidebar
      // shows a project once, under its main folder, with "+N folders"
      projects: this.sideProjects(),
      notice: this.noticeNow(),
      dialogs: [...this.dialogs.values()].map(x => x.d),
      // the doctor's short check, the one status of the agents (null until the first one is done)
      doctor: this.agentCheck ? { at: this.agentCheck.at, ms: this.agentCheck.report.ms, checking: this.checkShown, agents: this.agentCheck.report.agents } : this.checking ? { checking: true, agents: null } : null,
    };
  }

  private sideProjects() {
    const s = this.projectSettings;
    return s.list().flatMap(folder => {
      const r = s.get(folder);
      return r.registered || r.folders.length ? [{ folder, registered: !!r.registered, folders: r.folders.map(f => f.path) }] : [];
    });
  }

  /** Edits of reported artifacts seen per chat (in memory: after a restart it counts from 0, and nothing flashes on page load). */
  private artEdits = new Map<string, number>();
  /** Per reported target: its row id and file time when last looked at. */
  private artSeen = new Map<string, { id: number; mtime?: number }>();
  private artLooked = new Map<string, number>();

  /**
   * A number that grows on a new artifact and on every new version of one: the versions of the files in the chat's artifacts
   * folder, plus the edits of its reported files (a changed file time) and the targets it reported again. The file times are
   * read at most once every 2 s per chat, for the 50 newest reported files; the first look only remembers them.
   */
  artifactsRev(id: string): number {
    const c = this.c;
    const now = Date.now();
    if (now - (this.artLooked.get(id) ?? 0) >= 2000) {
      this.artLooked.set(id, now);
      let edits = this.artEdits.get(id) ?? 0;
      for (const r of c.store.reportedArtifacts(id).slice(0, 50)) {
        const key = `${id}\0${r.target}`;
        let mtime: number | undefined;
        if (!/^https?:\/\//i.test(r.target)) {
          try {
            mtime = fs.statSync(r.target).mtimeMs;
          } catch {
            /* gone, or not a file: skipped */
          }
        }
        const had = this.artSeen.get(key);
        if (had && (had.id !== r.id || (mtime !== undefined && had.mtime !== undefined && mtime !== had.mtime))) edits++;
        this.artSeen.set(key, { id: r.id, mtime: mtime ?? had?.mtime });
      }
      this.artEdits.set(id, edits);
    }
    return c.store.artifactVersions(id) + (this.artEdits.get(id) ?? 0);
  }

  /**
   * The controller's warning line, without a "context not loaded" about a sub thread: that warning is for a hand-off (a chat that
   * should load its parent's record); a sub thread gets its work from its brief.
   */
  private noticeNow(): string {
    const n = this.app.notice;
    if (!/context not loaded/.test(n)) return n;
    const subs = this.c.store.subThreads();
    return subs.some(t => n.includes(`"${t.title}"`)) ? '' : n;
  }

  /** Pushes the state to every client when it changed (called on events and twice a second). */
  pushState() {
    if (this.closed || !this.clients.size) return;
    const s = JSON.stringify(this.state());
    if (s === this.lastState) return;
    this.lastState = s;
    for (const cl of this.clients) cl.send(`{"t":"state","state":${s}}`);
  }

  private broadcast(m: object) {
    const s = JSON.stringify(m);
    for (const cl of this.clients) cl.send(s);
  }

  newChatInfo(from?: string) {
    const c = this.c;
    const src = from ? c.store.getThread(from) : undefined;
    const quota = c.quotaInfo();
    const folder = src?.cwd ?? (this.app.current?.host ? this.app.current.cwd : c.project);
    return {
      folder,
      home: process.env.HOME ?? '',
      computer: computerDir(),
      recent: c.recentFolders(folder),
      from: src ? { id: src.id, title: src.title, agent: src.agent, skip: !!src.skip_permissions } : null,
      agents: AGENTS.map(a => {
        // the desktop offers the newest models right after "default" (fable for Claude Code); the CLI app keeps modelList as it is
        const list = c.modelList(a), models = list.length ? [list[0], ...latestModels(a).filter(m => !list.includes(m)), ...list.slice(1)] : list;
        return { id: a, quota: quota[a] ?? null, skipFlag: SKIP_FLAG[a], models, efforts: Object.fromEntries(models.map(m => [m, effortsFor(a, m)])) };
      }),
    };
  }

  private ui(): Record<string, unknown> {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.c.store.root, 'ui.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  /** Chats whose CLI had lost their session, continued from Chorus's record in this run: the chat says so. */
  private fromRecord = new Set<string>();

  /**
   * Given to the Controller (decision 18): a chat about to resume whose CLI no longer has the session gets a new session in the
   * same chat. Its first message: read this chat's own record, then go on; a teammate's chat also gets its action's brief again.
   * The check is the session's file, before launching: Antigravity opens an empty conversation for an id it lacks, with no error.
   */
  sessionGone(row: ThreadRow): string | undefined {
    if ((this.o.sessionExists ?? sessionOnDisk)(row)) return undefined;
    this.fromRecord.add(row.id);
    if (!this.c.store.getTurns(row.id, { limit: 1 }).length) return ''; // nothing was said yet: a plain new session
    const name = CLIS[row.agent]?.name ?? row.agent;
    const brief = this.pro.lostBrief(row.id);
    const record = `${name} no longer has the earlier session of this chat, so Chorus started a new session in the same chat. Call the chorus MCP tool get_handoff_context with thread_id ${row.id} first: that is this chat's own record.`;
    return brief
      ? `${record} Go on from where it stopped, and do not redo what it already did. Do not wait for an OK.\n\n${brief}`
      : `${record} Then reply with at most 5 bullets: what was done, decisions, open work, and your next step. Wait for my next message before changing anything.`;
  }

  chatDetail(id: string) {
    const c = this.c;
    const t = c.store.getThread(id)!;
    const parent = t.parent_thread_id ? c.store.getThread(t.parent_thread_id) : undefined;
    return {
      thread: t,
      fromRecord: this.fromRecord.has(id) ? CLIS[t.agent]?.name ?? t.agent : null,
      parent: parent ? { id: parent.id, title: parent.title, agent: parent.agent } : null,
      usage: c.store.getUsage(id) ?? null,
      record: buildHandoff(c.store, t).text,
      contextLoaded: c.store.mcpCalls(id).some(m => m.tool === 'get_handoff_context'),
      turns: c.store.getTurns(id, { limit: 40 }),
      toolCalls: c.store.getToolCalls(id).slice(-40),
    };
  }

  artifacts(id: string) {
    const c = this.c;
    const versionsOf = (p: string) => c.store.db.prepare('SELECT version, ts FROM artifacts WHERE thread_id=? AND path=? ORDER BY ts').all(id, p) as { version: string; ts: string }[];
    const touched = new Set<string>();
    for (const call of c.store.getToolCalls(id)) if (/^(Write|Edit|write_to_file|replace_file_content|apply_patch|file_change)$/.test(call.tool) && call.target) touched.add(call.target);
    return {
      reported: this.reported(id),
      folder: c.store.artifactsDir(id),
      items: c.store.listArtifacts(id).map(a => ({ path: a.path, abs: a.abs, ts: a.ts, ago: c.ago(a.ts), versions: versionsOf(a.path) })),
      files: [...touched].slice(0, 50),
    };
  }

  /**
   * What the chat reported with show_artifact, newest first, that is there now: a file that exists, or an http(s) link (nothing is
   * fetched). `inside`: the file is in the chat's project, so a device on the private link may open it.
   */
  reported(id: string) {
    const c = this.c, t = c.store.getThread(id);
    if (!t) return [];
    const real = (p: string) => { try { return fs.realpathSync(p); } catch { return p; } };
    const project = real(t.project ?? t.cwd);
    return c.store.reportedArtifacts(id).flatMap(r => {
      const link = /^https?:\/\//i.test(r.target);
      if (!link) {
        try {
          if (!fs.statSync(r.target).isFile()) return [];
        } catch {
          return [];
        }
      }
      const rel = link ? '' : path.relative(project, real(r.target));
      const inside = !link && !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      return [{ id: r.id, title: r.title ?? (link ? r.target : path.basename(r.target)), target: r.target, link, inside, ts: r.ts, ago: c.ago(r.ts) }];
    });
  }

  /** Every skill Chorus sees (Sync skills): what "/" lists and what a first message's `/name` loads. */
  skillNames() {
    return [...new Set(scanSkills(this.c.store, this.c.project).skills.map(s => s.name))];
  }

  /** A folder the New chat form offers for a chat: the project, a chat's or a recent folder, This computer, or one in the home folder (Browse…). */
  private offeredFolder(dir: string) {
    const c = this.c;
    try {
      if (!fs.statSync(dir).isDirectory()) return false;
    } catch {
      return false;
    }
    const known = new Set([c.project, computerDir(), ...c.store.listThreads().map(t => t.cwd), ...c.recentFolders(c.project)].map(d => path.resolve(d)));
    const home = os.homedir();
    return known.has(dir) || (dir !== home && dir.startsWith(home + path.sep));
  }

  skills() {
    const p = this.c.project;
    const off = disabledSkills(p);
    return {
      where: '.chorus/skills (this project; one global library is TD-1)',
      items: listSkills(p).map(s => ({ folder: path.basename(s.dir), name: s.name, description: s.description, on: !off.includes(path.basename(s.dir)) })),
      found: findNativeSkills(p).map(f => ({ name: f.name, from: f.from, agent: f.agent, dir: f.dir })),
    };
  }

  /* ---------- WebSocket: the agent screens ---------- */

  /** The viewer the user used last (focused, clicked, typed in or opened a chat in): it sets the agents' screen size, so the view in
   *  use always fits, whether the Chorus window or a browser tab (owner, 2026-11-19). None yet: the window, else any tab. */
  private sizer: Client | undefined;

  /** Whether this viewer sets the agents' screen size: never through the private link. */
  setsSize(cl: Client) {
    if (cl.remote) return false;
    if (this.sizer && this.clients.has(this.sizer)) return cl === this.sizer;
    return cl.native || ![...this.clients].some(c => c.native);
  }

  /** The user is on this viewer now: it takes the size; it fits itself, and the others draw its screen. */
  private takeSize(cl: Client) {
    if (cl.remote || this.setsSize(cl) && this.sizer === cl) return;
    this.sizer = cl;
    this.announceSize();
  }

  /** Every viewer hears the agents' screen size and whether it is the one that sets it: one that doesn't draws the screen at that
   *  size, not its own, or the agent's lines wrap wrong (2026-11-19: a browser tab beside the window showed a garbled Claude). */
  private announceSize() {
    for (const c of this.clients) c.send(JSON.stringify({ t: 'size', cols: this.size.cols, rows: this.size.rows, sets: this.setsSize(c) }));
  }

  private connect(ws: WebSocket, remote = false, native = false) {
    const cl = new Client(this, ws, remote, native);
    this.clients.add(cl);
    // CHORUS_DEBUG_VIEWERS=1: who connects and who sizes the agents (plan 2026-11-07 check A.4)
    const debug = (what: string) => process.env.CHORUS_DEBUG_VIEWERS && console.error(`viewer ${remote ? 'remote' : native ? 'window' : 'browser tab'}: ${what}`);
    debug('connected');
    this.lastState = '';
    // a window that opens takes the size from the browser tabs; one that closes gives it back
    if (native) this.announceSize();
    ws.on('close', () => {
      this.cvSent.delete(cl);
      cl.detach();
      this.clients.delete(cl);
      if (this.sizer === cl) this.sizer = undefined;
      this.announceSize();
    });
    ws.on('message', raw => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      const host = typeof m.id === 'string' ? this.app.entry(m.id)?.host : undefined;
      if (m.t === 'focus') return this.takeSize(cl);
      if (m.t === 'attach' && typeof m.id === 'string') {
        // one screen size for every viewer: the one in use sets it; a phone looks at the agent at the Mac's size and never resizes it
        if (!cl.remote && this.sizer !== cl) this.takeSize(cl);
        if (m.cols > 0 && m.rows > 0 && this.setsSize(cl)) {
          const was = `${this.size.cols}x${this.size.rows}`;
          this.size = { cols: Math.min(500, m.cols | 0), rows: Math.min(200, m.rows | 0) };
          if (`${this.size.cols}x${this.size.rows}` !== was) this.announceSize();
        }
        debug(`attach ${m.cols}x${m.rows}, agents at ${this.size.cols}x${this.size.rows}`);
        if (!this.app.entry(m.id)?.host) this.select(m.id); // a parked chat resumes when you open it
        void cl.attach(m.id);
      } else if (m.t === 'cv') {
        // the Chat view: this client shows chat m.id (or none) and has its turns up to m.seq; it gets only what is new from now on
        this.cvWatch(cl, typeof m.id === 'string' ? m.id : undefined, Number(m.seq) || 0);
      } else if (m.t === 'imelog') {
        // the page's typing recorder (chorus.debugIme): key, input and composition events and what ime-input.js did, as JSON lines
        if (process.env.CHORUS_DEBUG_IME && Array.isArray(m.ev)) fs.appendFileSync(process.env.CHORUS_DEBUG_IME, m.ev.map((x: unknown) => JSON.stringify(x) + '\n').join(''));
      } else if (m.t === 'in' && typeof m.data === 'string') {
        // typing here: this is the view in use
        if (!cl.remote && this.sizer !== cl) this.takeSize(cl);
        if (process.env.CHORUS_DEBUG_INPUT) fs.appendFileSync(process.env.CHORUS_DEBUG_INPUT, JSON.stringify(m.data) + '\n');
        // a sub thread is watch-only: its keys are dropped unless the user unlocked it (its CLI's prompts are answered by the card)
        if (typeof m.id === 'string' && !this.watchOnlyLets(m.id, m.data)) return;
        // the mail watchdog is typing into this chat: the user's keys wait and go after it, still as the user's (typeIn)
        const held = typeof m.id === 'string' ? this.keyHold.get(m.id) : undefined;
        if (held) return void held.push(m.data);
        host?.write(m.data);
        if (host && typeof m.id === 'string') {
          this.noteTyped(m.id, m.data);
          this.typedTo(m.id, m.data);
        }
      }
      else if (m.t === 'resize' && m.cols > 0 && m.rows > 0 && this.setsSize(cl)) {
        this.size = { cols: Math.min(500, m.cols | 0), rows: Math.min(200, m.rows | 0) };
        host?.resize(this.size.cols, this.size.rows);
        this.announceSize();
        debug(`resize ${m.cols}x${m.rows}: agents at ${this.size.cols}x${this.size.rows}`);
      } else if (m.t === 'resize') debug(`resize ${m.cols}x${m.rows} ignored: agents stay at ${this.size.cols}x${this.size.rows}`);
      else if (m.t === 'detach') cl.detach();
      else if (m.t === 'drop' && typeof m.id === 'string' && Array.isArray(m.paths) && this.c.store.getThread(m.id)?.sub_status && !this.isUnlocked(m.id)) {
        // a locked sub thread takes no keys, and no dropped files either
        cl.send(JSON.stringify({ t: 'flash', text: 'This sub thread is watch-only: give the file to its main chat, or Unlock it first' }));
      } else if (m.t === 'drop' && typeof m.id === 'string' && Array.isArray(m.paths)) {
        // files dropped on the native window: Tauri gives their full paths (docs/phase5.md §8.3)
        const paths = m.paths.filter((p: unknown): p is string => typeof p === 'string' && path.isAbsolute(p));
        const r = this.c.dropFiles(m.id, paths.map((p: string) => ({ path: p })), !!m.copy);
        cl.send(JSON.stringify('error' in r ? { t: 'flash', text: r.error } : { t: 'dropped', id: m.id, paths: r.paths }));
      }
    });
    cl.send(JSON.stringify({ t: 'hello', flashes: this.flashes.slice(-3) }));
    this.pushState();
  }
}

/** One desktop window: it looks at one chat at a time and gets that agent's screen, then every byte the agent writes. */
class Client {
  attached: string | undefined;
  private off: (() => void) | undefined;
  private gen = 0;
  private srv: ChorusServer;
  readonly ws: WebSocket;
  /** a device through the private link */
  readonly remote: boolean;
  /** the Chorus window (not a browser tab) */
  readonly native: boolean;
  constructor(srv: ChorusServer, ws: WebSocket, remote = false, native = false) {
    this.srv = srv;
    this.ws = ws;
    this.remote = remote;
    this.native = native;
  }

  send(s: string) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(s);
  }

  detach() {
    this.off?.();
    this.off = undefined;
    this.attached = undefined;
  }

  async attach(id: string) {
    this.detach();
    this.attached = id;
    const gen = ++this.gen;
    const host = this.srv.app.entry(id)?.host;
    if (!host) return this.send(JSON.stringify({ t: 'screen', id, data: '', live: false }));
    host.resize(this.srv.size.cols, this.srv.size.rows);
    // bytes that arrive while the snapshot is taken are kept and sent after it, in order
    const queued: string[] = [];
    let ready = false;
    const onData = (d: string) => (ready ? this.send(JSON.stringify({ t: 'out', id, data: d })) : queued.push(d));
    const onExit = (code: number | null) => this.send(JSON.stringify({ t: 'exit', id, code }));
    host.on('data', onData);
    host.on('exit', onExit);
    this.off = () => {
      host.off('data', onData);
      host.off('exit', onExit);
    };
    const data = await snapshot(host);
    if (gen !== this.gen) return;
    this.send(JSON.stringify({ t: 'screen', id, data, live: host.state === 'running', cols: host.screen.cols, rows: host.screen.rows, sets: this.srv.setsSize(this) }));
    for (const d of queued) this.send(JSON.stringify({ t: 'out', id, data: d }));
    ready = true;
  }
}

const serializers = new WeakMap<object, { serialize(): string }>();

/**
 * The agent's screen as bytes a fresh terminal can replay: text, colours, cursor and the modes the agent switched on.
 * The serialize addon leaves out the hidden cursor, the SGR mouse encoding and focus reporting; they are added here.
 * The empty write waits until every byte received so far is on the screen, so nothing is lost or doubled.
 */
export function snapshot(host: ThreadHost): Promise<string> {
  const term = host.screen.term;
  let ser = serializers.get(term);
  if (!ser) {
    const { SerializeAddon } = require('@xterm/addon-serialize');
    ser = new SerializeAddon() as { serialize(): string };
    term.loadAddon(ser);
    serializers.set(term, ser);
  }
  return new Promise(resolve =>
    host.screen.write('', () => {
      let out = ser!.serialize();
      const core = term._core;
      if (core?.coreService?.isCursorHidden) out += '\x1b[?25l';
      if (core?.coreMouseService?.activeEncoding === 'SGR') out += '\x1b[?1006h';
      if (term.modes?.sendFocusMode) out += '\x1b[?1004h';
      if (term.modes?.applicationKeypadMode) out += '\x1b=';
      resolve(out);
    }),
  );
}

/* ---------- helpers ---------- */

function send(res: http.ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const UPLOAD_LIMIT = 50_000_000;

/** The request body as bytes; rejects (and stops reading) past `limit`. */
function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (d: Buffer) => {
      n += d.length;
      if (n > limit) {
        req.destroy();
        return reject(new Error('too large'));
      }
      parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function readJson(req: http.IncomingMessage, limit = 1_000_000): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => {
      s += d;
      if (s.length > limit) {
        req.destroy();
        reject(new Error('too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        reject(new Error('body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** What the page may save on the server (`POST ui`). */
const UI_KEYS = new Set(['browseSort', 'hidden', 'folded', 'agent', 'drawer', 'side', 'sideW', 'noDelAsk', 'welcome', 'ended', 'banner', 'doctorTip', 'navMore', 'seenMarks', 'sideLW']);
const asAgent = (s: unknown): AgentId | undefined => (AGENTS.includes(s as AgentId) ? (s as AgentId) : undefined);
const expand = (p: string) => p.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');

/**
 * The system's own folder picker, so a folder can be picked or made anywhere: Finder's on macOS (it has New Folder), zenity's on
 * Linux when it is installed. `none`: there is no picker here, and the page shows its own Browse dialog.
 */
export function pickFolder(start: string, title: string): Promise<{ dir?: string; cancelled?: boolean; none?: boolean }> {
  const q = (t: string) => `"${t.replace(/[\\"]/g, '\\$&')}"`;
  const [bin, args] =
    process.platform === 'darwin'
      ? ['osascript', ['-e', 'activate', '-e', `POSIX path of (choose folder with prompt ${q(title)}${fs.existsSync(start) ? ` default location (POSIX file ${q(start)})` : ''})`]]
      : ['zenity', ['--file-selection', '--directory', `--title=${title}`, `--filename=${start}/`]];
  return new Promise(resolve =>
    execFile(bin, args, { timeout: 30 * 60_000 }, (err, out) => {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return resolve({ none: true });
      if (err) return resolve({ cancelled: true }); // closed or Cancel (osascript -128, zenity 1)
      const dir = out.trim().replace(/(.)\/$/, '$1');
      resolve(dir ? { dir } : { cancelled: true });
    }),
  );
}

/** The CLI still has a chat's session: its transcript is where the CLI keeps it (docs/integrations/pro-probes.md, lost sessions). */
function sessionOnDisk(row: ThreadRow) {
  if (!row.native_session_id) return true;
  if (row.transcript_path && fs.existsSync(row.transcript_path)) return true;
  return !!transcriptPath(row.agent, row.native_session_id, row.cwd);
}

/** One folder level for the Browse dialog: its sub-folders by name (hidden ones left out). */
function listFolders(dir: string) {
  let d = path.resolve(expand(dir));
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) d = process.env.HOME ?? '/';
  let folders: string[] = [];
  try {
    folders = fs
      .readdirSync(d, { withFileTypes: true })
      .filter(x => x.isDirectory() && !x.name.startsWith('.'))
      .map(x => x.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  } catch {
    /* unreadable: an empty list */
  }
  // when each one was made, so the dialog sorts by it without asking again: its birth time, or its change time where the file
  // system keeps none (0 there)
  const items = folders.map(name => {
    try {
      const st = fs.statSync(path.join(d, name));
      return { name, created: Math.round(st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs) };
    } catch {
      return { name, created: 0 };
    }
  });
  return { dir: d, parent: path.dirname(d) === d ? null : path.dirname(d), folders, items };
}

/** The file manager, at an export: Finder selects it; elsewhere its folder opens. */
function reveal(file: string) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', ['-R', file]] : process.platform === 'win32' ? ['explorer', [`/select,${file}`]] : ['xdg-open', [path.dirname(file)]];
  const p = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
  p.on('error', () => {});
  p.unref();
}
