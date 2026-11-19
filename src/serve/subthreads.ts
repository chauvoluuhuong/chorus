// Main thread and sub threads (plan 2026-11-14, Stage 2): free for every user.
//
// Any chat can start a sub thread with the chorus MCP tool start_subthread: a new chat in the caller's folder, the caller as its
// parent, the brief as its first message. A sub thread has no finish tool: its turn ending is the signal. Since task #10 (2026-11-18)
// nothing here looks at chats or keeps a timer: each sub thread is a watch on chorus serve's one TurnWatch (key `sub:<thread>`), and
// every message (a report, "may be stuck", the main chat's answer, a question to the main chat) is a record in the one Mailbox, which
// hands it to the receiver's CLI without typing into its input, once the receiver is idle. The main chat pulls the rest with
// get_thread_turns or get_handoff_context and answers with send_to_subthread.
//
// The statuses are stored on the threads table of Chorus's own store (sub_* columns); the watches and the mail are in its `watch`
// and `mail` tables, so a restart keeps them.

import type { Mailbox, MailMessage, TurnWatch, WatchEvent, WatchState } from '@chauvoluuhuong/chorus-core';
import type { AgentId } from '../core/types.ts';
import type { Store, SubStatus, ThreadRow } from '../core/store.ts';

export const SUB_NOTE = 'You are a sub thread of another chat in Chorus. Do only this. When you are done, or when you need something, say so in your reply and end your turn: Chorus tells the main chat.';
export const MAX_WORKING = 3;
/** A task step's Worker (watchOnly): the paid module's to watch and report; stored in sub_status like the others. */
export const TASK = 'task' as SubStatus;
const AGENTS: AgentId[] = ['claude', 'codex', 'agy'];
/** the watches' owner on the shared TurnWatch */
export const OWNER = 'subthreads';
export const EXPECT = 'report each turn end to the main thread';
const keyOf = (thread: string) => `sub:${thread}`;

export interface SubDeps {
  store: Store;
  /** chorus serve's one TurnWatch: a watch per sub thread */
  watch: TurnWatch;
  /** chorus serve's one Mailbox: every report, note and question */
  mail: Mailbox;
  /** starts a chat; returns its id */
  start(x: { agent: AgentId; title: string; prompt: string; brief: string; cwd: string; parent: ThreadRow; model?: string; effort?: string; skipPermissions: boolean }): string;
  stop(id: string): void;
  /** the agents usable now (signed in), or undefined when not known yet */
  usable(): AgentId[] | undefined;
  now?: () => number;
  /** watchdog: no activity for this long → quiet (default: the watcher's QUIET_MS, 2 min) */
  quietMs?: number;
  /** a sub thread's status changed: the window's state */
  changed?: () => void;
}

export const TOOLS = [
  {
    name: 'start_subthread',
    description: 'Start a sub thread: another agent chat in this folder that does one piece of work from your brief. Use it for work that can run on its own, or that the user wants another agent to do. Chorus sends a short report to this chat each time it ends a turn; read the rest with get_thread_turns. At most 3 working at a time; a sub thread cannot start its own.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'a short title' },
        brief: { type: 'string', description: 'everything it needs to know to do the work; its first line says what it is for' },
        agent: { type: 'string', enum: AGENTS, description: 'claude, codex or agy (default: your own)' },
        model: { type: 'string' },
        effort: { type: 'string' },
      },
      required: ['title', 'brief'],
    },
  },
  {
    name: 'send_to_subthread',
    description: 'Send a message to one of your sub threads (an answer, more work). Use it to answer a sub thread\'s report or question, or to give it more to do. Chorus delivers it when the sub thread is idle. It also answers the sub thread\'s open questions.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, message: { type: 'string' } }, required: ['id', 'message'] },
  },
  { name: 'list_subthreads', description: 'Your sub threads: id, title, agent, status, turns, minutes, the start of the last reply. Use it when you need to see how your sub threads stand.', inputSchema: { type: 'object', properties: {} } },
  { name: 'stop_subthread', description: 'Stop one of your sub threads (its chat is closed; its record stays). Use it when its work is done or no longer needed.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  {
    name: 'ask_main_thread',
    description: 'Sub threads only: ask your main thread for a decision, an approval or a fact you need before you can go on, instead of the user. End your turn after calling it; the answer arrives as your next message.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['approval', 'question'], description: '"approval": you want an OK for something you would do; "question": a choice or a fact' },
        question: { type: 'string', description: 'what you ask, in one sentence' },
        details: { type: 'string', description: 'what your main thread needs to answer (a few lines)' },
        options: { type: 'array', items: { type: 'string' }, description: 'the answers you see, the one you suggest first' },
      },
      required: ['kind', 'question'],
    },
  },
] as const;
export const TOOL_NAMES = TOOLS.map(t => t.name) as string[];

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export class SubThreads {
  private readonly now: () => number;
  private readonly quietMs: number | undefined;
  private readonly d: SubDeps;

  constructor(d: SubDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.quietMs = d.quietMs;
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
        // its next message from the main thread answers what it asked
        const open = this.d.store.openAsks({ thread: sub.id });
        const answered = this.d.store.answerAsks(sub.id);
        for (const m of this.questionMail(sub.id, open.map(a => a.id))) this.d.mail.answered(m.id);
        // an ended sub thread is continued to take it: watched again
        if (!this.d.watch.has(keyOf(sub.id))) this.register(sub.id, sub.parent_thread_id!);
        const id = this.d.mail.send({
          from: { who: 'chat', thread: me.id, role: 'main thread' }, to: { thread: sub.id }, kind: 'note', subject: `From your main thread "${me.title}"`,
          body: message, refs: { about: me.id },
        });
        this.d.watch.note(keyOf(sub.id), `mail ${id}: a note from the main thread`);
        return { text: `Chorus delivers it to ${sub.id} when it is idle (now, if it is).${answered ? ` It answers its open question${answered > 1 ? 's' : ''}.` : ''}` };
      }
      case 'ask_main_thread':
        return this.ask(me, args);
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
        this.d.watch.unwatch(keyOf(sub.id), 'stopped by its main thread');
        this.d.changed?.();
        return { text: `Stopped ${sub.id} "${sub.title}".` };
      }
    }
    return { error: `no tool ${name}` };
  }

  /**
   * A sub thread asks its main thread (owner, 2026-11-17): a question in the main chat's mail, never a request, an Approvals or a
   * Needs you item. The main thread answers with send_to_subthread, or asks the user itself when it cannot.
   */
  private ask(me: ThreadRow, a: Record<string, unknown>): { text: string } | { error: string } {
    if (me.sub_status === TASK) return { error: 'You are a step of a task: ask your Planner through Chorus (ask_planner).' };
    if (!me.sub_status || !me.parent_thread_id) return { error: 'Only a sub thread can ask its main thread. Ask the user with request_approval.' };
    const main = this.d.store.getThread(me.parent_thread_id);
    if (!main) return { error: 'Your main thread is gone: say what you need in your reply and end your turn.' };
    const question = oneLine(String(a.question ?? ''));
    if (!question) return { error: 'question is empty' };
    const kind = a.kind === 'approval' ? 'approval' : 'question';
    const details = typeof a.details === 'string' ? a.details.trim() : '';
    const options = Array.isArray(a.options) ? a.options.map(x => oneLine(String(x))).filter(Boolean).slice(0, 6) : [];
    const q = this.d.store.createAsk({ threadId: me.id, parentId: main.id, kind, question, details, options });
    const text = `Chorus: sub thread "${me.title}" (${me.id}) asks [${q.id}] (${kind}): ${question}${details ? ` — ${clip(oneLine(details), 800)}` : ''}${options.length ? ` — options: ${options.join(' / ')}` : ''}. Answer it with send_to_subthread.`;
    const id = this.d.mail.send({
      from: { who: 'chat', thread: me.id, role: 'sub thread' }, to: { thread: main.id }, kind: 'question', subject: `Sub thread "${me.title}" asks: ${clip(question, 120)}`,
      body: text, refs: { question: q.id, about: me.id }, meta: { kind, details, options },
    });
    if (this.d.watch.has(keyOf(me.id))) this.d.watch.note(keyOf(me.id), `mail ${id}: question ${q.id} to the main thread`);
    return { text: `Asked your main thread (${q.id}). End your turn now: the answer arrives as your next message.` };
  }

  /** The question mail a sub thread sent for these asks. */
  private questionMail(sub: string, asks: string[]): MailMessage[] {
    if (!asks.length) return [];
    return this.d.mail.list({ from: sub }).filter(m => m.kind === 'question' && !!m.refs.question && asks.includes(m.refs.question));
  }

  private own(me: ThreadRow, id: unknown) {
    const sub = typeof id === 'string' ? this.d.store.getThread(id) : undefined;
    return sub && sub.sub_status && sub.sub_status !== TASK && sub.parent_thread_id === me.id ? sub : undefined;
  }

  /**
   * A task step's Worker chat (the paid module, ProCtx.watchOnly): a sub thread of the task's Planner for the window (watch-only,
   * shown under its owner), with a status of its own. The paid module watches and reports its Workers itself, so it is never
   * watched, reported, counted, listed or sent to here.
   */
  watchOnly(thread: string, mainThread: string) {
    const st = this.d.store;
    if (!st.getThread(thread) || !st.getThread(mainThread) || thread === mainThread) return;
    if (st.getThread(thread)!.parent_thread_id !== mainThread) st.updateThread(thread, { parent_thread_id: mainThread });
    st.setSub(thread, { sub_status: TASK, sub_started: st.getThread(thread)!.sub_started ?? iso(this.now()) });
    this.d.watch.unwatch(keyOf(thread), 'a task step');
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
    // a sub thread always starts with all permissions (the CLI's skip flag), whatever its main chat has (owner, 2026-11-19); a CLI
    // with no skip flag starts as it is
    const id = this.d.start({ agent, title, prompt: `${brief}\n\n${SUB_NOTE}`, brief, cwd: me.cwd, parent: me, model: typeof a.model === 'string' ? a.model : undefined, effort: typeof a.effort === 'string' ? a.effort : undefined, skipPermissions: true });
    const t = this.now();
    this.d.store.setSub(id, { sub_status: 'working', sub_brief: brief, sub_started: iso(t), sub_last_activity: iso(t), sub_turns: 0, sub_working_ms: 0, sub_reported: null, sub_ended: null });
    // just briefed: its first turn may end before a tick sees it work
    this.register(id, me.id, true);
    this.d.changed?.();
    return { text: `Started sub thread ${id} "${title}" (${agent}) in ${me.cwd}. Chorus sends a report to this chat when it ends a turn.` };
  }

  /* ---------- watching: a watch per sub thread on the shared TurnWatch ---------- */

  private register(thread: string, main: string, startsWorking = false) {
    this.d.watch.watch({ key: keyOf(thread), thread, belongsTo: main, kind: 'thread', owner: OWNER, expect: EXPECT, startsWorking, quietMs: this.quietMs, on: (e, s) => this.on(thread, e, s) });
  }

  /** At start, before the first tick: every open sub thread is watched again (the watcher keeps each one's data), and a report that
   *  was due when Chorus stopped is sent. */
  restore() {
    const st = this.d.store;
    for (const s of st.subThreads()) {
      if (!s.parent_thread_id || s.sub_status === TASK) continue;
      if (s.sub_status !== 'ended') this.register(s.id, s.parent_thread_id);
      else if (this.d.watch.get(keyOf(s.id))) this.d.watch.unwatch(keyOf(s.id), 'ended');
      if ((s.sub_status === 'stopped' || s.sub_status === 'ended') && !s.sub_reported) this.reportTurn(s);
    }
  }

  private on(thread: string, e: WatchEvent, w: WatchState) {
    const st = this.d.store;
    const s = st.getThread(thread);
    if (!s?.sub_status || s.sub_status === TASK || !s.parent_thread_id) return this.d.watch.unwatch(keyOf(thread), 'no longer a sub thread');
    const now = this.now();
    switch (e.type) {
      case 'turnEnd':
        // with or without `waited`: a turn held back by an approval or a question card is over now
        st.setSub(thread, { sub_status: 'stopped', sub_turns: (s.sub_turns ?? 0) + 1, sub_working_ms: (s.sub_working_ms ?? 0) + e.ms, sub_last_activity: iso(now), sub_reported: null });
        this.reportTurn(st.getThread(thread)!);
        break;
      case 'waiting':
        // a CLI permission prompt or a question card: waiting on the user, not working or quiet
        if (e.on.includes('card')) st.setSub(thread, { sub_status: 'waiting_user', sub_last_activity: iso(now) });
        break;
      case 'again':
        st.setSub(thread, { sub_status: 'working', sub_last_activity: iso(now) });
        break;
      case 'quiet': {
        st.setSub(thread, { sub_status: 'quiet' });
        const mins = Math.round((this.quietMs ?? 120_000) / 60_000) || 1;
        const id = this.d.mail.send({
          from: { who: 'chorus' }, to: { thread: s.parent_thread_id }, kind: 'note', subject: `Sub thread "${s.title}" may be stuck`,
          body: `Chorus: sub thread ${s.id} "${s.title}" (${s.agent}) has shown no activity for ${mins} min; it may be stuck. Look at it with get_thread_turns (thread_id ${s.id}), give it more with send_to_subthread, or stop it with stop_subthread.`,
          refs: { about: s.id },
        });
        this.d.watch.note(w.key, `mail ${id}: may be stuck`);
        break;
      }
      case 'gone': {
        const was = s.sub_status;
        st.setSub(thread, { sub_status: 'ended', sub_ended: iso(now), sub_reported: null, sub_working_ms: (s.sub_working_ms ?? 0) + (was === 'working' || was === 'quiet' ? Math.max(0, now - (w.since ?? now)) : 0) });
        this.reportTurn(st.getThread(thread)!);
        this.d.watch.unwatch(w.key, 'its chat ended');
        break;
      }
      default:
        return;
    }
    this.d.changed?.();
  }

  /** A turn end (or the end of its chat) goes to the main chat as a report, unless the turn ended on a question to it. */
  private reportTurn(s: ThreadRow) {
    const st = this.d.store;
    const t = iso(this.now());
    if (!s.parent_thread_id || !st.getThread(s.parent_thread_id)) return st.setSub(s.id, { sub_reported: t });
    // a turn that ended on a question to its main thread: the question went as mail, its report would only repeat it
    if (s.sub_status === 'stopped' && st.openAsks({ thread: s.id }).length) return st.setSub(s.id, { sub_reported: t });
    const what = s.sub_status === 'ended' ? 'has ended' : 'ended its turn';
    const id = this.d.mail.send({
      from: { who: 'chorus' }, to: { thread: s.parent_thread_id }, kind: 'report', subject: `Sub thread "${s.title}" ${what}`, body: this.report(s), refs: { about: s.id },
    });
    st.setSub(s.id, { sub_reported: t });
    if (this.d.watch.get(keyOf(s.id))) this.d.watch.note(keyOf(s.id), `mail ${id}: report`);
  }

  /**
   * After each watcher tick: what the watcher keeps but raises no event for. New activity ends a quiet spell; an approval answered in
   * the middle of a turn makes it working again; a question delivered to the main chat is marked so.
   */
  tick() {
    const st = this.d.store;
    let changed = false;
    for (const s of st.subThreads()) {
      if (s.sub_status === 'ended' || s.sub_status === TASK) continue;
      const w = this.d.watch.get(keyOf(s.id));
      if (!w) continue;
      if (w.activityAt !== undefined && iso(w.activityAt) !== s.sub_last_activity && w.activityAt > (ms(s.sub_last_activity) || 0)) st.setSub(s.id, { sub_last_activity: iso(w.activityAt) });
      const card = !!w.waitsOn?.includes('card');
      if (w.seen === 'working' && !card && !w.quietSent && (s.sub_status === 'quiet' || s.sub_status === 'waiting_user' || s.sub_status === 'stopped')) {
        st.setSub(s.id, { sub_status: 'working' });
        changed = true;
      }
    }
    for (const a of st.untypedAsks()) {
      const m = this.questionMail(a.thread_id, [a.id])[0];
      if (m && m.state !== 'queued' && m.state !== 'failed') st.askTyped(a.id);
    }
    if (changed) this.d.changed?.();
  }

  private turnMs(s: ThreadRow) {
    const w = this.d.watch.get(keyOf(s.id));
    const start = w?.seen === 'working' ? w.since : ms(s.sub_last_activity);
    return start !== undefined && Number.isFinite(start) ? Math.max(0, this.now() - start) : 0;
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

  /** A chat was deleted: the watches of its sub threads end (the mailbox drops its mail). */
  forget(id: string) {
    for (const w of [...this.d.watch.list({ thread: id }), ...this.d.watch.list({ belongsTo: id })]) if (w.owner === OWNER) this.d.watch.unwatch(w.key, 'chat deleted');
  }

  /**
   * The user typed a line into an unlocked sub thread (plan 2026-11-14, Package 4A): the main chat gets a note, delivered once it is
   * idle like a report.
   */
  userTyped(id: string, text: string) {
    const s = this.d.store.getThread(id);
    const line = oneLine(text);
    if (!s?.sub_status || !s.parent_thread_id || !line) return;
    const m = this.d.mail.send({
      from: { who: 'chorus' }, to: { thread: s.parent_thread_id }, kind: 'note', subject: `The user typed into sub thread "${s.title}"`,
      body: `Chorus: the user typed into sub thread ${s.id} "${s.title}": "${clip(line, 400)}"`, refs: { about: s.id },
    });
    if (this.d.watch.get(keyOf(s.id))) this.d.watch.note(keyOf(s.id), `mail ${m}: the user typed`);
  }

  /** For the window's state: a chat's place in a main thread / sub thread pair. */
  info(t: ThreadRow | undefined, unlocked = false) {
    if (!t?.sub_status) return null;
    const main = t.parent_thread_id ? this.d.store.getThread(t.parent_thread_id) : undefined;
    return { parent: t.parent_thread_id, status: t.sub_status, unlocked, title: main?.title ?? null };
  }
}
