// Live transcript tailing: follow a thread's CLI transcript while its TUI runs and keep the store current (P4.3).
import fs from 'node:fs';
import { adapters } from '../core/adapters/index.ts';
import { codexCwd, newTranscripts } from '../core/discover.ts';
import { transcriptPath } from '../core/capture.ts';
import type { Store } from '../core/store.ts';
import type { AgentId, Session } from '../core/types.ts';

export interface TailerOpts {
  store: Store;
  threadId: string;
  agent: AgentId;
  cwd: string;
  /** native session id when we chose it (claude) or are resuming */
  nativeId?: string;
  /** files other threads already follow */
  claimed: Set<string>;
  pollMs?: number;
  onUpdate?: (s: Session) => void;
}

export class Tailer {
  readonly threadId: string;
  file: string | undefined;
  session: Session | undefined;
  private o: TailerOpts;
  private since = Date.now();
  private offset = 0;
  private text = '';
  private partial = '';
  private timer: NodeJS.Timeout | undefined;
  private watcher: fs.FSWatcher | undefined;

  constructor(o: TailerOpts) {
    this.o = o;
    this.threadId = o.threadId;
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), this.o.pollMs ?? 700);
  }

  stop() {
    clearInterval(this.timer);
    this.watcher?.close();
    if (this.file) this.o.claimed.delete(this.file);
  }

  /** One pass: find the file if needed, read what was appended, re-parse, write the store. */
  poll() {
    if (!this.file && !this.locate()) return;
    let size: number;
    try {
      size = fs.statSync(this.file!).size;
    } catch {
      return;
    }
    if (size === this.offset) return;
    if (size < this.offset) {
      this.offset = 0;
      this.text = '';
      this.partial = '';
    }
    const fd = fs.openSync(this.file!, 'r');
    try {
      const buf = Buffer.alloc(size - this.offset);
      fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      const chunk = this.partial + buf.toString('utf8');
      const cut = chunk.lastIndexOf('\n');
      this.text += chunk.slice(0, cut + 1);
      this.partial = chunk.slice(cut + 1); // a line still being written
    } finally {
      fs.closeSync(fd);
    }
    this.session = adapters[this.o.agent].parseTranscript(this.text);
    this.o.store.recordSession(this.threadId, this.session, { transcriptPath: this.file });
    this.o.store.scanArtifacts(this.threadId);
    this.o.onUpdate?.(this.session);
  }

  private locate(): boolean {
    const { agent, store, threadId, cwd, claimed, nativeId } = this.o;
    let file: string | undefined;
    if (agent === 'claude') {
      const id = nativeId ?? store.getThread(threadId)?.native_session_id ?? undefined;
      file = id ? transcriptPath('claude', id, cwd) : undefined;
    } else if (nativeId) {
      file = transcriptPath(agent, nativeId, cwd);
    } else {
      // a new Codex/agy session: the first unclaimed transcript born after we spawned the TUI (Codex: same cwd)
      const c = newTranscripts(agent, this.since, claimed).find(x => agent !== 'codex' || realEq(codexCwd(x.file), cwd));
      if (c) {
        file = c.file;
        store.updateThread(threadId, { native_session_id: c.id });
      }
    }
    if (!file) return false;
    this.file = file;
    claimed.add(file);
    return true;
  }
}

function realEq(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const r = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  return r(a) === r(b);
}
