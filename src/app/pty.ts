// node-pty behind a small interface, so the PTY layer can be swapped (docs/phase4.md §1).
import { createRequire } from 'node:module';
import { isSea } from 'node:sea';
import path from 'node:path';

// node-pty is a native addon: inside a single-executable build it is loaded from node_modules next to the binary
const require = createRequire(isSea() ? path.join(path.dirname(process.execPath), 'chorus.js') : import.meta.url);

export interface PtyLike {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtyOpts {
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type PtyFactory = (file: string, args: string[], opts: PtyOpts) => PtyLike;

export const nodePtyFactory: PtyFactory = (file, args, opts) => {
  const pty = require('node-pty');
  const p = pty.spawn(file, args, { name: 'xterm-256color', cols: opts.cols, rows: opts.rows, cwd: opts.cwd, env: opts.env });
  return {
    pid: p.pid,
    onData: cb => void p.onData(cb),
    onExit: cb => void p.onExit((e: { exitCode: number }) => cb(e.exitCode)),
    write: d => p.write(d),
    resize: (c, r) => {
      try {
        p.resize(c, r);
      } catch {
        /* already exited */
      }
    },
    kill: s => {
      try {
        p.kill(s);
      } catch {
        /* already exited */
      }
    },
  };
};
