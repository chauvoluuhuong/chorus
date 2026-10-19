// Controller: ties the app shell to the store, launchers, tailers and approval detection (P4.2–P4.7).
import fs from 'node:fs';
import path from 'node:path';
import { buildHandoff, handoffPrompt } from '../core/handoff.ts';
import { buildInteractive, SKIP_FLAG, type InteractiveOpts, type Launch } from '../core/launch.ts';
import { disabledSkills, findNativeSkills, importSkill, listSkills, setSkillEnabled, syncSkills, sourceDir } from '../core/skills.ts';
import type { Store, ThreadRow } from '../core/store.ts';
import type { AgentId, Session } from '../core/types.ts';
import { App, projectName, type Entry } from './app.ts';
import { detectApproval, type PendingApproval } from './approval.ts';
import { detectLimit } from './limits.ts';
import { effortsFor, loadAgyModels, modelsFor } from './models.ts';
import type { ItemState } from './compositor.ts';
import { Tailer } from './tailer.ts';
import { spawn } from 'node:child_process';
import { BTN, LINK, T, agentStyle, type PaneLine, type RichLine, type Seg } from './compositor.ts';
import { riskOf } from './risk.ts';
import { ARTIFACTS_HINT, APPROVALS_HINT, MEMORY_HINT, NEW_CHAT_HINT, SKILLS_HINT, approvalLines, memoryLines as memoryScreenLines, type ApprovalScope, newChatForm, newChatHit, newChatKey, newChatLines, skillLines, type NewChatForm, type NewChatInfo } from './screens.ts';
import { VERIFIED_VERSION, versionWarning } from '../core/adapters/index.ts';
import { PreviewServer } from '../core/preview.ts';
import { defaultOpener, readOpenConfig, writeOpenConfig, type OpenConfig, type Opener } from '../core/opener.ts';
import { traceCmd } from '../cli/commands.ts';

export const AGENTS: AgentId[] = ['claude', 'codex', 'agy'];
const ACTIVITY_KINDS = ['all', 'tool', 'mcp', 'approval', 'file', 'usage', 'error'] as const;
const join2 = (...p: string[]) => p.filter(Boolean).join(';');
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
  /** how files and links are opened for the user (tests replace it) */
  opener?: Opener;
}

export class Controller {
  readonly app: App;
  readonly store: Store;
  readonly project: string;
  private o: ControllerOpts;
  private tailers = new Map<string, Tailer>();
  private claimed = new Set<string>();
  private pending = new Map<string, PendingApproval>();
  private pendingSince = new Map<string, number>();
  private modelCache = new Map<AgentId, string[]>();
  private limited = new Map<string, string>();
  private limitShown = new Set<string>();
  preview: PreviewServer | undefined;
  previewOpened = '';
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
    this.app.waitingProvider = () => this.pending.size;
    void this.probeAgents();
  }

  stop() {
    this.closed = true;
    this.preview?.close();
    clearInterval(this.detectTimer);
    for (const t of this.tailers.values()) t.stop();
  }

  /* ---------- threads ---------- */

  /** Threads from earlier runs appear in the sidebar without a process; selecting one resumes it. */
  restore() {
    // parents first, so a thread that continues another is listed right under it
    const rows = this.store.listThreads().reverse().filter(r => r.native_session_id);
    for (const row of [...rows.filter(r => !r.parent_thread_id), ...rows.filter(r => r.parent_thread_id)]) {
      this.app.addParked({ id: row.id, title: row.title, agent: row.agent, cwd: row.cwd, parentId: row.parent_thread_id ?? undefined, meta: row.skip_permissions ? { skip: true } : undefined });
      this.refreshMeta(row.id);
    }
  }

  /**
   * The first prompt is typed exactly as given: where artifacts go is told through the agent's instructions (launch.ts), not the prompt.
   * A chat belongs to the folder it works in: its artifacts live in <folder>/.chorus (Codex's sandbox only writes inside its folder).
   */
  newThread(o: { agent: AgentId; title?: string; prompt?: string; parent?: ThreadRow; model?: string; effort?: string; cwd?: string; skipPermissions?: boolean }): Entry {
    const cwd = o.cwd ?? this.project;
    const model = o.model && o.model !== 'default' ? o.model : this.o.models?.[o.agent];
    const effort = o.effort && o.effort !== 'default' ? o.effort : undefined; // "default" means: no flag
    if (fs.existsSync(sourceDir(this.project))) syncSkills(this.project, { agents: [o.agent], into: cwd });
    const n = this.store.listThreads().filter(t => t.agent === o.agent).length + 1;
    const row = this.store.createThread({ title: o.title ?? `${o.agent} ${n}`, agent: o.agent, cwd, project: cwd, model: model ?? null, parent_thread_id: o.parent?.id, state: 'working', skip_permissions: o.skipPermissions ? 1 : 0, effort: effort ?? null });
    const prompt = o.prompt;
    const launch = (this.o.launcher ?? buildInteractive)(o.agent, { prompt, cwd, project: cwd, home: this.store.shared ? this.store.root : undefined, threadId: row.id, model, effort, skipPermissions: o.skipPermissions });
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
    const launch = (this.o.launcher ?? buildInteractive)(row.agent, { cwd: row.cwd, project: row.project ?? this.project, home: this.store.shared ? this.store.root : undefined, threadId: row.id, resumeId: row.native_session_id, model: this.o.models?.[row.agent], effort: row.effort ?? undefined, skipPermissions: !!row.skip_permissions });
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
    const entry = this.newThread({ agent: to, title: `${from.title} → ${to}`, prompt: handoffPrompt(from), parent: from, cwd: from.cwd });
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
    const line = first.split('\n')[0].replace(/\s+/g, ' ').trim();
    const title = line.length > 28 ? line.slice(0, 27) + '…' : line;
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
    this.pendingSince.delete(e.id);
    this.refreshState(e.id);
    this.syncCard();
  }

  private checkLimit(id: string) {
    const u = this.store.getUsage(id);
    const t = this.store.getThread(id);
    if (u?.limitUtilization == null || !t) return;
    if (u.limitUtilization >= 0.9) {
      this.app.notice = `⚠ ${t.title} used ${Math.round(u.limitUtilization * 100)}% of its plan limit: ${this.app.menuLabel} h hands off to another agent`;
    }
    if (u.limitUtilization >= 0.99) void this.limitDialog(id, `${t.agent} reached its plan limit`, undefined);
  }

  /** The mockup's "limit reached" box: the chat is saved, so offer to continue with another agent. */
  private async limitDialog(id: string, title: string, resets: string | undefined) {
    if (this.limitShown.has(id)) return;
    this.limitShown.add(id);
    const t = this.store.getThread(id);
    if (!t) return;
    const turns = this.store.getTurns(id, { limit: 100000 }).length;
    const arts = this.store.listArtifacts(id).length;
    const files = new Set(this.store.getToolCalls(id).filter(c => /^(Write|Edit|write_to_file|replace_file_content|apply_patch|file_change)$/.test(c.tool) && c.target).map(c => c.target)).size;
    const others = AGENTS.filter(a => a !== t.agent);
    const q = this.quotaInfo();
    const key = await this.app.alert(
      title.charAt(0).toUpperCase() + title.slice(1),
      [`${resets ? `Resets in ${resets}. ` : ''}This chat is saved:`, `${turns} turns · ${arts} artifact${arts === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'} changed`],
      [...others.map((a, i) => ({ key: i === 0 ? '\r' : String(i + 1), label: `Continue in a new chat with ${a}${q[a] ? `  (${q[a]!.text})` : ''}` })), { key: 'w', label: 'Wait for the reset' }],
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
      this.app.notice = `⚠ context not loaded in "${t.title}": ${this.app.menuLabel} r asks it again`;
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
        this.pendingSince.set(e.id, Date.now());
        // a request on a chat you are not looking at: one-line flash and the bell, on top of the badge and the sidebar !
        if (e.id !== this.app.current?.id || this.app.paneId) {
          this.app.setFlash(`${e.title} needs approval`);
          this.app.bell();
        }
        changed = true;
      } else if (!found && had) {
        this.pending.delete(e.id);
        this.pendingSince.delete(e.id);
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
      const text = (resets?: string) => `⚠ ${e.title}: ${e.agent} reached its quota${resets ? ` (resets in ${resets})` : ''}: ${this.app.menuLabel} h continues in another agent`;
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

  /** Answers the request of one chat (default: the one you are looking at, else the one on the card, else the first waiting). */
  answer(approve: boolean, forId?: string): boolean {
    const act = this.app.current;
    const id = forId ?? (act && this.pending.has(act.id) ? act.id : this.app.currentCard?.threadId ?? [...this.pending.keys()][0]);
    const p = id && this.pending.get(id);
    const host = id ? this.app.entry(id)?.host : undefined;
    if (!p || !host) {
      this.app.setFlash('nothing is waiting for approval');
      return false;
    }
    host.write(approve ? p.keys.approve : p.keys.deny);
    this.pending.delete(id!);
    this.pendingSince.delete(id!);
    this.store.logApproval(id!, p.what, approve ? 'approved' : 'denied');
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
        this.newChatScreen();
        break;
      case 'handoff': {
        if (!cur) return this.app.setFlash('no chat to hand off');
        // the other agents first, then the same one for a fresh session; each with what is left of its plan
        const order = [...AGENTS.filter(a => a !== cur.agent), cur.agent as AgentId];
        const q = this.quotaInfo();
        const label = (a: AgentId) => `${a.padEnd(8)} ${a === cur.agent ? 'fresh session' : q[a] ? (q[a]!.text.startsWith('5h') ? `${q[a]!.text} used` : q[a]!.text) : 'quota ok'}`;
        const i = await this.app.choose(`Continue "${cur.title}" in a new chat`, order.map(label));
        if (i !== undefined) await this.handoff(cur.id, order[i]);
        break;
      }
      case 'memory':
        return this.memoryView();
      case 'skills':
        return this.skillsView();
      case 'approvals':
        return this.approvalsView();
      case 'files':
        return this.artifactsView(cur?.id, cur?.title);
      case 'activity':
      case 'tools':
        return cur ? this.activityView(cur.id, cur.title) : this.app.setFlash('open a chat first');
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
        this.app.showPane('help', helpLines(this.app.menuLabel));
        break;
    }
  }

  /* ---------- New chat ---------- */

  /** Never blocks: agy's list is asked for in the background and the New chat screen redraws when it arrives. */
  private modelList(agent: AgentId): string[] {
    let m = this.modelCache.get(agent);
    if (!m) {
      m = modelsFor(agent);
      if (agent === 'agy' && m.length <= 1) {
        void loadAgyModels().then(list => {
          if (!list.length || this.closed) return;
          this.modelCache.set('agy', ['default', ...list]);
          this.onModelsLoaded?.();
        });
      } else this.modelCache.set(agent, m);
    }
    return m;
  }

  /** set by the New chat screen while it is open, to redraw when a model list arrives */
  private onModelsLoaded: (() => void) | undefined;

  /** Plan text under each agent on the New chat screen, from the latest usage reading we stored. */
  private quotaInfo(): NewChatInfo['quota'] {
    const out: NewChatInfo['quota'] = {};
    const rows = this.store.db
      .prepare('SELECT t.agent AS agent, u.limit_utilization AS u FROM usage u JOIN threads t ON t.id = u.thread_id WHERE u.limit_utilization IS NOT NULL ORDER BY u.updated DESC')
      .all() as { agent: AgentId; u: number }[];
    for (const r of rows) {
      if (out[r.agent]) continue;
      const pct = Math.round(r.u * 100);
      out[r.agent] = { text: `5h ${pct}%`, level: pct >= 90 ? 'err' : pct >= 75 ? 'warn' : 'ok' };
    }
    return out;
  }

  private recentFolders(except: string): string[] {
    const seen: string[] = [];
    for (const t of this.store.listThreads()) if (t.cwd !== except && !seen.includes(t.cwd) && fs.existsSync(t.cwd)) seen.push(t.cwd);
    return seen.slice(0, 3);
  }

  /**
   * The New chat screen (also the first screen): agent, model, project folder, skip-permissions. Enter alone starts with the
   * defaults. The chat is named after your first message; you type it in the agent itself.
   */
  newChatScreen(preset: { agent?: AgentId; model?: string; effort?: string; folder?: string; skip?: boolean } = {}) {
    // the project you are in: the folder of the chat in front, else the folder chorus was started in (a parked chat does not count)
    const cur = this.app.current;
    const folder = preset.folder ?? (cur?.host ? cur.cwd : this.project);
    const f: NewChatForm = newChatForm({ agent: preset.agent, model: preset.model, effort: preset.effort, folder, models: a => this.modelList(a), efforts: (a, m) => effortsFor(a, m) });
    f.skip = !!preset.skip;
    const info = (): NewChatInfo => ({ models: a => this.modelList(a), efforts: (a, m) => effortsFor(a, m), quota: this.quotaInfo(), recent: this.recentFolders(f.folder), skipFlag: SKIP_FLAG });
    const redraw = () => this.app.updatePane(newChatLines(f, info()));
    this.onModelsLoaded = () => {
      if (this.app.paneId === 'new') redraw();
    };
    const finish = (r: 'start' | 'cancel' | undefined) => {
      if (r === 'cancel') return this.app.closePane();
      if (r !== 'start') return redraw();
      const dir = path.resolve(f.folder.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
      if (!(fs.existsSync(dir) && fs.statSync(dir).isDirectory())) {
        f.error = `${f.folder} is not a folder`;
        return redraw();
      }
      const agent = AGENTS[f.agent];
      const model = this.modelList(agent)[f.model];
      const effort = effortsFor(agent, model)[f.effort];
      this.app.closePane(false);
      this.newThread({ agent, model, effort, cwd: dir, skipPermissions: f.skip });
    };
    this.app.showPane('New chat', newChatLines(f, info()), {
      id: 'new',
      bare: true,
      hint: NEW_CHAT_HINT,
      // <project> / New chat; with a chat in front the app puts that chat's project first
      crumb: cur ? ['New chat'] : [projectName(folder), 'New chat'],
      onKey: key => {
        finish(newChatKey(f, key, info()));
        return true;
      },
      onHit: id => finish(newChatHit(f, id, info())),
    });
  }

  /* ---------- Approvals inbox ---------- */

  /** What waits for you; scope "this" keeps the chats of the project you are in (the chat in front, else where chorus started). */
  private approvalItems(scope: ApprovalScope = 'all') {
    const cwd = this.app.current?.cwd ?? this.project;
    return [...this.pending.entries()]
      .map(([id, p]) => {
        const e = this.app.entry(id);
        return e && { id, cwd: e.cwd, title: e.title, agent: e.agent, waiting: (Date.now() - (this.pendingSince.get(id) ?? Date.now())) / 1000, what: p.what, risk: riskOf(p.what, e.cwd) };
      })
      .filter((x): x is NonNullable<typeof x> => !!x && (scope === 'all' || x.cwd === cwd));
  }

  /** Today's answers ("Decided today"). */
  private decidedItems() {
    const today = new Date().toDateString();
    return this.store.approvalsLog(50).filter(r => new Date(r.ts).toDateString() === today).slice(0, 6).map(r => ({ decision: r.decision, what: r.what, agent: this.store.getThread(r.thread_id)?.agent ?? '', time: new Date(r.ts).toTimeString().slice(0, 5) }));
  }

  /** One list of everything waiting on you, from every chat: y / x answer without switching, ⏎ opens the chat. */
  approvalsView() {
    const st = { sel: 0, scope: 'all' as ApprovalScope };
    const draw = () => {
      const items = this.approvalItems(st.scope);
      st.sel = Math.min(st.sel, Math.max(0, items.length - 1));
      this.app.updatePane(approvalLines(items, st.sel, this.decidedItems(), st.scope));
      return items;
    };
    const open = (id?: string) => {
      const at = id ? this.app.entries.findIndex(e => e.id === id) : -1;
      if (at >= 0) this.app.select(at);
    };
    const act = (kind: 'approve' | 'deny' | 'open', id?: string) => {
      const items = this.approvalItems(st.scope);
      const target = id ?? items[st.sel]?.id;
      if (kind === 'open') return open(target);
      if (target) this.answer(kind === 'approve', target);
      draw();
    };
    this.app.showPane('Approvals', approvalLines(this.approvalItems(), 0, this.decidedItems(), 'all'), {
      id: 'approvals',
      bare: true,
      hint: APPROVALS_HINT,
      crumb: ['Approvals'],
      onKey: key => {
        const n = this.approvalItems(st.scope).length;
        if (key === '\x1b[A' || key === 'k') st.sel = Math.max(0, st.sel - 1);
        else if (key === '\x1b[B' || key === 'j') st.sel = Math.min(Math.max(0, n - 1), st.sel + 1);
        else if (key === '\t') st.scope = st.scope === 'all' ? 'this' : 'all';
        else if (key === 'y') return void act('approve'), true;
        else if (key === 'x') return void act('deny'), true;
        else if (key === '\r' || key === '\n') return void act('open'), true;
        else return false;
        draw();
        return true;
      },
      onHit: id => {
        const [kind, tid] = [id.split(':')[0], id.split(':').slice(1).join(':')];
        if (kind === 'row') {
          st.sel = Math.max(0, this.approvalItems(st.scope).findIndex(i => i.id === tid));
          draw();
        } else if (id === 'scope' || id === 'scope:this' || id === 'scope:all') {
          st.scope = id === 'scope' ? (st.scope === 'all' ? 'this' : 'all') : (id.slice(6) as ApprovalScope);
          draw();
        } else if (kind === 'approve' || kind === 'deny' || kind === 'open') act(kind, tid || undefined);
      },
    });
    // the inbox follows the live state while it is open
    const timer = setInterval(() => {
      if (this.closed || this.app.paneId !== 'approvals') return clearInterval(timer);
      draw();
    }, 1000);
    timer.unref();
  }

  /* ---------- Memory (shared by all projects) ---------- */

  memoryItems(query = '') {
    const rows = this.store.listThreads();
    const byId = new Map(rows.map(r => [r.id, r]));
    // parents first, a continued chat right under its parent
    const roots = rows.filter(r => !r.parent_thread_id || !byId.has(r.parent_thread_id));
    const ordered = roots.flatMap(r => [r, ...rows.filter(c => c.parent_thread_id === r.id)]);
    const all = ordered.map(r => {
      const turns = this.store.getTurns(r.id, { limit: 100000 });
      const asked = turns.find(t => t.role === 'user')?.text ?? (r.parent_thread_id ? `(continued from ${byId.get(r.parent_thread_id)?.title ?? 'another chat'})` : '');
      const last = [...turns].reverse().find(t => t.role === 'assistant')?.text ?? '';
      const files = new Set<string>();
      for (const c of this.store.getToolCalls(r.id)) if (/^(Write|Edit|write_to_file|replace_file_content|apply_patch|file_change)$/.test(c.tool) && c.target) files.add(path.relative(r.cwd, c.target) || c.target);
      return { id: r.id, title: r.title, child: !!r.parent_thread_id && byId.has(r.parent_thread_id), project: path.basename(r.project ?? r.cwd), agent: r.agent, turns: turns.length, ago: this.ago(r.updated), asked: asked.replace(/\s+/g, ' '), last: last.replace(/\s+/g, ' '), files: [...files].slice(0, 6).join(', ') };
    });
    // search: every word must appear somewhere in the row (title, project, agent, what it asked, its last message, its files)
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? all.filter(m => words.every(w => `${m.title} ${m.project} ${m.agent} ${m.asked} ${m.last} ${m.files}`.toLowerCase().includes(w))) : all;
  }

  /** Every chat Chorus has recorded, in any project. ⏎ opens it (parked chats resume), h continues it with another agent, d shows what an agent would read. */
  memoryView() {
    const st = { sel: 0, query: '', typing: false };
    const where = () => (this.store.shared ? this.store.root.replace(process.env.HOME ?? '\0', '~') + '/chorus.db' : '.chorus/chorus.db (this project)');
    const draw = () => {
      const items = this.memoryItems(st.query);
      st.sel = Math.min(st.sel, Math.max(0, items.length - 1));
      this.app.updatePane(memoryScreenLines(items, st.sel, where(), { query: st.query, typing: st.typing }));
      return items;
    };
    const open = async (id?: string) => {
      if (!id) return;
      const at = this.app.entries.findIndex(e => e.id === id);
      if (at >= 0) return this.app.select(at);
      const row = this.store.getThread(id);
      if (!row) return;
      // a chat from another project that this run has not listed yet: add it parked and resume it
      this.app.addParked({ id: row.id, title: row.title, agent: row.agent, cwd: row.cwd, parentId: row.parent_thread_id ?? undefined });
      this.app.select(this.app.entries.findIndex(e => e.id === id));
    };
    const handoffFrom = async (id?: string) => {
      const row = id && this.store.getThread(id);
      if (!row) return;
      const i = await this.app.choose(`continue "${row.title}" with…`, AGENTS.filter(a => a !== row.agent));
      if (i !== undefined) {
        this.app.closePane(false);
        await this.handoff(row.id, AGENTS.filter(a => a !== row.agent)[i]);
      }
    };
    this.app.showPane('Memory', memoryScreenLines(this.memoryItems(), 0, where()), {
      id: 'memory',
      bare: true,
      hint: MEMORY_HINT,
      crumb: ['Memory'],
      onKey: key => {
        if (st.typing) {
          // typing a search: Enter keeps the filter, Esc drops it
          if (key === '\x1b') (st.typing = false), (st.query = '');
          else if (key === '\r' || key === '\n') st.typing = false;
          else if (key === '\x7f' || key === '\b') st.query = st.query.slice(0, -1);
          else if (key === '\x15') st.query = '';
          else if (key.length >= 1 && key >= ' ' && !key.startsWith('\x1b')) st.query += key;
          st.sel = 0;
          draw();
          return true;
        }
        if (key === '/') {
          st.typing = true;
          draw();
          return true;
        }
        if (key === '\x1b' && st.query) {
          st.query = '';
          draw();
          return true;
        }
        const items = this.memoryItems(st.query);
        const cur = items[st.sel]?.id;
        if (key === '\x1b[A' || key === 'k') st.sel = Math.max(0, st.sel - 1);
        else if (key === '\x1b[B' || key === 'j') st.sel = Math.min(Math.max(0, items.length - 1), st.sel + 1);
        else if (key === '\r' || key === '\n') return void open(cur), true;
        else if (key === 'h') return void handoffFrom(cur), true;
        else if (key === 'd' && cur) return void this.app.showPane(`What an agent reads · ${items[st.sel].title}`, this.memoryLines(cur), { id: 'memory-digest', crumb: ['Memory', 'digest'], onClose: () => this.memoryView() }), true;
        else return false;
        draw();
        return true;
      },
      onHit: id => {
        const tid = id.split(':').slice(1).join(':');
        if (id.startsWith('row:')) {
          const items = this.memoryItems(st.query);
          const at = items.findIndex(i => i.id === tid);
          if (at === st.sel) void open(tid);
          else {
            st.sel = Math.max(0, at);
            draw();
          }
        } else if (id === 'search') {
          st.typing = true;
          draw();
        } else if (id === 'open') void open(this.memoryItems(st.query)[st.sel]?.id);
        else if (id === 'handoff') void handoffFrom(this.memoryItems(st.query)[st.sel]?.id);
      },
    });
  }

  /* ---------- Skills ---------- */

  skillsView() {
    const st = { sel: 0 };
    const items = () => listSkills(this.project).map(s => ({ folder: path.basename(s.dir), name: s.name, description: s.description, on: !disabledSkills(this.project).includes(path.basename(s.dir)) }));
    const found = () => findNativeSkills(this.project).map(f => ({ name: f.name, from: f.from, agent: f.agent, dir: f.dir }));
    const where = () => '.chorus/skills (this project; one global library is TD-1)';
    const draw = () => {
      const n = items().length;
      st.sel = Math.min(st.sel, Math.max(0, n - 1));
      this.app.updatePane(skillLines(items(), found(), st.sel, where()));
    };
    const toggle = (folder?: string) => {
      const s = items().find(i => i.folder === folder) ?? items()[st.sel];
      if (!s) return;
      setSkillEnabled(this.project, s.folder, !s.on);
      if (fs.existsSync(sourceDir(this.project))) syncSkills(this.project);
      this.app.setFlash(`${s.on ? 'Turned off' : 'Turned on'} ${s.name} for claude, codex and agy`);
      draw();
    };
    const edit = async () => {
      const s = listSkills(this.project)[st.sel];
      if (!s) return;
      const r = await (this.o.opener ?? defaultOpener)({ mode: 'default' }, { path: path.join(s.dir, 'SKILL.md') });
      this.app.setFlash(r.ok ? `opened ${s.name}/SKILL.md in your editor` : `could not open it (${r.error}); the file is ${path.join(s.dir, 'SKILL.md')}`);
    };
    const create = async () => {
      const name = await this.app.prompt('New skill', ['A skill is a folder with a SKILL.md every agent can load.', 'Name it with lowercase words and dashes.'], '');
      const slug = (name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!slug) return;
      const dir = path.join(sourceDir(this.project), slug);
      if (fs.existsSync(dir)) return this.app.setFlash(`${slug} already exists`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: Say here when an agent should use this skill.\n---\n\nWrite the instructions here.\n`);
      syncSkills(this.project);
      this.app.setFlash(`created ${slug}: edit it with e`);
      draw();
    };
    const doImport = (dir?: string) => {
      const f = found().find(x => x.dir === dir) ?? found()[0];
      if (!f) return this.app.setFlash('nothing to import');
      try {
        importSkill(this.project, f);
        syncSkills(this.project);
        this.app.setFlash(`Imported ${f.name}: now in the library, seen by all three`);
      } catch (e) {
        this.app.setFlash(String((e as Error).message));
      }
      draw();
    };
    this.app.showPane('Skills', skillLines(items(), found(), 0, where()), {
      id: 'skills',
      bare: true,
      hint: SKILLS_HINT,
      crumb: ['Skills'],
      onKey: key => {
        if (key === '\x1b[A' || key === 'k') st.sel = Math.max(0, st.sel - 1);
        else if (key === '\x1b[B' || key === 'j') st.sel = Math.min(Math.max(0, items().length - 1), st.sel + 1);
        else if (key === '\r' || key === '\n') toggle();
        else if (key === 'i') doImport();
        else if (key === 'e') return void edit(), true;
        else if (key === 'n') return void create(), true;
        else return false;
        draw();
        return true;
      },
      onHit: id => {
        if (id.startsWith('row:')) {
          const folder = id.slice(4);
          const at = items().findIndex(i => i.folder === folder);
          if (at === st.sel) toggle(folder);
          else {
            st.sel = Math.max(0, at);
            draw();
          }
        } else if (id === 'toggle') toggle();
        else if (id === 'edit') void edit();
        else if (id === 'new') void create();
        else if (id === 'import') doImport();
        else if (id.startsWith('import:')) doImport(id.slice(7));
      },
    });
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
      skip: !!t.skip_permissions,
      effort: t.effort ?? undefined,
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
    const dbFile = path.join(this.store.root, 'chorus.db');
    const mb = fs.existsSync(dbFile) ? Math.max(0.1, fs.statSync(dbFile).size / 1048576) : 0;
    out.push([['store   ', T.dim], [`${this.store.shared ? this.store.root.replace(process.env.HOME ?? '\0', '~') : '.chorus'}/chorus.db · ${n} chat${n === 1 ? '' : 's'}${this.store.shared ? ' (all projects)' : ' (this project)'} · ${mb.toFixed(1)} MB`]] as Seg[]);
    const mouse = process.env.CHORUS_MOUSE !== '0';
    out.push([['mouse   ', T.dim], [mouse ? 'on' : 'off', mouse ? T.ok : T.warn], ['  (CHORUS_MOUSE=0 turns it off; hold Shift to select text)', T.dim]] as Seg[]);
    const openCfg = readOpenConfig(this.project);
    out.push([['open    ', T.dim], [openCfg.mode === 'default' ? (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open') : openCfg.mode + (openCfg.command ? ` (${openCfg.command})` : ''), T.ok], [`  (${openCfg.mode === 'default' ? `default for ${process.platform === 'darwin' ? 'macOS' : process.platform}; ` : ''}override in .chorus/open.json)`, T.dim]] as Seg[]);
    if (process.env.CLAUDE_CODE_SESSION_ID) out.push([['env     ', T.dim], ['CLAUDE_CODE_SESSION_ID is set → removed when starting agents', T.warn]] as Seg[]);
    const notes = AGENTS.map(a => versionWarning(a, this.agentInfo.get(a)?.version)).filter((w): w is string => !!w);
    if (notes.length) out.push('', [[`${notes.length} warning${notes.length === 1 ? '' : 's'}`, T.warn]] as Seg[], ...notes.map(w => [[`  ${w}`]] as Seg[]));
    return out;
  }

  /** The Artifacts view: ↑↓ select, ⏎ or a click opens, f shows the folder, p copies the path, v shows versions. */
  artifactsView(threadId: string | undefined, title = '') {
    const st = { sel: 0, versions: false };
    const rows = () => this.store.listArtifacts(threadId);
    const draw = () => {
      st.sel = Math.min(st.sel, Math.max(0, rows().length - 1));
      this.app.updatePane(this.artifactLines(threadId, st.sel, st.versions));
    };
    const open = (mode?: OpenConfig['mode']) => {
      const a = rows()[st.sel];
      if (a) void this.openArtifact(a.thread_id, a.path, mode).then(() => draw());
    };
    this.app.showPane(title ? `Artifacts · ${title}` : 'Artifacts', this.artifactLines(threadId, 0, false), {
      id: 'artifacts',
      hint: ARTIFACTS_HINT,
      crumb: title ? [title, 'Artifacts'] : ['Artifacts'],
      onKey: key => {
        const n = rows().length;
        if (key === '\x1b[A' || key === 'k') st.sel = Math.max(0, st.sel - 1);
        else if (key === '\x1b[B' || key === 'j') st.sel = Math.min(Math.max(0, n - 1), st.sel + 1);
        else if (key === 'v') st.versions = !st.versions;
        else if (key === 'p' && rows()[st.sel]) this.copy(rows()[st.sel].abs);
        else if (key === 'o' || key === '\r' || key === '\n') return void open(), true;
        else if (key === 'f') return void open('folder'), true;
        else return false;
        draw();
        return true;
      },
      onHit: id => {
        if (id.startsWith('row:')) {
          const at = Number(id.slice(4));
          if (at === st.sel) open();
          else {
            st.sel = at;
            draw();
          }
        } else if (id === 'open') open();
        else if (id === 'folder') open('folder');
        else if (id === 'copy' && rows()[st.sel]) this.copy(rows()[st.sel].abs);
        else if (id === 'versions') {
          st.versions = !st.versions;
          draw();
        } else if (id === 'link' && this.preview?.url) open();
      },
    });
  }

  /**
   * Opens an artifact for the user: the served preview link (it reloads while the agent edits) with the system default, or the way
   * this project chose before. When the way fails, the user picks another and it is remembered in <project>/.chorus/open.json.
   */
  async openArtifact(threadId: string, rel: string, via?: OpenConfig['mode']): Promise<void> {
    const url = await this.openPreview(threadId, rel, false);
    const abs = path.join(this.store.artifactsDir(threadId), rel);
    const project = this.store.projectOf(threadId);
    let cfg = via ? { mode: via } : readOpenConfig(project);
    const opener: Opener = this.o.opener ?? (process.env.CHORUS_NO_OPEN === '1' ? async () => ({ ok: true }) : defaultOpener);
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await opener(cfg, { url, path: abs });
      if (r.ok) {
        this.app.setFlash(r.shown ? `${cfg.mode === 'copy' ? 'copied: ' : ''}${r.shown}` : `opened ${rel}`);
        return;
      }
      const k = await this.app.alert(`Couldn't open ${rel}`, [`${r.error ?? 'the open command failed'}.`, 'How do you want to open files?'], [
        { key: '\r', label: 'Copy the link to the clipboard' },
        { key: '2', label: 'Show the folder in the file manager' },
        { key: '3', label: 'Use another command…   e.g. firefox {url}' },
        { key: '4', label: "Just show the link, don't try again" },
      ]);
      if (k === undefined) return;
      if (k === '\r') cfg = { mode: 'copy' };
      else if (k === '2') cfg = { mode: 'folder' };
      else if (k === '4') cfg = { mode: 'show' };
      else {
        const command = await this.app.prompt('Open files with…', ['Use {url} for the preview link and {path} for the file.', 'Example: firefox {url}'], 'firefox {url}');
        if (!command) return;
        cfg = { mode: 'custom', command };
      }
      writeOpenConfig(project, cfg);
    }
  }

  /** Starts the preview server (once) and returns the link of one artifact. `open` also opens it with the project's way (used by `o` in older views and tests). */
  async openPreview(threadId: string, rel: string, open = true): Promise<string> {
    this.preview ??= new PreviewServer(this.store);
    await this.preview.start();
    const url = this.preview.urlFor(threadId, rel);
    this.previewOpened = url;
    if (open && process.env.CHORUS_NO_OPEN !== '1') await (this.o.opener ?? defaultOpener)(readOpenConfig(this.store.projectOf(threadId)), { url, path: path.join(this.store.artifactsDir(threadId), rel) });
    this.app.setFlash(`preview: ${url}`);
    return url;
  }

  private copy(text: string) {
    try {
      const c = process.platform === 'darwin' ? spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] }) : spawn('xclip', ['-selection', 'clipboard'], { stdio: ['pipe', 'ignore', 'ignore'] });
      c.on('error', () => {});
      c.stdin.on('error', () => {});
      c.stdin.end(text);
      this.app.setFlash('path copied');
    } catch {
      this.app.setFlash(text);
    }
  }

  artifactLines(threadId?: string, sel = 0, showVersions = false): PaneLine[] {
    const rows = this.store.listArtifacts(threadId);
    const out: PaneLine[] = [];
    const versionsOf = (tid: string, p: string) => this.store.db.prepare('SELECT version, ts FROM artifacts WHERE thread_id=? AND path=? ORDER BY ts').all(tid, p) as { version: string; ts: string }[];
    if (!rows.length) out.push([['No artifacts yet. Files the agents write into the thread artifacts folder show up here.', T.dim]] as Seg[]);
    else {
      out.push([['NAME'.padEnd(34) + 'VER   BY       UPDATED', T.dim]] as Seg[]);
      rows.forEach((a, i) => {
        const t = this.store.getThread(a.thread_id);
        const n = versionsOf(a.thread_id, a.path).length;
        out.push({ line: [[i === sel ? '▸ ' : '  ', T.chorus], [a.path.padEnd(32)], [`v${n}`.padEnd(6)], [(t?.agent ?? '').padEnd(9), agentStyle(t?.agent ?? '')], [this.ago(a.ts).padEnd(12), T.dim]] as Seg[], hit: `row:${i}`, sel: i === sel });
      });
      const cur = rows[Math.min(sel, rows.length - 1)];
      out.push('');
      out.push([['Link     ', T.dim], this.preview?.url ? [this.preview.urlFor(cur.thread_id, cur.path), LINK, 'link'] : ['press ⏎ to open it in the browser: it reloads while the agent keeps editing', T.dim], ...(this.preview?.url ? ([['   ● live reload', T.ok]] as Seg[]) : [])] as Seg[]);
      out.push([['File     ', T.dim], [cur.abs]] as Seg[]);
      if (showVersions) {
        out.push('', [[`Versions of ${cur.path}`, T.dim]] as Seg[]);
        versionsOf(cur.thread_id, cur.path).forEach((v, i) => out.push([[`  v${i + 1}  `, T.chorus], [v.version + '  '], [this.ago(v.ts), T.dim]] as Seg[]));
      }
    }
    const touched = new Set<string>();
    for (const t of this.store.listThreads()) if (!threadId || t.id === threadId) for (const c of this.store.getToolCalls(t.id)) if (/^(Write|Edit|write_to_file|replace_file_content|apply_patch|file_change)$/.test(c.tool) && c.target) touched.add(c.target);
    out.push('', [['Files written by tools', T.dim]] as Seg[], ...(touched.size ? [...touched].slice(0, 30).map(f => `  ${f}`) : [[['  (none)', T.dim]] as Seg[]]));
    return out;
  }

  /** The Activity view: f cycles the filter, r shows the raw trace next to what was parsed. */
  activityView(id: string, title: string) {
    let k = 0;
    const lines = () => this.activityLines(id, ACTIVITY_KINDS[k]);
    const hint = (): RichLine => [[' f ', BTN, 'filter'], [' filter  '], [' r ', BTN, 'raw'], [' raw trace  '], [' ↑↓ ', BTN], [' scroll  '], [' esc ', BTN, 'back'], [' back']];
    const next = () => {
      k = (k + 1) % ACTIVITY_KINDS.length;
      this.app.updatePane(lines());
    };
    const raw = () => this.app.showPane(`Raw trace · ${title}`, traceCmd(this.store, id).replaceAll(process.env.HOME ?? '\0', '~').split('\n'));
    this.app.showPane(`Activity · ${title}`, lines(), {
      id: 'activity',
      bare: true,
      crumb: [title, 'Activity'],
      hint: hint(),
      onKey: key => {
        if (key === 'f') return void next(), true;
        if (key === 'r') return void raw(), true;
        return false;
      },
      onHit: hit => {
        if (hit === 'filter') next();
        else if (hit === 'raw') raw();
        else if (hit.startsWith('kind:')) {
          k = Math.max(0, ACTIVITY_KINDS.indexOf(hit.slice(5) as (typeof ACTIVITY_KINDS)[number]));
          this.app.updatePane(lines());
        }
      },
    });
  }

  /** One timeline across a chat and the chats continued from it: tool calls, MCP calls, approvals, files, usage, handoffs. */
  activityLines(id: string, filter: (typeof ACTIVITY_KINDS)[number] = 'all'): PaneLine[] {
    const root = this.store.getThread(id)!;
    const family: ThreadRow[] = [root];
    for (let i = 0; i < family.length; i++) for (const c of this.store.listThreads()) if (c.parent_thread_id === family[i].id && !family.includes(c)) family.push(c);
    type Row = { ts: string; kind: (typeof ACTIVITY_KINDS)[number]; segs: Seg[] };
    const rows: Row[] = [];
    const clock = (iso: string) => (iso ? new Date(iso).toTimeString().slice(0, 8) : '--:--:--');
    const dur = (ms?: number) => (ms == null ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : ms < 1 ? '<1ms' : `${Math.round(ms)}ms`);
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;
    for (const t of family) {
      const turns = this.store.getTurns(t.id, { limit: 100000 });
      const u = this.store.getUsage(t.id);
      tokensIn += u?.inputTokens ?? 0;
      tokensOut += u?.outputTokens ?? 0;
      cost += u?.costUsd ?? 0;
      const who = (t.agent.padEnd(7)) as string;
      const head = (ts: string, what: string): Seg[] => [[clock(ts) + '  ', T.dim], [who, agentStyle(t.agent)], [what.padEnd(8)]];
      if (t !== root) rows.push({ ts: t.created, kind: 'all', segs: [[clock(t.created) + '  ', T.dim], [`──── chat "${t.title}" started with ${t.agent}, continuing "${family[0].title}" ────`, T.chorus]] });
      for (const c of this.store.getToolCalls(t.id)) {
        const ts = [...turns].reverse().find(x => x.seq <= c.turnSeq && x.ts)?.ts ?? t.created;
        rows.push({ ts, kind: 'tool', segs: [...head(ts, 'tool'), [`${c.tool} ${c.target}`.slice(0, 46).padEnd(48)], [c.status === 'ok' ? 'ok' : c.status === 'failed' ? 'failed' : '…', c.status === 'ok' ? T.ok : c.status === 'failed' ? T.err : T.dim], [dur(c.durationMs) ? '  ' + dur(c.durationMs) : '', T.dim]] });
      }
      for (const m of this.store.mcpCalls(t.id)) rows.push({ ts: m.ts, kind: 'mcp', segs: [...head(m.ts, 'mcp'), [`chorus.${m.tool}`.padEnd(48)], ['ok', T.ok]] });
      for (const r of this.store.approvalsLog(500).filter(x => x.thread_id === t.id)) rows.push({ ts: r.ts, kind: 'approval', segs: [...head(r.ts, 'approve'), [r.what.split(' · ').slice(-1)[0].slice(0, 46).padEnd(48)], r.decision === 'approved' ? ['approved', T.ok] : ['denied', T.err]] });
      for (const a of this.store.listArtifacts(t.id)) {
        const n = (this.store.db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE thread_id=? AND path=?').get(t.id, a.path) as { n: number }).n;
        rows.push({ ts: a.ts, kind: 'file', segs: [...head(a.ts, 'file'), [`${a.path} v${n}`]] });
      }
      if (u?.limitUtilization != null) rows.push({ ts: this.store.db.prepare('SELECT updated FROM usage WHERE thread_id=?').get(t.id)?.updated as string ?? t.updated, kind: 'usage', segs: [...head(t.updated, 'usage'), [`5h ${Math.round(u.limitUtilization * 100)}%`]] });
    }
    rows.sort((x, y) => x.ts.localeCompare(y.ts));
    const count = (kind: string) => rows.filter(r => (kind === 'all' ? true : r.kind === kind)).length;
    const bar: Seg[] = ACTIVITY_KINDS.flatMap((kind): Seg[] => {
      const label = `${kind} ${kind === 'error' ? 0 : count(kind)}`;
      return [[kind === ACTIVITY_KINDS[ACTIVITY_KINDS.indexOf(filter)] ? `[${label}]` : ` ${label} `, kind === filter ? join2('1', T.fg, T.bgSel) : kind === 'error' ? T.err : T.fg, `kind:${kind}`], [' ']];
    });
    const out: PaneLine[] = [
      [['Activity', join2('1', T.chorus)], [`  ·  ${root.title}`], [`          in ${tokensIn}  out ${tokensOut} tokens${cost ? ` · $${cost.toFixed(2)}` : ''}`, T.dim]],
      [...bar, ['  f cycles', T.dim]],
      '',
    ];
    const shown = rows.filter(r => filter === 'all' || r.kind === filter);
    for (const r of shown) out.push(r.segs);
    if (!shown.length) out.push([[rows.length ? `Nothing of kind ${filter}.` : 'Nothing recorded yet.', T.dim]]);
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

const helpLines = (k: string) => [
  `Chorus keeps your agents side by side: a sidebar of projects and their chats, the agent's own screen on the right.`,
  `Click anything underlined or filled; the keyboard does everything too. The menu key is ${k} (Ctrl+\\ or Ctrl+Space; CHORUS_MENU_KEY changes it):`,
  '',
  `  ${k}  ↑↓ ⏎  walk the menu and run a row (or click it, or press its letter)`,
  `  ${k}  1-9    switch to chat N (or click it in the sidebar)`,
  `  ${k}  n      New chat: agent, model, project folder, skip permissions`,
  `  ${k}  h      hand off the current chat to another agent`,
  `  ${k}  a      artifacts (o opens one in the browser with live reload)`,
  `  ${k}  i      approvals inbox (y approve, x deny, ⏎ open the chat)`,
  `  ${k}  k      skills: turn on or off, import the ones your agents already have`,
  `  ${k}  m      memory: every chat in every project`,
  `  ${k}  e      activity (f filters, r raw trace)`,
  `  ${k}  y / x  approve / deny the request a background chat is waiting on`,
  `  ${k}  r      ask a handoff chat to load its context again`,
  `  ${k}  b      hide or show the sidebar`,
  `  ${k}  q      quit (twice while chats run)`,
  `  ${k}  ${k}  send the menu key itself to the agent`,
  '',
  'Sidebar dots: ● working   ◐ waiting for you   ○ idle   ! needs approval   … starting   ◌ parked (select to resume)   ■ limit reached',
  'Narrow windows: the sidebar shrinks to names, then icons, then hides (b brings it back); under 50×12 only a notice shows.',
];
