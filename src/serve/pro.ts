// The optional module's seam. This file only passes calls on: with nothing loaded there is no code to run, so patching the check below
// gains nothing. The loader and its formats live in the core package.
import path from 'node:path';
import { exclude } from '@chauvoluuhuong/chorus-core';
import { ProjectSettings } from '../core/projects.ts';
import type { AgentId } from '../core/types.ts';
import { syncSkills } from '../core/skills.ts';
import type { Store } from '../core/store.ts';
import { isSubThread, type ThreadRole } from '../mcp/server.ts';
import { accountPro, activatePro, isLocked, loadPro, proDev, proLinks, recheckPro, signInPro, upgradePro, type ChatExtras, type LoadResult, type McpToolDef, type ProCtx, type ProHandler, type ProModule, type RemoteDecision, type RemoteRequest } from '@chauvoluuhuong/chorus-core/pro-loader';

export interface ProLoader {
  load(ctx: ProCtx, onChange: (r: LoadResult) => void): Promise<LoadResult>;
  activate(ctx: ProCtx, key: string, onChange: (r: LoadResult) => void): Promise<LoadResult>;
  /** back from the browser with a one-time code (plan stage 6) */
  signIn?(ctx: ProCtx, code: string, state: string, onChange: (r: LoadResult) => void): Promise<LoadResult>;
  /** the sign-up page and the first-launch words */
  links?(): { tryUrl: string; plansUrl: string };
  /** Upgrade's payment link for the signed-in account (plan stage 8); `signIn` when there is no account here yet */
  upgrade?(ctx: ProCtx, port?: number): Promise<{ url?: string; pro?: boolean; error?: string; signIn?: boolean }>;
  /** the signed-in account's email, as the backend last sent it (plan box, 2026-11-09) */
  account?(ctx: ProCtx): { email: string } | undefined;
  /** after paying: the licence as the server signs it now */
  recheck?(ctx: ProCtx, onChange: (r: LoadResult) => void): Promise<LoadResult>;
  dev: boolean;
}

/**
 * What a chat gets on top of a normal launch, for its start text (src/mcp/server.ts startText): a teammate's role from the paid
 * bundle, a sub thread's main thread, and for a plain chat every action it may propose. `chorus serve` passes this to the
 * Controller's launcher, so the CLI app's code stays as it is.
 */
export class ChatLaunch {
  /** set just around a new chat, which starts synchronously */
  next: ChatExtras | undefined;
  /** set just around a new sub thread: its brief (its row has none yet) */
  nextSub: string | undefined;
  host: ProHost | undefined;
  /** what the chat's mail transport adds to its launch (set by chorus serve: its transports' launch()) */
  wake: ((agent: AgentId, thread: string) => { args?: string[]; env?: Record<string, string>; files?: Record<string, string> } | undefined) | undefined;
  readonly store: Store | undefined;
  /** the projects' folders and variables (src/core/projects.ts), in the store's folder */
  readonly projects: ProjectSettings | undefined;
  /** told what each start or resume got (chorus serve: ProjectRuntime.launched) */
  launched: ((threadId: string, project: string, addDirs: string[], env: Record<string, string>) => void) | undefined;

  constructor(store?: Store) {
    this.store = store;
    this.projects = store ? new ProjectSettings(store.root) : undefined;
  }

  extras(o: { threadId: string; project: string; cwd: string }, agent: AgentId): { role?: ThreadRole; readOnly?: boolean; moreTools?: string[]; parent?: { id: string; title: string; brief: string }; actionLabels?: string[]; noNativeAsk?: boolean; wake?: ReturnType<NonNullable<ChatLaunch['wake']>>; addDirs?: string[]; env?: Record<string, string>; liveDirs?: boolean } {
    const wake = this.wake?.(agent, o.threadId);
    return { ...this.extrasOf(o, agent), ...(wake ? { wake } : {}), ...this.projectOf(o) };
  }

  /**
   * The chat's project settings, at every start and every resume: its folders (`--add-dir`) and its variables (the process
   * environment only). liveDirs: a folder added later can reach the running chat (Codex's default mode gets its per-session flag).
   */
  private projectOf(o: { threadId: string; project: string; cwd: string }): { addDirs?: string[]; env?: Record<string, string>; liveDirs?: boolean } {
    if (!this.projects) return {};
    const project = path.resolve(o.project || o.cwd);
    const addDirs = this.projects.addDirs(project);
    const env = this.projects.env(project);
    this.launched?.(o.threadId, project, addDirs, env);
    return { ...(addDirs.length ? { addDirs } : {}), ...(Object.keys(env).length ? { env } : {}), liveDirs: true };
  }

  private extrasOf(o: { threadId: string; project: string; cwd: string }, agent: AgentId): { role?: ThreadRole; readOnly?: boolean; moreTools?: string[]; parent?: { id: string; title: string; brief: string }; actionLabels?: string[]; noNativeAsk?: boolean } {
    const row = this.store?.getThread(o.threadId);
    const brief = this.nextSub ?? (isSubThread(row) ? row?.sub_brief : undefined);
    const main = brief != null && row?.parent_thread_id ? this.store?.getThread(row.parent_thread_id) : undefined;
    const parent = main ? { id: main.id, title: main.title, brief: brief ?? '' } : undefined;
    const e = this.next ?? this.host?.chatExtras(o.threadId);
    // a plain chat or sub thread: the bundle's tools need no prompt either (line 4 asks it to propose an action through Chorus)
    // only a main chat asks the user: a sub thread or a step's Worker gets its CLI's own question tool turned off
    const noNativeAsk = !!parent || !!row?.sub_status || !!e?.role?.step || undefined;
    if (!e) return { moreTools: this.host?.toolNames(), noNativeAsk, ...(parent ? { parent } : { actionLabels: this.host?.allActionLabels() }) };
    exclude(o.cwd, ['.chorus/']); // a teammate's check reads `git status`
    if (e.skills) syncSkills(o.project, { agents: [agent], into: o.cwd, only: e.skills });
    return { role: e.role, readOnly: e.readOnly, moreTools: this.host?.toolNames(), noNativeAsk, ...(parent ? { parent } : e.role ? {} : { actionLabels: this.host?.allActionLabels() }) };
  }
}

const realLoader: ProLoader = { load: loadPro, activate: activatePro, signIn: signInPro, links: proLinks, account: accountPro, upgrade: upgradePro, recheck: recheckPro, dev: proDev };

export interface ProStatus {
  unlocked: boolean;
  dev: boolean;
  reason?: string;
  message?: string;
  version?: string;
  /** what the signed entitlement says: trial, pro, free (trial ended), dev; the plan box and the trial banners read it */
  plan?: string;
  ends?: string;
  locked?: string[];
  /** the signed-in account's email, for the plan box; none for Community */
  email?: string;
}

const LOCKED = { status: 402, json: { locked: true } };

export class ProHost {
  private result: LoadResult = { locked: 'no-licence', message: 'Checking…' };
  private ready: Promise<void> = Promise.resolve();
  private routes: Record<string, ProHandler> = {};
  private tools: McpToolDef[] = [];
  private ctx: ProCtx;
  private loader: ProLoader;
  private onChange: () => void;
  private doctorSeen: { type: string } | undefined;
  private closed = false;

  constructor(ctx: ProCtx, onChange: () => void, loader: ProLoader = realLoader) {
    this.ctx = ctx;
    this.onChange = onChange;
    this.loader = loader;
  }

  private get module(): ProModule | undefined {
    return isLocked(this.result) ? undefined : this.result;
  }

  private use = (r: LoadResult) => {
    this.result = r;
    this.routes = isLocked(r) ? {} : r.routes(this.ctx);
    this.tools = isLocked(r) ? [] : r.mcpTools(this.ctx);
    if (this.doctorSeen && !isLocked(r)) r.onChatEvent(this.ctx, this.doctorSeen);
    this.onChange();
  };

  /** Once, at start. A failure in the module locks it and never stops the app. */
  start() {
    this.ready = this.loader.load(this.ctx, this.use).then(this.use, (e: Error) => this.use({ locked: 'damaged', message: e.message }));
    return this.ready;
  }

  async activate(key: string): Promise<ProStatus> {
    await this.ready;
    this.module?.dispose();
    this.use(await this.loader.activate(this.ctx, key, this.use).catch((e: Error): LoadResult => ({ locked: 'damaged', message: e.message })));
    return this.status();
  }

  status(): ProStatus {
    const r = this.result;
    if (isLocked(r)) return { unlocked: false, dev: this.loader.dev, reason: r.locked, message: r.message };
    const e = r.entitled;
    const email = e && e.plan !== 'community' ? this.loader.account?.(this.ctx)?.email : undefined;
    return { unlocked: true, dev: this.loader.dev, version: r.version, ...(e ? { plan: e.plan, ends: e.ends, locked: e.locked } : {}), ...(email ? { email } : {}) };
  }

  /** Back from the browser with the one-time code: the account's licence, activated here (plan stage 6). */
  async signIn(code: string, state: string): Promise<ProStatus> {
    await this.ready;
    if (!this.loader.signIn) return this.status();
    this.module?.dispose();
    this.use(await this.loader.signIn(this.ctx, code, state, this.use).catch((e: Error): LoadResult => ({ locked: 'damaged', message: e.message })));
    return this.status();
  }

  links() {
    return this.loader.links?.() ?? { tryUrl: '', plansUrl: '' };
  }

  /** Upgrade: the payment link the server makes for this account. Nothing here changes until the server says it was paid. */
  async upgrade(port?: number): Promise<{ url?: string; pro?: boolean; error?: string; signIn?: boolean }> {
    await this.ready;
    if (!this.loader.upgrade) return { error: 'Upgrading is not available in this build.' };
    const r = await this.loader.upgrade(this.ctx, port);
    // already paid, while this app still runs its older licence: take the paid one now, so the plan box says Pro (2026-11-10)
    if (r.pro) await this.recheck();
    return r;
  }

  /** Asks the server for the licence again (after paying). Unreachable keeps what runs; anything else replaces it. */
  async recheck(): Promise<ProStatus> {
    await this.ready;
    if (!this.loader.recheck) return this.status();
    const r = await this.loader.recheck(this.ctx, this.use).catch((e: Error): LoadResult => ({ locked: 'damaged', message: e.message }));
    if (isLocked(r) && r.locked === 'unreachable' && this.module) return { ...this.status(), message: r.message ?? 'Chorus could not reach its server.' };
    if (isLocked(r) && r.locked === 'no-licence') return this.status();
    this.module?.dispose();
    this.use(r);
    return this.status();
  }

  /** `path` is what follows /api/pro/. */
  async call(method: string, path: string, query: Record<string, string>, body: unknown): Promise<{ status: number; json: unknown }> {
    await this.ready;
    const h = this.routes[`${method} ${path}`] ?? this.routes['*'];
    if (!this.module) return LOCKED;
    const out = await h?.({ method, path, query, body });
    if (out === undefined) return { status: 404, json: { error: 'not found' } };
    const { httpStatus, json } = out as { httpStatus?: number; json?: unknown };
    return httpStatus ? { status: httpStatus, json } : { status: 200, json: out };
  }

  async ui(): Promise<{ js: string; css: string } | undefined> {
    await this.ready;
    return this.module?.ui();
  }

  /** `app`: the tools of an AI app that connects with no chat (`chorus mcp` alone), asked each time because the plan can lock them */
  async mcpTools(app = false) {
    await this.ready;
    return (app ? this.appTools() : this.tools).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  private appTools(): McpToolDef[] {
    return this.module?.appTools?.(this.ctx) ?? [];
  }

  async mcpCall(name: string, args: Record<string, unknown>, threadId?: string): Promise<{ status: number; json: unknown }> {
    await this.ready;
    if (!this.module) return LOCKED;
    const t = this.tools.find(x => x.name === name) ?? (threadId ? undefined : this.appTools().find(x => x.name === name));
    if (!t) return { status: 404, json: { error: `no tool ${name}` } };
    return { status: 200, json: { text: await t.handler(args, { threadId }) } };
  }

  /** A request through the private or public link (stage 7). Nothing loaded: nothing answers it. */
  async remote(req: RemoteRequest): Promise<RemoteDecision | undefined> {
    await this.ready;
    return this.module?.remote?.(this.ctx, req);
  }

  /** A teammate's chat whose CLI lost its session: its action's brief again, and what it already made (decision 18). */
  lostBrief(thread: string): string | undefined {
    return this.module?.lostBrief?.(this.ctx, thread);
  }

  chatExtras(thread: string) {
    return this.module?.chatExtras?.(this.ctx, thread);
  }

  /** A project's task counts (Settings › Projects): undefined without the module, locked, or with an older bundle. Free code never reads pro.db. */
  async projectCounts(project: string): Promise<{ tasks: number; open: number } | undefined> {
    await this.ready;
    try {
      const c = this.module?.projectCounts?.(this.ctx, project);
      return c && typeof c.tasks === 'number' ? { tasks: c.tasks, open: Number(c.open) || 0 } : undefined;
    } catch {
      return undefined;
    }
  }

  /** A project's open tasks, newest first (get_project): none without the module, locked, or with an older bundle. */
  async projectTasks(project: string, limit = 20): Promise<{ number: number; title: string; state: string }[]> {
    await this.ready;
    try {
      const l = this.module?.projectTasks?.(this.ctx, project, limit);
      return Array.isArray(l) ? l.map(t => ({ number: Number(t.number), title: String(t.title), state: String(t.state) })) : [];
    } catch {
      return [];
    }
  }

  /** The project's task files for Export this project (paths under pro/): none without the module or with an older bundle. */
  async exportProject(project: string): Promise<{ path: string; data: string | Buffer }[]> {
    await this.ready;
    try {
      return this.module?.exportProject?.(this.ctx, project) ?? [];
    } catch {
      return [];
    }
  }

  /** A chat's role, live (current_thread, the request_approval guard): none without the bundle or for a plain chat. Not gated. */
  roleOf(thread: string): ThreadRole | undefined {
    try {
      return this.module?.roleOf?.(this.ctx, thread);
    } catch {
      return undefined;
    }
  }

  /** Every action a plain chat may propose; none without the bundle. */
  allActionLabels(): string[] | undefined {
    try {
      return this.module?.allActionLabels?.(this.ctx);
    } catch {
      return undefined;
    }
  }

  /** The module's start resumes chats while `use` is still asking for its tools: those chats ask it again here. */
  toolNames() {
    return (this.tools.length ? this.tools : (this.module?.mcpTools(this.ctx) ?? [])).map(t => t.name);
  }

  /** What happens in the app that the module acts on. The last doctor answer also reaches a module that loads later. */
  chatEvent(ev: { type: string }) {
    if (ev.type === 'doctor') this.doctorSeen = ev;
    if (this.module && !this.closed) this.module.onChatEvent(this.ctx, ev);
  }

  /** A closing app kills its chats: those exits are not "stopped, not done". */
  close() {
    this.closed = true;
    this.module?.dispose();
  }
}
