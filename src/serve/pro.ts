// The optional module's seam. This file only passes calls on: with nothing loaded there is no code to run, so patching the check below
// gains nothing. The loader and its formats live in the core package.
import { activatePro, isLocked, loadPro, proDev, type LoadResult, type McpToolDef, type ProCtx, type ProHandler, type ProModule } from '@chauvoluuhuong/chorus-core/pro-loader';

export interface ProLoader {
  load(ctx: ProCtx, onChange: (r: LoadResult) => void): Promise<LoadResult>;
  activate(ctx: ProCtx, key: string, onChange: (r: LoadResult) => void): Promise<LoadResult>;
  dev: boolean;
}

const realLoader: ProLoader = { load: loadPro, activate: activatePro, dev: proDev };

export interface ProStatus {
  unlocked: boolean;
  dev: boolean;
  reason?: string;
  message?: string;
  version?: string;
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
    return isLocked(r) ? { unlocked: false, dev: this.loader.dev, reason: r.locked, message: r.message } : { unlocked: true, dev: this.loader.dev, version: r.version };
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

  async mcpTools() {
    await this.ready;
    return this.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  async mcpCall(name: string, args: Record<string, unknown>, threadId?: string): Promise<{ status: number; json: unknown }> {
    await this.ready;
    if (!this.module) return LOCKED;
    const t = this.tools.find(x => x.name === name);
    if (!t) return { status: 404, json: { error: `no tool ${name}` } };
    return { status: 200, json: { text: await t.handler(args, { threadId }) } };
  }

  /** What happens in the app that the module acts on. The last doctor answer also reaches a module that loads later. */
  chatEvent(ev: { type: string }) {
    if (ev.type === 'doctor') this.doctorSeen = ev;
    if (this.module) this.module.onChatEvent(this.ctx, ev);
  }

  close() {
    this.module?.dispose();
  }
}
