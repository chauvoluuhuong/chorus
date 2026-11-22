// The Chat view's data (plan 2026-11-22 chat-view, docs/features/chat-view.md): a chat drawn from the turns Chorus already captures
// from its CLI's transcript, beside the raw terminal. One session, two views: nothing here starts, resumes or types into a CLI except
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

/** Chorus's own tools that are drawn as cards, not rows (decision 7 of the plan). */
export const CARD_TOOLS = ['start_subthread', 'start_thread', 'show_artifact', 'request_approval', 'ask_main_thread'];
/** The turns a page holds by default. */
export const PAGE_TURNS = 30;
/** A detail is cut here unless the page asks for all of it; all of it is capped at FULL_MAX. */
export const DETAIL_MAX = 4096;
export const FULL_MAX = 256 * 1024;

export interface CvTurn {
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  ts?: string | null;
}
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
  | { type: 'artifact'; id: number; title: string; target: string; rel?: string; link: boolean; kind: string; open: boolean; seq: number | null; at: string }
  | { type: 'mail'; from: string; fromId?: string | null; subject: string; seq: number | null; at: string };

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

const EXT_KIND: Record<string, string> = { '.html': 'html', '.htm': 'html', '.md': 'markdown', '.markdown': 'markdown', '.mmd': 'mermaid', '.mermaid': 'mermaid', '.svg': 'image', '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.pdf': 'pdf', '.txt': 'text', '.json': 'text', '.csv': 'text' };

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
    const ext = path.extname(r.target).toLowerCase();
    // a file in the project shows as its path in the project (site/hero.html), as the agent names it
    const rel = !r.link && r.inside ? path.relative(me.project ?? me.cwd, r.target) : undefined;
    out.push({ type: 'artifact', id: r.id, title: r.title, target: r.target, ...(rel && !rel.startsWith('..') ? { rel } : {}), link: r.link, kind: r.link ? 'link' : EXT_KIND[ext] ?? 'file', open: !r.link && r.inside, seq: seqAt(store, id, r.ts), at: r.ts });
  }
  // mail this chat read: one line each (who it was from)
  const mail = store.db.prepare('SELECT from_thread, from_json, subject, refs, read_at FROM mail WHERE to_thread = ? AND read_at IS NOT NULL ORDER BY read_at').all(id) as { from_thread: string | null; from_json: string; subject: string; refs: string; read_at: string }[];
  for (const m of mail) {
    let who = 'Chorus';
    try {
      const f = JSON.parse(m.from_json);
      // a sub thread's report comes from Chorus about it: it is named after the sub thread
      const about = JSON.parse(m.refs || '{}')?.about;
      const sub = about ? store.getThread(about) : undefined;
      if (f?.thread) who = store.getThread(f.thread)?.title ?? f.role ?? 'a chat';
      else if (sub?.sub_status) who = `the sub thread "${sub.title}"`;
      else if (f?.who && f.who !== 'chorus') who = String(f.who);
    } catch {
      /* the sender stays Chorus */
    }
    out.push({ type: 'mail', from: who, fromId: m.from_thread, subject: clip(m.subject, 160), seq: seqAt(store, id, m.read_at), at: m.read_at });
  }
  return out;
}

/** A page of a chat: `before` a seq (the next older page), else the newest. */
export function turnsPage(d: CvDeps, id: string, o: { before?: number; limit?: number } = {}): CvPage {
  const { store } = d;
  const limit = Math.max(1, Math.min(200, o.limit ?? PAGE_TURNS));
  const turns = store.getTurns(id, { before: o.before, limit }).map(t => ({ seq: t.seq, role: t.role, text: t.text, ts: t.ts ?? null })) as CvTurn[];
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
  return { turns: newTurns.map(t => ({ seq: t.seq, role: t.role, text: t.text, ts: t.ts ?? null })), calls, ...(cards ? { cards } : {}) };
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
