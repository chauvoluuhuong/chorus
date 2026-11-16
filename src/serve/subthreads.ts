// Main thread and sub threads (plan 2026-11-14, Stage 2): free for every user.
//
// Any chat can start a sub thread with the chorus MCP tool start_subthread: a new chat in the caller's folder, the caller as its
// parent, the brief as its first message. A sub thread has no finish tool: its turn ending (the thread's state going from
// `working` to `waiting`, which the app already keeps) is the signal. Chorus then types one report line into the main chat, only
// while that chat is idle, one message per main chat every 8 s; the main chat pulls the rest with get_thread_turns or
// get_handoff_context and answers with send_to_subthread. A sub thread with no activity for 2 minutes is reported as quiet.
//
// Everything is stored on the threads table of Chorus's own store (sub_* columns); the queues are rebuilt from it after a restart.

import type { AgentId } from '../core/types.ts';
import type { Store, SubStatus, ThreadRow } from '../core/store.ts';

export const SUB_NOTE = 'You are a sub thread of another chat in Chorus. Do only this. When you are done, or when you need something, say so in your reply and end your turn: Chorus tells the main chat.';
export const MAX_WORKING = 3;
/** A task step's Worker (watchOnly): the paid module's to watch and report; stored in sub_status like the others. */
export const TASK = 'task' as SubStatus;
const AGENTS: AgentId[] = ['claude', 'codex', 'agy'];

export interface SubDeps {
  store: Store;
  /** starts a chat; returns its id */
  start(x: { agent: AgentId; title: string; prompt: string; cwd: string; parent: ThreadRow; model?: string; effort?: string; skipPermissions: boolean }): string;
  /** types into a chat (an ended one is continued first): `ended` = try later, `gone` = its session is gone */
  send(id: string, text: string): Promise<'sent' | 'ended' | 'gone'>;
  stop(id: string): void;
  /** an approval (CLI prompt or question card) is open for this chat */
  openApproval(id: string): boolean;
  /** the agents usable now (signed in), or undefined when not known yet */
  usable(): AgentId[] | undefined;
  /** the chat's process ended (its app entry says so) */
  ended?(id: string): boolean;
  now?: () => number;
  /** watchdog: no activity for this long → quiet (default 120 s) */
  quietMs?: number;
  /** one message per chat per this long (default 8 s) */
  gapMs?: number;
  /** a sub thread's status changed: the window's state */
  changed?: () => void;
}

interface Outgoing {
  /** the chat it is typed into */
  to: string;
  text: string;
  /** a report about this sub thread: marked reported once typed */
  about?: string;
  /** a message for a sub thread (send_to_subthread): its status goes back to working once typed */
  toSub?: boolean;
}

export const TOOLS = [
  {
    name: 'start_subthread',
    description: 'Start a sub thread: another agent chat in this folder that does one piece of work from your brief. Chorus types a short report into this chat each time it ends a turn; read the rest with get_thread_turns. At most 3 working at a time; a sub thread cannot start its own.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'a short title' },
        brief: { type: 'string', description: 'everything it needs to know to do the work' },
        agent: { type: 'string', enum: AGENTS, description: 'claude, codex or agy (default: your own)' },
        model: { type: 'string' },
        effort: { type: 'string' },
      },
      required: ['title', 'brief'],
    },
  },
  {
    name: 'send_to_subthread',
    description: 'Type a message into one of your sub threads (an answer, more work). Chorus types it when the sub thread is idle.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, message: { type: 'string' } }, required: ['id', 'message'] },
  },
  { name: 'list_subthreads', description: 'Your sub threads: id, title, agent, status, turns, minutes, the start of the last reply.', inputSchema: { type: 'object', properties: {} } },
  { name: 'stop_subthread', description: 'Stop one of your sub threads (its chat is closed; its record stays).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
] as const;
export const TOOL_NAMES = TOOLS.map(t => t.name) as string[];

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export class SubThreads {
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly gapMs: number;
  /** per sub thread: it was seen working since its last turn began (a turn end needs working → waiting) */
  private sawWorking = new Map<string, boolean>();
  /** per sub thread: when its current turn began */
  private turnStart = new Map<string, number>();
  /** per sub thread: the activity mark last seen */
  private mark = new Map<string, string>();
  private outbox: Outgoing[] = [];
  /** per chat: when Chorus last typed into it */
  private lastSent = new Map<string, number>();
  private sending = new Set<string>();

  private readonly d: SubDeps;

  constructor(d: SubDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.quietMs = d.quietMs ?? 120_000;
    this.gapMs = d.gapMs ?? 8_000;
  }

  /* ---------- the tools ---------- */

  async call(name: string, args: Record<string, unknown>, caller?: string): Promise<{ text: string } | { error: string }> {
    const me = caller ? this.d.store.getThread(caller) : undefined;
    if (!me) return { error: 'Only a Chorus chat can use this tool.' };
    switch (name) {
      case 'start_subthread':
        return this.startSub(me, args);
      case 'send_to_subthread': {
        const sub = this.own(me, args.id);
        if (!sub) return { error: `${String(args.id)} is not one of your sub threads.` };
        const message = String(args.message ?? '').trim();
        if (!message) return { error: 'message is empty' };
        this.outbox.push({ to: sub.id, text: message, toSub: true });
        void this.deliver();
        return { text: `Chorus types it into ${sub.id} when it is idle (now, if it is).` };
      }
      case 'list_subthreads': {
        const subs = this.d.store.subThreads(me.id).filter(s => s.sub_status !== TASK);
        if (!subs.length) return { text: '(no sub threads)' };
        return { text: subs.map(s => `${s.id}\t${s.title}\t${s.agent}\t${s.sub_status}\t${s.sub_turns ?? 0} turns\t${this.minutes(s)} min\t${clip(oneLine(this.d.store.lastReply(s.id)), 120)}`).join('\n') };
      }
      case 'stop_subthread': {
        const sub = this.own(me, args.id);
        if (!sub) return { error: `${String(args.id)} is not one of your sub threads.` };
        this.d.stop(sub.id);
        const t = iso(this.now());
        // asked for by the main chat: nothing to report
        this.d.store.setSub(sub.id, { sub_status: 'ended', sub_ended: t, sub_reported: t, sub_working_ms: (sub.sub_working_ms ?? 0) + this.turnMs(sub) });
        this.outbox = this.outbox.filter(o => o.to !== sub.id && o.about !== sub.id);
        this.d.changed?.();
        return { text: `Stopped ${sub.id} "${sub.title}".` };
      }
    }
    return { error: `no tool ${name}` };
  }

  private own(me: ThreadRow, id: unknown) {
    const sub = typeof id === 'string' ? this.d.store.getThread(id) : undefined;
    return sub && sub.sub_status && sub.sub_status !== TASK && sub.parent_thread_id === me.id ? sub : undefined;
  }

  /**
   * A task step's Worker chat (the paid module, ProCtx.watchOnly): a sub thread of the task's Planner for the window (watch-only,
   * shown under its owner), with a status of its own. The paid module reports its Workers itself, so it is never reported,
   * counted, listed or typed into here.
   */
  watchOnly(thread: string, mainThread: string) {
    const st = this.d.store;
    if (!st.getThread(thread) || !st.getThread(mainThread) || thread === mainThread) return;
    if (st.getThread(thread)!.parent_thread_id !== mainThread) st.updateThread(thread, { parent_thread_id: mainThread });
    st.setSub(thread, { sub_status: TASK, sub_started: st.getThread(thread)!.sub_started ?? iso(this.now()) });
    this.outbox = this.outbox.filter(o => o.to !== thread && o.about !== thread);
    this.d.changed?.();
  }

  private startSub(me: ThreadRow, a: Record<string, unknown>): { text: string } | { error: string } {
    if (me.sub_status) return { error: 'A sub thread cannot start sub threads of its own. Say what you need in your reply and end your turn: the main chat decides.' };
    const agent = (a.agent === undefined || a.agent === '' ? me.agent : a.agent) as AgentId;
    if (!AGENTS.includes(agent)) return { error: 'agent must be claude, codex or agy' };
    const usable = this.d.usable();
    if (usable && !usable.includes(agent)) return { error: `${agent} is not usable now (not installed or not signed in). Try another agent.` };
    const working = this.d.store.subThreads(me.id).filter(s => s.sub_status === 'working' || s.sub_status === 'quiet').length;
    if (working >= MAX_WORKING) return { error: `You already have ${MAX_WORKING} sub threads working. Wait for a report, or stop one with stop_subthread.` };
    const title = String(a.title ?? '').trim(), brief = String(a.brief ?? '').trim();
    if (!title || !brief) return { error: 'title and brief are needed' };
    const id = this.d.start({ agent, title, prompt: `${brief}\n\n${SUB_NOTE}`, cwd: me.cwd, parent: me, model: typeof a.model === 'string' ? a.model : undefined, effort: typeof a.effort === 'string' ? a.effort : undefined, skipPermissions: !!me.skip_permissions });
    const t = this.now();
    this.d.store.setSub(id, { sub_status: 'working', sub_brief: brief, sub_started: iso(t), sub_last_activity: iso(t), sub_turns: 0, sub_working_ms: 0, sub_reported: null, sub_ended: null });
    this.turnStart.set(id, t);
    this.sawWorking.set(id, true);
    this.mark.set(id, this.d.store.activityMark(id));
    this.d.changed?.();
    return { text: `Started sub thread ${id} "${title}" (${agent}) in ${me.cwd}. Chorus types a report into this chat when it ends a turn.` };
  }

  /* ---------- watching: called from the 500 ms state ticker ---------- */

  tick() {
    const st = this.d.store;
    let changed = false;
    for (const s of st.subThreads()) {
      const status = s.sub_status as SubStatus;
      if (status === 'ended' || status === TASK) continue;
      const now = this.now();
      const gone = s.state === 'ended' || !!this.d.ended?.(s.id);
      if (gone) {
        st.setSub(s.id, { sub_status: 'ended', sub_ended: iso(now), sub_reported: null, sub_working_ms: (s.sub_working_ms ?? 0) + (status === 'working' || status === 'quiet' ? this.turnMs(s) : 0) });
        changed = true;
        continue;
      }
      // activity: a new turn or tool call
      const m = st.activityMark(s.id);
      const moved = this.mark.has(s.id) && this.mark.get(s.id) !== m;
      this.mark.set(s.id, m);
      if (moved) st.setSub(s.id, { sub_last_activity: iso(now) });
      if (!this.sawWorking.has(s.id)) this.sawWorking.set(s.id, true); // after a restart: a turn that ended meanwhile counts
      if (s.state === 'working') this.sawWorking.set(s.id, true);
      const approval = this.d.openApproval(s.id);

      if (status === 'working' || status === 'quiet') {
        if (s.state === 'waiting' && this.sawWorking.get(s.id)) {
          if (approval) {
            st.setSub(s.id, { sub_status: 'waiting_user' });
          } else {
            st.setSub(s.id, { sub_status: 'stopped', sub_turns: (s.sub_turns ?? 0) + 1, sub_working_ms: (s.sub_working_ms ?? 0) + this.turnMs(s), sub_reported: null });
            this.turnStart.delete(s.id);
          }
          changed = true;
        } else if (approval) {
          // a CLI permission prompt (or a question card) in the middle of a turn: waiting on the user, not working or quiet
          st.setSub(s.id, { sub_status: 'waiting_user', sub_last_activity: iso(now) });
          changed = true;
        } else if (status === 'quiet' && moved) {
          st.setSub(s.id, { sub_status: 'working' });
          changed = true;
        } else if (status === 'working' && now - (ms(st.getThread(s.id)?.sub_last_activity) || now) >= this.quietMs) {
          st.setSub(s.id, { sub_status: 'quiet' });
          this.queue(s.parent_thread_id!, `Chorus: sub thread ${s.id} "${s.title}" (${s.agent}) has shown no activity for ${Math.round(this.quietMs / 60_000) || 1} min; it may be stuck. Look at it with get_thread_turns (thread_id ${s.id}), give it more with send_to_subthread, or stop it with stop_subthread.`);
          changed = true;
        }
      } else if (status === 'waiting_user' && !approval) {
        // the user answered: back in a turn, or the turn is over
        if (s.state === 'working') st.setSub(s.id, { sub_status: 'working', sub_last_activity: iso(now) });
        else st.setSub(s.id, { sub_status: 'stopped', sub_turns: (s.sub_turns ?? 0) + 1, sub_working_ms: (s.sub_working_ms ?? 0) + this.turnMs(s), sub_reported: null }), this.turnStart.delete(s.id);
        changed = true;
      }
    }
    // reports due (also after a restart: the columns say which)
    for (const s of st.subThreads()) {
      if ((s.sub_status === 'stopped' || s.sub_status === 'ended') && !s.sub_reported && s.parent_thread_id && !this.outbox.some(o => o.about === s.id)) {
        this.outbox.push({ to: s.parent_thread_id, about: s.id, text: this.report(s) });
      }
    }
    if (changed) this.d.changed?.();
    void this.deliver();
  }

  private queue(to: string, text: string) {
    if (to) this.outbox.push({ to, text });
  }

  private turnMs(s: ThreadRow) {
    const start = this.turnStart.get(s.id) ?? ms(s.sub_last_activity);
    return Number.isFinite(start) ? Math.max(0, this.now() - start) : 0;
  }

  private minutes(s: ThreadRow) {
    const end = s.sub_ended ? ms(s.sub_ended) : this.now();
    return Math.max(0, Math.round((end - ms(s.sub_started)) / 60_000)) || 0;
  }

  report(s: ThreadRow): string {
    const said = clip(oneLine(this.d.store.lastReply(s.id)), 400);
    const what = s.sub_status === 'ended' ? 'has ended (its chat closed)' : 'ended its turn';
    return `Chorus: sub thread ${s.id} "${s.title}" (${s.agent}) ${what} after ${this.minutes(s)} min. It said: "${said}" Read the rest with get_thread_turns (thread_id ${s.id}) or get_handoff_context. Answer it or give it more with send_to_subthread; stop it with stop_subthread.`;
  }

  /** Types what is due into each chat that is idle now: one message per chat, at most one every gapMs. */
  private async deliver() {
    const st = this.d.store;
    const now = this.now();
    const seen = new Set<string>();
    for (const o of [...this.outbox]) {
      if (seen.has(o.to) || this.sending.has(o.to)) continue;
      seen.add(o.to);
      const row = st.getThread(o.to);
      if (!row) {
        this.drop(o.to);
        continue;
      }
      if (now - (this.lastSent.get(o.to) ?? -Infinity) < this.gapMs) continue;
      // only into an idle chat: not in a turn, nothing waiting on the user (an ended chat is continued by send)
      if (row.state === 'working' || this.d.openApproval(o.to)) continue;
      this.sending.add(o.to);
      void this.d
        .send(o.to, o.text)
        .catch(() => 'ended' as const)
        .then(r => {
          this.sending.delete(o.to);
          if (r === 'ended') return;
          this.lastSent.set(o.to, this.now());
          if (r === 'gone') return this.drop(o.to);
          this.outbox = this.outbox.filter(x => x !== o);
          const t = iso(this.now());
          if (o.about) st.setSub(o.about, { sub_reported: t });
          if (o.toSub) {
            st.setSub(o.to, { sub_status: 'working', sub_last_activity: t });
            this.turnStart.set(o.to, this.now());
            this.sawWorking.set(o.to, false);
            this.mark.set(o.to, st.activityMark(o.to));
          }
          this.d.changed?.();
        });
    }
  }

  /** The chat is gone: what was due for it is marked reported and dropped. */
  private drop(to: string) {
    const t = iso(this.now());
    for (const o of this.outbox) if (o.to === to && o.about) this.d.store.setSub(o.about, { sub_reported: t });
    this.outbox = this.outbox.filter(o => o.to !== to);
  }

  /**
   * The user typed a line into an unlocked sub thread (plan 2026-11-14, Package 4A): the main chat is told, under the same rules
   * as a report (only while it is idle, one message per chat every gapMs).
   */
  userTyped(id: string, text: string) {
    const s = this.d.store.getThread(id);
    const line = oneLine(text);
    if (!s?.sub_status || !s.parent_thread_id || !line) return;
    this.queue(s.parent_thread_id, `Chorus: the user typed into sub thread ${s.id} "${s.title}": "${clip(line, 400)}"`);
    void this.deliver();
  }

  /** For the window's state: a chat's place in a main thread / sub thread pair. */
  info(t: ThreadRow | undefined, unlocked = false) {
    if (!t?.sub_status) return null;
    const main = t.parent_thread_id ? this.d.store.getThread(t.parent_thread_id) : undefined;
    return { parent: t.parent_thread_id, status: t.sub_status, unlocked, title: main?.title ?? null };
  }
}
