// The Chat view's data (plan 2026-11-22 chat-view, docs/features/chat-view.md): a chat drawn from the turns Chorus already captures
// from its CLI's transcript, beside the agent's own terminal. One session, two views: nothing here starts, resumes or types into a CLI except
// `say` and `key`, which are the user typing.
//
// What the page gets, and when:
//   - GET chats/:id/turns: a page of turns (newest first page, 30 by default), one short row per tool call of those turns, and the
//     cards (sub threads, chats it started, reported artifacts, mail it read), each placed by the turn it came after;
//   - while the page shows the Chat view, only what is new: the turns and rows added or changed since the last send (`cv` messages,
//     from the tailer's own update, never a timer);
//   - GET chats/:id/calls/:callId: one call's full input and output, read from the transcript only when the user taps the row.
import fs from 'node:fs';
import path from 'node:path';
import { adapters, inputState, NEWLINE_KEYS, toolKind, type ScreenLine, type ToolKind } from '@chauvoluuhuong/chorus-core';
import type { Store, ThreadRow } from '../core/store.ts';
import type { AgentId } from '../core/types.ts';
import { kindOf } from './fileview.ts';

/** Chorus's own tools that are drawn as cards, not rows (decision 7 of the plan). */
export const CARD_TOOLS = ['start_subthread', 'start_thread', 'show_artifact', 'request_approval', 'ask_main_thread'];
/** The turns a page holds by default. */
export const PAGE_TURNS = 30;
/** A detail is cut here unless the page asks for all of it; all of it is capped at FULL_MAX. */
export const DETAIL_MAX = 4096;
export const FULL_MAX = 256 * 1024;

/**
 * A "user" turn the user did not type as a message (owner, 2026-11-23: the real Planner chat showed a background job's notice and a
 * shortened conversation's summary as the user's own bubbles). The CLI's transcript stores these as user lines; the Chat view draws
 * each as one quiet line. `job`: a background command or watch of the CLI reports; `compact`: the CLI shortened the conversation and
 * wrote its summary; `answer`: the user's answer to a Chorus card, typed by Chorus; `stopped`: the user stopped the turn; `chorus`:
 * a message Chorus typed (another chat says…, a step is done…); `brief`: the instructions Chorus started the chat with.
 */
export interface CvNote {
  kind: 'job' | 'compact' | 'answer' | 'stopped' | 'chorus' | 'brief';
  /** the line's bold words, where the kind alone does not say them */
  head?: string;
  /** what follows them: the job's name, the answer, the message's first words */
  sub?: string;
}
export interface CvTurn {
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  ts?: string | null;
  /** not a message: a quiet line (its `text` is then cut at NOTE_MAX; `long` when there is more, GET chats/:id/turns/:seq) */
  note?: CvNote;
  long?: boolean;
}
/** A quiet line carries this much of its text; the rest is read only when the user opens it. */
export const NOTE_MAX = 600;
/** One tool call as the Chat view loads it: what kind, on what, and its result in a word. Never its input or output. */
export interface CvCall {
  id: string;
  /** the turn it came after */
  seq: number;
  kind: ToolKind;
  tool: string;
  target: string;
  status: 'running' | 'ok' | 'failed';
  /** the word on the right: "120 lines", "+12 −3", "exit 1", "4 matches" */
  word?: string;
  ms?: number;
}
export type CvCard =
  | { type: 'sub'; id: string; title: string; agent: string; state: string; status: string; started?: string | null; report?: string; question?: string; seq: number | null; at: string }
  | { type: 'chat'; id: string; title: string; teammate?: string; agent: string; skip: boolean; state: string; seq: number | null; at: string }
  | { type: 'startedBy'; id: string; title: string; agent: string; skip: boolean; seq: 0; at: string }
  | { type: 'artifact'; id: number; title: string; target: string; rel?: string; link: boolean; kind: string; fileType?: string; open: boolean; seq: number | null; at: string }
  | { type: 'mail'; from: string; fromId?: string | null; /** a sub thread's report: the sub thread it is about */ sub?: { id: string; title: string }; subject: string; seq: number | null; at: string };

export interface CvPage {
  turns: CvTurn[];
  calls: CvCall[];
  cards: CvCard[];
  /** earlier turns exist (scrolling up loads them) */
  more: boolean;
  /** the lowest seq of this page: the next page asks before it */
  from: number;
}

/** What chatview needs from the server: the store and the reported artifacts (with whether a device may open each). */
export interface CvDeps {
  store: Store;
  reported(id: string): { id: number; title: string; target: string; link: boolean; inside: boolean; ts: string }[];
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
const firstLine = (s: string) => s.trim().split('\n')[0].trim();

/** What a user turn is when it is not a message the user typed (CvNote); undefined for a message. */
export function noteOf(text: string): CvNote | undefined {
  const t = text.trimStart();
  // Claude Code: a background command or a watch reports into the conversation
  if (t.startsWith('<task-notification>')) {
    const sum = tag(t, 'summary') ?? '';
    const status = tag(t, 'status');
    const name = /"([^"]+)"/.exec(sum)?.[1];
    const m = /^Monitor event/.test(sum) ? { head: 'Watch reported' } : /still running after (\S+?),/.exec(sum) ? { head: 'Background job still running', more: /still running after (\S+?),/.exec(sum)![1] } : /exit code [1-9]|failed/.test(sum) || status === 'failed' ? { head: 'Background job failed' } : /stopped|killed/.test(sum) || status === 'killed' ? { head: 'Background job stopped' } : status === 'completed' || /completed/.test(sum) ? { head: 'Background job finished' } : { head: 'Background job reported' };
    const sub = [name ?? (sum && !/^Background command$/.test(sum) ? sum : ''), (m as { more?: string }).more].filter(Boolean).join(' · ');
    return { kind: 'job', head: m.head, ...(sub ? { sub: clip(sub, 160) } : {}) };
  }
  // Claude Code: the conversation was shortened; this turn is the summary it goes on from
  if (t.startsWith('This session is being continued from a previous conversation')) return { kind: 'compact' };
  // Chorus typed the user's answer to a card (request_approval)
  const ans = /^Chorus approval r_[0-9a-f]+:\s*([\s\S]*)$/.exec(t);
  if (ans) return { kind: 'answer', sub: clip(ans[1].replace(/\s+/g, ' ').trim(), 240) };
  if (/^\[Request interrupted by user[^\]]*\]\s*$/.test(t)) return { kind: 'stopped' };
  // what Chorus types into a chat: mail from another chat, a step's news, a restart (a long one arrives as pasted text)
  const ch = /^(?:<pasted_content[^>]*>\s*)?Chorus: ([\s\S]*)$/.exec(t);
  if (ch) return { kind: 'chorus', sub: clip(firstLine(ch[1].replace(/<\/pasted_content>\s*$/, '')), 160) };
  if (t.startsWith('Chorus restarted.')) return { kind: 'chorus', sub: clip(firstLine(t), 160) };
  // the instructions Chorus starts a chat with: a task's Planner and step chats, a chat handed off from another agent
  if (/^You are [\w.-]+, doing one step of /.test(t) || t.startsWith('You are Planner. Read the instructions') || t.startsWith('This chat continues the Chorus thread ')) return { kind: 'brief' };
  return undefined;
}

/** A quiet line's text as it is shown when opened: a notice's tags as "name  value" rows, a pasted block without its wrapper. */
export function noteText(text: string, note: CvNote): string {
  if (note.kind === 'job') {
    const rows = [...(tag(text, 'task-notification') ?? text).matchAll(/<([\w-]+)>([\s\S]*?)<\/\1>/g)].filter(m => m[1] !== 'task-notification' && m[1] !== 'tool-use-id').map(m => `${m[1].padEnd(12)} ${m[2].trim()}`);
    const rest = text.replace(/<task-notification>[\s\S]*?<\/task-notification>/, '').trim();
    return [rows.join('\n'), rest].filter(Boolean).join('\n\n');
  }
  return text.replace(/^\s*<pasted_content[^>]*>\s*/, '').replace(/<\/pasted_content>\s*$/, '').trim();
}

/** A turn as the page gets it: a message whole, a quiet line with its kind and the first NOTE_MAX characters of its text. */
export function turnOut(t: { seq: number; role: string; text: string; ts?: string | null }): CvTurn {
  const base = { seq: t.seq, role: t.role as CvTurn['role'], ts: t.ts ?? null };
  const note = t.role === 'user' ? noteOf(t.text) : undefined;
  if (!note) return { ...base, text: t.text };
  const text = noteText(t.text, note);
  return { ...base, text: text.length > NOTE_MAX ? text.slice(0, NOTE_MAX) : text, note, ...(text.length > NOTE_MAX ? { long: true } : {}) };
}

/** One quiet line's whole text, read when the user opens it (capped at FULL_MAX). */
export function turnText(store: Store, id: string, seq: number): { text: string; capped?: boolean } | { error: string } {
  const r = store.db.prepare('SELECT role, text FROM turns WHERE thread_id = ? AND seq = ?').get(id, seq) as { role: string; text: string } | undefined;
  if (!r) return { error: 'not found' };
  const note = r.role === 'user' ? noteOf(r.text) : undefined;
  const text = note ? noteText(r.text, note) : r.text;
  return text.length > FULL_MAX ? { text: text.slice(0, FULL_MAX), capped: true } : { text };
}

export function callRow(r: any): CvCall {
  const kind = (r.kind as ToolKind | null) ?? toolKind(r.tool);
  const word = r.note ?? (r.status === 'failed' ? 'failed' : undefined);
  return { id: r.call_id, seq: r.turn_seq, kind, tool: r.tool, target: clip(String(r.target ?? ''), 200), status: r.status, ...(word ? { word: clip(word, 40) } : {}), ...(r.duration_ms != null ? { ms: r.duration_ms } : {}) };
}

/** The turn a moment belongs after: the last turn written at or before it (null: before every turn, or no times known). */
function seqAt(store: Store, id: string, at: string | null | undefined): number | null {
  if (!at) return null;
  const r = store.db.prepare('SELECT MAX(seq) AS s FROM turns WHERE thread_id = ? AND ts IS NOT NULL AND ts <= ?').get(id, at) as { s: number | null };
  return r?.s ?? 0;
}

/** a reported file's kind for its card, as the file viewer names it (src/serve/fileview.ts); 'file' for one it can't show, with its
 * type's name when known (fileType: "Keynote") */
const cardKind = (target: string) => {
  const k = kindOf(target);
  return { kind: k.kind === 'none' ? 'file' : k.kind, ...(k.type ? { fileType: k.type } : {}) };
};

/** Every card of a chat, placed by the turn it came after. */
export function cardsOf(d: CvDeps, id: string): CvCard[] {
  const { store } = d;
  const me = store.getThread(id);
  if (!me) return [];
  const out: CvCard[] = [];
  const kids = store.db.prepare('SELECT * FROM threads WHERE parent_thread_id = ? ORDER BY created').all(id) as unknown as ThreadRow[];
  for (const t of kids) {
    const at = t.sub_started ?? t.created;
    if (t.sub_status && (t.sub_status as string) !== 'task') {
      const rep = store.db.prepare("SELECT body FROM mail WHERE to_thread = ? AND kind = 'report' AND refs LIKE ? ORDER BY created_at DESC LIMIT 1").get(id, `%"about":"${t.id}"%`) as { body: string } | undefined;
      const ask = store.db.prepare('SELECT question FROM asks WHERE thread_id = ? AND answered IS NULL ORDER BY created DESC LIMIT 1').get(t.id) as { question: string } | undefined;
      out.push({ type: 'sub', id: t.id, title: t.title, agent: t.agent, state: t.state, status: String(t.sub_status), started: t.sub_started, ...(rep?.body ? { report: clip(rep.body.replace(/\s+/g, ' ').trim(), 240) } : {}), ...(ask ? { question: clip(ask.question, 240) } : {}), seq: seqAt(store, id, at), at });
    } else {
      const teammate = / · /.test(t.title) ? t.title.split(' · ')[0] : undefined;
      out.push({ type: 'chat', id: t.id, title: t.title, ...(teammate ? { teammate } : {}), agent: t.agent, skip: !!t.skip_permissions, state: t.state, seq: seqAt(store, id, at), at });
    }
  }
  // a chat that another chat started (start_thread): the line at its top says which one
  const parent = me.parent_thread_id && !me.sub_status ? store.getThread(me.parent_thread_id) : undefined;
  if (parent) out.push({ type: 'startedBy', id: parent.id, title: parent.title, agent: parent.agent, skip: !!me.skip_permissions, seq: 0, at: me.created });
  for (const r of d.reported(id)) {
    // a file in the project shows as its path in the project (site/hero.html), as the agent names it
    const rel = !r.link && r.inside ? path.relative(me.project ?? me.cwd, r.target) : undefined;
    out.push({ type: 'artifact', id: r.id, title: r.title, target: r.target, ...(rel && !rel.startsWith('..') ? { rel } : {}), link: r.link, ...(r.link ? { kind: 'link' } : cardKind(r.target)), open: !r.link && r.inside, seq: seqAt(store, id, r.ts), at: r.ts });
  }
  // mail this chat read: one line each (who it was from)
  const mail = store.db.prepare('SELECT from_thread, from_json, subject, refs, read_at FROM mail WHERE to_thread = ? AND read_at IS NOT NULL ORDER BY read_at').all(id) as { from_thread: string | null; from_json: string; subject: string; refs: string; read_at: string }[];
  for (const m of mail) {
    let who = 'Chorus';
    let about: { id: string; title: string } | undefined;
    try {
      const f = JSON.parse(m.from_json);
      // a sub thread's report comes from Chorus about it: it is named after the sub thread
      const aboutId = JSON.parse(m.refs || '{}')?.about;
      const sub = aboutId ? store.getThread(aboutId) : undefined;
      if (f?.thread) who = store.getThread(f.thread)?.title ?? f.role ?? 'a chat';
      else if (sub?.sub_status) {
        who = `the sub thread "${sub.title}"`;
        about = { id: sub.id, title: sub.title };
      } else if (f?.who && f.who !== 'chorus') who = String(f.who);
    } catch {
      /* the sender stays Chorus */
    }
    out.push({ type: 'mail', from: who, fromId: m.from_thread, ...(about ? { sub: about } : {}), subject: clip(m.subject, 160), seq: seqAt(store, id, m.read_at), at: m.read_at });
  }
  return out;
}

/** A page of a chat: `before` a seq (the next older page), else the newest. */
export function turnsPage(d: CvDeps, id: string, o: { before?: number; limit?: number } = {}): CvPage {
  const { store } = d;
  const limit = Math.max(1, Math.min(200, o.limit ?? PAGE_TURNS));
  const turns = store.getTurns(id, { before: o.before, limit }).map(turnOut);
  const from = turns.length ? turns[0].seq : o.before ?? 1;
  const to = o.before ?? Number.MAX_SAFE_INTEGER;
  // the calls after each turn of the page; the newest page also has the calls before its first turn's successor
  const lo = turns.length && from > 1 ? from : 0;
  const rows = store.db.prepare('SELECT * FROM tool_calls WHERE thread_id = ? AND turn_seq >= ? AND turn_seq < ? ORDER BY turn_seq, rowid').all(id, lo, to) as any[];
  const more = !!(store.db.prepare('SELECT 1 FROM turns WHERE thread_id = ? AND seq < ? LIMIT 1').get(id, from) as unknown);
  const cards = cardsOf(d, id).filter(c => (c.seq ?? Number.MAX_SAFE_INTEGER) >= lo && (c.seq ?? Number.MAX_SAFE_INTEGER) < to || (c.seq == null && o.before == null));
  return { turns, calls: rows.map(callRow), cards, more, from };
}

/** What one client was last sent for the chat it shows in the Chat view. */
export interface CvSent {
  id: string;
  /** the highest turn seq sent */
  seq: number;
  /** each call sent: its status and word, to send it again when they change (running → done) */
  calls: Map<string, string>;
  cards: string;
}

const sig = (c: CvCall) => `${c.status}|${c.word ?? ''}|${c.target}`;

/** The first send to a client: what it now has (after GET turns, the page is the client's own). */
export function sentOf(id: string, page: CvPage, d: CvDeps): CvSent {
  return { id, seq: page.turns.length ? page.turns[page.turns.length - 1].seq : 0, calls: new Map(page.calls.map(c => [c.id, sig(c)])), cards: JSON.stringify(cardsOf(d, id)) };
}

/**
 * What changed since the last send: turns after the last one sent (and the last one again, a reply can grow), the calls that are new
 * or whose status or word changed, and all cards when any changed. Undefined when nothing did. Updates `sent`.
 */
export function delta(d: CvDeps, sent: CvSent): { turns: CvTurn[]; calls: CvCall[]; cards?: CvCard[] } | undefined {
  const { store } = d;
  const id = sent.id;
  const turns = store.db.prepare('SELECT seq, role, text, ts FROM turns WHERE thread_id = ? AND seq >= ? ORDER BY seq').all(id, Math.max(1, sent.seq)) as unknown as CvTurn[];
  const last = sent.seq ? turns.find(t => t.seq === sent.seq) : undefined;
  const newTurns = turns.filter(t => t.seq > sent.seq || (t === last && false));
  // calls of the latest turns, plus any call still running
  const rows = store.db.prepare("SELECT * FROM tool_calls WHERE thread_id = ? AND (turn_seq >= ? OR status = 'running') ORDER BY turn_seq, rowid").all(id, Math.max(0, sent.seq - 1)) as any[];
  const calls: CvCall[] = [];
  for (const r of rows) {
    const c = callRow(r);
    const s = sig(c);
    if (sent.calls.get(c.id) !== s) {
      calls.push(c);
      sent.calls.set(c.id, s);
    }
  }
  const cardsNow = JSON.stringify(cardsOf(d, id));
  const cards = cardsNow !== sent.cards ? (JSON.parse(cardsNow) as CvCard[]) : undefined;
  sent.cards = cardsNow;
  if (newTurns.length) sent.seq = newTurns[newTurns.length - 1].seq;
  if (!newTurns.length && !calls.length && !cards) return undefined;
  return { turns: newTurns.map(turnOut), calls, ...(cards ? { cards } : {}) };
}

/** One call's input and output from the chat's transcript: cut at DETAIL_MAX, or whole up to FULL_MAX with `full`. */
export function callDetail(store: Store, id: string, callId: string, full = false): { input: string; output: string; cut: boolean; capped?: boolean; kind?: ToolKind } | { error: string } {
  const t = store.getThread(id);
  if (!t) return { error: 'not found' };
  const row = store.db.prepare('SELECT * FROM tool_calls WHERE thread_id = ? AND call_id = ?').get(id, callId) as any;
  if (!row) return { error: 'not found' };
  const a = adapters[t.agent as AgentId];
  let text = '';
  try {
    text = t.transcript_path ? fs.readFileSync(t.transcript_path, 'utf8') : '';
  } catch {
    text = '';
  }
  const dt = text && a?.toolCallDetail ? a.toolCallDetail(text, callId) : undefined;
  // nothing more in the transcript (a kind the CLI keeps no detail for, or the file is gone): the row's own text
  const input = dt?.input ?? row.target ?? '';
  const output = dt?.output ?? row.detail ?? row.result ?? '';
  const max = full ? FULL_MAX : DETAIL_MAX;
  const cutOut = Buffer.byteLength(output) > max;
  const out = cutOut ? Buffer.from(output).subarray(0, max).toString('utf8').replace(/�+$/, '') : output;
  const cutIn = Buffer.byteLength(input) > max;
  const inp = cutIn ? Buffer.from(input).subarray(0, max).toString('utf8').replace(/�+$/, '') : input;
  return { input: inp, output: out, cut: !full && (cutOut || cutIn), ...(full && (cutOut || cutIn) ? { capped: true } : {}), ...(dt?.cut ? { cut: true } : {}), kind: (row.kind as ToolKind | null) ?? toolKind(row.tool) };
}

/**
 * The text as Chorus types it into the CLI (Stage 0.2, chatview-probe S): a new line is the CLI's NEWLINE_KEYS (Enter alone sends),
 * and a message that ends in an `@path` gets a space after it, or Codex's file menu takes the Enter and nothing is sent.
 */
export function typedText(agent: AgentId, text: string): string {
  let t = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  if (/(^|\s)[@＠]\S+$/.test(t)) t += ' ';
  return t.split('\n').join(NEWLINE_KEYS[agent] ?? '\x1b\r');
}

/** The CLI kept what was typed in its input (it did not take it: an unknown command in Codex, a menu that ate the Enter). */
export function heldInInput(agent: AgentId, rows: ScreenLine[], cols: number, text: string): boolean {
  const st = inputState(agent, rows, cols);
  if (!st.ready || !st.draft.trim()) return false;
  const head = text.replace(/\s+/g, ' ').trim().slice(0, 24);
  return !!head && st.draft.replace(/\s+/g, ' ').includes(head.replace(/^[@＠]/, ''));
}

/** The keys the Chat view's key row sends (Stage 0.4): fixed bytes, nothing else. */
export const KEYS: Record<string, string> = { esc: '\x1b', 'shift-tab': '\x1b[Z' };
