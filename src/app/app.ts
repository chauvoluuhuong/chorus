// The chorus app shell: threads in PTYs with virtual screens, top bar, project-tree sidebar, status line, menu key,
// panes, dialogs, cards. Clicks are looked up in the hit regions of the last frame (compositor.ts), never recomputed.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { compose, Differ, T, hitAt, layout, paneRoom, type Hit, type ItemState, type PaneLine, type RichLine, type SideRow, type StatusBar } from './compositor.ts';
import { chip, hints } from './screens.ts';
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
  /** the folder the chat works in: chats are grouped by it in the sidebar */
  cwd: string;
  host?: ThreadHost;
  /** set by the controller from transcripts and the approval detector; absent = derive from the process */
  state?: ItemState;
  /** this thread continues another one: shown under it */
  parentId?: string;
  /** what the status bar shows besides the title (filled by the controller) */
  meta?: { model?: string; effort?: string; usage?: number; ctx?: number; artifacts?: number; from?: string; toast?: string; skip?: boolean };
}

export interface AppOpts {
  /** mouse clicks and hover (default on; CHORUS_MOUSE=0 turns it off) */
  mouse?: boolean;
  /** e.g. "ctrl+b"; default: Ctrl+\\ and Ctrl+Space (env CHORUS_MENU_KEY) */
  menuKey?: string;
  ptyFactory?: PtyFactory;
  /** repaint the whole frame this often even when nothing changed, so a glitch in the terminal heals itself (ms, default 3000) */
  repaintMs?: number;
}

export interface PaneOpts {
  /** which sidebar entry or menu row this pane belongs to ('new', 'skills', 'memory' …) */
  id?: string;
  hint?: RichLine;
  /** sees every key first (return true when it used it) */
  onKey?: (key: string) => boolean | void;
  /** a click on one of the pane's hit regions */
  onHit?: (id: string) => void;
  /** called when the pane closes by esc / Back */
  onClose?: () => void;
  /** the path shown in the top bar: where you are (default: the title); earlier parts are links back */
  crumb?: string[];
  /** the lines carry their own heading: no title row (the screens of the mockup) */
  bare?: boolean;
}

interface PaneState extends PaneOpts {
  title: string;
  lines: PaneLine[];
  scroll: number;
}

// 1003 = press, release and motion (hover); 1006 = SGR encoding. The agent's own mouse request is forwarded, see onMouse.
const MODE_RESET = '\x1b[?7h\x1b[?2004l\x1b[?1l\x1b[?1000l\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b[0m\x1b[?1049l';
const MOUSE_ON = '\x1b[?1003h\x1b[?1006h';
const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** keys the menu hands to the controller */
export const ACTION_KEYS: Record<string, string> = { D: 'delete', n: 'new', h: 'handoff', m: 'memory', a: 'files', f: 'files', i: 'approvals', k: 'skills', e: 'activity', t: 'activity', y: 'approve', x: 'deny', r: 'retry', d: 'doctor', '?': 'help' };

export interface ModalSpec {
  title: string;
  lines: string[];
  rows: [string, string, boolean?, string?][];
  foot?: string;
  onKey: (key: string) => void;
  onHit: (id: string) => void;
}

export class App extends EventEmitter {
  readonly entries: Entry[] = [];
  /** how the menu key is named on screen */
  menuLabel = '⌃\\';
  active = 0;
  sidebarOn = true;
  /** extra text shown in the status line until cleared (limit warning …) */
  notice = '';
  /** supplied by the controller: how many chats wait for an approval, and how many files the current chat has */
  waitingProvider: () => number = () => 0;
  /** hit regions of the last frame (tests click through them) */
  hits: Hit[] = [];
  private io: AppIO;
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
  private pane: PaneState | undefined;
  private folded = new Set<string>();
  private hover: string | undefined;
  /** sidebar scroll: undefined follows the selected chat; the last drawn offset and its limit let the wheel start from what you see */
  private sideScroll: number | undefined;
  private sideOffset = 0;
  private sideMax = 0;
  private alertState: { title: string; lines: string[]; options: { key: string; label: string }[]; sel: number; resolve: (k: string | undefined) => void } | undefined;
  private dialog: { title: string; options: string[]; sel: number; resolve: (i: number | undefined) => void } | undefined;
  /** a list box over whatever is in front (the folder picker): it reads the keys and clicks while open */
  private modal: ModalSpec | undefined;
  private wheelAcc = 0;
  private promptState: { title: string; lines: string[]; value: string; resolve: (v: string | undefined) => void } | undefined;
  private winTitle = '';
  private mouseOn: boolean;
  private repaintMs: number;
  private lastFull = 0;
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
      s = s.replace(MOUSE, (_m, b, x, y, kind) => (this.onMouse(Number(b), Number(x) - 1, Number(y) - 1, kind === 'M'), ''));
    }
    if (s) this.router.feed(s);
  };
  private onExitSignal = () => this.stop();
  readonly done: Promise<void>;
  private finish!: () => void;

  constructor(io: AppIO = processIO(), opts: AppOpts = {}) {
    super();
    this.io = io;
    this.mouseOn = (opts.mouse ?? true) && process.env.CHORUS_MOUSE !== '0';
    this.repaintMs = opts.repaintMs ?? Number(process.env.CHORUS_REPAINT_MS ?? 3000);
    this.factory = opts.ptyFactory ?? nodePtyFactory;
    const mk = parseMenuKeys(opts.menuKey ?? process.env.CHORUS_MENU_KEY);
    this.menuLabel = mk.label;
    this.router = new InputRouter(e => this.onInput(e), mk.keys);
    this.done = new Promise(r => (this.finish = r));
  }

  private contentSize() {
    const { cols, rows } = this.io.size();
    const L = layout(cols, rows, this.sidebarOn);
    return { cols: L.contentCols, rows: L.contentRows, tooSmall: L.tooSmall };
  }

  /* ---------- threads ---------- */

  /** Start a process for a thread and show it (also used by tests and `chorus mux`). */
  addThread(spec: ThreadSpec, select = true, parentId?: string): ThreadHost {
    const entry: Entry = { id: spec.id, title: spec.title, agent: spec.agent, cwd: spec.cwd, parentId };
    this.insert(entry);
    const host = this.attach(entry, spec);
    if (select) {
      this.closePane();
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

  /** Takes a chat out of the list and stops its process; the chats continued from it lose their link. */
  removeEntry(id: string) {
    const at = this.entries.findIndex(e => e.id === id);
    if (at < 0) return;
    const [gone] = this.entries.splice(at, 1);
    gone.host?.kill();
    for (const e of this.entries) if (e.parentId === id) e.parentId = undefined;
    const wasActive = at === this.active;
    if (at < this.active) this.active--;
    this.active = Math.max(0, Math.min(this.active, this.entries.length - 1));
    this.sideScroll = undefined;
    if (!this.entries.length) this.emit('action', 'new');
    else if (wasActive) this.emit('select', this.entries[this.active]);
    this.schedule();
  }

  /** Lines a full-area view can use (for lists a view scrolls itself). */
  paneRows(): number {
    const { cols, rows } = this.io.size();
    return paneRoom(layout(cols, rows, this.sidebarOn).contentRows, false);
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
    this.closePane(false);
    this.active = i;
    this.sideScroll = undefined; // follow the chat you picked
    this.emit('select', this.entries[i]);
    this.schedule();
  }

  /** The id of the open pane ('new', 'skills', 'memory' …), if any. */
  get paneId() {
    return this.pane?.id;
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
    // autowrap off: a row that comes out one cell too long (a glyph the terminal draws wider) is cut, never wrapped, so a frame can never scroll the screen
    // \x1b[22;0t saves the window title, \x1b[23;0t on exit gives it back
    this.io.stdout.write('\x1b[22;0t\x1b[?1049h\x1b[?7l\x1b[2J' + (this.mouseOn ? MOUSE_ON : ''));
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
    this.io.stdout.write(MODE_RESET + '\x1b[23;0t');
    this.emit('stopped');
    this.finish();
  }

  private relayout() {
    const { cols, rows, tooSmall } = this.contentSize();
    // too small: leave the agents at their last size, they keep running and redraw when the window is big enough again
    if (!tooSmall) for (const e of this.entries) e.host?.resize(cols, rows);
    this.differ.reset();
    this.io.stdout.write('\x1b[2J');
    this.schedule();
  }

  /* ---------- panes, dialogs, flashes ---------- */

  /** The path of the screen in front changes (New chat follows its project folder). */
  setCrumb(crumb: string[]) {
    if (!this.pane || JSON.stringify(this.pane.crumb) === JSON.stringify(crumb)) return;
    this.pane.crumb = crumb;
    this.schedule();
  }

  /** A full-area view (new chat, approvals, memory, skills …). */
  showPane(title: string, lines: PaneLine[], opts: PaneOpts = {}) {
    this.pane = { title, lines, scroll: 0, ...opts };
    this.router.capture = true;
    this.schedule();
  }

  showPaneHint(hint: RichLine) {
    if (this.pane) this.pane.hint = hint;
    this.schedule();
  }

  updatePane(lines: PaneLine[], title?: string) {
    if (!this.pane) return;
    this.pane.lines = lines;
    if (title) this.pane.title = title;
    this.schedule();
  }

  closePane(notify = true) {
    const p = this.pane;
    this.pane = undefined;
    this.router.capture = !!this.dialog || !!this.alertState;
    if (p && notify) p.onClose?.();
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

  /** One line of text (a command, a folder); Enter accepts, Esc cancels. */
  prompt(title: string, lines: string[], initial = ''): Promise<string | undefined> {
    return new Promise(resolve => {
      this.promptState = { title, lines, value: initial, resolve };
      this.router.capture = true;
      this.schedule();
    });
  }

  /** A warning with a few ways out (the mockup's "limit reached" box). Resolves with the chosen key, undefined on Esc. */
  alert(title: string, lines: string[], options: { key: string; label: string }[]): Promise<string | undefined> {
    return new Promise(resolve => {
      this.alertState = { title, lines, options, sel: 0, resolve };
      this.router.capture = true;
      this.schedule();
    });
  }

  /** Opens a list box over the current screen; `onKey` gets every key, `onHit` every click on one of its rows. */
  showModal(m: ModalSpec) {
    this.modal = m;
    this.router.capture = true;
    this.schedule();
  }

  updateModal(m: Partial<ModalSpec>) {
    if (!this.modal) return;
    Object.assign(this.modal, m);
    this.schedule();
  }

  closeModal() {
    this.modal = undefined;
    this.router.capture = !!this.pane || !!this.dialog || !!this.alertState || !!this.promptState;
    this.schedule();
  }

  /** Terminal bell: a request needs you while you look at another chat (CHORUS_BELL=0 mutes it). */
  bell() {
    if (this.started && process.env.CHORUS_BELL !== '0') this.io.stdout.write('\x07');
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

  toggleSidebar() {
    this.sidebarOn = !this.sidebarOn;
    this.relayout();
  }

  /* ---------- menu ---------- */

  /** The menu of the mockup: ten rows, ↑↓ + Enter, a click, or the row's letter. */
  menuRows(): { key: string; label: string; action: string }[] {
    const art = this.current?.meta?.artifacts;
    const waiting = this.waitingProvider();
    return [
      { key: 'h', label: 'Hand off to another agent', action: 'handoff' },
      { key: 'n', label: 'New chat', action: 'new' },
      { key: 'a', label: `Artifacts${art ? ` (${art})` : ''}`, action: 'files' },
      { key: 'i', label: `Approvals${waiting ? ` (${waiting})` : ''}`, action: 'approvals' },
      { key: 'k', label: 'Skills', action: 'skills' },
      { key: 'm', label: 'Memory', action: 'memory' },
      { key: 'e', label: 'Activity', action: 'activity' },
      { key: 'D', label: 'Delete chat', action: 'delete' },
      { key: 'b', label: 'Show / hide sidebar', action: 'sidebar' },
      { key: '?', label: 'Help', action: 'help' },
      { key: 'q', label: 'Quit', action: 'quit' },
    ];
  }

  /** Runs a menu command by action name. */
  runAction(action: string) {
    this.router.close();
    if (action === 'sidebar') this.toggleSidebar();
    else if (action === 'quit') this.quit();
    else this.emit('action', action);
    this.schedule();
  }

  openMenu() {
    this.router.open();
  }

  get menuOpen() {
    return this.router.menuOpen;
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

  /** Scrolls the sidebar by lines, from what is on screen now. */
  scrollSide(delta: number) {
    this.sideScroll = Math.max(0, Math.min(this.sideMax, (this.sideScroll ?? this.sideOffset) + delta));
    this.schedule();
  }

  /** Back: from a pane to the chat; from a chat to New chat. */
  back() {
    if (this.pane) this.closePane();
    else this.emit('action', 'new');
  }

  /* ---------- input ---------- */

  private onInput(e: InputEvent) {
    if (e.type === 'key') return this.onCaptured(e.key);
    switch (e.type) {
      case 'pass':
        this.quitArmed = false;
        this.current?.host?.write(e.data);
        break;
      case 'menu-open':
        this.menuSel = 0;
        break;
      case 'menu-close':
        break;
      case 'menu-move': {
        const n = this.menuRows().length;
        this.menuSel = (this.menuSel + e.delta + n) % n;
        break;
      }
      case 'menu-enter':
        this.runAction(this.menuRows()[this.menuSel].action);
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
    if (this.promptState) {
      const st = this.promptState;
      const done = (v: string | undefined) => {
        this.promptState = undefined;
        this.router.capture = !!this.pane || !!this.dialog || !!this.alertState || !!this.modal;
        st.resolve(v);
        this.schedule();
      };
      if (key === '\x1b') return done(undefined);
      if (key === '\r' || key === '\n') return done(st.value.trim() || undefined);
      if (key === '\x7f' || key === '\b') st.value = st.value.slice(0, -1);
      else if (key === '\x15') st.value = '';
      else if (key.length >= 1 && key >= ' ' && !key.startsWith('\x1b')) st.value += key;
      return void this.schedule();
    }
    if (this.alertState) return this.alertKey(key);
    if (this.modal) {
      this.modal.onKey(key);
      return void this.schedule();
    }
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
    if (this.pane?.onKey?.(key)) return void this.schedule();
    if (this.pane) {
      const { rows } = this.io.size();
      const page = Math.max(1, rows - 5);
      const max = Math.max(0, this.pane.lines.length - (rows - 4));
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
      this.router.capture = !!this.pane || !!this.dialog;
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
   * Mouse (0-based cell). Motion lights up the region under the pointer. A left click on a Chorus region runs it; elsewhere
   * in the thread area it goes to the agent if the agent asked for the mouse (coordinates shifted by the sidebar and top bar).
   */
  private onMouse(b: number, x: number, y: number, press: boolean) {
    const motion = (b & 32) !== 0;
    const wheel = (b & 64) !== 0;
    const id = hitAt(this.hits, x, y);
    if (motion) {
      if (id !== this.hover) {
        this.hover = id;
        this.schedule();
      }
      return;
    }
    if (wheel && press && this.sideMax > 0 && x < layout(this.io.size().cols, this.io.size().rows, this.sidebarOn).sidebar) {
      this.scrollSide((b & 1) ? 3 : -3);
      return;
    }
    if (this.modal && wheel && press) {
      this.modal.onKey((b & 1) ? '\x1b[B' : '\x1b[A');
      this.schedule();
      return;
    }
    if (this.pane && wheel && press) {
      this.pane.scroll = Math.max(0, this.pane.scroll + ((b & 1) ? 3 : -3));
      this.schedule();
      return;
    }
    if (press && !wheel && (b & 3) === 0 && id && this.click(id)) return this.schedule();
    const { cols, rows } = this.io.size();
    const L = layout(cols, rows, this.sidebarOn);
    const host = this.current?.host;
    const inThread = !this.pane && !this.promptState && !this.dialog && !this.alertState && !this.router.menuOpen && host?.state === 'running' && x >= L.contentX && y >= L.contentY && y < L.contentY + L.contentRows;
    // a full-screen agent that did not ask for the mouse (agy) would never see the wheel: send it the page keys it scrolls with
    if (wheel && press && inThread && host && !host.screen.modes().mouse && host.screen.modes().alt) {
      this.wheelAcc += (b & 1) ? 1 : -1;
      if (Math.abs(this.wheelAcc) >= 2) {
        host.write(this.wheelAcc > 0 ? '\x1b[6~' : '\x1b[5~');
        this.wheelAcc = 0;
      }
      return;
    }
    if (!this.pane && !this.dialog && !this.alertState && !this.router.menuOpen && host && host.state === 'running' && host.screen.modes().mouse && x >= L.contentX && y >= L.contentY && y < L.contentY + L.contentRows) {
      const row = y - L.contentY - host.screen.shift(); // an anchored screen (agy) is drawn lower than the agent thinks
      if (row >= 0) host.write(`\x1b[<${b};${x - L.contentX + 1};${row + 1}${press ? 'M' : 'm'}`);
    }
  }

  /** Runs the region with this id. Returns false when nothing used it. */
  click(id: string): boolean {
    if (this.router.menuOpen) {
      const m = id.startsWith('menu:') ? this.menuRows().find(r => r.key === id.slice(5)) : undefined;
      if (m) this.runAction(m.action);
      else this.router.close();
      return true;
    }
    if (this.alertState) {
      const i = id.startsWith('alert:') ? Number(id.slice(6)) : -1;
      if (i >= 0) this.alertKey(this.alertState.options[i].key);
      return true;
    }
    if (this.modal) {
      this.modal.onHit(id);
      return true;
    }
    if (this.dialog) {
      const i = id.startsWith('choice:') ? Number(id.slice(7)) : -1;
      if (i >= 0) this.onCaptured(String(i + 1));
      return true;
    }
    if (id === 'newproject') return void this.emit('action', 'project'), true;
    if (id === 'side:up' || id === 'side:down') return void this.scrollSide(id === 'side:up' ? -5 : 5), true;
    if (id === 'back') return void this.back(), true;
    if (id === 'menu') return void this.openMenu(), true;
    if (id === 'approvals') return void this.emit('action', 'approvals'), true;
    if (id === 'artifacts') return void this.emit('action', 'files'), true;
    if (id === 'new') return void this.emit('action', 'new'), true;
    if (id === 'skills') return void this.emit('action', 'skills'), true;
    if (id === 'memory') return void this.emit('action', 'memory'), true;
    if (id.startsWith('crumb:')) return void this.closePane(), true; // a path part before the last one is the chat: back to it
    if (id.startsWith('newin:')) return void this.emit('action', `new-in:${id.slice(6)}`), true; // the + of a project row
    if (id.startsWith('project:')) {
      const cwd = id.slice(8);
      if (this.folded.has(cwd)) this.folded.delete(cwd);
      else this.folded.add(cwd);
      return true;
    }
    if (id.startsWith('chat:')) return void this.select(Number(id.slice(5))), true;
    if (this.pane?.onHit) return void this.pane.onHit(id), true;
    return false;
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

  /** The sidebar: New chat, then each project with its chats, then Skills and Memory. */
  sideRows(): SideRow[] {
    const rows: SideRow[] = [{ kind: 'new', active: this.pane?.id === 'new' }];
    const order: string[] = [];
    for (const e of this.entries) if (!order.includes(e.cwd)) order.push(e.cwd);
    const act = this.pane ? undefined : this.current;
    for (const cwd of order) {
      const chats = this.entries.map((e, index) => ({ e, index })).filter(c => c.e.cwd === cwd);
      const open = !this.folded.has(cwd);
      rows.push({
        kind: 'project',
        cwd,
        name: projectName(cwd),
        open,
        count: chats.length,
        waiting: chats.filter(c => this.stateOf(c.e) === 'approval').length,
        active: act?.cwd === cwd && !open,
      });
      if (open)
        for (const c of chats) rows.push({ kind: 'chat', index: c.index, title: c.e.title, agent: c.e.agent, state: this.stateOf(c.e), active: c.e === act, child: !!c.e.parentId });
    }
    rows.push({ kind: 'skills', active: this.pane?.id === 'skills' }, { kind: 'memory', active: this.pane?.id === 'memory' });
    return rows;
  }

  render() {
    if (!this.started) return;
    const { cols, rows } = this.io.size();
    const act = this.current;
    const L = layout(cols, rows, this.sidebarOn);
    const dialog = this.dialog;
    const alert = this.alertState;
    const actName = act?.title ?? 'chat';
    const menuRows = this.menuRows();
    const overlay = this.promptState
      ? { title: this.promptState.title, lines: [...this.promptState.lines, '', `> ${this.promptState.value}▌`], selected: this.promptState.lines.length + 1, foot: '⏎ accept   esc cancel' }
      : alert
      ? { title: alert.title, lines: alert.lines, rows: alert.options.map((o, i) => [o.key === '\r' ? '⏎' : o.key, o.label, i === alert.sel, `alert:${i}`] as [string, string, boolean, string]), alert: true }
      : this.modal
      ? { title: this.modal.title, lines: this.modal.lines, rows: this.modal.rows, foot: this.modal.foot, minWidth: 64 }
      : dialog
        ? { title: dialog.title, rows: dialog.options.map((o, i) => [i === dialog.sel ? '▸' : ' ', o, i === dialog.sel, `choice:${i}`] as [string, string, boolean, string]), foot: '↑↓ move   ⏎ start   esc cancel' }
        : this.router.menuOpen
          ? { title: `chorus · ${actName}`, rows: menuRows.map((r, i) => [r.key, r.label, i === this.menuSel, `menu:${r.key}`] as [string, string, boolean, string]), foot: `↑↓ move   ⏎ run   esc  back to ${act?.agent ?? 'the chat'}` }
          : undefined;
    const room = this.pane ? paneRoom(L.contentRows, !this.pane.bare) : 0;
    const pane = this.pane && {
      title: this.pane.title,
      bare: this.pane.bare,
      lines: this.pane.lines.slice(this.pane.scroll, this.pane.scroll + room),
      hint:
        this.pane.hint ??
        ([
          ...hints(chip('↑↓', 'scroll'), chip('PgUp/PgDn', 'page'), chip('g/G', 'top / bottom'), chip('esc', 'back', 'back')),
          [`    ${Math.min(this.pane.lines.length, this.pane.scroll + 1)}-${Math.min(this.pane.lines.length, this.pane.scroll + room)} of ${this.pane.lines.length}`, T.dim],
        ] as RichLine),
    };
    const meta = act?.meta ?? {};
    const exited = act?.host?.state === 'ended' ? `  (exited ${act.host.exitCode})` : '';
    const statusBar: StatusBar | undefined = act
      ? { title: act.title + exited, agent: act.agent, model: meta.model, effort: meta.effort, from: meta.from, usage: meta.usage, ctx: meta.ctx, artifacts: meta.artifacts ?? 0, toast: meta.toast, warn: (meta.usage ?? 0) >= 90, skip: meta.skip }
      : undefined;
    // a full-area screen shows only a real flash (on its hint row); the status line says "no chats yet" when there is none
    const message = this.flash || this.notice || (this.pane ? undefined : !act ? 'no chats yet' : undefined);
    // where you are, nothing else: the chat title, or the screen (after the chat it belongs to, for its Artifacts or Activity)
    // the path is <project> / <chat> [/ Artifacts]; Approvals, Memory and Skills belong to no project
    const inProject = !this.pane || ['artifacts', 'activity'].includes(this.pane.id ?? ''); // New chat names its own project
    const path = this.pane ? (this.pane.crumb ?? [this.pane.title]) : act ? [act.title] : [];
    const crumb = inProject && act && path.length ? [projectName(act.cwd), ...path] : path;
    const { grid, cursor, hits, sideOffset, sideMax } = compose({
      cols,
      rows,
      sidebarOn: this.sidebarOn,
      side: this.sideRows(),
      sideScroll: this.sideScroll,
      top: { back: !!this.pane || !!act, crumb, waiting: this.waitingProvider() },
      screen: act?.host?.screen,
      statusBar: this.pane ? undefined : statusBar,
      message,
      statusRight: this.router.menuOpen ? '↑↓ ⏎ or the letter · esc' : '',
      overlay,
      pane,
      menuLabel: this.menuLabel,
      hover: this.hover,
    });
    this.hits = hits;
    this.sideOffset = sideOffset;
    this.sideMax = sideMax;
    // the Differ trusts that the terminal still shows what it last sent; every few seconds send everything again, so anything
    // that disturbed the screen (a torn frame, a stray write, a terminal that scrolled) is gone by itself
    if (this.repaintMs > 0 && Date.now() - this.lastFull > this.repaintMs) {
      this.differ.reset();
      this.lastFull = Date.now();
    }
    // the window title names the project, like the mockup's window bar: "~/projects/cake-shop — chorus"
    const winTitle = `${(act?.cwd ?? process.cwd()).replace(process.env.HOME ?? '\0', '~')} — chorus`;
    const titleSeq = winTitle !== this.winTitle ? `\x1b]0;${winTitle}\x07` : '';
    this.winTitle = winTitle;
    let out = titleSeq + '\x1b[?2026h\x1b[?25l' + this.differ.frame(grid) + this.modeSync(pane ? undefined : act);
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

/** The last folder name of a chat's working directory (the sidebar's project name). */
export function projectName(cwd: string): string {
  if (cwd.replace(/\/+$/, '').endsWith('/.chorus/computer')) return 'This computer';
  return path.basename(cwd) || cwd;
}
