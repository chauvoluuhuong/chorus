// One thread = one agent process in a PTY plus its virtual screen.
import { EventEmitter } from 'node:events';
import { nodePtyFactory, type PtyFactory, type PtyLike } from './pty.ts';
import { VirtualScreen } from './screen.ts';

/** Variables a parent Claude Code session leaks into children (CLAUDE.md rule 5). */
const SCRUB_ENV = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID'];

export type HostState = 'running' | 'ended';

export interface HostOpts {
  id: string;
  title: string;
  agent: string;
  file: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
}

export class ThreadHost extends EventEmitter {
  readonly id: string;
  title: string;
  readonly agent: string;
  readonly screen: VirtualScreen;
  state: HostState = 'running';
  exitCode: number | null = null;
  lastOutput = 0;
  private pty: PtyLike;

  constructor(o: HostOpts, factory: PtyFactory = nodePtyFactory) {
    super();
    this.id = o.id;
    this.title = o.title;
    this.agent = o.agent;
    this.screen = new VirtualScreen(o.cols, o.rows);
    const env: Record<string, string> = { ...(process.env as Record<string, string>), TERM: 'xterm-256color', ...o.env };
    for (const k of SCRUB_ENV) delete env[k];
    this.pty = factory(o.file, o.args, { cols: o.cols, rows: o.rows, cwd: o.cwd, env });
    // the program queries its terminal (cursor position, device attributes …); we are that terminal
    this.screen.onReply(d => this.state === 'running' && this.pty.write(d));
    this.pty.onData(d => {
      this.lastOutput = Date.now();
      this.screen.write(d, () => this.emit('update'));
    });
    this.pty.onExit(code => {
      this.state = 'ended';
      this.exitCode = code;
      this.emit('update');
      this.emit('exit', code);
    });
  }

  get pid() {
    return this.pty.pid;
  }

  write(data: string) {
    if (this.state === 'running') this.pty.write(data);
  }

  resize(cols: number, rows: number) {
    if (cols === this.screen.cols && rows === this.screen.rows) return;
    this.screen.resize(cols, rows);
    if (this.state === 'running') this.pty.resize(cols, rows);
    this.emit('update');
  }

  kill() {
    if (this.state === 'running') this.pty.kill();
  }

  /** Output seen in the last `ms` milliseconds (a cheap "busy" signal until P4.4 reads real events). */
  busy(ms = 1500) {
    return this.state === 'running' && Date.now() - this.lastOutput < ms;
  }
}
