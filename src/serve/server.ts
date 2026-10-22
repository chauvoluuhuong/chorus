// chorus serve: the local API the desktop app runs on (Phase 5, architecture §2). It hosts the same Controller as the CLI app,
// without a terminal: the agents run in PTYs here, their screens stream to the desktop over a WebSocket, and every operation
// (new chat, handoff, approvals, memory, skills, artifacts) is the Controller's. The desktop has no business logic of its own.
//
// Security: 127.0.0.1 only; a random token (in the first URL, then an HttpOnly SameSite=Strict cookie) on every request;
// the Host header must be ours (no DNS rebinding); WebSocket upgrades must come from our own origin; writes need X-Chorus: 1.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { App, projectName, type AppIO, type Entry } from '../app/app.ts';
import { AGENTS, type Controller } from '../app/controller.ts';
import type { ItemState, RichLine } from '../app/compositor.ts';
import { effortsFor } from '../app/models.ts';
import type { ThreadHost } from '../app/thread-host.ts';
import { buildHandoff } from '../core/handoff.ts';
import { SKIP_FLAG } from '../core/launch.ts';
import { defaultOpener } from '../core/opener.ts';
import { disabledSkills, findNativeSkills, importSkill, listSkills, setSkillEnabled, sourceDir, syncSkills } from '../core/skills.ts';
import type { AgentId } from '../core/types.ts';

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
const LITERAL = new Set(['POST skills/import']);

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
  port?: number;
  /** fixed token (tests); random otherwise */
  token?: string;
  /** called when the last client asks the server to stop (the desktop window closing) */
  onQuit?: () => void;
}

const plain = (l: RichLine): string => (typeof l === 'string' ? l : l.map(s => s[0]).join(''));

export class ChorusServer {
  readonly c: Controller;
  readonly app: App;
  readonly token: string;
  url = '';
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

  constructor(o: ServeOpts) {
    this.o = o;
    this.c = o.controller;
    this.app = o.controller.app;
    this.token = o.token ?? crypto.randomBytes(24).toString('hex');
    this.bridge();
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
    app.on('thread-exit', () => this.pushState());
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
    this.http = http.createServer((req, res) => void this.handle(req, res).catch(e => send(res, 500, { error: String((e as Error)?.message ?? e) })));
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on('upgrade', (req, sock, head) => {
      if (!this.allowed(req) || !this.sameOrigin(req)) return sock.destroy();
      this.wss!.handleUpgrade(req, sock, head, ws => this.connect(ws));
    });
    const listen = (p: number) =>
      new Promise<void>((resolve, reject) => {
        this.http!.once('error', reject);
        this.http!.listen(p, '127.0.0.1', () => resolve());
      });
    // the usual port when it is free, any free one otherwise
    await listen(port).catch(() => listen(0));
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
    this.ticker = setInterval(() => this.pushState(), 500);
    return this.url;
  }

  /** The address to open: the token goes in once, then lives in a cookie. */
  get openUrl() {
    return `${this.url}/?token=${this.token}`;
  }

  close() {
    this.closed = true;
    clearInterval(this.ticker);
    for (const cl of this.clients) cl.ws.close();
    this.wss?.close();
    this.http?.close();
    this.http?.closeAllConnections?.();
  }

  /* ---------- auth ---------- */

  private hostOk(req: http.IncomingMessage) {
    const port = (this.http?.address() as AddressInfo | null)?.port;
    return req.headers.host === `127.0.0.1:${port}` || req.headers.host === `localhost:${port}`;
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
    return !origin || origin === this.url || origin === this.url.replace('127.0.0.1', 'localhost') || origin === 'tauri://localhost';
  }

  /* ---------- HTTP ---------- */

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url ?? '/', this.url);
    if (!this.hostOk(req)) return send(res, 403, { error: 'wrong host' });
    // the first visit carries the token in the URL: the page comes with it in a cookie and drops it from the address bar.
    // No redirect: a window that navigates here from another origin (the desktop app's tauri://) is a cross-site
    // navigation, and a SameSite=Strict cookie set on a redirect would not come back on the redirected request.
    if (u.pathname === '/' && u.searchParams.get('token')) {
      if (!this.allowed(req)) return send(res, 401, { error: 'bad token' });
      res.setHeader('set-cookie', `${this.cookieName}=${this.token}; HttpOnly; SameSite=Strict; Path=/`);
      return this.file('/', res);
    }
    if (!this.allowed(req)) return send(res, 401, { error: 'open the address chorus serve printed (it carries the token)' });
    if (req.method !== 'GET' && (req.headers['x-chorus'] !== '1' || !this.sameOrigin(req))) return send(res, 403, { error: 'missing X-Chorus header' });
    if (!u.pathname.startsWith('/api/')) return this.file(u.pathname, res);
    const body = req.method === 'GET' ? {} : await readJson(req);
    const out = await this.route(req.method ?? 'GET', u.pathname.slice(5).split('/').map(decodeURIComponent), u.searchParams, body);
    if (out === undefined) return send(res, 404, { error: 'not found' });
    send(res, 200, out);
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
  private async route(method: string, parts: string[], q: URLSearchParams, b: Record<string, any>): Promise<unknown> {
    const [a, id, sub] = parts;
    const c = this.c;
    const thread = id ? c.store.getThread(id) : undefined;
    // literal routes first ("skills/import"), then the ones with an id ("skills/:id/toggle")
    const literal = `${method} ${parts.join('/')}`;
    const key = LITERAL.has(literal) ? literal : `${method} ${a}${id ? '/:id' : ''}${sub ? '/' + sub : ''}`;
    switch (key) {
      case 'GET state':
        return this.state();
      case 'GET newchat':
        return this.newChatInfo(q.get('from') ?? undefined);
      case 'GET folders':
        return listFolders(q.get('dir') ?? c.project);
      case 'POST folders': {
        const dir = path.join(expand(String(b.dir)), String(b.name ?? '').replace(/[/\\]/g, ''));
        fs.mkdirSync(dir, { recursive: true });
        return listFolders(dir);
      }
      case 'POST chats': {
        const agent = asAgent(b.agent);
        if (!agent) return { error: 'agent must be claude, codex or agy' };
        const dir = path.resolve(expand(String(b.folder ?? c.project)));
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
        const e = await c.handoff(id, to, { model: b.model, effort: b.effort, skipPermissions: !!b.skip });
        this.pushState();
        return { id: e?.id };
      }
      case 'POST chats/:id/approve':
      case 'POST chats/:id/deny': {
        const ok = c.answer(sub === 'approve', id);
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
        return { lines: c.doctorLines().map(plain) };
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
      current: this.app.current?.id ?? null,
      chats,
      approvals: c.approvalItems('all'),
      notice: this.app.notice,
      dialogs: [...this.dialogs.values()].map(x => x.d),
      agents: Object.fromEntries(AGENTS.map(a => [a, c.agentInfo.get(a) ?? null])),
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
      recent: c.recentFolders(folder),
      from: src ? { id: src.id, title: src.title, agent: src.agent, skip: !!src.skip_permissions } : null,
      agents: AGENTS.map(a => {
        const models = c.modelList(a);
        return { id: a, info: c.agentInfo.get(a) ?? null, quota: quota[a] ?? null, skipFlag: SKIP_FLAG[a], models, efforts: Object.fromEntries(models.map(m => [m, effortsFor(a, m)])) };
      }),
    };
  }

  chatDetail(id: string) {
    const c = this.c;
    const t = c.store.getThread(id)!;
    const parent = t.parent_thread_id ? c.store.getThread(t.parent_thread_id) : undefined;
    return {
      thread: t,
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

  private connect(ws: WebSocket) {
    const cl = new Client(this, ws);
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
        if (m.cols > 0 && m.rows > 0) this.size = { cols: Math.min(500, m.cols | 0), rows: Math.min(200, m.rows | 0) };
        if (!this.app.entry(m.id)?.host) this.select(m.id); // a parked chat resumes when you open it
        void cl.attach(m.id);
      } else if (m.t === 'in' && typeof m.data === 'string') {
        if (process.env.CHORUS_DEBUG_INPUT) fs.appendFileSync(process.env.CHORUS_DEBUG_INPUT, JSON.stringify(m.data) + '\n');
        host?.write(m.data);
      }
      else if (m.t === 'resize' && m.cols > 0 && m.rows > 0) {
        this.size = { cols: Math.min(500, m.cols | 0), rows: Math.min(200, m.rows | 0) };
        host?.resize(this.size.cols, this.size.rows);
      } else if (m.t === 'detach') cl.detach();
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
  constructor(srv: ChorusServer, ws: WebSocket) {
    this.srv = srv;
    this.ws = ws;
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

const asAgent = (s: unknown): AgentId | undefined => (AGENTS.includes(s as AgentId) ? (s as AgentId) : undefined);
const expand = (p: string) => p.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');

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
