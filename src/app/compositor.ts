// Draws the app frame: sidebar | active thread's screen | status line | overlay. Pure functions over cells,
// so the layout can be tested without a terminal (docs/phase4.md §2).
import type { Cell, VirtualScreen } from './screen.ts';

export type Grid = Cell[][];

export type ItemState = 'busy' | 'idle' | 'approval' | 'ended' | 'parked' | 'starting';

export interface SidebarItem {
  title: string;
  agent: string;
  state: ItemState;
  active: boolean;
}

export interface Overlay {
  title: string;
  lines: string[];
  selected?: number;
}

export interface View {
  cols: number;
  rows: number;
  sidebarWidth: number; // 0 = hidden
  items: SidebarItem[];
  screen?: VirtualScreen;
  status: string;
  statusRight: string;
  overlay?: Overlay;
  /** replaces the thread area (memory view, tool calls, files, help) */
  pane?: { title: string; lines: string[]; hint: string };
  /** approval card, drawn over the bottom of the thread area */
  card?: { title: string; lines: string[] };
}

const GLYPH: Record<ItemState, { ch: string; s: string }> = {
  busy: { ch: '●', s: '32' },
  idle: { ch: '○', s: '2' },
  approval: { ch: '!', s: '1;31' },
  ended: { ch: '✕', s: '2' },
  parked: { ch: '◌', s: '2' },
  starting: { ch: '…', s: '33' },
};

export function blank(cols: number, rows: number): Grid {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ t: ' ', s: '' })));
}

function put(grid: Grid, y: number, x: number, text: string, s = '', maxX = grid[0].length) {
  if (y < 0 || y >= grid.length) return;
  let cx = x;
  for (const ch of text) {
    if (cx >= maxX) break;
    grid[y][cx++] = { t: ch, s };
  }
}

export function layout(cols: number, rows: number, sidebarWanted: number) {
  const sw = sidebarWanted > 0 && cols >= 60 ? sidebarWanted : 0;
  return { sidebar: sw, contentX: sw ? sw + 1 : 0, contentCols: cols - (sw ? sw + 1 : 0), contentRows: Math.max(1, rows - 1) };
}

export function compose(v: View): { grid: Grid; cursor: { x: number; y: number } | null } {
  const L = layout(v.cols, v.rows, v.sidebarWidth);
  const grid = blank(v.cols, v.rows);

  if (L.sidebar) {
    put(grid, 0, 1, 'CHORUS', '1', L.sidebar);
    v.items.slice(0, L.contentRows - 2).forEach((it, i) => {
      const y = i + 2;
      const g = GLYPH[it.state];
      const text = `${it.active ? '▶' : ' '}${i + 1} ${it.title}`;
      put(grid, y, 0, text.slice(0, L.sidebar - 2), it.active ? '1' : '', L.sidebar - 2);
      put(grid, y, L.sidebar - 1, g.ch, g.s, L.sidebar);
    });
    for (let y = 0; y < L.contentRows; y++) put(grid, y, L.sidebar, '│', '2');
  }

  if (v.pane) {
    put(grid, 0, L.contentX, ` ${v.pane.title} `.padEnd(L.contentCols), '7', L.contentX + L.contentCols);
    const body = v.pane.lines.slice(0, L.contentRows - 2);
    body.forEach((line, i) => put(grid, i + 1, L.contentX + 1, line, '', L.contentX + L.contentCols));
    put(grid, L.contentRows - 1, L.contentX, ` ${v.pane.hint} `, '2', L.contentX + L.contentCols);
  } else if (v.screen) {
    for (let y = 0; y < L.contentRows; y++) {
      const row = v.screen.row(y, L.contentCols);
      for (let x = 0; x < row.length; x++) grid[y][L.contentX + x] = row[x];
    }
  }

  // status line: whole last row, inverse
  const left = ` ${v.status}`;
  const right = `${v.statusRight} `;
  put(grid, v.rows - 1, 0, ' '.repeat(v.cols), '7');
  put(grid, v.rows - 1, 0, left.slice(0, Math.max(0, v.cols - right.length - 1)), '7');
  put(grid, v.rows - 1, Math.max(0, v.cols - right.length), right, '7');

  let cursor: { x: number; y: number } | null = null;
  if (v.screen && !v.overlay && !v.pane) {
    const c = v.screen.cursor();
    if (!c.hidden && c.y < L.contentRows && c.x < L.contentCols) cursor = { x: L.contentX + c.x, y: c.y };
  }

  if (v.card) drawCard(grid, v.card, L.contentX, L.contentCols, L.contentRows);
  if (v.overlay) drawOverlay(grid, v.overlay, L.contentX, L.contentCols, L.contentRows);
  return { grid, cursor };
}

function drawCard(grid: Grid, c: { title: string; lines: string[] }, x0: number, width: number, height: number) {
  const inner = width - 4;
  const wrap = (l: string) => {
    const out: string[] = [];
    for (let rest = l; rest.length; rest = rest.slice(inner - 2)) out.push(rest.slice(0, inner - 2));
    return out.length ? out : [''];
  };
  const lines = c.lines.flatMap(wrap).slice(0, 8);
  const boxH = lines.length + 2;
  const y = Math.max(0, height - boxH);
  const x = x0 + 1;
  put(grid, y, x, '┌' + '─'.repeat(inner) + '┐', '1;31');
  put(grid, y, x + 2, ` ${c.title} `, '1;31');
  lines.forEach((l, i) => put(grid, y + 1 + i, x, '│' + (' ' + l).padEnd(inner).slice(0, inner) + '│', '1;31'));
  put(grid, y + boxH - 1, x, '└' + '─'.repeat(inner) + '┘', '1;31');
  for (let i = 0; i < lines.length; i++) put(grid, y + 1 + i, x + 1, (' ' + lines[i]).padEnd(inner).slice(0, inner), '');
}

function drawOverlay(grid: Grid, o: Overlay, x0: number, width: number, height: number) {
  const inner = Math.min(width - 4, Math.max(o.title.length + 2, ...o.lines.map(l => l.length + 2), 24));
  const boxW = inner + 2;
  const boxH = o.lines.length + 2;
  const x = x0 + 1;
  const y = Math.max(0, height - boxH - 1);
  put(grid, y, x, '┌' + '─'.repeat(inner) + '┐', '');
  put(grid, y, x + 2, ` ${o.title} `, '1');
  o.lines.forEach((line, i) => {
    const sel = o.selected === i;
    put(grid, y + 1 + i, x, '│' + (' ' + line).padEnd(inner).slice(0, inner) + '│', sel ? '7' : '');
  });
  put(grid, y + boxH - 1, x, '└' + '─'.repeat(inner) + '┘', '');
  void boxW;
}

export function rowToAnsi(row: Cell[]): string {
  let out = '';
  let last = '';
  for (const c of row) {
    if (c.t === '' ) continue;
    if (c.s !== last) {
      out += `\x1b[0${c.s ? ';' + c.s : ''}m`;
      last = c.s;
    }
    out += c.t;
  }
  return out + '\x1b[0m';
}

export function gridText(grid: Grid): string[] {
  return grid.map(r => r.map(c => c.t).join('').replace(/\s+$/, ''));
}

/** Emits only the rows that changed since the last frame. */
export class Differ {
  private prev: string[] = [];

  reset() {
    this.prev = [];
  }

  frame(grid: Grid): string {
    let out = '';
    grid.forEach((row, y) => {
      const ansi = rowToAnsi(row);
      if (this.prev[y] !== ansi) {
        out += `\x1b[${y + 1};1H${ansi}`;
        this.prev[y] = ansi;
      }
    });
    this.prev.length = grid.length;
    return out;
  }
}
