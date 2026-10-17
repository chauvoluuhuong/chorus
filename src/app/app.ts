// The chorus app shell: threads in PTYs with virtual screens, sidebar, status line, menu key, panes, dialogs, cards.
import { EventEmitter } from 'node:events';
import { compose, Differ, layout, type ItemState } from './compositor.ts';
import { InputRouter, type InputEvent } from './input.ts';
import { nodePtyFactory, type PtyFactory } from './pty.ts';
import { ThreadHost, type HostOpts } from './thread-host.ts';

export interface AppIO {
  stdin: NodeJS.ReadableStream & { setRawMode?: (on: boolean) => unknown; isTTY?: boolean };
  stdout: NodeJS.WritableStream;
  size(): { cols: number; rows: number };
  onResize(cb: () => void): () => void;
}

export function processIO(): AppIO {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    size: () => ({ cols: process.stdout.columns || 100, rows: process.stdout.rows || 30 }),
    onResize: cb => {
      process.stdout.on('resize', cb);
      return () => void process.stdout.off('resize', cb);
    },
  };
}

export type ThreadSpec = Omit<HostOpts, 'cols' | 'rows'>;

/** A thread in the sidebar. `host` is absent while the thread is parked (no process). */
export interface Entry {
  id: string;
  title: string;
  agent: string;
  host?: ThreadHost;
  /** set by the controller from transcripts and the approval detector; absent = derive from the process */
  state?: ItemState;
}

export interface AppOpts {
  sidebarWidth?: number;
  menuKey?: string;
  ptyFactory?: PtyFactory;
}

export interface Card {
  threadId: string;
  title: string;
  lines: string[];
}

const MODE_RESET = '\x1b[?2004l\x1b[?1l\x1b[?25h\x1b[0m\x1b[?1049l';
/** keys the menu hands to the controller */
export const ACTION_KEYS: Record<string, string> = { n: 'new', h: 'handoff', m: 'memory', f: 'files', t: 'tools', y: 'approve', x: 'deny', r: 'retry', '?': 'help' };

export class App extends EventEmitter {
  readonly entries: Entry[] = [];
  active = 0;
  sidebarOn = true;
  /** extra text shown in the status line until cleared (limit warning …) */
  notice = '';
  private io: AppIO;
  private sidebarWidth: number;
  private factory: PtyFactory;
  private router: InputRouter;
  private differ = new Differ();
  private timer: NodeJS.Timeout | undefined;
  private tick: NodeJS.Timeout | undefined;
  private started = false;
  private menuSel = 0;
  private flash = '';
  private flashTimer: NodeJS.Timeout | undefined;
  private quitArmed = false;
  private applied = { appCursor: false, bracketedPaste: false };
  private offResize: (() => void) | undefined;
  private pane: { title: string; lines: string[]; scroll: number } | undefined;
  private dialog: { title: string; options: string[]; sel: number; resolve: (i: number | undefined) => void } | undefined;
  private card: Card | undefined;
  private onData = (d: string | Buffer) => this.router.feed(String(d));
  private onExitSignal = () => this.stop();
  readonly done: Promise<void>;
  private finish!: () => void;

  constructor(io: AppIO = processIO(), opts: AppOpts = {}) {
    super();
    this.io = io;
    this.sidebarWidth = opts.sidebarWidth ?? 26;
    this.factory = opts.ptyFactory ?? nodePtyFactory;
    this.router = new InputRouter(e => this.onInput(e), opts.menuKey);
    this.done = new Promise(r => (this.finish = r));
  }

  private contentSize() {
    const { cols, rows } = this.io.size();
    const L = layout(cols, rows, this.sidebarOn ? this.sidebarWidth : 0);
    return { cols: L.contentCols, rows: L.contentRows };
  }

  /* ---------- threads ---------- */

  /** Start a process for a thread and show it (also used by tests and `chorus mux`). */
  addThread(spec: ThreadSpec, select = true): ThreadHost {
    const entry: Entry = { id: spec.id, title: spec.title, agent: spec.agent };
    this.entries.push(entry);
    const host = this.attach(entry, spec);
    if (select) this.active = this.entries.length - 1;
    this.schedule();
    return host;
  }

  /** A thread without a process (resumed on demand). */
  addParked(e: Omit<Entry, 'host' | 'state'>) {
    this.entries.push({ ...e, state: 'parked' });
    this.schedule();
  }

  attach(entry: Entry, spec: ThreadSpec): ThreadHost {
    const { cols, rows } = this.contentSize();
    const host = new ThreadHost({ ...spec, cols, rows }, this.factory);
    host.on('update', () => this.schedule());
    host.on('exit', code => this.emit('thread-exit', entry, code));
    entry.host = host;
    if (entry.state === 'parked') entry.state = undefined;
    this.emit('thread-started', entry, host);
    return host;
  }

  get current(): Entry | undefined {
    return this.entries[this.active];
  }

  entry(id: string) {
    return this.entries.find(e => e.id === id);
  }

  setState(id: string, state: ItemState | undefined) {
    const e = this.entry(id);
    if (e && e.state !== state) {
      e.state = state;
      this.schedule();
    }
  }

  select(i: number) {
    if (i < 0 || i >= this.entries.length) return;
    this.active = i;
    this.emit('select', this.entries[i]);
    this.schedule();
  }

  /* ---------- lifecycle ---------- */

  start() {
    if (this.started) return;
    this.started = true;
    this.io.stdin.setRawMode?.(true);
    this.io.stdin.resume();
    this.io.stdin.on('data', this.onData);
    this.offResize = this.io.onResize(() => this.relayout());
    process.on('exit', this.onExitSignal);
    process.on('SIGTERM', this.onExitSignal);
    process.on('SIGHUP', this.onExitSignal);
    this.io.stdout.write('\x1b[?1049h\x1b[2J');
    this.tick = setInterval(() => this.schedule(), 700);
    this.render();
  }

  stop(killThreads = true) {
    if (!this.started) return;
    this.started = false;
    clearInterval(this.tick);
    clearTimeout(this.timer);
    this.io.stdin.off('data', this.onData);
    this.io.stdin.setRawMode?.(false);
    this.io.stdin.pause();
    this.offResize?.();
    process.off('exit', this.onExitSignal);
    process.off('SIGTERM', this.onExitSignal);
    process.off('SIGHUP', this.onExitSignal);
    if (killThreads) for (const e of this.entries) e.host?.kill();
    this.io.stdout.write(MODE_RESET);
    this.emit('stopped');
    this.finish();
  }

  private relayout() {
    const { cols, rows } = this.contentSize();
    for (const e of this.entries) e.host?.resize(cols, rows);
    this.differ.reset();
    this.io.stdout.write('\x1b[2J');
    this.schedule();
  }

  /* ---------- panes, dialogs, cards, flashes ---------- */

  showPane(title: string, lines: string[]) {
    this.pane = { title, lines, scroll: 0 };
    this.router.capture = true;
    this.schedule();
  }

  closePane() {
    this.pane = undefined;
    this.router.capture = !!this.dialog;
    this.schedule();
  }

  /** A small choice list; resolves with the index or undefined when cancelled. */
  choose(title: string, options: string[]): Promise<number | undefined> {
    return new Promise(resolve => {
      this.dialog = { title, options, sel: 0, resolve };
      this.router.capture = true;
      this.schedule();
    });
  }

  setCard(card: Card | undefined) {
    this.card = card;
    this.schedule();
  }

  get currentCard() {
    return this.card;
  }

  setFlash(msg: string) {
    this.flash = msg;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flash = '';
      this.schedule();
    }, 4500);
    this.schedule();
  }

  /* ---------- input ---------- */

  private menuItems() {
    return [
      ...this.entries.map((t, i) => ({ label: `${i + 1}  ${t.title}${t.state === 'ended' ? ' (ended)' : t.state === 'parked' ? ' (parked)' : ''}`, run: () => this.select(i) })),
      { label: 'n  new thread', run: () => this.emit('action', 'new') },
      { label: 'h  hand off the current thread', run: () => this.emit('action', 'handoff') },
      { label: 'm  memory (what a handoff carries)', run: () => this.emit('action', 'memory') },
      { label: 'f  files and artifacts', run: () => this.emit('action', 'files') },
      { label: 't  tool calls', run: () => this.emit('action', 'tools') },
      { label: 'y  approve pending request', run: () => this.emit('action', 'approve') },
      { label: 'x  deny pending request', run: () => this.emit('action', 'deny') },
      { label: `b  ${this.sidebarOn ? 'hide' : 'show'} sidebar`, run: () => this.toggleSidebar() },
      { label: '?  help', run: () => this.emit('action', 'help') },
      { label: 'q  quit', run: () => this.quit() },
    ];
  }

  toggleSidebar() {
    this.sidebarOn = !this.sidebarOn;
    this.relayout();
  }

  private quit() {
    const running = this.entries.filter(t => t.host?.state === 'running').length;
    if (running && !this.quitArmed) {
      this.quitArmed = true;
      this.setFlash(`${running} thread(s) still running: press the menu key then q again to quit`);
      return;
    }
    this.stop();
  }

  private onInput(e: InputEvent) {
    if (e.type === 'key') return this.onCaptured(e.key);
    switch (e.type) {
      case 'pass':
        this.quitArmed = false;
        this.current?.host?.write(e.data);
        break;
      case 'menu-open':
        this.menuSel = this.active;
        break;
      case 'menu-close':
        break;
      case 'menu-move': {
        const n = this.menuItems().length;
        this.menuSel = (this.menuSel + e.delta + n) % n;
        break;
      }
      case 'menu-enter':
        this.menuItems()[this.menuSel]?.run();
        break;
      case 'menu-key': {
        const k = e.key;
        if (k !== 'q') this.quitArmed = false;
        if (/[1-9]/.test(k)) this.select(Number(k) - 1);
        else if (k === 'b') this.toggleSidebar();
        else if (k === 'q') this.quit();
        else if (ACTION_KEYS[k]) this.emit('action', ACTION_KEYS[k]);
        break;
      }
    }
    this.schedule();
  }

  private onCaptured(key: string) {
    if (this.dialog) {
      const d = this.dialog;
      const done = (i: number | undefined) => {
        this.dialog = undefined;
        this.router.capture = !!this.pane;
        d.resolve(i);
        this.schedule();
      };
      if (key === '\x1b[A' || key === '\x1bOA') d.sel = (d.sel + d.options.length - 1) % d.options.length;
      else if (key === '\x1b[B' || key === '\x1bOB') d.sel = (d.sel + 1) % d.options.length;
      else if (key === '\r' || key === '\n') done(d.sel);
      else if (key === '\x1b' || key === 'q') done(undefined);
      else if (/^[1-9]$/.test(key) && Number(key) <= d.options.length) done(Number(key) - 1);
      this.schedule();
      return;
    }
    if (this.pane) {
      const { rows } = this.io.size();
      const page = Math.max(1, rows - 4);
      const max = Math.max(0, this.pane.lines.length - (rows - 3));
      if (key === '\x1b' || key === 'q') return this.closePane();
      if (key === '\x1b[A' || key === 'k') this.pane.scroll = Math.max(0, this.pane.scroll - 1);
      else if (key === '\x1b[B' || key === 'j' || key === '\r') this.pane.scroll = Math.min(max, this.pane.scroll + 1);
      else if (key === '\x1b[5~') this.pane.scroll = Math.max(0, this.pane.scroll - page);
      else if (key === '\x1b[6~' || key === ' ') this.pane.scroll = Math.min(max, this.pane.scroll + page);
      else if (key === 'g') this.pane.scroll = 0;
      else if (key === 'G') this.pane.scroll = max;
      this.schedule();
    }
  }

  /* ---------- drawing ---------- */

  schedule() {
    if (!this.started || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.render();
    }, 16);
  }

  private stateOf(e: Entry): ItemState {
    if (e.state) return e.host?.state === 'ended' ? 'ended' : e.state;
    if (!e.host) return 'parked';
    return e.host.state === 'ended' ? 'ended' : e.host.busy() ? 'busy' : 'idle';
  }

  render() {
    if (!this.started) return;
    const { cols, rows } = this.io.size();
    const act = this.current;
    const L = layout(cols, rows, this.sidebarOn ? this.sidebarWidth : 0);
    const dialog = this.dialog;
    const overlay = dialog
      ? { title: dialog.title, lines: dialog.options.map((o, i) => `${i + 1}  ${o}`), selected: dialog.sel }
      : this.router.menuOpen
        ? { title: 'chorus', lines: this.menuItems().map(i => i.label), selected: this.menuSel }
        : undefined;
    const pane = this.pane && {
      title: this.pane.title,
      lines: this.pane.lines.slice(this.pane.scroll, this.pane.scroll + L.contentRows - 2),
      hint: `↑/↓ PgUp/PgDn scroll · g/G top/bottom · esc close  (${Math.min(this.pane.lines.length, this.pane.scroll + 1)}-${Math.min(this.pane.lines.length, this.pane.scroll + L.contentRows - 2)} of ${this.pane.lines.length})`,
    };
    const card = this.card && { title: this.card.title, lines: [...this.card.lines, 'ctrl+space y  approve    ctrl+space x  deny    (or switch to the thread and answer there)'] };
    const status =
      this.flash ||
      this.notice ||
      (act ? `${this.active + 1}/${this.entries.length}  ${act.title}  ·  ${act.agent}${act.host?.state === 'ended' ? `  (exited ${act.host.exitCode})` : ''}` : 'no threads');
    const { grid, cursor } = compose({
      cols,
      rows,
      sidebarWidth: this.sidebarOn ? this.sidebarWidth : 0,
      items: this.entries.map((t, i) => ({ title: t.title, agent: t.agent, state: this.stateOf(t), active: i === this.active })),
      screen: act?.host?.screen,
      status,
      statusRight: this.router.menuOpen ? '1-9 switch · n new · h handoff · m memory · ? help · esc' : 'ctrl+space: menu',
      overlay,
      pane,
      card,
    });
    let out = '\x1b[?2026h\x1b[?25l' + this.differ.frame(grid) + this.modeSync(pane ? undefined : act);
    if (cursor) out += `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h`;
    out += '\x1b[?2026l';
    this.io.stdout.write(out);
  }

  /** Mirror the modes the active agent set on its (virtual) terminal onto the real one, so keys encode the way it expects. */
  private modeSync(act?: Entry): string {
    const m = act?.host?.screen.modes() ?? { appCursor: false, bracketedPaste: false };
    let out = '';
    if (m.appCursor !== this.applied.appCursor) out += m.appCursor ? '\x1b[?1h' : '\x1b[?1l';
    if (m.bracketedPaste !== this.applied.bracketedPaste) out += m.bracketedPaste ? '\x1b[?2004h' : '\x1b[?2004l';
    this.applied = { appCursor: m.appCursor, bracketedPaste: m.bracketedPaste };
    return out;
  }
}
