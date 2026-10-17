#!/usr/bin/env node
// Phase 4 spike: can TypeScript host several real agent TUIs in PTYs with virtual screens, a sidebar and
// a status line, and switch between them? (tmux-style). Throwaway; findings go to docs/phase4.md.
//   node tools/spike/mux.ts codex agy
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const SIDEBAR = 24;
const names = process.argv.slice(2);
const out = process.stdout;
let cols = out.columns || 120;
let rows = out.rows || 40;
const inner = () => ({ c: cols - SIDEBAR - 1, r: rows - 1 });

interface T { name: string; term: any; ser: any; proc: any; bytes: number; lastData: number }
const threads: T[] = names.map(name => {
  const { c, r } = inner();
  const term = new Terminal({ cols: c, rows: r, allowProposedApi: true, scrollback: 0 });
  const ser = new SerializeAddon();
  term.loadAddon(ser);
  const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>;
  const proc = pty.spawn(name, [], { name: 'xterm-256color', cols: c, rows: r, cwd: process.cwd(), env });
  const t: T = { name, term, ser, proc, bytes: 0, lastData: Date.now() };
  proc.onData((d: string) => {
    t.bytes += d.length;
    t.lastData = Date.now();
    term.write(d, () => schedule());
  });
  return t;
});
let active = 0;
let menu = false;
let timer: NodeJS.Timeout | undefined;
const schedule = () => (timer ??= setTimeout(() => ((timer = undefined), render()), 25));

// Draw one row of a virtual screen from its cells (colors + attributes), the way tmux does.
function rowToAnsi(term: any, y: number, width: number): string {
  const line = term.buffer.active.getLine(y);
  if (!line) return '';
  let out = '';
  let last = '';
  let cell: any;
  for (let x = 0; x < width; x++) {
    cell = line.getCell(x, cell);
    if (!cell) break;
    const w = cell.getWidth();
    if (w === 0) continue;
    const color = (mode: number, v: number, fg: boolean) =>
      cell.isFgDefault && fg && mode === 0 ? '' :
      mode === 0 ? '' : mode === 1 /* palette16 */ ? `${fg ? 38 : 48};5;${v}` : mode === 2 /* palette256 */ ? `${fg ? 38 : 48};5;${v}` : `${fg ? 38 : 48};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`;
    const parts = [
      cell.isBold() ? '1' : '', cell.isDim() ? '2' : '', cell.isItalic() ? '3' : '', cell.isUnderline() ? '4' : '', cell.isInverse() ? '7' : '',
      cell.isFgDefault() ? '' : color(cell.isFgRGB() ? 3 : cell.isFgPalette() ? 2 : 0, cell.getFgColor(), true),
      cell.isBgDefault() ? '' : color(cell.isBgRGB() ? 3 : cell.isBgPalette() ? 2 : 0, cell.getBgColor(), false),
    ].filter(Boolean);
    const key = parts.join(';');
    if (key !== last) {
      out += `\x1b[0${key ? ';' + key : ''}m`;
      last = key;
    }
    out += cell.getChars() || ' ';
  }
  return out + '\x1b[0m';
}

function render() {
  const t = threads[active];
  const { c, r } = inner();
  let s = '\x1b[?2026h\x1b[?25l';
  for (let y = 0; y < rows - 1; y++) {
    // sidebar column
    const row = threads[y - 1];
    const label = row ? `${y - 1 === active ? "▶" : " "} ${y} ${row.name}${Date.now() - row.lastData < 1500 ? ' ●' : ''}` : '';
    s += `\x1b[${y + 1};1H\x1b[0m${(y === 0 ? ' CHORUS' : label).padEnd(SIDEBAR).slice(0, SIDEBAR)}│`;
    if (y < r) s += `\x1b[${y + 1};${SIDEBAR + 2}H` + rowToAnsi(t.term, y, c) + '\x1b[0m\x1b[K';
  }
  const status = ` ${threads.map((x, i) => `${i === active ? '[' : ' '}${i + 1}:${x.name}${i === active ? ']' : ' '}`).join('')}  ${menu ? 'MENU: press 1-9' : 'ctrl+space = menu'}`;
  s += `\x1b[${rows};1H\x1b[0m\x1b[7m${status.padEnd(cols).slice(0, cols)}\x1b[0m`;
  const b = t.term.buffer.active;
  s += `\x1b[${b.cursorY + 1};${SIDEBAR + 2 + b.cursorX}H\x1b[?25h\x1b[?2026l`;
  out.write(s);
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
out.write('\x1b[?1049h\x1b[2J');
process.stdin.on('data', (d: Buffer) => {
  if (menu) {
    menu = false;
    const n = d.toString()[0];
    if (/[1-9]/.test(n) && threads[Number(n) - 1]) active = Number(n) - 1;
    else if (n === 'q') return quit();
    return render();
  }
  if (d.length === 1 && d[0] === 0) {
    menu = true;
    return render();
  }
  threads[active].proc.write(d.toString());
});
out.on('resize', () => {
  cols = out.columns;
  rows = out.rows;
  const { c, r } = inner();
  for (const t of threads) {
    t.term.resize(c, r);
    t.proc.resize(c, r);
  }
  out.write('\x1b[2J');
  render();
});
function quit() {
  for (const t of threads) try { t.proc.kill(); } catch {}
  out.write('\x1b[?1049l');
  process.exit(0);
}
setInterval(render, 500);
render();
