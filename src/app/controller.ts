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
import type { ItemState } from './compositor.ts';
import { Tailer } from './tailer.ts';

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
  }

  stop() {
    this.closed = true;
    clearInterval(this.detectTimer);
    for (const t of this.tailers.values()) t.stop();
  }

  /* ---------- threads ---------- */

  /** Threads from earlier runs appear in the sidebar without a process; selecting one resumes it. */
  restore() {
    for (const row of this.store.listThreads().reverse()) {
      if (!row.native_session_id) continue;
      this.app.addParked({ id: row.id, title: row.title, agent: row.agent });
    }
  }

  /**
   * `raw` prompts (handoffs) are typed exactly as given. Any other first prompt gets a line telling the agent
   * where this thread's artifacts go (docs/architecture.md §9).
   */
  newThread(o: { agent: AgentId; title?: string; prompt?: string; parent?: ThreadRow; raw?: boolean }): Entry {
    if (fs.existsSync(sourceDir(this.project))) syncSkills(this.project, { agents: [o.agent] });
    const n = this.store.listThreads().filter(t => t.agent === o.agent).length + 1;
    const row = this.store.createThread({ title: o.title ?? `${o.agent} ${n}`, agent: o.agent, cwd: this.project, parent_thread_id: o.parent?.id, state: 'working' });
    const prompt = o.prompt && !o.raw ? `${o.prompt}\n\n(Files meant for the user, such as notes or reports, go in ${this.store.artifactsDir(row.id)})` : o.prompt;
    const launch = (this.o.launcher ?? buildInteractive)(o.agent, { prompt, cwd: this.project, project: this.project, threadId: row.id, model: this.o.models?.[o.agent] });
    if (launch.sessionId) this.store.updateThread(row.id, { native_session_id: launch.sessionId });
    this.sawStart.set(row.id, o.prompt ? Date.now() : 0);
    const host = this.app.addThread({ id: row.id, title: row.title, agent: o.agent, file: launch.bin, args: launch.args, cwd: launch.cwd }, true);
    this.watchRaw(row.id, host);
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
    this.refreshState(id);
    this.store.updateThread(id, { state: s.status === 'working' ? 'working' : 'waiting' });
    this.checkLimit(id);
    this.checkContext(id);
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
    if (u?.limitUtilization != null && u.limitUtilization >= 0.9 && t) {
      this.app.notice = `⚠ ${t.title} used ${Math.round(u.limitUtilization * 100)}% of its plan limit: ctrl+space h hands off to another agent`;
    }
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
    this.syncCard(); // also after a switch: the card is only for threads you are not looking at
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
      case 'new': {
        const i = await this.app.choose('new thread with…', AGENTS);
        if (i !== undefined) this.newThread({ agent: AGENTS[i] });
        break;
      }
      case 'handoff': {
        if (!cur) return this.app.setFlash('no thread to hand off');
        const i = await this.app.choose(`hand off "${cur.title}" to…`, AGENTS);
        if (i !== undefined) await this.handoff(cur.id, AGENTS[i]);
        break;
      }
      case 'memory':
        return cur ? this.app.showPane(`memory · ${cur.title}`, this.memoryLines(cur.id)) : undefined;
      case 'files':
        return this.app.showPane('files and artifacts', this.fileLines());
      case 'tools':
        return cur ? this.app.showPane(`tool calls · ${cur.title}`, this.toolLines(cur.id)) : undefined;
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
