// One terminal lock per chat (task #14). Everything that writes into a chat's CLI that is not the user's own keys goes through
// `run(thread, fn)`, one at a time per chat: Claude's channel warning, the launch screens, a live working folder (/add-dir), the answer
// paths that type into the CLI (cards, Approvals' Skip), the older hosts' typing, and the mail watchdog's type-in.
//
// The type-in also HOLDS the terminal (`hold`): while it clears the user's draft, types its line and types the draft back, every other
// write to that chat's host is kept back and goes out after it, in order. `guard()` puts that check on a host's own `write`, so a
// write from code serve does not own (the Controller's) cannot slip in between either. The user's keys are held by serve's key
// handler instead, and replayed through the user path, so they still count as typed.

/** What the lock needs of a chat's process. */
export interface Writable {
  write(data: string): void;
}

export class TermLocks {
  private chains = new Map<string, Promise<unknown>>();
  private queued = new Map<string, number>();
  private held = new Map<string, string[]>();
  private raw = new WeakMap<Writable, (data: string) => void>();

  /** Runs fn when no other writer of this chat is running; the next one waits for it (an error does not stop the chain). */
  run<T>(thread: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.chains.get(thread) ?? Promise.resolve();
    this.queued.set(thread, (this.queued.get(thread) ?? 0) + 1);
    const next = prev.then(fn, fn).finally(() => {
      const n = (this.queued.get(thread) ?? 1) - 1;
      if (n) this.queued.set(thread, n);
      else this.queued.delete(thread);
      if (this.chains.get(thread) === done) this.chains.delete(thread);
    });
    const done = next.catch(() => undefined);
    this.chains.set(thread, done);
    return next;
  }

  /** A writer of this chat runs or waits. */
  busy(thread: string) {
    return (this.queued.get(thread) ?? 0) > 0;
  }

  /** While held, other writes to this chat's guarded host wait; release() sends them, in order. */
  hold(thread: string) {
    if (!this.held.has(thread)) this.held.set(thread, []);
  }

  holding(thread: string) {
    return this.held.has(thread);
  }

  release(thread: string, host?: Writable) {
    const kept = this.held.get(thread) ?? [];
    this.held.delete(thread);
    const write = host && (this.raw.get(host) ?? host.write.bind(host));
    if (write) for (const d of kept) write(d);
  }

  /** Puts the hold check on a host's own write (once per host). Returns the host's unguarded write, for the holder itself. */
  guard(thread: string, host: Writable): (data: string) => void {
    const known = this.raw.get(host);
    if (known) return known;
    const raw = host.write.bind(host);
    this.raw.set(host, raw);
    host.write = (data: string) => {
      const kept = this.held.get(thread);
      if (kept) kept.push(data);
      else raw(data);
    };
    return raw;
  }
}
