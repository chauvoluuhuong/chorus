// Finding the transcript of a session we did not name (Codex and agy choose their own ids; docs/phase4.md §5).
import fs from 'node:fs';
import path from 'node:path';
import { homes } from './launch.ts';
import type { AgentId } from './types.ts';

export interface Candidate {
  file: string;
  /** native session id (also the file's id part) */
  id: string;
  birth: number;
}

function walk(dir: string, match: (p: string) => boolean, out: string[] = []): string[] {
  for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, match, out);
    else if (match(p)) out.push(p);
  }
  return out;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** Transcript files created after `since` that are not claimed yet, oldest first. */
export function newTranscripts(agent: Exclude<AgentId, 'claude'>, since: number, claimed: Set<string>): Candidate[] {
  const root = agent === 'codex' ? path.join(homes.codex(), 'sessions') : path.join(homes.agy(), 'brain');
  const files = agent === 'codex' ? walk(root, p => /rollout-.*\.jsonl$/.test(p)) : walk(root, p => /logs\/transcript\.jsonl$/.test(p));
  const out: Candidate[] = [];
  for (const file of files) {
    if (claimed.has(file)) continue;
    let birth: number;
    try {
      birth = fs.statSync(file).birthtimeMs;
    } catch {
      continue;
    }
    if (birth < since - 1000) continue;
    const id = file.match(UUID)?.[0] ?? '';
    if (id) out.push({ file, id, birth });
  }
  return out.sort((a, b) => a.birth - b.birth);
}

/** First line of a Codex rollout carries the cwd; agy has none (matched by order and prompt marker). */
export function codexCwd(file: string): string | undefined {
  try {
    const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0];
    return JSON.parse(first).payload?.cwd;
  } catch {
    return undefined;
  }
}

/** `artifactNote` (launch.ts) as it reads inside Codex's developer message */
const MARKER = /This chat is Chorus thread ([\w-]+)\. Files meant for the user/;

/**
 * The Chorus thread a Codex rollout belongs to: the `This chat is Chorus thread t_…` line we pass as developer_instructions, read from
 * the rollout's developer message (TD-4, docs/integrations/codex.md). Undefined while the rollout does not carry it yet.
 */
export function codexThreadId(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (!line.includes('"developer"')) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue; // a line still being written
    }
    const p = o.payload;
    if (o.type !== 'response_item' || p?.type !== 'message' || p.role !== 'developer') continue;
    for (const c of p.content ?? []) {
      const m = typeof c?.text === 'string' && MARKER.exec(c.text);
      if (m) return m[1];
    }
  }
  return undefined;
}

/** rollout file -> the thread its marker names (a marker never changes, so each file is read until it shows, then never again) */
const marked = new Map<string, string>();
/** the developer message is the third line, after session_meta and task_started (~25 KB with a long skill list) */
const HEAD = 1 << 20;

function readHead(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(HEAD, fs.fstatSync(fd).size));
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The unclaimed Codex rollout born after `since` whose developer message names `threadId`. Never a guess: a rollout gets its marker
 * with the chat's first turn (before that it is session_meta only, and a chat that never gets a turn has no rollout at all), so until
 * then there is no match and the caller retries.
 */
export function codexRolloutFor(threadId: string, since: number, claimed: Set<string>): Candidate | undefined {
  return newTranscripts('codex', since, claimed).find(c => {
    let id = marked.get(c.file);
    if (!id) {
      try {
        id = codexThreadId(readHead(c.file));
      } catch {
        return false;
      }
      if (id) marked.set(c.file, id);
    }
    return id === threadId;
  });
}
