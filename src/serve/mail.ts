// chorus serve's side of the one watcher and the one mailbox (task #10, 2026-11-18). The engines are chorus-core's (src/watch/,
// src/mail/); this file gives them what only the host knows:
// - each CLI's transport hooks: Claude's channel push goes through the chat's own `chorus mcp` process, which holds a stream open to
//   serve (ChannelHub); Codex and agy are told whether the chat's CLI runs, its session id, pid and folder;
// - what a chat's launch adds per session (`wake`), and the answer to Claude's development-channels warning at each launch;
// - after an agy resume, whether it really loaded the conversation (agy sometimes opens an empty one: antigravity-agy.md §16).
// Nothing here types a Chorus message into a chat.
import type http from 'node:http';
import { agyTransport, CLAUDE_CHANNEL_WARNING, claudeTransport, codexTransport, type DeliverResult, type Transport, type TransportLaunch } from '@chauvoluuhuong/chorus-core';
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
