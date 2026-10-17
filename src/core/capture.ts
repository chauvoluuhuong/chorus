// Capture pipeline: read what a CLI left (stream or transcript) and write it to the store.
import fs from 'node:fs';
import path from 'node:path';
import { adapters } from './adapters/index.ts';
import { homes } from './launch.ts';
import type { Store } from './store.ts';
import type { AgentId, Session } from './types.ts';

/** Where a CLI keeps the transcript of one session (verified paths, docs/integrations). */
export function transcriptPath(agent: AgentId, nativeId: string, cwd: string): string | undefined {
  if (agent === 'claude') {
    // slug = cwd with every non-alphanumeric character replaced by '-' (resolved: macOS /tmp -> /private/tmp)
    for (const c of new Set([cwd, safeReal(cwd)])) {
      const p = path.join(homes.claude(), 'projects', c.replace(/[^a-zA-Z0-9]/g, '-'), `${nativeId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
    return undefined;
  }
  if (agent === 'codex') return findFile(path.join(homes.codex(), 'sessions'), n => n.endsWith(`${nativeId}.jsonl`));
  const p = path.join(homes.agy(), 'brain', nativeId, '.system_generated', 'logs', 'transcript.jsonl');
  return fs.existsSync(p) ? p : undefined;
}

function safeReal(p: string) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function findFile(root: string, match: (name: string) => boolean): string | undefined {
  if (!fs.existsSync(root)) return undefined;
  for (const e of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => b.name.localeCompare(a.name))) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      const r = findFile(p, match);
      if (r) return r;
    } else if (match(e.name)) return p;
  }
  return undefined;
}

/** Parse a headless stdout capture into the thread. */
export function captureStream(store: Store, threadId: string, stdout: string, prompt?: string): Session {
  const thread = store.getThread(threadId)!;
  const s = adapters[thread.agent].parseStream(stdout, { prompt });
  store.recordSession(threadId, s);
  store.scanArtifacts(threadId);
  return s;
}

/** Parse the CLI's own transcript (interactive sessions, or a richer view after a headless run). */
export function captureTranscript(store: Store, threadId: string): Session | undefined {
  const thread = store.getThread(threadId)!;
  if (!thread.native_session_id) return undefined;
  const file = thread.transcript_path ?? transcriptPath(thread.agent, thread.native_session_id, thread.cwd);
  if (!file || !fs.existsSync(file)) return undefined;
  const s = adapters[thread.agent].parseTranscript(fs.readFileSync(file, 'utf8'));
  store.recordSession(threadId, s, { transcriptPath: file });
  store.scanArtifacts(threadId);
  return s;
}
