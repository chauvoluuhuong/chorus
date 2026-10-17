// The chorus app shell (P4.1): threads in PTYs with virtual screens, sidebar, status line, menu key.
import { EventEmitter } from 'node:events';
import { compose, Differ, layout, type ItemState, type Overlay } from './compositor.ts';
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

export interface AppOpts {
  sidebarWidth?: number;
  menuKey?: string;
  ptyFactory?: PtyFactory;
}

const MODE_RESET = '\x1b[?2004l\x1b[?1l\x1b[?25h\x1b[0m\x1b[?1049l';

export class App extends EventEmitter {
  readonly threads: ThreadHost[] = [];
  active = 0;
  sidebarOn = true;
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

  addThread(spec: ThreadSpec, select = true): ThreadHost {
    const { cols, rows } = this.contentSize();
    const host = new ThreadHost({ ...spec, cols, rows }, this.factory);
    host.on('update', () => this.schedule());
    host.on('exit', code => this.emit('thread-exit', host, code));
    this.threads.push(host);
    if (select) this.active = this.threads.length - 1;
    this.schedule();
    return host;
  }

  select(i: number) {
    if (i >= 0 && i < this.threads.length) {
      this.active = i;
      this.schedule();
    }
  }

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
    this.tick = setInterval(() => this.schedule(), 700); // refresh the busy dots
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
    if (killThreads) for (const t of this.threads) t.kill();
    this.io.stdout.write(MODE_RESET);
    this.finish();
  }

  private relayout() {
    const { cols, rows } = this.contentSize();
    for (const t of this.threads) t.resize(cols, rows);
    this.differ.reset();
    this.io.stdout.write('\x1b[2J');
    this.schedule();
  }

  /* ---------- input ---------- */

  private menuItems() {
    return [
      ...this.threads.map((t, i) => ({ label: `${i + 1}  ${t.title}${t.state === 'ended' ? ' (ended)' : ''}`, run: () => this.select(i) })),
      { label: 'n  new thread', run: () => this.notYet('new thread', 'new') },
      { label: 'h  hand off', run: () => this.notYet('hand off', 'handoff') },
      { label: `b  ${this.sidebarOn ? 'hide' : 'show'} sidebar`, run: () => this.toggleSidebar() },
      { label: 'q  quit', run: () => this.quit() },
    ];
  }

  private notYet(what: string, action: string) {
    this.emit('action', action);
    this.setFlash(`${what}: not available yet`);
  }

  private toggleSidebar() {
    this.sidebarOn = !this.sidebarOn;
    this.relayout();
  }

  private quit() {
    const running = this.threads.filter(t => t.state === 'running').length;
    if (running && !this.quitArmed) {
      this.quitArmed = true;
      this.setFlash(`${running} thread(s) still running: press the menu key then q again to quit`);
      return;
    }
    this.stop();
  }

  private setFlash(msg: string) {
    this.flash = msg;
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flash = '';
      this.schedule();
    }, 4000);
    this.schedule();
  }

  private onInput(e: InputEvent) {
    switch (e.type) {
      case 'pass':
        this.quitArmed = false;
        this.threads[this.active]?.write(e.data);
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
      case 'menu-enter': {
        this.router.close();
        this.menuItems()[this.menuSel]?.run();
        break;
      }
      case 'menu-key': {
        this.router.close();
        const k = e.key;
        if (k !== 'q') this.quitArmed = false;
        if (/[1-9]/.test(k)) this.select(Number(k) - 1);
        else if (k === 'b') this.toggleSidebar();
        else if (k === 'n') this.notYet('new thread', 'new');
        else if (k === 'h') this.notYet('hand off', 'handoff');
        else if (k === 'q') this.quit();
        break;
      }
    }
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

  private stateOf(t: ThreadHost): ItemState {
    return t.state === 'ended' ? 'ended' : t.busy() ? 'busy' : 'idle';
  }

  render() {
    if (!this.started) return;
    const { cols, rows } = this.io.size();
    const act = this.threads[this.active];
    const overlay: Overlay | undefined = this.router.menuOpen
      ? { title: 'chorus', lines: this.menuItems().map(i => i.label), selected: this.menuSel }
      : undefined;
    const { grid, cursor } = compose({
      cols,
      rows,
      sidebarWidth: this.sidebarOn ? this.sidebarWidth : 0,
      items: this.threads.map((t, i) => ({ title: t.title, agent: t.agent, state: this.stateOf(t), active: i === this.active })),
      screen: act?.screen,
      status: this.flash || (act ? `${this.active + 1}/${this.threads.length}  ${act.title}  ·  ${act.agent}${act.state === 'ended' ? `  (exited ${act.exitCode})` : ''}` : 'no threads'),
      statusRight: this.router.menuOpen ? '1-9 switch · b sidebar · q quit · esc cancel' : 'ctrl+space: menu',
      overlay,
    });
    let out = '\x1b[?2026h\x1b[?25l' + this.differ.frame(grid) + this.modeSync(act);
    if (cursor) out += `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h`;
    out += '\x1b[?2026l';
    this.io.stdout.write(out);
  }

  /** Mirror the modes the active agent set on its (virtual) terminal onto the real one, so keys encode the way it expects. */
  private modeSync(act?: ThreadHost): string {
    const m = act?.screen.modes() ?? { appCursor: false, bracketedPaste: false };
    let out = '';
    if (m.appCursor !== this.applied.appCursor) out += m.appCursor ? '\x1b[?1h' : '\x1b[?1l';
    if (m.bracketedPaste !== this.applied.bracketedPaste) out += m.bracketedPaste ? '\x1b[?2004h' : '\x1b[?2004l';
    this.applied = { appCursor: m.appCursor, bracketedPaste: m.bracketedPaste };
    return out;
  }
}
