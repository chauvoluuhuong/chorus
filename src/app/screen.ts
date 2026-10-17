// A virtual terminal screen for one thread (the "terminal emulator in memory" of architecture §8).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');

/** One screen cell. `s` is an SGR parameter string ('' = default style), `t` the characters ('' = second half of a wide char). */
export interface Cell {
  t: string;
  s: string;
}

export interface TermModes {
  appCursor: boolean;
  bracketedPaste: boolean;
  alt: boolean;
}

export class VirtualScreen {
  readonly term: any;
  cols: number;
  rows: number;

  constructor(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  }

  write(data: string | Uint8Array, done?: () => void) {
    this.term.write(data, done);
  }

  /** Replies the emulator generates to the program (cursor position reports, device attributes …). */
  onReply(cb: (data: string) => void) {
    this.term.onData(cb);
  }

  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
  }

  row(y: number, width = this.cols): Cell[] {
    const line = this.term.buffer.active.getLine(y);
    const out: Cell[] = [];
    let cell: any;
    for (let x = 0; x < width; x++) {
      cell = line?.getCell(x, cell);
      if (!cell) {
        out.push({ t: ' ', s: '' });
        continue;
      }
      const w = cell.getWidth();
      if (w === 0) {
        out.push({ t: '', s: '' });
        continue;
      }
      out.push({ t: cell.getChars() || ' ', s: sgr(cell) });
    }
    return out;
  }

  /** Plain text of the screen, for tests and traces. */
  text(): string[] {
    const lines: string[] = [];
    for (let y = 0; y < this.rows; y++) lines.push(this.term.buffer.active.getLine(y)?.translateToString(true) ?? '');
    return lines;
  }

  cursor(): { x: number; y: number; hidden: boolean } {
    const b = this.term.buffer.active;
    const hidden = this.term._core?.coreService?.isCursorHidden ?? false;
    return { x: b.cursorX, y: b.cursorY, hidden };
  }

  modes(): TermModes {
    const m = this.term.modes;
    return { appCursor: !!m.applicationCursorKeysMode, bracketedPaste: !!m.bracketedPasteMode, alt: this.term.buffer.active.type === 'alternate' };
  }
}

function sgr(cell: any): string {
  const p: string[] = [];
  if (cell.isBold()) p.push('1');
  if (cell.isDim()) p.push('2');
  if (cell.isItalic()) p.push('3');
  if (cell.isUnderline()) p.push('4');
  if (cell.isBlink()) p.push('5');
  if (cell.isInverse()) p.push('7');
  if (cell.isInvisible()) p.push('8');
  if (cell.isStrikethrough()) p.push('9');
  if (!cell.isFgDefault()) p.push(color(cell.isFgRGB(), cell.getFgColor(), 38));
  if (!cell.isBgDefault()) p.push(color(cell.isBgRGB(), cell.getBgColor(), 48));
  return p.join(';');
}

function color(rgb: boolean, v: number, base: 38 | 48): string {
  return rgb ? `${base};2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}` : `${base};5;${v}`;
}
