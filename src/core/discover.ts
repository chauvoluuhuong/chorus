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
