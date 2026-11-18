// chorus serve's side of the one watcher and the one mailbox (task #10, 2026-11-18). The engines are chorus-core's (src/watch/,
// src/mail/); this file gives them what only the host knows:
// - each CLI's transport hooks: Claude's channel push goes through the chat's own `chorus mcp` process, which holds a stream open to
//   serve (ChannelHub); Codex and agy are told whether the chat's CLI runs, its session id, pid and folder;
// - what a chat's launch adds per session (`wake`), and the answer to Claude's development-channels warning at each launch;
// - after an agy resume, whether it really loaded the conversation (agy sometimes opens an empty one: antigravity-agy.md §16).
// Nothing here types a Chorus message into a chat, except the mail watchdog's last resort (typeLine, task #14): one short line, with
// the user's draft put back.
import type http from 'node:http';
import { agyTransport, CLAUDE_CHANNEL_WARNING, claudeTransport, clearKeys, codexTransport, inputState, restoreKeys, type DeliverResult, type ScreenLine, type Transport, type TransportLaunch, type TypeInResult } from '@chauvoluuhuong/chorus-core';
import type { AgentId } from '../core/types.ts';

/** What a chat's `chorus mcp` stream gets: one JSON line per push. */
export interface ChannelPush {
  content: string;
  meta: Record<string, string>;
}

/** Waits this long for a running Claude chat's MCP stream to connect (it starts with the CLI, after the warning screen). */
export const CHANNEL_WAIT_MS = 20_000;

/**
 * The `chorus mcp` process of each running Claude chat opens GET /api/pro/mcp/channel?thread=<id> and keeps it open: a push writes a
 * line there, and that process sends it to Claude Code as `notifications/claude/channel`. Serve keeps no other MCP session.
 */
export class ChannelHub {
  private streams = new Map<string, Set<http.ServerResponse>>();
  private waiters = new Map<string, Set<() => void>>();

  /** A `chorus mcp` process connects for its chat. */
  open(thread: string, res: http.ServerResponse) {
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    res.write('\n'); // headers out now: the client knows it is connected
    let set = this.streams.get(thread);
    if (!set) this.streams.set(thread, (set = new Set()));
    set.add(res);
    const close = () => {
      set!.delete(res);
      if (!set!.size && this.streams.get(thread) === set) this.streams.delete(thread);
    };
    res.on('close', close);
    for (const w of this.waiters.get(thread) ?? []) w();
    this.waiters.delete(thread);
  }

  connected(thread: string) {
    return !!this.streams.get(thread)?.size;
  }

  /** Writes the push to every open stream of the chat; false when none is open. */
  push(thread: string, p: ChannelPush): boolean {
    const set = this.streams.get(thread);
    if (!set?.size) return false;
    const line = `${JSON.stringify(p)}\n`;
    let ok = false;
    for (const res of set) {
      try {
        if (!res.writableEnded && !res.destroyed) ok = res.write(line) || true;
      } catch {
        /* closed under us */
      }
    }
    return ok;
  }

  /** Resolves true once the chat's stream is open, false after `ms`. */
  wait(thread: string, ms: number): Promise<boolean> {
    if (this.connected(thread)) return Promise.resolve(true);
    return new Promise(resolve => {
      let set = this.waiters.get(thread);
      if (!set) this.waiters.set(thread, (set = new Set()));
      const done = () => {
        clearTimeout(t);
        set!.delete(done);
        resolve(this.connected(thread));
      };
      const t = setTimeout(done, ms);
      t.unref?.();
      set.add(done);
    });
  }

  close() {
    for (const set of this.streams.values()) for (const res of set) res.end();
    this.streams.clear();
    for (const set of this.waiters.values()) for (const w of set) w();
    this.waiters.clear();
  }
}

/** How a chat stands, for the transports: from the store row and the app's process entry. */
export interface ChatSession {
  agent: AgentId;
  /** its CLI's own session id (Claude session, Codex thread, agy conversation) */
  native?: string;
  /** a CLI process runs for it */
  running: boolean;
  pid?: number;
  cwd: string;
  /** not running and its CLI no longer has the session: lost (the Restore card) */
  lost: boolean;
  /** agy only: running, but a resume has not shown the conversation yet */
  unconfirmed?: boolean;
}

export interface TransportHooks {
  session(thread: string): ChatSession | undefined;
  hub: ChannelHub;
  channelWaitMs?: number;
}

/** One transport per CLI, on the host's hooks. */
export function makeTransports(h: TransportHooks): Record<AgentId, Transport> {
  const push = async (thread: string, p: ChannelPush): Promise<DeliverResult> => {
    const s = h.session(thread);
    if (!s) return 'gone';
    if (!s.running) return s.lost ? 'gone' : 'ended';
    // its `chorus mcp` connects once the CLI is past its startup screens
    if (!h.hub.connected(thread) && !(await h.hub.wait(thread, h.channelWaitMs ?? CHANNEL_WAIT_MS))) return 'failed';
    return h.hub.push(thread, p) ? 'sent' : 'failed';
  };
  const live = (thread: string) => {
    const s = h.session(thread);
    if (!s || (!s.running && s.lost)) return undefined;
    return s;
  };
  return {
    claude: claudeTransport({ push }),
    codex: codexTransport({ session: thread => { const s = live(thread); return s && { id: s.native, live: s.running, cwd: s.cwd }; } }),
    // agy: "not running" while a resume has not loaded the conversation; the host then starts it again
    agy: agyTransport({ session: thread => { const s = live(thread); return s && { conversation: s.native, pid: s.pid, live: s.running && !s.unconfirmed, cwd: s.cwd }; } }),
  };
}

/** What a chat's launch adds for its transport (per session, never a config change). */
export function wakeFor(transports: Partial<Record<AgentId, Transport>>, agent: AgentId, thread: string): TransportLaunch | undefined {
  return transports[agent]?.launch?.({ thread, mcp: { name: 'chorus' } });
}

/**
 * Claude Code's development-channels warning, shown at every launch and resume with the channels flag: answered once per launch with
 * Enter on option 1 ("I am using this for local development"), only while it is on screen. Returns a stop function.
 */
export function answerChannelWarning(host: { on(ev: 'update', cb: () => void): unknown; off(ev: 'update', cb: () => void): unknown; write(d: string): void; screen: { text(): string[] } }, o: { ms?: number } = {}): () => void {
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    clearTimeout(t);
    host.off('update', onUpdate);
  };
  // 'update' comes after the screen took the output
  const onUpdate = () => {
    if (done) return;
    const text = host.screen.text().join('\n');
    if (!CLAUDE_CHANNEL_WARNING.test(text)) return;
    stop();
    host.write('\r');
  };
  // the warning comes first, at start: after this long the launch is past it
  const t = setTimeout(stop, o.ms ?? 60_000);
  t.unref?.();
  host.on('update', onUpdate);
  return stop;
}

/* ---------- the mail watchdog's type-in (task #14) ---------- */

/** A chat's screen as rows with xterm's wrap flag (what inputState reads): the visible viewport of its headless terminal. */
export function screenRows(screen: { term: any }): ScreenLine[] {
  const b = screen.term.buffer.active;
  const out: ScreenLine[] = [];
  for (let y = b.viewportY; y < b.viewportY + screen.term.rows; y++) {
    const line = b.getLine(y);
    out.push({ text: line?.translateToString(true) ?? '', wrapped: !!line?.isWrapped });
  }
  return out;
}

/** What typeLine needs of a chat's CLI: its screen rows (with xterm's wrap flag), and its own write (not the guarded one). */
export interface TypeInTarget {
  agent: AgentId;
  running(): boolean;
  rows(): ScreenLine[];
  cols(): number;
  write(data: string): void;
}

export interface TypeInSteps {
  sleep(ms: number): Promise<void>;
  /** the page's overlay: shown once the keys are held, gone at the end */
  start(): void;
  end(ok: boolean): void;
  /** hold every other write and the user's keys; release sends them, the user's through the user path */
  hold(): void;
  release(): void;
  log?(line: string): void;
}

/** How long typeLine waits at each step (the probe: a turn starts 0.4–0.5 s after Enter). */
export const TYPE_TIMES = { clearMs: 300, lineMs: 400, leaveMs: 5_000, restoreMs: 400, pollMs: 200 };

/**
 * Types the watchdog's line into an idle or busy chat and puts the user's draft back (typein-probe B, C): read the input, hold the
 * keys, clear with Ctrl+U, type the line and Enter, wait for it to leave the input, type the draft back with Option+Enter between its
 * lines, release. 'not-ready' when the input is not on screen (a dialog, a launch screen), the draft holds an attachment, or a step
 * did not take; the draft is put back whenever it was cleared.
 */
export async function typeLine(t: TypeInTarget, line: string, s: TypeInSteps, times = TYPE_TIMES): Promise<TypeInResult> {
  if (!t.running()) return 'not-ready';
  const read = () => inputState(t.agent, t.rows(), t.cols());
  const first = read();
  if (!first.ready || first.attachment) {
    s.log?.(`not ready: ${first.attachment ? 'the draft holds an attachment' : first.dialog ?? 'no input'}`);
    return 'not-ready';
  }
  const draft = first.draft;
  s.hold();
  s.start();
  let ok = false;
  let cleared = false;
  try {
    // clear: Ctrl+U per input row and once more; a wrapped draft can need a press or two more (probe D)
    let cur = first;
    for (let i = 0; i < 3 && cur.draft; i++) {
      t.write(clearKeys(t.agent, cur));
      await s.sleep(times.clearMs);
      cur = read();
      if (!cur.ready) break;
    }
    if (!cur.ready || cur.draft) {
      s.log?.(`not cleared: ${cur.ready ? JSON.stringify(cur.draft.slice(0, 40)) : cur.dialog ?? 'no input'}`);
      // only what was cleared goes back (Ctrl+U removes from the end)
      if (cur.ready && draft.startsWith(cur.draft) && cur.draft.length < draft.length) t.write(restoreKeys(t.agent, draft.slice(cur.draft.length)));
      return 'not-ready';
    }
    cleared = true;
    t.write(line);
    await s.sleep(times.lineMs);
    t.write('\r');
    // the line leaves the input: a turn starts, or the CLI queues it for after the running turn
    const mark = line.match(/m_[a-z0-9]+/)?.[0] ?? line.slice(0, 24);
    const end = Date.now() + times.leaveMs;
    let left = false;
    while (Date.now() < end) {
      await s.sleep(times.pollMs);
      const st = read();
      if (st.ready && !st.draft.includes(mark)) {
        left = true;
        break;
      }
      if (!st.ready && st.dialog !== 'no-input') break;
    }
    if (!left) {
      // still in the input (or a dialog came up): take the line out again; the draft goes back below
      const st = read();
      if (st.ready && st.draft) t.write(clearKeys(t.agent, st));
      s.log?.('the line did not leave the input');
      await s.sleep(times.clearMs);
    }
    ok = left;
    return left ? 'typed' : 'not-ready';
  } finally {
    if (cleared && draft) {
      // never into a dialog that came up meanwhile (its keys would answer it): wait for the input to be back
      let st = read();
      for (const until = Date.now() + times.leaveMs; !st.ready && Date.now() < until; st = read()) await s.sleep(times.pollMs);
      if (st.ready) {
        t.write(restoreKeys(t.agent, draft));
        await s.sleep(times.restoreMs);
        const back = read();
        if (!back.ready || back.draft !== draft) s.log?.(`draft not seen back as typed: ${JSON.stringify(back.draft?.slice(0, 40))}`);
      } else s.log?.('the draft could not be put back: the input did not come back');
    }
    s.release();
    s.end(ok);
  }
}
