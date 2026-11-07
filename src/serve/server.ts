// chorus serve: the local API the desktop app runs on (Phase 5, architecture §2). It hosts the same Controller as the CLI app,
// without a terminal: the agents run in PTYs here, their screens stream to the desktop over a WebSocket, and every operation
// (new chat, handoff, approvals, memory, skills, artifacts) is the Controller's. The desktop has no business logic of its own.
//
// Security: 127.0.0.1 only; a random token (in the first URL, then an HttpOnly SameSite=Strict cookie) on every request;
// the Host header must be ours (no DNS rebinding); WebSocket upgrades must come from our own origin; writes need X-Chorus: 1.
import { execFile } from 'node:child_process';
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
import { computerDir } from '../app/screens.ts';
import type { ThreadHost } from '../app/thread-host.ts';
import { transcriptPath } from '../core/capture.ts';
import type { ThreadRow } from '../core/store.ts';
import { buildHandoff, handoffPrompt } from '../core/handoff.ts';
import { SKIP_FLAG } from '../core/launch.ts';
import { defaultOpener } from '../core/opener.ts';
import { disabledSkills, findNativeSkills, importSkill, listSkills, setSkillEnabled, sourceDir, syncSkills } from '../core/skills.ts';
import type { AgentId } from '../core/types.ts';
import { CLIS, type AgentCheck, type DeepReport, type FastReport } from '@chauvoluuhuong/chorus-core/doctor';
import { check, composeIssue, firstLaunch, ghReady, host, isDue, isIssueKind, ISSUE_KINDS, lastDeep, latestReleases, markSeen, openInTerminal, openUrl, remoteTested, reportDetails, runCommand, runDeep, sendIssue, DOCTOR_DIR } from '../core/doctor.ts';

import type { NotificationInbox } from './notifications.ts';
import { ChatLaunch, ProHost, type ProLoader } from './pro.ts';
import type { UpdateCheck } from './updates.ts';
import type { ChatStart } from '@chauvoluuhuong/chorus-core/pro-loader';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '../..');
const UI_DIR = path.join(ROOT, 'src/desktop');
/** files of npm packages the page loads (no bundler, no CDN: the desktop works offline) */
const VENDOR: Record<string, string> = {
  'xterm.js': 'node_modules/@xterm/xterm/lib/xterm.js',
  'xterm.css': 'node_modules/@xterm/xterm/css/xterm.css',
  'addon-fit.js': 'node_modules/@xterm/addon-fit/lib/addon-fit.js',
};
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const DEFAULT_SIZE = { cols: 120, rows: 36 };
/** --host values that mean every address of this machine */
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
const LITERAL = new Set(['POST ui', 'POST folders/pick', 'POST skills/import', 'GET doctor/first', 'POST doctor/check', 'POST doctor/refresh', 'POST doctor/seen', 'POST doctor/open', 'POST doctor/run', 'POST doctor/issue', 'POST doctor/issue/send']);

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
  updates?: UpdateCheck;
  onUpdateOpen?: (url: string) => void;
  onNotificationLink?: (url: string) => void;
  port?: number;
  /** the address to listen on: 127.0.0.1 unless `chorus serve --host` asks for another (opt-in: a container, a server). Its name is
   *  then accepted in the Host and Origin checks too; the token is still needed on every request. */
  host?: string;
  /** fixed token (tests); random otherwise */
  token?: string;
  /** called when the last client asks the server to stop (the desktop window closing) */
  onQuit?: () => void;
  /** the doctor's short check and the install/login command runner (tests); the real ones otherwise */
  check?: () => Promise<FastReport>;
  runCommand?: typeof runCommand;
  /** the optional module's loader (tests); the real one otherwise */
  proLoader?: ProLoader;
  /** read by the launcher given to the Controller */
  chatLaunch?: ChatLaunch;
  /** opens the sign-up page in the user's browser (tests); the system's opener otherwise */
  openLink?: (url: string) => void;
  /** the system's folder picker (tests); the real one otherwise */
  pickFolder?: typeof pickFolder;
  /** whether the CLI still has a chat's session (tests); its transcript on disk otherwise */
  sessionExists?: (row: ThreadRow) => boolean;
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
  /** what `chorus mcp` holds: it opens /api/pro/mcp/ and nothing else */
  readonly mcpToken = crypto.randomBytes(24).toString('hex');
  readonly pro: ProHost;
  url = '';
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
    this.pro = new ProHost({ homeDir: this.c.store.root, skills: project => listSkills(project || this.c.project).map(s => s.name), signedIn: () => this.agentCheck?.report.agents.filter(a => a.state === 'ready' || a.state === 'untested').map(a => a.agent), emit: (event, data) => this.broadcast({ t: 'pro', event, data }), startChat: x => this.startChat(x), stopChat: id => this.app.entry(id)?.host?.kill(), sendToChat: (id, text) => this.sendToChat(id, text), handoffPrompt: id => handoffPrompt(this.c.store.getThread(id)!), resumeChat: id => { if (!this.c.store.getThread(id)?.native_session_id || this.app.entry(id)?.state !== 'parked') return false; this.select(id); return true; }, approvals: () => this.c.approvalItems('all').map((a: any) => ({ thread: a.id, kind: a.kind, what: a.what ?? a.question ?? '', request: a.request, options: a.options, details: a.details, waiting: a.waiting })), answerApproval: (id, answer, request, note) => void (request ? this.c.answerRequest(request, answer, note) : this.c.answer(answer === 'ok', id)), chatInfo: id => { const t = this.c.store.getThread(id); return t ? { title: t.title, cwd: t.cwd, agent: t.agent, state: t.state } : undefined; }, port: () => (this.http?.address() as AddressInfo | null)?.port, chats: () => this.c.store.listThreads().map(t => ({ id: t.id, title: t.title, cwd: t.cwd, agent: t.agent, state: t.state })), chatRecord: id => { const t = this.c.store.getThread(id); return t ? buildHandoff(this.c.store, t).text : undefined; }, projects: () => [...new Set(this.c.store.listThreads().map(t => t.cwd).filter(Boolean))] }, () => this.broadcast({ t: 'pro-status', status: this.pro.status() }), o.proLoader);
    if (o.chatLaunch) o.chatLaunch.host = this.pro;
    this.bridge();
  }

  private startChat(x: ChatStart): string {
    const launch = this.o.chatLaunch;
    if (launch) launch.next = { note: x.note, readOnly: x.readOnly, skills: x.skills };
    try {
      return this.c.newThread({ agent: x.agent, model: x.model, effort: x.effort, title: x.title, prompt: x.prompt, cwd: x.cwd, skipPermissions: x.skipPermissions, parent: x.parent ? this.c.store.getThread(x.parent) : undefined }).id;
    } finally {
      if (launch) launch.next = undefined;
    }
  }

  private sendToChat(id: string, text: string) {
    const host = this.app.entry(id)?.host;
    if (!host) return;
    host.write(text);
    // text and Enter in one chunk read as a paste in the TUIs: Enter goes apart
    setTimeout(() => host.state === 'running' && host.write('\r'), 700);
  }

  /** The Controller's questions, flashes and bell reach the desktop instead of a terminal. */
  private bridge() {
    const app = this.app;
    app.alert = (title, lines, options) => this.ask({ kind: 'alert', title, lines, options }) as Promise<string | undefined>;
    app.prompt = (title, lines, initial = '') => this.ask({ kind: 'prompt', title, lines, initial }) as Promise<string | undefined>;
    app.choose = (title, options) => this.ask({ kind: 'choose', title, lines: [], options: options.map((label, i) => ({ key: String(i), label })) }).then(v => (v === undefined ? undefined : Number(v)));
    const flash = app.setFlash.bind(app);
    app.setFlash = (msg: string) => {
      flash(msg);
      this.flashes.push({ text: msg, ts: Date.now() });
      this.flashes = this.flashes.slice(-20);
      this.broadcast({ t: 'flash', text: msg });
    };
    app.bell = () => this.broadcast({ t: 'bell' });
    // a new process for a chat (new, resumed): it takes the desktop's terminal size, and clients looking at that chat follow it
    app.on('thread-started', (e: Entry, host: ThreadHost) => {
      host.resize(this.size.cols, this.size.rows);
      for (const cl of this.clients) if (cl.attached === e.id) void cl.attach(e.id);
      this.pushState();
    });
    app.on('thread-exit', (e: Entry) => {
      this.pro.chatEvent({ type: 'exit', thread: e?.id } as { type: string });
      this.pushState();
    });
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
    this.ticker = setInterval(() => this.pushState(), 500);
    // openUrl: the page's address with its token, printed by `chorus` after the window opens (a browser tab on the same Chorus)
    fs.writeFileSync(this.serveFile, JSON.stringify({ url: this.url, openUrl: this.openUrl, mcpToken: this.mcpToken }), { mode: 0o600 });
    void this.pro.start();
    const tested = JSON.stringify(remoteTested());
    if (this.o.notifications)
      void this.o.notifications.startup().then(() => {
        this.pushState();
        // the backend's answer came after the check at start and changed the tested versions: check again against the new list
        if (this.agentCheck && JSON.stringify(remoteTested()) !== tested) void this.checkAgents({ quiet: true }).catch(e => this.noteError('doctor check', e));
      });
    if (this.o.updates) void this.o.updates.startup().then(() => this.pushState());
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

  close() {
    this.closed = true;
    this.pro.close();
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
      const bytes = await readRaw(req, UPLOAD_LIMIT).catch(() => undefined);
      if (!bytes) return send(res, 413, { error: `a dropped file can be at most ${UPLOAD_LIMIT / 1_000_000} MB` });
      const r = this.c.dropFiles(upload[1], [{ name: u.searchParams.get('name') ?? 'file', bytes }]);
      return send(res, 'error' in r ? 409 : 200, r);
    }
    const body = req.method === 'GET' ? {} : await readJson(req);
    const out = await this.route(req.method ?? 'GET', u.pathname.slice(5).split('/').map(decodeURIComponent), u.searchParams, body);
    if (out === undefined) return send(res, 404, { error: 'not found' });
    send(res, 200, out);
  }

  private mcpAllowed(req: http.IncomingMessage) {
    const t = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const ok = !!t && t.length === this.mcpToken.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(this.mcpToken));
    return ok && this.hostOk(req) && !req.headers.origin && (req.method === 'GET' || req.headers['x-chorus'] === '1');
  }

  private async proMcp(req: http.IncomingMessage, res: http.ServerResponse, route: string) {
    if (req.method === 'GET' && route === 'tools') return send(res, 200, { tools: await this.pro.mcpTools(new URL(req.url ?? '/', 'http://x').searchParams.get('app') === '1') });
    if (req.method === 'POST' && route === 'call') {
      const b = await readJson(req);
      if (process.env.CHORUS_PRO_LOG) console.error(`[pro] mcp ${String(b.name)} thread ${String(b.threadId)}`);
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
    this.broadcast({ t: 'pro-signed-in', status: st, then });
    if (!st.unlocked) return page('Something went wrong', `${st.message ?? 'Chorus could not finish signing you in.'} Open Chorus and try again.`);
    page('You\'re signed in', 'Go back to Chorus: it is ready. You can close this tab.');
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
      const url = `${tryUrl}?${new URLSearchParams({ state, port: new URL(this.url).port })}`;
      (this.o.openLink ?? openUrl)(url);
      return send(res, 200, { ok: true, url });
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
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
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
    if (action === 'login' && agent === 'agy') {
      if (!openInTerminal('agy')) return { error: 'agy signs in when it starts: run `agy` once in a terminal' };
      return { id: '', agent, action, command, done: true, ok: true, output: '', results: [], terminal: true };
    }
    const job: DoctorJob = { id: crypto.randomBytes(4).toString('hex'), agent, action, command, done: false, output: '', results: [] };
    this.doctorJobs.set(job.id, job);
    void (async () => {
      if (action === 'deep') {
        const run = await runDeep(agent, e => e.type === 'scenario-end' && job.results.push(e.result));
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
    if (a === 'updates') {
      if (method === 'POST' && id === 'skip' && parts.length === 2) { this.o.updates?.skip(); this.pushState(); return { ok: true }; }
      if (method === 'POST' && id === 'open' && parts.length === 2) {
        const url = this.o.updates?.updateUrl();
        if (!url) return { error: 'No update is available for this platform' };
        (this.o.onUpdateOpen ?? openUrl)(url); return { ok: true };
      }
      return undefined;
    }
    if (a === 'notifications') {
      const inbox = this.o.notifications;
      if (method === 'GET' && parts.length === 1) return inbox?.snapshot() ?? { items: [], unread: 0, checkedAt: null, checking: false, offline: false };
      if (method === 'POST' && id === 'read-all' && parts.length === 2) { inbox?.markAllRead(); this.pushState(); return inbox?.snapshot() ?? { items: [], unread: 0 }; }
      if (method === 'POST' && id === 'link' && parts.length === 2) {
        if (typeof b.url !== 'string' || !inbox?.allowsLink(typeof b.id === 'string' ? b.id : undefined, b.url)) return { error: 'This link is not in the notification' };
        (this.o.onNotificationLink ?? openUrl)(b.url); return { ok: true };
      }
      if (method === 'POST' && sub === 'open' && parts.length === 3 && inbox?.content(id)) {
        void inbox.opened(id).catch(() => {}); this.pushState(); return { item: inbox.content(id), inbox: inbox.snapshot() };
      }
      return undefined;
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
        const dir = path.join(expand(String(b.dir)), String(b.name ?? '').replace(/[/\\]/g, ''));
        fs.mkdirSync(dir, { recursive: true });
        return listFolders(dir);
      }
      case 'POST chats': {
        const agent = asAgent(b.agent);
        if (!agent) return { error: 'agent must be claude, codex or agy' };
        const dir = path.resolve(expand(String(b.folder ?? c.project)));
        if (dir === computerDir()) fs.mkdirSync(dir, { recursive: true }); // "This computer": a chat that belongs to no project
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { error: `${b.folder} is not a folder` };
        const e = c.newThread({ agent, model: b.model, effort: b.effort, cwd: dir, skipPermissions: !!b.skip, prompt: b.prompt?.trim() || undefined });
        this.pushState();
        return { id: e.id };
      }
      case 'GET chats/:id':
        return thread && this.chatDetail(id);
      case 'DELETE chats/:id':
        if (!thread) return undefined;
        void c.deleteThread(id).then(() => this.pushState());
        return { asked: true };
      case 'POST chats/:id/select':
        return this.select(id) ? { ok: true } : undefined;
      case 'POST chats/:id/handoff': {
        const to = asAgent(b.to);
        if (!thread || !to) return undefined;
        const opts = { model: b.model, effort: b.effort, skipPermissions: !!b.skip };
        const note = typeof b.note === 'string' ? b.note.trim() : '';
        // a note (the paid Hand off's "Anything to add?") goes after the record, in the same first message
        const e = note ? c.newThread({ agent: to, title: `${thread.title} → ${to}`, prompt: `${handoffPrompt(thread)}\n\n${note}`, parent: thread, cwd: thread.cwd, ...opts }) : await c.handoff(id, to, opts);
        this.pushState();
        return { id: e?.id };
      }
      case 'POST chats/:id/approve':
      case 'POST chats/:id/deny': {
        const ok = c.answer(sub === 'approve', id);
        this.pushState();
        return { ok };
      }
      case 'POST chats/:id/answer': {
        // a request_approval card: the option (and note) becomes the user's next message to that agent
        const ok = typeof b.request === 'string' && typeof b.option === 'string' && c.answerRequest(b.request, b.option, typeof b.note === 'string' ? b.note : undefined);
        this.pushState();
        return { ok };
      }
      case 'POST chats/:id/retry':
        this.select(id);
        c.retryContext();
        return { ok: true };
      case 'GET chats/:id/activity':
        return thread && c.activityRows(id);
      case 'GET chats/:id/artifacts':
        return thread && this.artifacts(id);
      case 'POST chats/:id/open':
        if (!thread) return undefined;
        await c.openArtifact(id, String(b.path), b.via);
        return { ok: true };
      case 'POST chats/:id/preview':
        return thread && { url: await c.openPreview(id, String(b.path), false) };
      case 'GET memory':
        return { where: c.store.shared ? c.store.root.replace(process.env.HOME ?? '\0', '~') + '/chorus.db' : '.chorus/chorus.db', items: c.memoryItems(q.get('q') ?? '') };
      case 'GET approvals':
        return { pending: c.approvalItems('all'), decided: c.decidedItems() };
      case 'GET skills':
        return this.skills();
      case 'POST skills': {
        const slug = String(b.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
        openUrl(CLIS[a].page);
        return { ok: true };
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
        const r = await reportDetails({ fast, deep: this.deepReports, chats, projects: new Set(threads.map(t => t.project ?? t.cwd)).size, client, errors, update: this.o.updates?.snapshot() ?? null });
        return { ...r, kinds: Object.entries(ISSUE_KINDS).map(([id, k]) => ({ id, name: k.name })) };
      }
      case 'POST doctor/issue/send': {
        if (!isIssueKind(b.kind) || typeof b.details !== 'string') return { error: 'kind and details' };
        const it = composeIssue({ kind: b.kind, summary: String(b.summary ?? ''), what: String(b.what ?? ''), details: b.details });
        return { ...sendIssue(it.title, it.body, path.join(DOCTOR_DIR(), 'issue.md')), title: it.title, labels: it.labels };
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
        artifacts: e.meta?.artifacts ?? 0,
        toast: e.meta?.toast ?? null,
        updated: t?.updated ?? null,
      };
    });
    return {
      project: c.project,
      update: this.o.updates?.snapshot() ?? null,
      notifications: this.o.notifications?.summary() ?? { unread: 0, checkedAt: null, checking: false, offline: false },
      current: this.app.current?.id ?? null,
      chats,
      // when each request appeared (whole seconds), not "seconds waiting": the state must not change every push, or the
      // window would redraw the inbox under the mouse
      approvals: c.approvalItems('all').map(({ waiting, ...x }) => ({ ...x, since: Math.round(Date.now() / 1000 - waiting) })),
      ui: this.ui(),
      notice: this.app.notice,
      dialogs: [...this.dialogs.values()].map(x => x.d),
      // the doctor's short check, the one status of the agents (null until the first one is done)
      doctor: this.agentCheck ? { at: this.agentCheck.at, ms: this.agentCheck.report.ms, checking: this.checkShown, agents: this.agentCheck.report.agents } : this.checking ? { checking: true, agents: null } : null,
    };
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
        const models = c.modelList(a);
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
      folder: c.store.artifactsDir(id),
      items: c.store.listArtifacts(id).map(a => ({ path: a.path, abs: a.abs, ts: a.ts, ago: c.ago(a.ts), versions: versionsOf(a.path) })),
      files: [...touched].slice(0, 50),
    };
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

  /** Whether this viewer sets the agents' screen size: never through the private link; a browser tab only while no window is open. */
  private setsSize(cl: Client) {
    return !cl.remote && (cl.native || ![...this.clients].some(c => c.native));
  }

  private connect(ws: WebSocket, remote = false, native = false) {
    const cl = new Client(this, ws, remote, native);
    this.clients.add(cl);
    this.lastState = '';
    ws.on('close', () => {
      cl.detach();
      this.clients.delete(cl);
    });
    ws.on('message', raw => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      const host = typeof m.id === 'string' ? this.app.entry(m.id)?.host : undefined;
      if (m.t === 'attach' && typeof m.id === 'string') {
        // one screen size for every viewer: a phone looks at the agent at the Mac's size and never resizes it (stage 7)
        if (m.cols > 0 && m.rows > 0 && this.setsSize(cl)) this.size = { cols: Math.min(500, m.cols | 0), rows: Math.min(200, m.rows | 0) };
        if (!this.app.entry(m.id)?.host) this.select(m.id); // a parked chat resumes when you open it
        void cl.attach(m.id);
      } else if (m.t === 'in' && typeof m.data === 'string') {
        if (process.env.CHORUS_DEBUG_INPUT) fs.appendFileSync(process.env.CHORUS_DEBUG_INPUT, JSON.stringify(m.data) + '\n');
        host?.write(m.data);
      }
      else if (m.t === 'resize' && m.cols > 0 && m.rows > 0 && this.setsSize(cl)) {
        this.size = { cols: Math.min(500, m.cols | 0), rows: Math.min(200, m.rows | 0) };
        host?.resize(this.size.cols, this.size.rows);
      } else if (m.t === 'detach') cl.detach();
      else if (m.t === 'drop' && typeof m.id === 'string' && Array.isArray(m.paths)) {
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
    this.send(JSON.stringify({ t: 'screen', id, data, live: host.state === 'running', cols: host.screen.cols, rows: host.screen.rows }));
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

function readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => {
      s += d;
      if (s.length > 1_000_000) req.destroy();
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
const UI_KEYS = new Set(['hidden', 'folded', 'agent', 'drawer', 'welcome', 'ended', 'banner']);
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
  return { dir: d, parent: path.dirname(d) === d ? null : path.dirname(d), folders };
}
