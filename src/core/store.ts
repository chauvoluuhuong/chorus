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
  created: string;
  updated: string;
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
  cli_version TEXT, transcript_path TEXT, created TEXT NOT NULL, updated TEXT NOT NULL
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
CREATE TABLE IF NOT EXISTS mcp_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT, tool TEXT NOT NULL, ts TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;
  readonly root: string;

  constructor(project: string) {
    this.root = path.join(project, '.chorus');
    fs.mkdirSync(this.root, { recursive: true });
    this.db = new DatabaseSync(path.join(this.root, 'chorus.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  threadDir(id: string) {
    return path.join(this.root, 'threads', id);
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
      created: now(),
      updated: now(),
    };
    this.db
      .prepare(
        `INSERT INTO threads (id,title,agent,model,cwd,native_session_id,parent_thread_id,state,cli_version,transcript_path,created,updated)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(row.id, row.title, row.agent, row.model, row.cwd, row.native_session_id, row.parent_thread_id, row.state, row.cli_version, row.transcript_path, row.created, row.updated);
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
      db.prepare('DELETE FROM turns WHERE thread_id = ?').run(threadId);
      db.prepare('DELETE FROM tool_calls WHERE thread_id = ?').run(threadId);
      const ti = db.prepare('INSERT INTO turns (thread_id,seq,role,text,ts) VALUES (?,?,?,?,?)');
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

  mcpCalls(threadId: string): { tool: string; ts: string }[] {
    return this.db.prepare('SELECT tool,ts FROM mcp_calls WHERE thread_id = ? ORDER BY id').all(threadId) as any;
  }
}
