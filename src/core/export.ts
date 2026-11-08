// Export (2.0 plan stage 11, decision 21): everything the user has in Chorus, in one .zip, free for everyone. Nothing is uploaded.
// In the file: manifest.json, chorus.json (every chat with its messages, tool calls, approvals, questions, usage and files), each chat as
// a Markdown page, the chats' artifacts and dropped files, the skill library, and Pro's data copied as files (free code never reads Pro's
// tables). Never: licences, install keys, the API token, notifications, updates or doctor logs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

/** A small ZIP writer: deflated entries, written as they come so a big export never sits in memory at once. */
class Zip {
  private fd: number;
  private at = 0;
  private entries: { name: Buffer; crc: number; size: number; packed: number; offset: number; time: number; date: number }[] = [];

  constructor(file: string) {
    this.fd = fs.openSync(file, 'w', 0o600);
  }

  private write(b: Buffer) {
    fs.writeSync(this.fd, b);
    this.at += b.length;
  }

  add(name: string, data: Buffer | string) {
    const raw = typeof data === 'string' ? Buffer.from(data) : data;
    const packed = zlib.deflateRawSync(raw);
    const n = Buffer.from(name.replace(/\\/g, '/'));
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const e = { name: n, crc: zlib.crc32(raw), size: raw.length, packed: packed.length, offset: this.at, time, date };
    if (e.size > 0xfffffffe || this.at > 0xfffffffe) throw new Error('This export is over 4 GB: export without the largest files.');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(0x0800, 6); // names are UTF-8
    h.writeUInt16LE(8, 8); // deflate
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt32LE(e.crc, 14);
    h.writeUInt32LE(e.packed, 18);
    h.writeUInt32LE(e.size, 22);
    h.writeUInt16LE(n.length, 26);
    this.write(h);
    this.write(n);
    this.write(packed);
    this.entries.push(e);
  }

  close() {
    const start = this.at;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(20, 4);
      c.writeUInt16LE(20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(8, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(e.packed, 20);
      c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.name.length, 28);
      c.writeUInt32LE(e.offset, 42);
      this.write(c);
      this.write(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.at - start, 12);
    end.writeUInt32LE(start, 16);
    this.write(end);
    fs.closeSync(this.fd);
    return this.entries.length;
  }
}

export interface ExportResult {
  file: string;
  bytes: number;
  chats: number;
  projects: number;
  files: number;
}

const safe = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';
const name = (p: string) => safe(path.basename(p) || p);

/** Every file under a folder, relative to it. Links are not followed. */
function walk(dir: string, base = dir): string[] {
  let out: string[] = [];
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of items) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out = out.concat(walk(p, base));
    else if (d.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

function markdown(chat: any) {
  const lines = [`# ${chat.title}`, '', `${chat.agent}${chat.model ? ` · ${chat.model}` : ''} · ${chat.project} · started ${chat.created}`, ''];
  for (const t of chat.turns) lines.push(`## ${t.role === 'user' ? 'You' : t.role === 'assistant' ? chat.agent : t.role}${t.at ? ` · ${t.at}` : ''}`, '', t.text, '');
  if (chat.toolCalls.length) lines.push('## Tool calls', '', ...chat.toolCalls.map((c: any) => `- ${c.tool} ${c.target} (${c.status})`), '');
  return lines.join('\n');
}

/** Writes the export to `dir` (default the Downloads folder) and says what is in it. */
export function exportAll(o: { home: string; version: string; dir?: string; now?: Date }): ExportResult {
  const now = o.now ?? new Date();
  const dir = o.dir ?? path.join(os.homedir(), 'Downloads');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 10);
  let file = path.join(dir, `chorus-export-${stamp}.zip`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `chorus-export-${stamp} (${i}).zip`);
  const db = new DatabaseSync(path.join(o.home, 'chorus.db'), { readOnly: true });
  const all = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];
  const has = (t: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t);
  const by = (rows: any[]) => rows.reduce((m, r) => (m.get(r.thread_id) ?? m.set(r.thread_id, []).get(r.thread_id)).push(r) && m, new Map<string, any[]>());
  const turns = by(all('SELECT * FROM turns ORDER BY thread_id, seq'));
  const tools = by(all('SELECT * FROM tool_calls ORDER BY thread_id, turn_seq'));
  const approvals = by(has('approvals_log') ? all('SELECT * FROM approvals_log ORDER BY id') : []);
  const questions = by(has('requests') ? all('SELECT * FROM requests ORDER BY created') : []);
  const arts = by(has('artifacts') ? all('SELECT * FROM artifacts ORDER BY ts') : []);
  const atts = by(has('attachments') ? all('SELECT * FROM attachments ORDER BY id') : []);
  const usage = new Map(all('SELECT * FROM usage').map(u => [u.thread_id, u]));
  const zip = new Zip(file);
  let files = 0;
  try {
    const chats = all('SELECT * FROM threads ORDER BY created').map(t => {
      const project = t.project ?? t.cwd;
      const where = `files/${name(project)}/${t.id}`;
      const chatDir = path.join(project, '.chorus', 'threads', t.id);
      // the files themselves: what agents saved for the user, and what the user dropped and asked to copy
      for (const sub of ['artifacts', 'attachments']) {
        for (const rel of walk(path.join(chatDir, sub))) {
          try {
            zip.add(`${where}/${sub}/${rel}`, fs.readFileSync(path.join(chatDir, sub, rel)));
            files++;
          } catch {
            /* a file that went away while exporting */
          }
        }
      }
      const u = usage.get(t.id);
      const chat = {
        id: t.id, title: t.title, project, agent: t.agent, model: t.model ?? null, effort: t.effort ?? null, cliVersion: t.cli_version ?? null,
        parent: t.parent_thread_id ?? null, state: t.state, skipPermissions: !!t.skip_permissions, session: t.native_session_id ?? null, created: t.created, updated: t.updated,
        turns: (turns.get(t.id) ?? []).map((x: any) => ({ seq: x.seq, role: x.role, text: x.text, at: x.ts ?? null })),
        toolCalls: (tools.get(t.id) ?? []).map((x: any) => ({ id: x.call_id, turn: x.turn_seq, tool: x.tool, target: x.target, status: x.status, result: x.result ?? null, ms: x.duration_ms ?? null, note: x.note ?? null })),
        approvals: (approvals.get(t.id) ?? []).map((x: any) => ({ what: x.what, decision: x.decision, at: x.ts })),
        questions: (questions.get(t.id) ?? []).map((x: any) => ({ id: x.id, question: x.question, details: x.details ?? null, options: JSON.parse(x.options || '[]'), status: x.status, answer: x.answer ?? null, note: x.note ?? null, at: x.created, answered: x.answered ?? null })),
        artifacts: (arts.get(t.id) ?? []).map((x: any) => ({ path: x.path, version: x.version, at: x.ts, file: `${where}/artifacts/${x.path}` })),
        attachments: (atts.get(t.id) ?? []).map((x: any) => ({ file: x.copied ? `${where}/attachments/${path.basename(x.path)}` : null, path: x.path, from: x.original_path ?? null, copied: !!x.copied, bytes: x.bytes ?? null, at: x.created })),
        usage: u ? { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_tokens, costUsd: u.cost_usd } : null,
      };
      zip.add(`chats/${name(project)}/${String(t.created).slice(0, 10)} ${safe(t.title)} - ${t.id}.md`, markdown(chat));
      return chat;
    });
    const projects = [...new Set(chats.map(c => c.project))].map(p => ({ path: p, name: name(p), chats: chats.filter(c => c.project === p).length }));
    let ui: unknown = null;
    try {
      ui = JSON.parse(fs.readFileSync(path.join(o.home, 'ui.json'), 'utf8'));
    } catch {
      /* no sidebar settings yet */
    }
    zip.add('chorus.json', JSON.stringify({ projects, chats, sidebar: ui }, null, 2));
    // the skill library, as it is on disk
    for (const rel of walk(path.join(o.home, 'skills'))) zip.add(`skills/${rel}`, fs.readFileSync(path.join(o.home, 'skills', rel)));
    if (fs.existsSync(path.join(o.home, 'skills.json'))) zip.add('skills/skills.json', fs.readFileSync(path.join(o.home, 'skills.json')));
    // Pro's data, copied as files: the write-ahead log holds its latest writes, so it goes too
    const pro = ['pro.db', 'pro.db-wal'].filter(f => fs.existsSync(path.join(o.home, f)));
    for (const f of pro) zip.add(`pro/${f}`, fs.readFileSync(path.join(o.home, f)));
    zip.add('manifest.json', JSON.stringify({ format: 'chorus-export', version: 1, made: now.toISOString(), chorus: o.version, counts: { projects: projects.length, chats: chats.length, turns: chats.reduce((n, c) => n + c.turns.length, 0), files }, included: { files: true, skills: true, pro: pro.length > 0, transcripts: false } }, null, 2));
    zip.close();
    return { file, bytes: fs.statSync(file).size, chats: chats.length, projects: projects.length, files };
  } catch (e) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* nothing to clean */
    }
    throw e;
  } finally {
    db.close();
  }
}
