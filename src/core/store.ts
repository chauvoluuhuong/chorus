// Shared store: .chorus/chorus.db (SQLite, WAL), used by the CLI app and every `chorus mcp` process.
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentId, Session, ToolCall, Turn, Usage } from './types.ts';

export type ThreadState = 'working' | 'waiting' | 'ended';

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
  target TEXT NOT NULL, status TEXT NOT NULL, result TEXT, duration_ms INTEGER,
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
`;

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
  }

  /** Databases made before the shared store lack these columns. */
  private migrate() {
    const cols = (this.db.prepare('PRAGMA table_info(threads)').all() as { name: string }[]).map(c => c.name);
    if (!cols.includes('project')) this.db.exec('ALTER TABLE threads ADD COLUMN project TEXT');
    if (!cols.includes('skip_permissions')) this.db.exec('ALTER TABLE threads ADD COLUMN skip_permissions INTEGER NOT NULL DEFAULT 0');
    if (!cols.includes('effort')) this.db.exec('ALTER TABLE threads ADD COLUMN effort TEXT');
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

  updateThread(id: string, patch: Partial<Omit<ThreadRow, 'id' | 'created'>>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    const sets = keys.map(k => `${k} = ?`).join(', ');
    this.db.prepare(`UPDATE threads SET ${sets}, updated = ? WHERE id = ?`).run(...keys.map(k => (patch[k] ?? null) as any), now(), id);
  }

  getThread(id: string): ThreadRow | undefined {
    return this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined;
  }

  listThreads(): ThreadRow[] {
    return this.db.prepare('SELECT * FROM threads ORDER BY updated DESC').all() as unknown as ThreadRow[];
  }

  /** Replace a thread's captured record with the latest parse of its CLI session (idempotent). */
  recordSession(threadId: string, s: Session, extra: { transcriptPath?: string } = {}) {
    const db = this.db;
    db.exec('BEGIN');
    try {
      // upsert: a tailed session only grows, so rewriting every row each time would get slower with every turn
      db.prepare('DELETE FROM turns WHERE thread_id = ? AND seq > ?').run(threadId, s.turns.length);
      const have = (db.prepare('SELECT COUNT(*) AS n FROM tool_calls WHERE thread_id = ?').get(threadId) as any).n as number;
      if (have > s.toolCalls.length) db.prepare('DELETE FROM tool_calls WHERE thread_id = ?').run(threadId);
      const ti = db.prepare('INSERT OR REPLACE INTO turns (thread_id,seq,role,text,ts) VALUES (?,?,?,?,?)');
      for (const t of s.turns) ti.run(threadId, t.seq, t.role, t.text, t.ts ?? null);
      const ci = db.prepare(
        'INSERT OR REPLACE INTO tool_calls (thread_id,call_id,turn_seq,tool,target,status,result,duration_ms) VALUES (?,?,?,?,?,?,?,?)',
      );
      for (const c of s.toolCalls) ci.run(threadId, c.id, c.turnSeq, c.tool, c.target, c.status, c.result ?? null, c.durationMs ?? null);
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
    return rows.map(r => ({ id: r.call_id, turnSeq: r.turn_seq, tool: r.tool, target: r.target, status: r.status, result: r.result ?? undefined, durationMs: r.duration_ms ?? undefined }));
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

  mcpCalls(threadId: string): { tool: string; ts: string }[] {
    return this.db.prepare('SELECT tool,ts FROM mcp_calls WHERE thread_id = ? ORDER BY id').all(threadId) as any;
  }
}
