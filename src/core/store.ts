// Shared store: .chorus/chorus.db (SQLite, WAL), used by the CLI app and every `chorus mcp` process.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MailMessage, MailState, MailStore, WatchEventRecord, WatchState, WatchStore } from '@chauvoluuhuong/chorus-core';
import type { AgentId, Session, ToolCall, Turn, Usage } from './types.ts';
import { maskSecrets } from './adapters/util.ts';

export type ThreadState = 'working' | 'waiting' | 'ended';
/** A sub thread: in a turn, its turn ended (`stopped`), held by an approval, no activity for a while, or its chat ended. */
export type SubStatus = 'working' | 'stopped' | 'waiting_user' | 'quiet' | 'ended';
/** The sub thread columns on `threads`. */
export type SubFields = Pick<ThreadRow, 'sub_status' | 'sub_brief' | 'sub_started' | 'sub_last_activity' | 'sub_ended' | 'sub_turns' | 'sub_working_ms' | 'sub_reported'>;

export interface ThreadRow {
  id: string;
  title: string;
  agent: AgentId;
  model: string | null;
  cwd: string;
  native_session_id: string | null;
  parent_thread_id: string | null;
  state: ThreadState;
  cli_version: string | null;
  transcript_path: string | null;
  /** the project folder whose .chorus/ holds this thread's artifacts (the store itself may be shared, see Store) */
  project: string | null;
  /** 1 when the chat runs with permission prompts off */
  skip_permissions: number;
  /** reasoning effort chosen for the chat (null = the agent's default) */
  effort: string | null;
  /** the last turn of earlier sessions: a new session of this chat (its CLI lost the old one) saves its turns after them */
  turn_base?: number;
  /** set only for a sub thread (src/serve/subthreads.ts): its status; its parent is parent_thread_id */
  sub_status?: SubStatus | null;
  /** what the main chat asked it to do */
  sub_brief?: string | null;
  sub_started?: string | null;
  sub_last_activity?: string | null;
  sub_ended?: string | null;
  sub_turns?: number;
  /** time spent in turns */
  sub_working_ms?: number;
  /** when its latest report was typed into the main chat (null: one is due) */
  sub_reported?: string | null;
  /** the pid of the chat's CLI while it runs (set by `chorus serve` when it spawns it): `chorus mcp` finds its chat by it */
  cli_pid?: number | null;
  created: string;
  updated: string;
}

export interface ApprovalLogRow {
  id: number;
  thread_id: string;
  what: string;
  decision: 'approved' | 'denied';
  ts: string;
}

/** A question an agent put to the user through the chorus `request_approval` tool (shown as a card, answered in Chorus). */
export interface RequestRow {
  id: string;
  thread_id: string;
  question: string;
  details: string | null;
  options: string[];
  status: 'pending' | 'answered' | 'cancelled';
  /** a question (open: it can be skipped, the agent decides itself) or an approval (Approve / Decline of an action) */
  kind: 'question' | 'approval';
  /** 0: only the listed options make sense, the card has no "Other…" */
  other: number;
  answer: string | null;
  note: string | null;
  created: string;
  answered: string | null;
}

/** A sub thread's question to its main thread (ask_main_thread): typed into the main chat, answered by send_to_subthread. */
export interface AskRow {
  id: string;
  /** the sub thread that asks */
  thread_id: string;
  /** its main thread */
  parent_id: string;
  kind: 'approval' | 'question';
  question: string;
  details: string | null;
  options: string[];
  created: string;
  /** when it was typed into the main chat */
  typed: string | null;
  answered: string | null;
}

/** A file or link an agent reported with the chorus `show_artifact` tool (plan 2026-11-13): wherever it is saved. */
export interface ReportedArtifact {
  id: number;
  thread_id: string;
  /** an absolute path, or an http(s) link */
  target: string;
  title: string | null;
  ts: string;
}

export interface ArtifactRow {
  thread_id: string;
  path: string;
  version: string;
  ts: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL, model TEXT, cwd TEXT NOT NULL,
  native_session_id TEXT, parent_thread_id TEXT, state TEXT NOT NULL DEFAULT 'waiting',
  cli_version TEXT, transcript_path TEXT, project TEXT, skip_permissions INTEGER NOT NULL DEFAULT 0, effort TEXT,
  created TEXT NOT NULL, updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS turns (
  thread_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, ts TEXT,
  PRIMARY KEY (thread_id, seq)
);
CREATE TABLE IF NOT EXISTS tool_calls (
  thread_id TEXT NOT NULL, call_id TEXT NOT NULL, turn_seq INTEGER NOT NULL, tool TEXT NOT NULL,
  target TEXT NOT NULL, status TEXT NOT NULL, result TEXT, duration_ms INTEGER, note TEXT, detail TEXT,
  PRIMARY KEY (thread_id, call_id)
);
CREATE TABLE IF NOT EXISTS usage (
  thread_id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  cost_usd REAL, limit_utilization REAL, limit_resets_at TEXT, limit_status TEXT, updated TEXT
);
CREATE TABLE IF NOT EXISTS artifacts (
  thread_id TEXT NOT NULL, path TEXT NOT NULL, version TEXT NOT NULL, ts TEXT NOT NULL,
  PRIMARY KEY (thread_id, path, version)
);
CREATE TABLE IF NOT EXISTS approvals_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, what TEXT NOT NULL, decision TEXT NOT NULL, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, tool TEXT NOT NULL, ts TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, path TEXT NOT NULL, original_path TEXT, copied INTEGER NOT NULL,
  bytes INTEGER, created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, question TEXT NOT NULL, details TEXT, options TEXT NOT NULL,
  status TEXT NOT NULL, answer TEXT, note TEXT, created TEXT NOT NULL, answered TEXT, kind TEXT NOT NULL DEFAULT 'approval', other INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS asks (
  id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, parent_id TEXT NOT NULL, kind TEXT NOT NULL, question TEXT NOT NULL, details TEXT,
  options TEXT NOT NULL DEFAULT '[]', created TEXT NOT NULL, typed TEXT, answered TEXT
);
CREATE TABLE IF NOT EXISTS skill_sources (path TEXT PRIMARY KEY, kind TEXT NOT NULL, added TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skills (dir TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, seen TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skill_links (dir TEXT NOT NULL, cli TEXT NOT NULL, path TEXT NOT NULL, made TEXT NOT NULL, PRIMARY KEY (dir, cli));
CREATE TABLE IF NOT EXISTS reported (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, target TEXT NOT NULL, title TEXT, ts TEXT NOT NULL
);
-- the mailbox (task #10, chorus-core src/mail/): every message between chats and from Chorus to a chat
CREATE TABLE IF NOT EXISTS mail (
  id TEXT PRIMARY KEY, from_thread TEXT, from_json TEXT NOT NULL, to_thread TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL,
  body TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '{}', meta TEXT, state TEXT NOT NULL, channel TEXT, tries INTEGER NOT NULL DEFAULT 0,
  error TEXT, created_at TEXT NOT NULL, delivered_at TEXT, read_at TEXT, answered_at TEXT
);
CREATE INDEX IF NOT EXISTS mail_to ON mail (to_thread, state);
CREATE INDEX IF NOT EXISTS mail_state ON mail (state);
CREATE INDEX IF NOT EXISTS mail_from ON mail (from_thread);
-- the one watcher (task #10, chorus-core src/watch/): each watch's state, data and deadline, so a restart keeps them
CREATE TABLE IF NOT EXISTS watch (
  key TEXT PRIMARY KEY, thread TEXT NOT NULL, belongs_to TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL, expect TEXT NOT NULL,
  seen TEXT, since INTEGER, waits_on TEXT, deadline INTEGER, data TEXT NOT NULL DEFAULT '{}', extra TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS watch_belongs ON watch (belongs_to);
CREATE INDEX IF NOT EXISTS watch_thread ON watch (thread);
CREATE INDEX IF NOT EXISTS watch_ended ON watch (ended_at);
CREATE TABLE IF NOT EXISTS watch_event (
  id INTEGER PRIMARY KEY, key TEXT NOT NULL, thread TEXT NOT NULL, belongs_to TEXT NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL,
  detail TEXT, action TEXT
);
CREATE INDEX IF NOT EXISTS watch_event_key ON watch_event (key);
CREATE INDEX IF NOT EXISTS watch_event_belongs ON watch_event (belongs_to);
`;

/** watch_event keeps the last 30 days, at most this many rows (pruned at start). */
export const WATCH_EVENTS_KEPT = 50_000;
const WATCH_EVENT_DAYS = 30;

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
const parse = <T>(s: string | null | undefined, d: T): T => {
  if (s == null) return d;
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};
const opt = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);
/** a record without its unset fields (rows read back equal what was written) */
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const now = () => new Date().toISOString();

export interface StoreOpts {
  /**
   * Keep the database in this folder (default: env CHORUS_HOME, else the project's own .chorus/). With a home folder every
   * project shares one database, so chats, memory and handoff work across projects; artifacts stay in each project's folder.
   */
  home?: string;
}

export class Store {
  readonly db: DatabaseSync;
  /** where chorus.db lives */
  readonly root: string;
  /** true when the database is shared by every project */
  readonly shared: boolean;
  /** the project this process works in (the default for new threads) */
  readonly project: string;

  constructor(project: string, opts: StoreOpts = {}) {
    this.project = project;
    const home = opts.home ?? process.env.CHORUS_HOME;
    this.shared = !!home;
    this.root = home ? path.resolve(home) : path.join(project, '.chorus');
    fs.mkdirSync(this.root, { recursive: true });
    this.db = new DatabaseSync(path.join(this.root, 'chorus.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.migrate();
    this.pruneWatchEvents();
  }

  /** watch_event: the last 30 days, at most WATCH_EVENTS_KEPT rows. */
  pruneWatchEvents(at = Date.now(), keep = WATCH_EVENTS_KEPT) {
    this.db.prepare('DELETE FROM watch_event WHERE at < ?').run(at - WATCH_EVENT_DAYS * 86_400_000);
    this.db.prepare('DELETE FROM watch_event WHERE id <= (SELECT id FROM watch_event ORDER BY id DESC LIMIT 1 OFFSET ?)').run(keep);
  }

  /* ---------- the mailbox's records (chorus-core MailStore) ---------- */

  private mailRow(r: any): MailMessage {
    return defined({
      id: r.id, from: parse(r.from_json, { who: 'chorus' as const }), to: { thread: r.to_thread }, kind: r.kind, subject: r.subject, body: r.body,
      refs: parse(r.refs, {}), ...(r.meta != null ? { meta: parse(r.meta, {}) } : {}), state: r.state, channel: opt(r.channel), tries: r.tries,
      error: opt(r.error), created_at: r.created_at, delivered_at: opt(r.delivered_at), read_at: opt(r.read_at), answered_at: opt(r.answered_at),
    });
  }

  /** The `mail` table as the Mailbox's store. */
  mailStore(): MailStore {
    const db = this.db;
    const COLS: Record<string, (m: Partial<MailMessage>) => unknown> = {
      from_thread: m => m.from?.thread ?? null, from_json: m => json(m.from), to_thread: m => m.to?.thread, kind: m => m.kind, subject: m => m.subject,
      body: m => m.body, refs: m => json(m.refs ?? {}), meta: m => json(m.meta), state: m => m.state, channel: m => m.channel ?? null, tries: m => m.tries ?? 0,
      error: m => m.error ?? null, created_at: m => m.created_at, delivered_at: m => m.delivered_at ?? null, read_at: m => m.read_at ?? null, answered_at: m => m.answered_at ?? null,
    };
    // which columns a field of MailMessage writes
    const FIELD: Record<string, string[]> = { from: ['from_thread', 'from_json'], to: ['to_thread'] };
    return {
      insert: m => {
        const cols = Object.keys(COLS);
        db.prepare(`INSERT INTO mail (id,${cols.join(',')}) VALUES (?,${cols.map(() => '?').join(',')})`).run(m.id, ...(cols.map(c => COLS[c](m)) as any[]));
      },
      update: (id, f) => {
        const cols = [...new Set(Object.keys(f).flatMap(k => FIELD[k] ?? (k in COLS ? [k] : [])))];
        if (!cols.length) return;
        db.prepare(`UPDATE mail SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`).run(...(cols.map(c => COLS[c](f)) as any[]), id);
      },
      get: id => {
        const r = db.prepare('SELECT * FROM mail WHERE id = ?').get(id);
        return r ? this.mailRow(r) : undefined;
      },
      list: (q: { to?: string; from?: string; state?: MailState[] }) => {
        const where: string[] = [], args: string[] = [];
        if (q.to !== undefined) where.push('to_thread = ?'), args.push(q.to);
        if (q.from !== undefined) where.push('from_thread = ?'), args.push(q.from);
        if (q.state) where.push(`state IN (${q.state.map(() => '?').join(',') || "''"})`), args.push(...q.state);
        return (db.prepare(`SELECT * FROM mail${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid`).all(...args) as any[]).map(r => this.mailRow(r));
      },
    };
  }

  /* ---------- the watcher's records (chorus-core WatchStore) ---------- */

  /** The `watch` and `watch_event` tables as the TurnWatch's store. */
  watchStore(): WatchStore {
    const db = this.db;
    return {
      load: () =>
        (db.prepare('SELECT * FROM watch WHERE ended_at IS NULL ORDER BY created_at').all() as any[]).map(r => this.watchRow(r)),
      save: (s: WatchState) => {
        const extra = { waitOverAt: s.waitOverAt, idleAt: s.idleAt, activity: s.activity, activityAt: s.activityAt, quietSent: s.quietSent };
        db.prepare(
          `INSERT INTO watch (key,thread,belongs_to,kind,owner,expect,seen,since,waits_on,deadline,data,extra,created_at,ended_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET thread=excluded.thread, belongs_to=excluded.belongs_to, kind=excluded.kind, owner=excluded.owner, expect=excluded.expect,
           seen=excluded.seen, since=excluded.since, waits_on=excluded.waits_on, deadline=excluded.deadline, data=excluded.data, extra=excluded.extra,
           created_at=excluded.created_at, ended_at=excluded.ended_at`,
        ).run(s.key, s.thread, s.belongsTo, s.kind, s.owner, s.expect, s.seen ?? null, s.since ?? null, json(s.waitsOn), s.deadline ?? null, JSON.stringify(s.data ?? {}), JSON.stringify(extra), s.created_at, s.ended_at ?? null);
      },
      event: (e: WatchEventRecord) => {
        db.prepare('INSERT INTO watch_event (key,thread,belongs_to,type,at,detail,action) VALUES (?,?,?,?,?,?,?)').run(e.key, e.thread, e.belongsTo, e.type, e.at, json(e.detail), e.action ?? null);
      },
    };
  }

  private watchRow(r: any): WatchState {
    const x = parse<Partial<WatchState>>(r.extra, {});
    return defined({
      key: r.key, thread: r.thread, belongsTo: r.belongs_to, kind: r.kind, owner: r.owner, expect: r.expect, seen: opt(r.seen), since: opt(r.since),
      waitsOn: parse<string[] | undefined>(r.waits_on, undefined), deadline: opt(r.deadline), waitOverAt: x.waitOverAt, idleAt: x.idleAt,
      activity: x.activity, activityAt: x.activityAt, quietSent: x.quietSent, data: parse(r.data, {}), created_at: r.created_at, ended_at: opt(r.ended_at),
    });
  }

  /** One watch record, open or ended. */
  watchRecord(key: string): WatchState | undefined {
    const r = this.db.prepare('SELECT * FROM watch WHERE key = ?').get(key);
    return r ? this.watchRow(r) : undefined;
  }

  /** Watch records kept for one chat that ended at or after `since`, newest first (list_watches with ended). */
  endedWatches(belongsTo: string, since: number, limit = 20): WatchState[] {
    return (this.db.prepare('SELECT * FROM watch WHERE belongs_to = ? AND ended_at IS NOT NULL AND ended_at >= ? ORDER BY ended_at DESC LIMIT ?').all(belongsTo, since, limit) as any[]).map(r => this.watchRow(r));
  }

  /** The watcher's log of one watch (key) or of everything kept for one chat (belongsTo); oldest first. */
  watchEvents(q: { key?: string; belongsTo?: string }): WatchEventRecord[] {
    const rows = (q.key !== undefined ? this.db.prepare('SELECT * FROM watch_event WHERE key = ? ORDER BY id').all(q.key) : this.db.prepare('SELECT * FROM watch_event WHERE belongs_to = ? ORDER BY id').all(q.belongsTo ?? '')) as any[];
    return rows.map(r => ({ key: r.key, thread: r.thread, belongsTo: r.belongs_to, type: r.type, at: r.at, detail: parse(r.detail, undefined), ...(r.action != null ? { action: r.action } : {}) }));
  }

  /** Databases made before the shared store lack these columns. */
  private migrate() {
    const cols = (this.db.prepare('PRAGMA table_info(threads)').all() as { name: string }[]).map(c => c.name);
    if (!cols.includes('project')) this.db.exec('ALTER TABLE threads ADD COLUMN project TEXT');
    if (!cols.includes('skip_permissions')) this.db.exec('ALTER TABLE threads ADD COLUMN skip_permissions INTEGER NOT NULL DEFAULT 0');
    const tcols = (this.db.prepare('PRAGMA table_info(tool_calls)').all() as { name: string }[]).map(c => c.name);
    if (!tcols.includes('note')) this.db.exec('ALTER TABLE tool_calls ADD COLUMN note TEXT');
    if (!tcols.includes('detail')) this.db.exec('ALTER TABLE tool_calls ADD COLUMN detail TEXT');
    if (!cols.includes('effort')) this.db.exec('ALTER TABLE threads ADD COLUMN effort TEXT');
    if (!cols.includes('turn_base')) this.db.exec('ALTER TABLE threads ADD COLUMN turn_base INTEGER NOT NULL DEFAULT 0');
    // sub threads (plan 2026-11-14, Stage 2): free, so on Chorus's own threads table
    for (const [col, type] of [['sub_status', 'TEXT'], ['sub_brief', 'TEXT'], ['sub_started', 'TEXT'], ['sub_last_activity', 'TEXT'], ['sub_ended', 'TEXT'], ['sub_turns', 'INTEGER NOT NULL DEFAULT 0'], ['sub_working_ms', 'INTEGER NOT NULL DEFAULT 0'], ['sub_reported', 'TEXT']])
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE threads ADD COLUMN ${col} ${type}`);
    if (!cols.includes('cli_pid')) this.db.exec('ALTER TABLE threads ADD COLUMN cli_pid INTEGER');
    const rcols = (this.db.prepare('PRAGMA table_info(requests)').all() as { name: string }[]).map(c => c.name);
    if (!rcols.includes('kind')) this.db.exec("ALTER TABLE requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'approval'");
    if (!rcols.includes('other')) this.db.exec('ALTER TABLE requests ADD COLUMN other INTEGER NOT NULL DEFAULT 1');
  }

  /**
   * Copies the threads of a project's own .chorus/chorus.db into this (shared) database, once. Rows whose id exists are skipped.
   * Returns how many threads came over.
   */
  importLocal(project: string): number {
    const file = path.join(project, '.chorus', 'chorus.db');
    if (!this.shared || !fs.existsSync(file) || path.resolve(file) === path.join(this.root, 'chorus.db')) return 0;
    const src = new DatabaseSync(file, { readOnly: true });
    try {
      const ids = new Set((this.db.prepare('SELECT id FROM threads').all() as { id: string }[]).map(r => r.id));
      const threads = src.prepare('SELECT * FROM threads').all() as any[];
      let n = 0;
      this.db.exec('BEGIN');
      for (const t of threads) {
        if (ids.has(t.id)) continue;
        this.db.prepare(
          `INSERT INTO threads (id,title,agent,model,cwd,native_session_id,parent_thread_id,state,cli_version,transcript_path,project,skip_permissions,effort,created,updated)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(t.id, t.title, t.agent, t.model, t.cwd, t.native_session_id, t.parent_thread_id, t.state, t.cli_version, t.transcript_path, t.project ?? project, t.skip_permissions ?? 0, t.effort ?? null, t.created, t.updated);
        for (const [table, cols] of [
          ['turns', 'thread_id,seq,role,text,ts'],
          ['tool_calls', 'thread_id,call_id,turn_seq,tool,target,status,result,duration_ms'],
          ['usage', 'thread_id,input_tokens,output_tokens,cache_read_tokens,cost_usd,limit_utilization,limit_resets_at,limit_status,updated'],
          ['artifacts', 'thread_id,path,version,ts'],
        ] as const) {
          const marks = cols.split(',').map(() => '?').join(',');
          const ins = this.db.prepare(`INSERT OR IGNORE INTO ${table} (${cols}) VALUES (${marks})`);
          for (const r of src.prepare(`SELECT ${cols} FROM ${table} WHERE thread_id = ?`).all(t.id) as any[]) ins.run(...cols.split(',').map(c => r[c] ?? null));
        }
        n++;
      }
      this.db.exec('COMMIT');
      return n;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* nothing open */
      }
      throw e;
    } finally {
      src.close();
    }
  }

  close() {
    this.db.close();
  }

  /** The project folder a thread belongs to: its artifacts live in <project>/.chorus/threads/<id>/. */
  projectOf(id: string): string {
    const r = this.db.prepare('SELECT project FROM threads WHERE id = ?').get(id) as { project: string | null } | undefined;
    return r?.project ?? this.project;
  }
  threadDir(id: string) {
    return path.join(this.projectOf(id), '.chorus', 'threads', id);
  }
  artifactsDir(id: string) {
    return path.join(this.threadDir(id), 'artifacts');
  }
  /** Files the user dropped on the chat and asked to copy (or that had no path): <project>/.chorus/threads/<id>/attachments/ */
  attachmentsDir(id: string) {
    return path.join(this.threadDir(id), 'attachments');
  }

  /** A file the user gave this chat by dropping it: where the agent reads it, and where it came from when it was copied. */
  addAttachment(threadId: string, a: { path: string; originalPath?: string; copied: boolean; bytes?: number }) {
    this.db.prepare('INSERT INTO attachments (thread_id,path,original_path,copied,bytes,created) VALUES (?,?,?,?,?,?)').run(threadId, a.path, a.originalPath ?? null, a.copied ? 1 : 0, a.bytes ?? null, now());
  }
  attachments(threadId: string): { path: string; originalPath?: string; copied: boolean; bytes?: number; created: string }[] {
    return (this.db.prepare('SELECT * FROM attachments WHERE thread_id = ? ORDER BY id').all(threadId) as any[]).map(r => ({ path: r.path, originalPath: r.original_path ?? undefined, copied: !!r.copied, bytes: r.bytes ?? undefined, created: r.created }));
  }

  createThread(t: Partial<ThreadRow> & { title: string; agent: AgentId; cwd: string }): ThreadRow {
    const row: ThreadRow = {
      id: t.id ?? 't_' + randomUUID().slice(0, 8),
      title: t.title,
      agent: t.agent,
      model: t.model ?? null,
      cwd: t.cwd,
      native_session_id: t.native_session_id ?? null,
      parent_thread_id: t.parent_thread_id ?? null,
      state: t.state ?? 'waiting',
      cli_version: t.cli_version ?? null,
      transcript_path: t.transcript_path ?? null,
      project: t.project ?? this.project,
      skip_permissions: t.skip_permissions ?? 0,
      effort: t.effort ?? null,
      created: now(),
      updated: now(),
    };
    this.db
      .prepare(
        `INSERT INTO threads (id,title,agent,model,cwd,native_session_id,parent_thread_id,state,cli_version,transcript_path,project,skip_permissions,effort,created,updated)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(row.id, row.title, row.agent, row.model, row.cwd, row.native_session_id, row.parent_thread_id, row.state, row.cli_version, row.transcript_path, row.project, row.skip_permissions, row.effort, row.created, row.updated);
    fs.mkdirSync(this.artifactsDir(row.id), { recursive: true });
    return row;
  }

  /** Removes a chat and everything recorded for it. Chats continued from it stay, without the link. Files in the project stay. */
  deleteThread(id: string) {
    const db = this.db;
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE threads SET parent_thread_id = NULL WHERE parent_thread_id = ?').run(id);
      for (const table of ['turns', 'tool_calls', 'usage', 'artifacts', 'approvals_log', 'mcp_calls', 'requests', 'attachments', 'reported', 'asks']) db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(id);
      db.prepare('DELETE FROM threads WHERE id = ?').run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /** The chat's CLI lost its session: a new one starts, and its turns are saved after the ones the chat has. */
  startOver(id: string) {
    const last = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM turns WHERE thread_id = ?').get(id) as { n: number }).n;
    this.updateThread(id, { turn_base: last, transcript_path: null });
  }

  updateThread(id: string, patch: Partial<Omit<ThreadRow, 'id' | 'created'>>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map(k => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE threads SET ${sets}, updated = ? WHERE id = ?`).run(...keys.map(k => (patch[k] ?? null) as any), now(), id);
  }

  getThread(id: string): ThreadRow | undefined {
    return this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined;
  }

  /** Sets a sub thread's fields (without touching `updated`, which says when the chat itself changed). */
  setSub(id: string, patch: Partial<SubFields>) {
    const keys = Object.keys(patch) as (keyof SubFields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE threads SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => (patch[k] ?? null) as any), id);
  }

  /** The chat's CLI started (a pid) or ended (null). Like setSub, `updated` stays. */
  setCliPid(id: string, pid: number | null) {
    this.db.prepare('UPDATE threads SET cli_pid = ? WHERE id = ?').run(pid, id);
  }

  /** The chat whose CLI runs as this pid now (the newest, should a pid be reused). */
  threadByCliPid(pid: number): ThreadRow | undefined {
    return this.db.prepare("SELECT * FROM threads WHERE cli_pid = ? AND state != 'ended' ORDER BY updated DESC LIMIT 1").get(pid) as ThreadRow | undefined;
  }

  /* ---------- a sub thread asks its main thread (ask_main_thread) ---------- */

  createAsk(a: { threadId: string; parentId: string; kind?: 'approval' | 'question'; question: string; details?: string; options?: string[] }): AskRow {
    const id = `q_${randomBytes(4).toString('hex')}`;
    this.db.prepare('INSERT INTO asks (id,thread_id,parent_id,kind,question,details,options,created) VALUES (?,?,?,?,?,?,?,?)').run(id, a.threadId, a.parentId, a.kind === 'approval' ? 'approval' : 'question', a.question, a.details?.trim() || null, JSON.stringify(a.options ?? []), now());
    return this.getAsk(id)!;
  }

  getAsk(id: string): AskRow | undefined {
    const r = this.db.prepare('SELECT * FROM asks WHERE id = ?').get(id) as any;
    return r ? { ...r, options: JSON.parse(r.options) } : undefined;
  }

  /** Unanswered asks of a sub thread (`thread`) or waiting for a main thread (`parent`); oldest first. */
  openAsks(o: { thread?: string; parent?: string }): AskRow[] {
    const rows = (o.thread ? this.db.prepare('SELECT * FROM asks WHERE answered IS NULL AND thread_id = ? ORDER BY created').all(o.thread) : this.db.prepare('SELECT * FROM asks WHERE answered IS NULL AND parent_id = ? ORDER BY created').all(o.parent ?? '')) as any[];
    return rows.map(r => ({ ...r, options: JSON.parse(r.options) }));
  }

  /** Asks not yet delivered to their main thread and not answered. */
  untypedAsks(): AskRow[] {
    return (this.db.prepare('SELECT * FROM asks WHERE typed IS NULL AND answered IS NULL ORDER BY created').all() as any[]).map(r => ({ ...r, options: JSON.parse(r.options) }));
  }

  /** Marks an ask delivered into its main thread (by the mailbox; the column keeps its old name). */
  askTyped(id: string) {
    this.db.prepare('UPDATE asks SET typed = ? WHERE id = ? AND typed IS NULL').run(now(), id);
  }

  /** The main thread answered the sub thread: every open ask of it is answered. Returns how many. */
  answerAsks(thread: string): number {
    return Number(this.db.prepare('UPDATE asks SET answered = ? WHERE thread_id = ? AND answered IS NULL').run(now(), thread).changes);
  }

  /** Every sub thread, or those of one main chat; oldest first. */
  subThreads(parent?: string): ThreadRow[] {
    return (parent
      ? this.db.prepare('SELECT * FROM threads WHERE sub_status IS NOT NULL AND parent_thread_id = ? ORDER BY sub_started, created').all(parent)
      : this.db.prepare('SELECT * FROM threads WHERE sub_status IS NOT NULL ORDER BY sub_started, created').all()) as unknown as ThreadRow[];
  }

  /** How much a thread has done (turns and tool calls recorded): it changes when the thread shows activity. */
  activityMark(id: string): string {
    const t = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS m FROM turns WHERE thread_id = ?').get(id) as { n: number; m: number };
    const c = this.db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE thread_id = ?').get(id) as { n: number };
    return `${t.n}/${t.m}/${c.n}`;
  }

  /** The text of a thread's last reply (its last assistant turn), or ''. */
  lastReply(id: string): string {
    const r = this.db.prepare("SELECT text FROM turns WHERE thread_id = ? AND role = 'assistant' ORDER BY seq DESC LIMIT 1").get(id) as { text: string } | undefined;
    return r?.text ?? '';
  }

  listThreads(): ThreadRow[] {
    return this.db.prepare('SELECT * FROM threads ORDER BY updated DESC').all() as unknown as ThreadRow[];
  }

  /** Replace a thread's captured record with the latest parse of its CLI session (idempotent). */
  recordSession(threadId: string, s: Session, extra: { transcriptPath?: string } = {}) {
    const db = this.db;
    // the session's own turns come after those of the chat's earlier sessions (startOver)
    const base = this.getThread(threadId)?.turn_base ?? 0;
    db.exec('BEGIN');
    try {
      // upsert: a tailed session only grows, so rewriting every row each time would get slower with every turn
      db.prepare('DELETE FROM turns WHERE thread_id = ? AND seq > ?').run(threadId, base + s.turns.length);
      const have = (db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE thread_id = ? AND turn_seq > ?').get(threadId, base) as any).n as number;
      if (have > s.toolCalls.length) db.prepare('DELETE FROM tool_calls WHERE thread_id = ? AND turn_seq > ?').run(threadId, base);
      const ti = db.prepare('INSERT OR REPLACE INTO turns (thread_id,seq,role,text,ts) VALUES (?,?,?,?,?)');
      for (const t of s.turns) ti.run(threadId, base + t.seq, t.role, t.text, t.ts ?? null);
      const ci = db.prepare(
        'INSERT OR REPLACE INTO tool_calls (thread_id,call_id,turn_seq,tool,target,status,result,duration_ms,note,detail) VALUES (?,?,?,?,?,?,?,?,?,?)',
      );
      for (const c of s.toolCalls) ci.run(threadId, c.id, base + c.turnSeq, c.tool, maskSecrets(c.target), c.status, c.result ? maskSecrets(c.result) : null, c.durationMs ?? null, c.note ?? null, c.detail ? maskSecrets(c.detail) : null);
      db.prepare(
        `INSERT OR REPLACE INTO usage (thread_id,input_tokens,output_tokens,cache_read_tokens,cost_usd,limit_utilization,limit_resets_at,limit_status,updated)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(threadId, s.usage.inputTokens, s.usage.outputTokens, s.usage.cacheReadTokens, s.usage.costUsd ?? null, s.limit?.utilization ?? null, s.limit?.resetsAt ?? null, s.limit?.status ?? null, now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.updateThread(threadId, {
      ...(s.nativeSessionId ? { native_session_id: s.nativeSessionId } : {}),
      ...(s.model ? { model: s.model } : {}),
      ...(s.cliVersion ? { cli_version: s.cliVersion } : {}),
      ...(extra.transcriptPath ? { transcript_path: extra.transcriptPath } : {}),
    });
  }

  getTurns(threadId: string, opts: { before?: number; limit?: number } = {}): Turn[] {
    const limit = opts.limit ?? 20;
    const rows = this.db
      .prepare('SELECT seq,role,text,ts FROM turns WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
      .all(threadId, opts.before ?? Number.MAX_SAFE_INTEGER, limit) as unknown as Turn[];
    return rows.reverse();
  }

  getToolCalls(threadId: string): ToolCall[] {
    const rows = this.db.prepare('SELECT * FROM tool_calls WHERE thread_id = ? ORDER BY rowid').all(threadId) as any[];
    return rows.map(r => ({ id: r.call_id, turnSeq: r.turn_seq, tool: r.tool, target: r.target, status: r.status, result: r.result ?? undefined, durationMs: r.duration_ms ?? undefined, note: r.note ?? undefined, detail: r.detail ?? undefined }));
  }

  getUsage(threadId: string): (Usage & { limitUtilization?: number }) | undefined {
    const r = this.db.prepare('SELECT * FROM usage WHERE thread_id = ?').get(threadId) as any;
    return r && { inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, costUsd: r.cost_usd ?? undefined, limitUtilization: r.limit_utilization ?? undefined };
  }

  /** Register files under the thread's artifacts folder; a changed file becomes a new version. */
  scanArtifacts(threadId: string): ArtifactRow[] {
    const dir = this.artifactsDir(threadId);
    const added: ArtifactRow[] = [];
    const walk = (d: string) => {
      for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else {
          const version = createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
          const rel = path.relative(dir, p);
          const exists = this.db.prepare('SELECT 1 FROM artifacts WHERE thread_id=? AND path=? AND version=?').get(threadId, rel, version);
          if (!exists) {
            const row = { thread_id: threadId, path: rel, version, ts: now() };
            this.db.prepare('INSERT INTO artifacts (thread_id,path,version,ts) VALUES (?,?,?,?)').run(row.thread_id, row.path, row.version, row.ts);
            added.push(row);
          }
        }
      }
    };
    walk(dir);
    return added;
  }

  listArtifacts(threadId?: string): (ArtifactRow & { abs: string })[] {
    const rows = (threadId
      ? this.db.prepare('SELECT * FROM artifacts WHERE thread_id = ? ORDER BY ts').all(threadId)
      : this.db.prepare('SELECT * FROM artifacts ORDER BY ts').all()) as unknown as ArtifactRow[];
    // latest version per path
    const latest = new Map<string, ArtifactRow>();
    for (const r of rows) latest.set(r.thread_id + '\0' + r.path, r);
    return [...latest.values()].map(r => ({ ...r, abs: path.join(this.artifactsDir(r.thread_id), r.path) }));
  }

  /** Every version of every file in the chat's artifacts folder (scanArtifacts adds a row per new content): grows on each edit. */
  artifactVersions(threadId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE thread_id = ?').get(threadId) as { n: number }).n;
  }

  logMcpCall(threadId: string | undefined, tool: string) {
    this.db.prepare('INSERT INTO mcp_calls (thread_id,tool,ts) VALUES (?,?,?)').run(threadId ?? null, tool, now());
  }

  /** Every approve/deny answered from Chorus is kept, so "what did I approve?" has an answer. */
  logApproval(threadId: string, what: string, decision: 'approved' | 'denied') {
    this.db.prepare('INSERT INTO approvals_log (thread_id,what,decision,ts) VALUES (?,?,?,?)').run(threadId, what, decision, now());
  }

  approvalsLog(limit = 20): ApprovalLogRow[] {
    return this.db.prepare('SELECT * FROM approvals_log ORDER BY id DESC LIMIT ?').all(limit) as unknown as ApprovalLogRow[];
  }

  /**
   * An agent asks the user something (the chorus request_approval tool); the app that hosts the chat shows it. One open ask per
   * chat: the chat's older pending asks are cancelled (not answered, so nothing goes to the approvals log).
   */
  createRequest(r: { threadId: string; question: string; details?: string; options?: string[]; kind?: 'question' | 'approval'; other?: boolean }): RequestRow {
    const id = `r_${randomBytes(4).toString('hex')}`;
    this.db.prepare("UPDATE requests SET status = 'cancelled', answered = ? WHERE thread_id = ? AND status = 'pending'").run(now(), r.threadId);
    this.db.prepare("INSERT INTO requests (id,thread_id,question,details,options,status,created,kind,other) VALUES (?,?,?,?,?,'pending',?,?,?)").run(id, r.threadId, r.question, r.details ?? null, JSON.stringify(r.options?.length ? r.options : ['Approve', 'Decline']), now(), r.kind === 'question' ? 'question' : 'approval', r.other === false ? 0 : 1);
    return this.getRequest(id)!;
  }

  getRequest(id: string): RequestRow | undefined {
    const r = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as any;
    return r ? { ...r, options: JSON.parse(r.options) } : undefined;
  }

  pendingRequests(threadId?: string): RequestRow[] {
    const rows = (threadId ? this.db.prepare("SELECT * FROM requests WHERE status = 'pending' AND thread_id = ? ORDER BY created").all(threadId) : this.db.prepare("SELECT * FROM requests WHERE status = 'pending' ORDER BY created").all()) as any[];
    return rows.map(r => ({ ...r, options: JSON.parse(r.options) }));
  }

  /** Answers a pending request once; false when it was already answered or cancelled (by another window or app). */
  answerRequest(id: string, answer: string, note?: string, status: 'answered' | 'cancelled' = 'answered'): boolean {
    return Number(this.db.prepare("UPDATE requests SET status = ?, answer = ?, note = ?, answered = ? WHERE id = ? AND status = 'pending'").run(status, answer, note ?? null, now(), id).changes) > 0;
  }

  /** show_artifact: the agent reports a file (absolute path) or a link it made for the user. The same target again moves it up. */
  reportArtifact(threadId: string, target: string, title?: string): ReportedArtifact {
    this.db.prepare('DELETE FROM reported WHERE thread_id = ? AND target = ?').run(threadId, target);
    const r = this.db.prepare('INSERT INTO reported (thread_id,target,title,ts) VALUES (?,?,?,?)').run(threadId, target, title?.trim() || null, now());
    return this.db.prepare('SELECT * FROM reported WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as ReportedArtifact;
  }

  /** What a chat reported, newest first. */
  reportedArtifacts(threadId: string): ReportedArtifact[] {
    return this.db.prepare('SELECT * FROM reported WHERE thread_id = ? ORDER BY id DESC').all(threadId) as unknown as ReportedArtifact[];
  }

  /* ---------- Sync skills (src/core/skillsync.ts): the sources the user added, the skills last seen, the links Chorus made ---------- */

  skillSources(): { path: string; kind: 'folder' | 'skill'; added: string }[] {
    return this.db.prepare('SELECT * FROM skill_sources ORDER BY added').all() as any;
  }
  addSkillSource(p: string, kind: 'folder' | 'skill') {
    this.db.prepare('INSERT OR REPLACE INTO skill_sources (path,kind,added) VALUES (?,?,COALESCE((SELECT added FROM skill_sources WHERE path = ?),?))').run(p, kind, p, now());
  }
  removeSkillSource(p: string) {
    this.db.prepare('DELETE FROM skill_sources WHERE path = ?').run(p);
  }
  /** What the latest scan found: the table holds exactly these afterwards. */
  replaceSkills(skills: { dir: string; name: string; description: string; source: string }[]) {
    const ts = now();
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM skills').run();
      const ins = this.db.prepare('INSERT OR REPLACE INTO skills (dir,name,description,source,seen) VALUES (?,?,?,?,?)');
      for (const s of skills) ins.run(s.dir, s.name, s.description, s.source, ts);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  storedSkills(): { dir: string; name: string; description: string; source: string; seen: string }[] {
    return this.db.prepare('SELECT * FROM skills ORDER BY name, dir').all() as any;
  }
  skillLinks(): { dir: string; cli: string; path: string; made: string }[] {
    return this.db.prepare('SELECT * FROM skill_links ORDER BY made').all() as any;
  }
  addSkillLink(dir: string, cli: string, p: string) {
    this.db.prepare('INSERT OR REPLACE INTO skill_links (dir,cli,path,made) VALUES (?,?,?,?)').run(dir, cli, p, now());
  }
  removeSkillLink(dir: string, cli: string) {
    this.db.prepare('DELETE FROM skill_links WHERE dir = ? AND cli = ?').run(dir, cli);
  }

  mcpCalls(threadId: string): { tool: string; ts: string }[] {
    return this.db.prepare('SELECT tool,ts FROM mcp_calls WHERE thread_id = ? ORDER BY id').all(threadId) as any;
  }
}
