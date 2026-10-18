// Controller: ties the app shell to the store, launchers, tailers and approval detection (P4.2–P4.7).
import fs from 'node:fs';
import path from 'node:path';
import { buildHandoff, handoffPrompt } from '../core/handoff.ts';
import { buildInteractive, type InteractiveOpts, type Launch } from '../core/launch.ts';
import { syncSkills, sourceDir } from '../core/skills.ts';
import type { Store, ThreadRow } from '../core/store.ts';
import type { AgentId, Session } from '../core/types.ts';
import { App, type Entry } from './app.ts';
import { detectApproval, type PendingApproval } from './approval.ts';
import { detectLimit } from './limits.ts';
import { modelsFor } from './models.ts';
import type { ItemState } from './compositor.ts';
import { Tailer } from './tailer.ts';
import { spawn } from 'node:child_process';
import { T, agentStyle, type HomeView, type RichLine, type Seg } from './compositor.ts';
import { VERIFIED_VERSION, versionWarning } from '../core/adapters/index.ts';

export const AGENTS: AgentId[] = ['claude', 'codex', 'agy'];
const RAW_CAP = 2 * 1024 * 1024;

export interface ControllerOpts {
  project: string;
  store: Store;
  app: App;
  /** model per agent for new threads (tests use cheap ones) */
  models?: Partial<Record<AgentId, string>>;
  tailPollMs?: number;
  /** how a thread's agent is started (tests start a fake TUI instead) */
  launcher?: (agent: AgentId, o: InteractiveOpts) => Launch;
}

export class Controller {
  readonly app: App;
  readonly store: Store;
  readonly project: string;
  private o: ControllerOpts;
  private tailers = new Map<string, Tailer>();
  private claimed = new Set<string>();
  private pending = new Map<string, PendingApproval>();
  private limited = new Map<string, string>();
  private limitShown = new Set<string>();
  private agentInfo = new Map<AgentId, { version?: string; login?: string; ok: boolean }>();
  private sessions = new Map<string, Session>();
  private sawStart = new Map<string, number>();
  private detectTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(o: ControllerOpts) {
    this.o = o;
    this.app = o.app;
    this.store = o.store;
    this.project = o.project;
    this.app.on('action', (a: string) => void this.onAction(a));
    this.app.on('thread-exit', (e: Entry) => this.onExit(e));
    this.app.on('select', (e: Entry) => void this.onSelect(e));
    this.app.on('stopped', () => this.stop());
    this.detectTimer = setInterval(() => this.detect(), 400);
    this.app.homeProvider = () => this.homeData();
    void this.probeAgents();
  }

  stop() {
    this.closed = true;
    clearInterval(this.detectTimer);
    for (const t of this.tailers.values()) t.stop();
  }

  /* ---------- threads ---------- */

  /** Threads from earlier runs appear in the sidebar without a process; selecting one resumes it. */
  restore() {
    // parents first, so a thread that continues another is listed right under it
    const rows = this.store.listThreads().reverse().filter(r => r.native_session_id);
    for (const row of [...rows.filter(r => !r.parent_thread_id), ...rows.filter(r => r.parent_thread_id)]) {
      this.app.addParked({ id: row.id, title: row.title, agent: row.agent, parentId: row.parent_thread_id ?? undefined });
      this.refreshMeta(row.id);
    }
  }

  /**
   * `raw` prompts (handoffs) are typed exactly as given. Any other first prompt gets a line telling the agent
   * where this thread's artifacts go (docs/architecture.md §9).
   */
  newThread(o: { agent: AgentId; title?: string; prompt?: string; parent?: ThreadRow; raw?: boolean; model?: string; cwd?: string }): Entry {
    const cwd = o.cwd ?? this.project;
    const model = o.model && o.model !== 'default' ? o.model : this.o.models?.[o.agent];
    if (fs.existsSync(sourceDir(this.project))) syncSkills(this.project, { agents: [o.agent], into: cwd });
    const n = this.store.listThreads().filter(t => t.agent === o.agent).length + 1;
    const row = this.store.createThread({ title: o.title ?? `${o.agent} ${n}`, agent: o.agent, cwd, model: model ?? null, parent_thread_id: o.parent?.id, state: 'working' });
    const prompt = o.prompt && !o.raw ? `${o.prompt}\n\n(Files meant for the user, such as notes or reports, go in ${this.store.artifactsDir(row.id)})` : o.prompt;
    const launch = (this.o.launcher ?? buildInteractive)(o.agent, { prompt, cwd, project: this.project, threadId: row.id, model });
    if (launch.sessionId) this.store.updateThread(row.id, { native_session_id: launch.sessionId });
    this.sawStart.set(row.id, o.prompt ? Date.now() : 0);
    const host = this.app.addThread({ id: row.id, title: row.title, agent: o.agent, file: launch.bin, args: launch.args, cwd: launch.cwd }, true, o.parent?.id);
    this.watchRaw(row.id, host);
    this.refreshMeta(row.id);
    this.tail(row, launch.sessionId);
    return this.app.entry(row.id)!;
  }

  private resume(entry: Entry) {
    const row = this.store.getThread(entry.id);
    if (!row?.native_session_id) return;
    const launch = (this.o.launcher ?? buildInteractive)(row.agent, { cwd: row.cwd, project: this.project, threadId: row.id, resumeId: row.native_session_id, model: this.o.models?.[row.agent] });
    const host = this.app.attach(entry, { id: row.id, title: row.title, agent: row.agent, file: launch.bin, args: launch.args, cwd: launch.cwd });
    this.store.updateThread(row.id, { state: 'working' });
    this.watchRaw(row.id, host);
    this.tail(row, row.native_session_id);
  }

  private async onSelect(e: Entry) {
    if (!e.host && e.state === 'parked') this.resume(e);
    this.syncCard();
  }

  async handoff(fromId: string, to: AgentId): Promise<Entry | undefined> {
    const from = this.store.getThread(fromId);
    if (!from) return undefined;
    this.tailers.get(fromId)?.poll(); // make sure the store has the latest of the source thread
    const entry = this.newThread({ agent: to, title: `${from.title} → ${to}`, prompt: handoffPrompt(from), parent: from, raw: true });
    this.app.setFlash(`handoff: ${to} is loading "${from.title}" through the Chorus MCP server`);
    return entry;
  }

  /* ---------- tailing, state ---------- */

  private tail(row: ThreadRow, nativeId?: string) {
    this.tailers.get(row.id)?.stop();
    const t = new Tailer({
      store: this.store,
      threadId: row.id,
      agent: row.agent,
      cwd: row.cwd,
      nativeId,
      claimed: this.claimed,
      pollMs: this.o.tailPollMs,
      onUpdate: s => this.onSession(row.id, s),
    });
    this.tailers.set(row.id, t);
    t.start();
  }

  private onSession(id: string, s: Session) {
    if (this.closed) return;
    this.sessions.set(id, s);
    this.nameFromFirstMessage(id, s);
    this.refreshMeta(id, s);
    this.refreshState(id);
    this.store.updateThread(id, { state: s.status === 'working' ? 'working' : 'waiting' });
    this.checkLimit(id);
    this.checkContext(id);
  }

  /** A thread started from the form has no title: it takes the first line of your first message. */
  private nameFromFirstMessage(id: string, s: Session) {
    const t = this.store.getThread(id);
    const first = s.turns.find(x => x.role === 'user')?.text;
    if (!t || !first || !/^(claude|codex|agy) \d+$/.test(t.title)) return;
    const title = first.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 28);
    if (!title) return;
    this.store.updateThread(id, { title });
    const e = this.app.entry(id);
    if (e) e.title = title;
  }

  private refreshState(id: string) {
    const e = this.app.entry(id);
    if (!e) return;
    let st: ItemState | undefined;
    if (e.host?.state === 'ended') st = 'ended';
    else if (this.pending.has(id)) st = 'approval';
    else {
      const s = this.sessions.get(id);
      if (s?.status) st = s.status === 'working' ? 'busy' : 'idle';
      else if (this.sawStart.get(id)) st = 'starting';
    }
    this.app.setState(id, st);
  }

  private onExit(e: Entry) {
    if (this.closed) return;
    this.store.updateThread(e.id, { state: 'ended' });
    this.pending.delete(e.id);
    this.refreshState(e.id);
    this.syncCard();
  }

  private checkLimit(id: string) {
    const u = this.store.getUsage(id);
    const t = this.store.getThread(id);
    if (u?.limitUtilization == null || !t) return;
    if (u.limitUtilization >= 0.9) {
      this.app.notice = `⚠ ${t.title} used ${Math.round(u.limitUtilization * 100)}% of its plan limit: ctrl+space h hands off to another agent`;
    }
    if (u.limitUtilization >= 0.99) void this.limitDialog(id, `${t.agent} reached its plan limit`, undefined);
  }

  /** The mockup's "limit reached" box: the thread is saved, so offer to continue with another agent. */
  private async limitDialog(id: string, title: string, resets: string | undefined) {
    if (this.limitShown.has(id)) return;
    this.limitShown.add(id);
    const t = this.store.getThread(id);
    if (!t) return;
    const turns = this.store.getTurns(id, { limit: 100000 }).length;
    const arts = this.store.listArtifacts(id).length;
    const others = AGENTS.filter(a => a !== t.agent);
    const key = await this.app.alert(
      title.charAt(0).toUpperCase() + title.slice(1),
      [`${resets ? `Resets in ${resets}. ` : ''}This thread is saved:`, `${turns} turns · ${arts} artifact${arts === 1 ? '' : 's'}`],
      [...others.map((a, i) => ({ key: i === 0 ? '\r' : String(i + 1), label: `Continue in a new thread with ${a}` })), { key: 'w', label: 'Not now' }],
    );
    const i = key === undefined || key === 'w' ? -1 : key === '\r' ? 0 : Number(key) - 1;
    if (i >= 0 && others[i]) await this.handoff(id, others[i]);
  }

  /** A handoff thread whose first turn ended without calling get_handoff_context gets a warning and a retry key. */
  private checkContext(id: string) {
    const t = this.store.getThread(id);
    const s = this.sessions.get(id);
    if (!t?.parent_thread_id || !s) return;
    const loaded = this.store.mcpCalls(id).some(m => m.tool === 'get_handoff_context');
    if (loaded) {
      if (this.app.notice.startsWith('⚠ context')) this.app.notice = '';
    } else if (s.status === 'waiting' && s.turns.some(x => x.role === 'assistant')) {
      this.app.notice = `⚠ context not loaded in "${t.title}": ctrl+space r asks it again`;
    }
  }

  /* ---------- approvals ---------- */

  private detect() {
    if (this.closed) return;
    let changed = false;
    for (const e of this.app.entries) {
      if (!e.host || e.host.state !== 'running') continue;
      const found = detectApproval(e.agent as AgentId, e.host.screen.text());
      const had = this.pending.get(e.id);
      if (found && !had) {
        this.pending.set(e.id, found);
        changed = true;
      } else if (!found && had) {
        this.pending.delete(e.id);
        changed = true;
      }
      if (changed) this.refreshState(e.id);
    }
    this.checkQuota();
    this.syncCard(); // also after a switch: the card is only for threads you are not looking at
  }

  /** An agent that ran out of quota says so on its screen: warn and point at the handoff. */
  private checkQuota() {
    for (const e of this.app.entries) {
      if (!e.host || e.host.state !== 'running') continue;
      const hit = detectLimit(e.agent as AgentId, e.host.screen.logicalLines());
      const known = this.limited.get(e.id);
      const text = (resets?: string) => `⚠ ${e.title}: ${e.agent} reached its quota${resets ? ` (resets in ${resets})` : ''}: ctrl+space h continues in another agent`;
      if (hit && (known === undefined || (!known && hit.resets))) {
        // the message may still be drawing: refresh the warning once the reset time shows up
        this.limited.set(e.id, hit.resets ?? '');
        this.app.notice = text(hit.resets);
        if (known === undefined) void this.limitDialog(e.id, `${e.agent} reached its quota`, hit.resets);
      } else if (!hit && known !== undefined) {
        this.limited.delete(e.id);
        if (this.app.notice.startsWith(`⚠ ${e.title}: ${e.agent} reached`)) this.app.notice = '';
      }
    }
  }

  private syncCard() {
    // the card is for threads you are NOT looking at; the active thread shows its own prompt
    const act = this.app.current;
    const other = [...this.pending.entries()].find(([id]) => id !== act?.id);
    if (!other) return this.app.setCard(undefined);
    const [id, p] = other;
    const e = this.app.entry(id)!;
    this.app.setCard({ threadId: id, title: `${e.title} (${e.agent}) asks for approval`, lines: [p.what, p.question] });
  }

  answer(approve: boolean): boolean {
    const act = this.app.current;
    const id = act && this.pending.has(act.id) ? act.id : this.app.currentCard?.threadId ?? [...this.pending.keys()][0];
    const p = id && this.pending.get(id);
    const host = id ? this.app.entry(id)?.host : undefined;
    if (!p || !host) {
      this.app.setFlash('nothing is waiting for approval');
      return false;
    }
    host.write(approve ? p.keys.approve : p.keys.deny);
    this.pending.delete(id!);
    this.refreshState(id!);
    this.syncCard();
    this.app.setFlash(`${approve ? 'approved' : 'denied'}: ${p.what.slice(0, 60)}`);
    return true;
  }

  /* ---------- menu actions and views ---------- */

  private async onAction(a: string) {
    const cur = this.app.current;
    switch (a) {
      case 'new':
        await this.newThreadForm();
        break;
      case 'handoff': {
        if (!cur) return this.app.setFlash('no thread to hand off');
        const i = await this.app.choose(`hand off "${cur.title}" to…`, AGENTS);
        if (i !== undefined) await this.handoff(cur.id, AGENTS[i]);
        break;
      }
      case 'memory':
        return cur ? this.app.showPane(`memory · ${cur.title}`, this.memoryLines(cur.id)) : undefined;
      case 'files':
        return this.app.showPane(cur ? `Artifacts · ${cur.title}` : 'Artifacts', this.artifactLines(cur?.id));
      case 'activity':
      case 'tools':
        return cur ? this.app.showPane(`Activity · ${cur.title}`, this.activityLines(cur.id)) : undefined;
      case 'doctor':
        return this.app.showPane('Doctor', this.doctorLines());
      case 'approve':
        this.answer(true);
        break;
      case 'deny':
        this.answer(false);
        break;
      case 'retry':
        this.retryContext();
        break;
      case 'help':
        this.app.showPane('help', HELP);
        break;
    }
  }

  /** Agent, model, folder: nothing else to decide. The thread is named after your first message. */
  async newThreadForm(preset: { agent?: AgentId; model?: string; folder?: string } = {}): Promise<Entry | undefined> {
    const v = await this.app.form(
      'new thread',
      [
        { kind: 'select', label: 'Agent', options: AGENTS, index: Math.max(0, AGENTS.indexOf(preset.agent ?? 'claude')) },
        { kind: 'select', label: 'Model', options: vals => modelsFor((vals.Agent || 'claude') as AgentId) },
        { kind: 'text', label: 'Folder', value: preset.folder ?? this.project },
      ],
      vals => {
        const dir = path.resolve(vals.Folder.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
        return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? undefined : `${vals.Folder} is not a folder`;
      },
    );
    if (!v) return undefined;
    return this.newThread({ agent: v.Agent as AgentId, model: v.Model, cwd: path.resolve(v.Folder.replace(/^~(?=\/|$)/, process.env.HOME ?? '~')) });
  }

  private retryContext() {
    const cur = this.app.current;
    const t = cur && this.store.getThread(cur.id);
    const parent = t?.parent_thread_id && this.store.getThread(t.parent_thread_id);
    if (!cur?.host || !parent) return this.app.setFlash('this thread has no parent to load');
    cur.host.write(handoffPrompt(parent));
    setTimeout(() => cur.host?.write('\r'), 500);
    this.app.notice = '';
    this.app.setFlash('asked again to call get_handoff_context');
  }

  /* ---------- status bar data, home, doctor, activity, artifacts ---------- */

  /** What the status bar shows for a thread: model, plan usage, artifacts, where it came from. */
  private refreshMeta(id: string, s?: Session) {
    const e = this.app.entry(id);
    const t = this.store.getThread(id);
    if (!e || !t) return;
    const u = this.store.getUsage(id);
    const parent = t.parent_thread_id ? this.store.getThread(t.parent_thread_id) : undefined;
    const arts = this.store.listArtifacts(id);
    const before = e.meta?.artifacts ?? 0;
    e.meta = {
      model: t.model ?? s?.model ?? undefined,
      usage: u?.limitUtilization != null ? u.limitUtilization * 100 : undefined,
      artifacts: arts.length,
      from: parent?.agent,
      toast: e.meta?.toast,
    };
    if (arts.length > before && before >= 0 && arts.length) {
      const last = arts[arts.length - 1];
      e.meta.toast = `+ ${last.path}`;
      setTimeout(() => {
        if (e.meta) e.meta.toast = undefined;
        this.app.schedule();
      }, 6000);
    }
    this.app.schedule();
  }

  private async probeAgents() {
    const run = (cmd: string, args: string[]) =>
      new Promise<string>(resolve => {
        let out = '';
        try {
          const c = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          const t = setTimeout(() => c.kill(), 15000);
          c.stdout.on('data', d => (out += d));
          c.stderr.on('data', d => (out += d));
          c.on('close', () => (clearTimeout(t), resolve(out)));
          c.on('error', () => (clearTimeout(t), resolve('')));
        } catch {
          resolve('');
        }
      });
    await Promise.all(
      AGENTS.map(async a => {
        const v = (await run(a, ['--version'])).match(/\d+\.\d+\.\d+/)?.[0];
        if (!v) return void this.agentInfo.set(a, { ok: false });
        let login = 'installed';
        let ok = true;
        if (a === 'claude') {
          try {
            ok = JSON.parse(await run('claude', ['auth', 'status'])).loggedIn === true;
          } catch {
            ok = true;
          }
          login = ok ? 'logged in' : 'not logged in (claude auth login)';
        } else if (a === 'codex') {
          ok = /logged in/i.test(await run('codex', ['login', 'status']));
          login = ok ? 'logged in' : 'not logged in (codex login)';
        }
        this.agentInfo.set(a, { version: v, login, ok });
        this.app.schedule();
      }),
    );
  }

  private ago(iso: string): string {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  homeData(): Omit<HomeView, 'selected'> {
    const stateText = (e: import('./app.ts').Entry) => {
      const st = e.state ?? (!e.host ? 'parked' : e.host.state === 'ended' ? 'ended' : e.host.busy() ? 'busy' : 'idle');
      return { busy: 'working', idle: 'waiting for you', approval: 'needs approval', ended: 'ended', parked: 'parked', starting: 'starting', limit: 'limit reached' }[st];
    };
    return {
      project: this.project.replace(process.env.HOME ?? '\0', '~'),
      agents: AGENTS.map(a => {
        const i = this.agentInfo.get(a);
        return { name: a, version: i?.version, ok: i ? i.ok : true, note: i ? undefined : 'checking…' };
      }),
      threads: this.app.entries.map(e => {
        const row = this.store.getThread(e.id);
        return { id: e.id, title: e.title, agent: e.agent, state: stateText(e), age: row ? this.ago(row.updated) : '', artifacts: this.store.listArtifacts(e.id).length, child: !!e.parentId };
      }),
    };
  }

  doctorLines(): RichLine[] {
    const out: RichLine[] = [];
    let warnings = 0;
    for (const a of AGENTS) {
      const i = this.agentInfo.get(a);
      const home = a === 'claude' ? '~/.claude/projects' : a === 'codex' ? '~/.codex/sessions' : '~/.gemini/antigravity-cli';
      const w = versionWarning(a, i?.version);
      if (w) warnings++;
      out.push([
        [a.padEnd(7), agentStyle(a)],
        [(i?.version ?? '—').padEnd(9)],
        [`${i ? (i.ok ? '✓ ' : '✗ ') + (i.login ?? 'not installed') : 'checking…'}`.padEnd(30), i ? (i.ok ? T.ok : T.err) : T.dim],
        [home.padEnd(30), T.dim],
        [w ? 'newer than verified' : `verified ${VERIFIED_VERSION[a]}`, w ? T.warn : T.ok],
      ] as Seg[]);
    }
    out.push('');
    const n = this.store.listThreads().length;
    out.push([['store   ', T.dim], [`.chorus/chorus.db · ${n} thread${n === 1 ? '' : 's'}`]] as Seg[]);
    if (process.env.CLAUDE_CODE_SESSION_ID) out.push([['env     ', T.dim], ['CLAUDE_CODE_SESSION_ID is set → removed when starting agents', T.warn]] as Seg[]);
    const notes = AGENTS.map(a => versionWarning(a, this.agentInfo.get(a)?.version)).filter((w): w is string => !!w);
    if (notes.length) out.push('', [[`${notes.length} warning${notes.length === 1 ? '' : 's'}`, T.warn]] as Seg[], ...notes.map(w => [[`  ${w}`]] as Seg[]));
    return out;
  }

  artifactLines(threadId?: string): RichLine[] {
    const rows = this.store.listArtifacts(threadId);
    const out: RichLine[] = [];
    if (!rows.length) out.push([['No artifacts yet. Files the agents write into the thread artifacts folder show up here.', T.dim]] as Seg[]);
    else {
      out.push([['NAME'.padEnd(34) + 'VER   BY       UPDATED', T.dim]] as Seg[]);
      const versions = (tid: string, p: string) => (this.store.db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE thread_id=? AND path=?').get(tid, p) as { n: number }).n;
      rows.forEach((a, i) => {
        const t = this.store.getThread(a.thread_id);
        out.push([[i === 0 ? '▸ ' : '  ', T.chorus], [a.path.padEnd(32)], [`v${versions(a.thread_id, a.path)}`.padEnd(6)], [(t?.agent ?? '').padEnd(9), agentStyle(t?.agent ?? '')], [this.ago(a.ts), T.dim]] as Seg[]);
      });
      out.push('', [['Path     ', T.dim], [rows[0].abs]] as Seg[]);
    }
    const touched = new Set<string>();
    for (const t of this.store.listThreads()) if (!threadId || t.id === threadId) for (const c of this.store.getToolCalls(t.id)) if (/^(Write|Edit|write_to_file|replace_file_content|apply_patch)$/.test(c.tool) && c.target) touched.add(c.target);
    out.push('', [['Files written by tools', T.dim]] as Seg[], ...(touched.size ? [...touched].slice(0, 30).map(f => `  ${f}`) : [[['  (none)', T.dim]] as Seg[]]));
    return out;
  }

  activityLines(id: string): RichLine[] {
    const t = this.store.getThread(id)!;
    const u = this.store.getUsage(id);
    const turns = this.store.getTurns(id, { limit: 100000 });
    const clock = (seq: number) => {
      const ts = [...turns].reverse().find(x => x.seq <= seq && x.ts)?.ts;
      return ts ? new Date(ts).toTimeString().slice(0, 8) : '--:--:--';
    };
    const out: RichLine[] = [
      [[`${t.title}`, T.chorus], [`   in ${u?.inputTokens ?? 0}  out ${u?.outputTokens ?? 0} tokens${u?.costUsd != null ? ` · $${u.costUsd.toFixed(2)}` : ''}${u?.limitUtilization != null ? ` · plan ${Math.round(u.limitUtilization * 100)}%` : ''}`, T.dim]] as Seg[],
      '',
    ];
    for (const c of this.store.getToolCalls(id)) {
      out.push([[clock(c.turnSeq) + '  ', T.dim], [t.agent.padEnd(7), agentStyle(t.agent)], ['tool   '], [`${c.tool} ${c.target}`.slice(0, 46).padEnd(48)], [c.status === 'ok' ? 'ok' : c.status === 'failed' ? 'failed' : '…', c.status === 'ok' ? T.ok : c.status === 'failed' ? T.err : T.dim]] as Seg[]);
    }
    for (const m of this.store.mcpCalls(id)) out.push([[new Date(m.ts).toTimeString().slice(0, 8) + '  ', T.dim], [t.agent.padEnd(7), agentStyle(t.agent)], ['mcp    '], [`chorus.${m.tool}`], ['  ok', T.ok]] as Seg[]);
    for (const a of this.store.listArtifacts(id)) out.push([[new Date(a.ts).toTimeString().slice(0, 8) + '  ', T.dim], [t.agent.padEnd(7), agentStyle(t.agent)], ['file   '], [`${a.path} v1`]] as Seg[]);
    for (const c of this.store.listThreads().filter(x => x.parent_thread_id === id)) out.push('', [[`──── continued in "${c.title}" with ${c.agent} ────`, T.chorus]] as Seg[]);
    if (out.length === 2) out.push([['Nothing recorded yet.', T.dim]] as Seg[]);
    return out;
  }

  memoryLines(id: string): string[] {
    const t = this.store.getThread(id)!;
    const u = this.store.getUsage(id);
    const head = [`what get_handoff_context returns for "${t.title}":`, ''];
    const body = buildHandoff(this.store, t).text.split('\n');
    const foot = u ? ['', `usage: ${u.inputTokens} in / ${u.outputTokens} out${u.costUsd != null ? ` · $${u.costUsd.toFixed(4)}` : ''}${u.limitUtilization != null ? ` · plan ${Math.round(u.limitUtilization * 100)}%` : ''}`] : [];
    return [...head, ...body, ...foot];
  }

  toolLines(id: string): string[] {
    const calls = this.store.getToolCalls(id);
    if (!calls.length) return ['no tool calls recorded yet'];
    return calls.map(c => `${c.status === 'ok' ? '✓' : c.status === 'failed' ? '✗' : '…'} ${c.tool.padEnd(10)} ${c.target.slice(0, 70)}${c.result ? `  → ${c.result.slice(0, 60)}` : ''}`);
  }

  fileLines(): string[] {
    const rows = this.store.listArtifacts();
    const lines = rows.length ? rows.map(a => `${a.thread_id}  ${path.relative(this.project, a.abs)}  (${a.version})`) : ['no artifacts yet'];
    const touched = new Set<string>();
    for (const t of this.store.listThreads()) for (const c of this.store.getToolCalls(t.id)) if (/^(Write|Edit|write_to_file|replace_file_content|apply_patch)$/.test(c.tool) && c.target) touched.add(c.target);
    return ['artifacts:', ...lines, '', 'files written by tools:', ...(touched.size ? [...touched] : ['(none)'])];
  }

  /* ---------- raw capture ---------- */

  private watchRaw(id: string, host: import('./thread-host.ts').ThreadHost) {
    const dir = path.join(this.store.threadDir(id), 'raw');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'pty.log');
    host.on('data', (d: string) => {
      try {
        fs.appendFileSync(file, d);
        if (fs.statSync(file).size > RAW_CAP) {
          const buf = fs.readFileSync(file);
          fs.writeFileSync(file, buf.subarray(buf.length - RAW_CAP / 2));
        }
      } catch {
        /* capture is best effort */
      }
    });
  }
}

const HELP = [
  'Chorus keeps your agents side by side. Everything goes through the menu key, ctrl+space:',
  '',
  '  ctrl+space  1-9     switch to thread N',
  '  ctrl+space  n       new thread (pick claude, codex or agy)',
  '  ctrl+space  h       hand off the current thread to another agent',
  '  ctrl+space  m       memory: what the next agent will read',
  '  ctrl+space  f       files and artifacts',
  '  ctrl+space  t       tool calls of this thread',
  '  ctrl+space  y / x   approve / deny the request a background thread is waiting on',
  '  ctrl+space  r       ask a handoff thread to load its context again',
  '  ctrl+space  b       hide or show the sidebar',
  '  ctrl+space  q       quit (twice while threads run)',
  '  ctrl+space  ctrl+space   send ctrl+space to the agent',
  '',
  'Sidebar dots: ● working   ○ waiting for you   ! needs approval   … starting   ◌ parked (select to resume)   ✕ ended',
];
