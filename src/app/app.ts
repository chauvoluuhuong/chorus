// The chorus app shell: threads in PTYs with virtual screens, sidebar, status line, menu key, panes, dialogs, cards.
import { EventEmitter } from 'node:events';
import { compose, Differ, layout, type HomeView, type ItemState, type RichLine, type StatusBar } from './compositor.ts';
import { InputRouter, parseMenuKeys, type InputEvent } from './input.ts';
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
  /** this thread continues another one: shown under it */
  parentId?: string;
  /** what the status bar shows besides the title (filled by the controller) */
  meta?: { model?: string; usage?: number; artifacts?: number; from?: string; toast?: string };
}

export interface AppOpts {
  /** mouse clicks in the sidebar and on the home list (default on; CHORUS_MOUSE=0 turns it off) */
  mouse?: boolean;
  sidebarWidth?: number;
  /** e.g. "ctrl+b"; default: Ctrl+\\ and Ctrl+Space (env CHORUS_MENU_KEY) */
  menuKey?: string;
  ptyFactory?: PtyFactory;
}

export type FormField =
  | { kind: 'select'; label: string; options: string[] | ((values: Record<string, string>) => string[]); index?: number }
  | { kind: 'text'; label: string; value: string; hint?: string };

export interface Card {
  threadId: string;
  title: string;
  lines: string[];
}

const MODE_RESET = '\x1b[?2004l\x1b[?1l\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[0m\x1b[?1049l';
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h'; // button press/release, SGR encoding
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** keys the menu hands to the controller */
export const ACTION_KEYS: Record<string, string> = { n: 'new', h: 'handoff', m: 'memory', a: 'files', f: 'files', e: 'activity', t: 'activity', y: 'approve', x: 'deny', r: 'retry', d: 'doctor', '?': 'help' };

export class App extends EventEmitter {
  readonly entries: Entry[] = [];
  /** how the menu key is named on screen */
  menuLabel = '⌃\\';
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
  private pane: { title: string; lines: RichLine[]; scroll: number; hint?: string; onKey?: (key: string) => boolean | void } | undefined;
  private home: { selected: number } | undefined;
  /** supplied by the controller: what the home screen lists */
  homeProvider: (() => Omit<HomeView, 'selected'>) | undefined;
  private formState: { title: string; fields: FormField[]; focus: number; error: string; validate?: (v: Record<string, string>) => string | undefined; resolve: (v: Record<string, string> | undefined) => void } | undefined;
  private alertState: { title: string; lines: string[]; options: { key: string; label: string }[]; sel: number; resolve: (k: string | undefined) => void } | undefined;
  private dialog: { title: string; options: string[]; sel: number; resolve: (i: number | undefined) => void } | undefined;
  private card: Card | undefined;
  private mouseOn: boolean;
  private mousePending = '';
  private onData = (d: string | Buffer) => {
    let s = this.mousePending + String(d);
    this.mousePending = '';
    if (this.mouseOn) {
      const tail = s.match(/\x1b(?:\[(?:<[\d;]*)?)?$/); // a mouse report cut in two chunks
      if (tail && tail.index !== undefined && tail[0].length > 2) {
        this.mousePending = tail[0];
        s = s.slice(0, tail.index);
      }
      s = s.replace(MOUSE, (_m, b, x, y, kind) => (this.onMouse(Number(b), Number(x), Number(y), kind === 'M'), ''));
    }
    if (s) this.router.feed(s);
  };
  private onExitSignal = () => this.stop();
  readonly done: Promise<void>;
  private finish!: () => void;

  constructor(io: AppIO = processIO(), opts: AppOpts = {}) {
    super();
    this.io = io;
    this.sidebarWidth = opts.sidebarWidth ?? 30;
    this.mouseOn = (opts.mouse ?? true) && process.env.CHORUS_MOUSE !== '0';
    this.factory = opts.ptyFactory ?? nodePtyFactory;
    const mk = parseMenuKeys(opts.menuKey ?? process.env.CHORUS_MENU_KEY);
    this.menuLabel = mk.label;
    this.router = new InputRouter(e => this.onInput(e), mk.keys);
    this.done = new Promise(r => (this.finish = r));
  }

  private contentSize() {
    const { cols, rows } = this.io.size();
    const L = layout(cols, rows, this.sidebarOn ? this.sidebarWidth : 0);
    return { cols: L.contentCols, rows: L.contentRows };
  }

  /* ---------- threads ---------- */

  /** Start a process for a thread and show it (also used by tests and `chorus mux`). */
  addThread(spec: ThreadSpec, select = true, parentId?: string): ThreadHost {
    const entry: Entry = { id: spec.id, title: spec.title, agent: spec.agent, parentId };
    this.insert(entry);
    const host = this.attach(entry, spec);
    if (select) {
      this.closeHome();
      this.active = this.entries.indexOf(entry);
      this.emit('select', entry);
    }
    this.schedule();
    return host;
  }

  /** A thread without a process (resumed on demand). */
  addParked(e: Omit<Entry, 'host' | 'state'>) {
    this.insert({ ...e, state: 'parked' });
    this.schedule();
  }

  /** A thread that continues another is listed right under it (the mockup's "↳ continued"). */
  private insert(entry: Entry) {
    const keepActive = this.entries[this.active];
    const parentAt = entry.parentId ? this.entries.findIndex(e => e.id === entry.parentId) : -1;
    if (parentAt < 0) this.entries.push(entry);
    else {
      let at = parentAt + 1;
      while (at < this.entries.length && this.entries[at].parentId === entry.parentId) at++;
      this.entries.splice(at, 0, entry);
    }
    if (keepActive) this.active = this.entries.indexOf(keepActive);
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
    this.closeHome();
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
    this.io.stdout.write('\x1b[?1049h\x1b[2J' + (this.mouseOn ? MOUSE_ON : ''));
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

  /** A full-area view. `onKey` sees every key first (return true when it used it); `hint` replaces the scrolling hint. */
  showPane(title: string, lines: RichLine[], opts: { hint?: string; onKey?: (key: string) => boolean | void } = {}) {
    this.pane = { title, lines, scroll: 0, ...opts };
    this.router.capture = true;
    this.schedule();
  }

  showPaneHint(hint: string) {
    if (this.pane) this.pane.hint = hint;
    this.schedule();
  }

  updatePane(lines: RichLine[], title?: string) {
    if (!this.pane) return;
    this.pane.lines = lines;
    if (title) this.pane.title = title;
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

  /** A small form: select fields (←/→) and text fields; Enter submits, Esc cancels. Resolves with label → value. */
  form(title: string, fields: FormField[], validate?: (v: Record<string, string>) => string | undefined): Promise<Record<string, string> | undefined> {
    return new Promise(resolve => {
      this.formState = { title, fields: fields.map(f => ({ ...f })), focus: 0, error: '', validate, resolve };
      this.router.capture = true;
      this.schedule();
    });
  }

  private formValues(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.formState!.fields) out[f.label] = f.kind === 'text' ? f.value : this.optionsOf(f, out)[f.index ?? 0] ?? '';
    return out;
  }

  private optionsOf(f: Extract<FormField, { kind: 'select' }>, values: Record<string, string>): string[] {
    return typeof f.options === 'function' ? f.options(values) : f.options;
  }

  private formKey(key: string) {
    const st = this.formState!;
    const f = st.fields[st.focus];
    const finish = (v: Record<string, string> | undefined) => {
      this.formState = undefined;
      this.router.capture = !!this.pane || !!this.dialog;
      st.resolve(v);
      this.schedule();
    };
    st.error = '';
    if (key === '\x1b') return finish(undefined);
    if (key === '\r' || key === '\n') {
      const v = this.formValues();
      const err = st.validate?.(v);
      if (err) st.error = err;
      else return finish(v);
    } else if (key === '\t' || key === '\x1b[B') st.focus = (st.focus + 1) % st.fields.length;
    else if (key === '\x1b[Z' || key === '\x1b[A') st.focus = (st.focus + st.fields.length - 1) % st.fields.length;
    else if (f.kind === 'select' && (key === '\x1b[C' || key === '\x1b[D')) {
      const n = this.optionsOf(f, this.formValues()).length;
      f.index = ((f.index ?? 0) + (key === '\x1b[C' ? 1 : n - 1)) % Math.max(1, n);
      // later selects depend on earlier ones (the model list depends on the agent): start them over
      for (const g of st.fields.slice(st.focus + 1)) if (g.kind === 'select') g.index = 0;
    } else if (f.kind === 'text') {
      if (key === '\x7f' || key === '\b') f.value = f.value.slice(0, -1);
      else if (key === '\x15') f.value = '';
      else if (key.length === 1 && key >= ' ') f.value += key;
    }
    this.schedule();
  }

  setCard(card: Card | undefined) {
    if (JSON.stringify(card) === JSON.stringify(this.card)) return;
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

  /** The menu of the mockup. ↑↓ walk the sidebar (Enter opens the thread), a letter runs a command. */
  private menuRows(): [string, string, boolean?][] {
    const art = this.current?.meta?.artifacts;
    return [
      ['↑↓', 'Move in the sidebar', true],
      ['h', 'Hand off (new thread, other agent)'],
      ['n', 'New thread'],
      ['m', 'Memory of this thread'],
      ['a', `Artifacts${art ? ` (${art})` : ''}`],
      ['e', 'Activity'],
      ['y x', 'Approve / deny a waiting request'],
      ['0', 'Home'],
      ['b', 'Show / hide sidebar'],
      ['?', 'Help'],
      ['q', 'Quit'],
    ];
  }

  /** A warning with a few ways out (the mockup's "limit reached" box). Resolves with the chosen key, undefined on Esc. */
  alert(title: string, lines: string[], options: { key: string; label: string }[]): Promise<string | undefined> {
    return new Promise(resolve => {
      this.alertState = { title, lines, options, sel: 0, resolve };
      this.router.capture = true;
      this.schedule();
    });
  }

  /* ---------- home ---------- */

  showHome() {
    this.home = { selected: Math.max(0, this.active) };
    this.router.capture = true;
    this.schedule();
  }

  closeHome() {
    if (!this.home) return;
    this.home = undefined;
    this.router.capture = !!this.pane || !!this.dialog || !!this.formState || !!this.alertState;
    this.schedule();
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
        const n = Math.max(1, this.entries.length);
        this.menuSel = (this.menuSel + e.delta + n) % n;
        break;
      }
      case 'menu-enter':
        this.select(this.menuSel);
        break;
      case 'menu-key': {
        const k = e.key;
        if (k !== 'q') this.quitArmed = false;
        if (/[1-9]/.test(k)) this.select(Number(k) - 1);
        else if (k === '0') this.showHome();
        else if (k === 'b') this.toggleSidebar();
        else if (k === 'q') this.quit();
        else if (ACTION_KEYS[k]) this.emit('action', ACTION_KEYS[k]);
        break;
      }
    }
    this.schedule();
  }

  private onCaptured(key: string) {
    if (this.formState) return this.formKey(key);
    if (this.alertState) return this.alertKey(key);
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
    if (this.home && !this.pane) return this.homeKey(key);
    if (this.pane?.onKey?.(key)) return void this.schedule();
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

  private alertKey(key: string) {
    const st = this.alertState!;
    const done = (k: string | undefined) => {
      this.alertState = undefined;
      this.router.capture = !!this.pane || !!this.dialog || !!this.home;
      st.resolve(k);
      this.schedule();
    };
    if (key === '\x1b' || key === 'w') return done(undefined);
    if (key === '\x1b[A') st.sel = (st.sel + st.options.length - 1) % st.options.length;
    else if (key === '\x1b[B') st.sel = (st.sel + 1) % st.options.length;
    else if (key === '\r' || key === '\n') return done(st.options[st.sel].key);
    else if (st.options.some(o => o.key === key)) return done(key);
    this.schedule();
  }

  /**
   * Mouse: a click in the sidebar or on the home list is Chorus's; in the thread area it goes to the agent if the agent
   * asked for the mouse (coordinates shifted by the sidebar), otherwise it is ignored. Wheel in a pane scrolls it.
   */
  private onMouse(b: number, x: number, y: number, press: boolean) {
    if (this.formState || this.alertState || this.dialog || this.router.menuOpen) return;
    const wheel = (b & 64) !== 0;
    if (this.pane) {
      if (wheel && press) this.pane.scroll = Math.max(0, this.pane.scroll + ((b & 1) ? 3 : -3));
      this.schedule();
      return;
    }
    if (this.home) {
      const i = y - 6; // first thread row of the home screen (1-based terminal rows)
      const t = this.homeProvider?.().threads ?? [];
      if (press && !wheel && i >= 0 && i < t.length) {
        this.home.selected = i;
        const at = this.entries.findIndex(e => e.id === t[i].id);
        if (at >= 0) this.select(at);
      }
      this.schedule();
      return;
    }
    const { cols, rows } = this.io.size();
    const L = layout(cols, rows, this.sidebarOn ? this.sidebarWidth : 0);
    if (L.sidebar && x <= L.sidebar) {
      const i = Math.floor((y - 2) / 2); // threads take two rows each, below the header
      if (press && !wheel && (b & 3) === 0 && i >= 0 && i < this.entries.length) this.select(i);
      return;
    }
    const host = this.current?.host;
    if (host && host.state === 'running' && host.screen.modes().mouse && x > L.contentX && y <= L.contentRows) {
      host.write(`\x1b[<${b};${x - L.contentX};${y}${press ? 'M' : 'm'}`);
    }
  }

  private homeKey(key: string) {
    const h = this.home!;
    const n = this.homeProvider?.().threads.length ?? 0;
    if (key === '\x1b[A' || key === 'k') h.selected = Math.max(0, h.selected - 1);
    else if (key === '\x1b[B' || key === 'j') h.selected = Math.min(Math.max(0, n - 1), h.selected + 1);
    else if (key === '\r' || key === '\n') {
      const t = this.homeProvider?.().threads[h.selected];
      const at = t ? this.entries.findIndex(e => e.id === t.id) : -1;
      if (at >= 0) this.select(at);
    } else if (key === 'n') this.emit('action', 'new');
    else if (key === 'a') this.emit('action', 'files');
    else if (key === 'd') this.emit('action', 'doctor');
    else if (key === 'q') this.quit();
    else if (key === '\x1b' && this.entries.length) this.closeHome();
    this.schedule();
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
    const L = layout(cols, rows, this.sidebarOn && !this.home ? this.sidebarWidth : 0);
    const dialog = this.dialog;
    const alert = this.alertState;
    const actName = act?.title ?? 'thread';
    const overlay = this.formState
      ? this.formOverlay()
      : alert
        ? { title: alert.title, lines: alert.lines, rows: alert.options.map((o, i) => [o.key === '\r' ? '⏎' : o.key, o.label, i === alert.sel] as [string, string, boolean]), alert: true }
        : dialog
          ? { title: dialog.title, rows: dialog.options.map((o, i) => [String(i + 1), o, i === dialog.sel] as [string, string, boolean]), foot: '⏎ choose   esc cancel' }
          : this.router.menuOpen
            ? { title: `chorus · ${actName}`, rows: this.menuRows().map(([k, l], i) => [k, l, i === 0] as [string, string, boolean]), foot: `esc  back to ${act?.agent ?? 'the thread'}` }
            : undefined;
    const pane = this.pane && {
      title: this.pane.title,
      lines: this.pane.lines.slice(this.pane.scroll, this.pane.scroll + L.contentRows - 2),
      hint: this.pane.hint ?? `↑/↓ PgUp/PgDn scroll · g/G top/bottom · esc close  (${Math.min(this.pane.lines.length, this.pane.scroll + 1)}-${Math.min(this.pane.lines.length, this.pane.scroll + L.contentRows - 2)} of ${this.pane.lines.length})`,
    };
    const card = this.card && { title: this.card.title, lines: [...this.card.lines, `${this.menuLabel} y  approve    ${this.menuLabel} x  deny    (or switch to the thread and answer there)`] };
    const home = this.home && this.homeProvider ? { ...this.homeProvider(), selected: this.home.selected } : undefined;
    const meta = act?.meta ?? {};
    const exited = act?.host?.state === 'ended' ? `  (exited ${act.host.exitCode})` : '';
    const statusBar: StatusBar | undefined = act
      ? { title: act.title + exited, agent: act.agent, model: meta.model, from: meta.from, usage: meta.usage, artifacts: meta.artifacts ?? 0, toast: meta.toast, warn: (meta.usage ?? 0) >= 90 }
      : undefined;
    const message = this.flash || this.notice || (this.home ? 'home' : undefined);
    const { grid, cursor } = compose({
      cols,
      rows,
      sidebarWidth: this.sidebarOn ? this.sidebarWidth : 0,
      items: this.entries.map((t, i) => ({ title: t.title, agent: t.agent, state: this.stateOf(t), active: i === this.active, child: !!t.parentId })),
      screen: act?.host?.screen,
      statusBar,
      message,
      statusRight: this.router.menuOpen ? '1-9 switch · n new · h handoff · m memory · ? help · esc' : this.home ? 'esc: back to the thread' : `${this.menuLabel} menu`,
      overlay,
      pane,
      card,
      home,
      menuLabel: this.menuLabel,
    });
    let out = '\x1b[?2026h\x1b[?25l' + this.differ.frame(grid) + this.modeSync(pane || home ? undefined : act);
    if (cursor) out += `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h`;
    out += '\x1b[?2026l';
    this.io.stdout.write(out);
  }

  private formOverlay() {
    const st = this.formState!;
    const values: Record<string, string> = {};
    const lines = st.fields.map(f => {
      if (f.kind === 'text') {
        values[f.label] = f.value;
        return `${f.label.padEnd(7)} ${f.value}${st.fields[st.focus] === f ? '▌' : ''}`;
      }
      const opts = this.optionsOf(f, values);
      values[f.label] = opts[f.index ?? 0] ?? '';
      const shown = opts.slice(Math.max(0, (f.index ?? 0) - 3), Math.max(0, (f.index ?? 0) - 3) + 7).map(o => (o === values[f.label] ? `[${o}]` : ` ${o} `));
      return `${f.label.padEnd(7)} ${shown.join(' ')}`;
    });
    const hint = st.error ? `! ${st.error}` : '⏎ start   tab next field   ←/→ change   esc cancel';
    return { title: st.title, lines: [...lines, '', hint], selected: st.focus };
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
