// Draws the app frame: sidebar | active thread's screen | status bar | overlay. Pure functions over cells,
// so the layout can be tested without a terminal. The look follows docs/mockups/chorus-cli.html.
import type { Cell, VirtualScreen } from './screen.ts';

export type Grid = Cell[][];

export type ItemState = 'busy' | 'idle' | 'approval' | 'ended' | 'parked' | 'starting' | 'limit';

/** Colors of the mockup (true color; terminals without it approximate). */
export const T = {
  dim: '38;2;111;120;137',
  fg: '38;2;217;222;231',
  chorus: '38;2;79;193;182',
  claude: '38;2;224;138;104',
  codex: '38;2;143;184;255',
  agy: '38;2;155;211;143',
  ok: '38;2;140;207;126',
  warn: '38;2;240;184;90',
  err: '38;2;240;122;122',
  line: '38;2;60;68;82',
  bgSide: '48;2;21;26;33',
  bgSel: '48;2;38;48;64',
  bgStatus: '48;2;29;37;48',
  bgWarn: '48;2;58;44;18',
  bgBrand: '48;2;79;193;182',
  fgBrand: '38;2;11;26;25',
  bgBox: '48;2;24;29;37',
};
export const agentStyle = (agent: string) => (agent === 'claude' ? T.claude : agent === 'codex' ? T.codex : agent === 'agy' ? T.agy : T.fg);
const join = (...p: (string | undefined | false)[]) => p.filter(Boolean).join(';');

export interface SidebarItem {
  title: string;
  agent: string;
  state: ItemState;
  active: boolean;
  /** continued from another thread: drawn under it */
  child?: boolean;
}

/** One styled piece of text: [text, style]. */
export type Seg = [string, string?];
export type RichLine = string | Seg[];

export interface Overlay {
  title: string;
  /** free lines (forms): the selected one is highlighted */
  lines?: string[];
  /** key + label rows (menus): the selected one is highlighted */
  rows?: [string, string, boolean?][];
  selected?: number;
  foot?: string;
  alert?: boolean;
}

export interface StatusBar {
  title: string;
  agent: string;
  model?: string;
  from?: string;
  /** plan usage 0..100 */
  usage?: number;
  artifacts: number;
  toast?: string;
  warn?: boolean;
}

export interface HomeView {
  project: string;
  agents: { name: string; version?: string; ok: boolean; note?: string }[];
  threads: { id: string; title: string; agent: string; state: string; age: string; artifacts: number; child?: boolean }[];
  selected: number;
}

export interface View {
  cols: number;
  rows: number;
  sidebarWidth: number; // 0 = hidden
  items: SidebarItem[];
  screen?: VirtualScreen;
  /** segmented bar for the current thread; `message` replaces it (flash, warnings, no thread yet) */
  statusBar?: StatusBar;
  message?: string;
  statusRight: string;
  overlay?: Overlay;
  /** replaces the thread area (memory, files, activity, help …) */
  pane?: { title: string; lines: RichLine[]; hint: string };
  /** approval card, drawn over the bottom of the thread area */
  card?: { title: string; lines: string[] };
  /** the home screen: no sidebar, no thread */
  home?: HomeView;
}

const GLYPH: Record<ItemState, { ch: string; s: string; label: string }> = {
  busy: { ch: '●', s: T.ok, label: 'working' },
  idle: { ch: '○', s: T.dim, label: 'idle' },
  approval: { ch: '!', s: join('1', T.err), label: 'needs approval' },
  ended: { ch: '○', s: T.dim, label: 'ended' },
  parked: { ch: '◌', s: T.dim, label: 'parked' },
  starting: { ch: '…', s: T.warn, label: 'starting' },
  limit: { ch: '■', s: T.err, label: 'limit reached' },
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

function putRich(grid: Grid, y: number, x: number, line: RichLine, base = '', maxX = grid[0].length) {
  const segs: Seg[] = typeof line === 'string' ? [[line]] : line;
  let cx = x;
  for (const [text, st] of segs) {
    put(grid, y, cx, text, join(base, st), maxX);
    cx += [...text].length;
  }
}

function fill(grid: Grid, y: number, x0: number, x1: number, s: string) {
  for (let x = x0; x < x1; x++) if (grid[y]?.[x]) grid[y][x] = { t: ' ', s };
}

export function layout(cols: number, rows: number, sidebarWanted: number) {
  const sw = sidebarWanted > 0 && cols >= 60 ? sidebarWanted : 0;
  return { sidebar: sw, contentX: sw ? sw + 1 : 0, contentCols: cols - (sw ? sw + 1 : 0), contentRows: Math.max(1, rows - 1) };
}

export function compose(v: View): { grid: Grid; cursor: { x: number; y: number } | null } {
  const L = layout(v.cols, v.rows, v.home ? 0 : v.sidebarWidth);
  const grid = blank(v.cols, v.rows);

  if (v.home) drawHome(grid, v.home, L.contentCols, L.contentRows);

  if (L.sidebar) drawSidebar(grid, v.items, L.sidebar, L.contentRows);

  if (v.pane) {
    fill(grid, 0, L.contentX, L.contentX + L.contentCols, T.bgStatus);
    put(grid, 0, L.contentX + 1, v.pane.title, join('1', T.chorus, T.bgStatus), L.contentX + L.contentCols);
    v.pane.lines.slice(0, L.contentRows - 2).forEach((line, i) => putRich(grid, i + 1, L.contentX + 2, line, '', L.contentX + L.contentCols));
    put(grid, L.contentRows - 1, L.contentX + 1, v.pane.hint, T.dim, L.contentX + L.contentCols);
  } else if (v.screen && !v.home) {
    for (let y = 0; y < L.contentRows; y++) {
      const row = v.screen.row(y, L.contentCols);
      for (let x = 0; x < row.length; x++) grid[y][L.contentX + x] = row[x];
    }
  }

  drawStatus(grid, v);

  let cursor: { x: number; y: number } | null = null;
  if (v.screen && !v.overlay && !v.pane && !v.home) {
    const c = v.screen.cursor();
    if (!c.hidden && c.y < L.contentRows && c.x < L.contentCols) cursor = { x: L.contentX + c.x, y: c.y };
  }

  if (v.card) drawCard(grid, v.card, L.contentX, L.contentCols, L.contentRows);
  if (v.overlay) drawOverlay(grid, v.overlay, L.contentX, L.contentCols, L.contentRows);
  return { grid, cursor };
}

function stateOf(it: SidebarItem): { ch: string; s: string; label: string; labelStyle: string } {
  if (it.state === 'idle' && !it.active) return { ch: '◐', s: T.warn, label: 'waiting for you', labelStyle: T.warn };
  const g = GLYPH[it.state];
  return { ...g, labelStyle: it.state === 'approval' || it.state === 'limit' ? T.err : T.dim };
}

function drawSidebar(grid: Grid, items: SidebarItem[], width: number, height: number) {
  for (let y = 0; y < height; y++) {
    fill(grid, y, 0, width, T.bgSide);
    put(grid, y, width, '│', T.line);
  }
  put(grid, 0, 1, 'THREADS', join(T.dim, T.bgSide), width);
  const active = Math.max(0, items.findIndex(i => i.active));
  put(grid, 0, 10, '·', join(T.dim, T.bgSide), width);
  put(grid, 0, 12, String(items.length ? active + 1 : 0), join(T.chorus, T.bgSide), width);
  put(grid, 0, 12 + String(active + 1).length, `/${items.length}`, join(T.dim, T.bgSide), width);

  const room = Math.floor((height - 4) / 2);
  items.slice(0, Math.max(0, room)).forEach((it, i) => {
    const y = 1 + i * 2;
    const g = stateOf(it);
    const bg = it.active ? T.bgSel : T.bgSide;
    fill(grid, y, 0, width, bg);
    fill(grid, y + 1, 0, width, bg);
    if (it.active) {
      put(grid, y, 0, '▎', join(T.chorus, bg), width);
      put(grid, y + 1, 0, '▎', join(T.chorus, bg), width);
    }
    let x = 2;
    if (it.child) {
      put(grid, y, x, '↳', join(T.dim, bg), width);
      x += 2;
    }
    put(grid, y, x, g.ch, join(g.s, bg), width);
    const title = it.title.length > width - x - 3 ? it.title.slice(0, width - x - 4) + '…' : it.title;
    put(grid, y, x + 2, title, join(it.active ? '1' : '', T.fg, bg), width - 1);
    const x2 = it.child ? 6 : 4;
    put(grid, y + 1, x2, it.agent, join(agentStyle(it.agent), bg), width - 1);
    put(grid, y + 1, x2 + it.agent.length, ` · ${g.label}`, join(g.labelStyle, bg), width - 1);
  });

  const f1: Seg[] = [['⌃Space ↑↓', join(T.chorus, T.bgSide)], [' move  ', join(T.dim, T.bgSide)], ['⏎', join(T.chorus, T.bgSide)], [' open', join(T.dim, T.bgSide)]];
  const f2: Seg[] = [['⌃Space n', join(T.chorus, T.bgSide)], [' new  ', join(T.dim, T.bgSide)], ['b', join(T.chorus, T.bgSide)], [' hide', join(T.dim, T.bgSide)]];
  for (let x = 0; x < width; x++) grid[height - 3][x] = { t: '─', s: join(T.line, T.bgSide) };
  putRich(grid, height - 2, 1, f1, '', width);
  putRich(grid, height - 1, 1, f2, '', width);
}

function meter(pct: number): { text: string; s: string } {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return { text: '▮'.repeat(filled) + '▱'.repeat(10 - filled), s: pct >= 90 ? T.err : pct >= 75 ? T.warn : T.ok };
}

function drawStatus(grid: Grid, v: View) {
  const y = v.rows - 1;
  const warn = v.statusBar?.warn;
  const bg = warn ? T.bgWarn : T.bgStatus;
  fill(grid, y, 0, v.cols, bg);
  const segs: Seg[] = [[' chorus ', join('1', T.fgBrand, T.bgBrand)]];
  const sep: Seg = ['│', join(T.line, bg)];
  const sb = v.statusBar;
  if (v.message || !sb) {
    segs.push([` ${v.message ?? 'no threads'} `, join(T.fg, bg)]);
  } else {
    segs.push([` ${sb.title} `, join(T.fg, bg)], sep);
    segs.push([` ${sb.agent}${sb.model ? ' · ' + sb.model : ''}`, join(agentStyle(sb.agent), bg)]);
    if (sb.from) segs.push([' from ', join(T.dim, bg)], [sb.from, join(agentStyle(sb.from), bg)]);
    segs.push([' ', bg], sep);
    if (sb.usage !== undefined) {
      const m = meter(sb.usage);
      segs.push([' 5h ', join(T.fg, bg)], [m.text, join(m.s, bg)], [` ${Math.round(sb.usage)}%`, join(T.fg, bg)]);
      if (warn) segs.push([' limit', join(T.err, bg)]);
      segs.push([' ', bg], sep);
    }
    segs.push([` ${sb.artifacts} artifact${sb.artifacts === 1 ? '' : 's'}`, join(T.fg, bg)]);
    if (sb.toast) segs.push([` ${sb.toast}`, join(T.ok, bg)]);
    segs.push([' ', bg]);
  }
  // measure, then right-align the hint
  const used = segs.reduce((n, [t]) => n + [...t].length, 0);
  const right = ` ${v.statusRight} `;
  putRich(grid, y, 0, segs, '', v.cols);
  if (used + right.length < v.cols) put(grid, y, v.cols - right.length, right, join(T.dim, bg));
}

function drawHome(grid: Grid, h: HomeView, width: number, height: number) {
  put(grid, 0, 2, 'chorus', join('1', T.chorus), width);
  put(grid, 0, 9, `0.1  ·  ${h.project}`, T.dim, width);
  put(grid, 2, 2, 'Agents', T.dim, width);
  let x = 11;
  for (const a of h.agents) {
    put(grid, 2, x, a.name, agentStyle(a.name), width);
    const info = ` ${a.version ?? a.note ?? 'not installed'} `;
    put(grid, 2, x + a.name.length, info, a.version ? T.fg : T.warn, width);
    put(grid, 2, x + a.name.length + info.length, a.ok ? '✓' : '✗', a.ok ? T.ok : T.err, width);
    x += a.name.length + info.length + 6;
  }
  put(grid, 4, 2, 'Threads', T.dim, width);
  if (!h.threads.length) put(grid, 6, 2, 'No threads yet. Press n to start one.', T.dim, width);
  h.threads.slice(0, height - 9).forEach((t, i) => {
    const y = 5 + i;
    const sel = i === h.selected;
    const bg = sel ? T.bgSel : '';
    fill(grid, y, 0, width, bg);
    put(grid, y, 2, sel ? '▸' : ' ', join(T.chorus, bg), width);
    const title = (t.child ? '↳ ' : '') + t.title;
    put(grid, y, 4, title.length > 26 ? title.slice(0, 25) + '…' : title, join(t.child ? T.dim : T.fg, bg), width);
    put(grid, y, 32, t.agent, join(agentStyle(t.agent), bg), width);
    put(grid, y, 41, t.state, join(t.state === 'waiting for you' ? T.warn : T.dim, bg), width);
    put(grid, y, 58, t.age, join(T.dim, bg), width);
    put(grid, y, 71, t.artifacts ? `${t.artifacts} artifact${t.artifacts === 1 ? '' : 's'}` : '—', join(T.dim, bg), width);
  });
  const keys: Seg[] = [['n', T.chorus], [' new thread   '], ['⏎', T.chorus], [' open   '], ['a', T.chorus], [' artifacts   '], ['d', T.chorus], [' doctor   '], ['q', T.chorus], [' quit']];
  putRich(grid, height - 2, 2, keys.map(([t, st]) => [t, st ?? T.dim] as Seg), '', width);
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
  const border = join('1', T.err, T.bgBox);
  put(grid, y, x, '┌' + '─'.repeat(inner) + '┐', border);
  put(grid, y, x + 2, ` ${c.title} `, border);
  lines.forEach((l, i) => {
    put(grid, y + 1 + i, x, '│', border);
    put(grid, y + 1 + i, x + 1, (' ' + l).padEnd(inner).slice(0, inner), join(T.fg, T.bgBox));
    put(grid, y + 1 + i, x + inner + 1, '│', border);
  });
  put(grid, y + boxH - 1, x, '└' + '─'.repeat(inner) + '┘', border);
}

function drawOverlay(grid: Grid, o: Overlay, x0: number, width: number, height: number) {
  const free = o.lines ?? [];
  const rows = o.rows ?? [];
  const body = free.length + rows.length + (free.length && rows.length ? 1 : 0);
  const inner = Math.min(width - 4, Math.max(o.title.length + 4, o.foot?.length ?? 0, ...free.map(l => l.length + 2), ...rows.map(r => r[1].length + 8), 34));
  const boxH = body + 2 + 2 + (o.foot ? 2 : 0); // borders, title + rule, foot rule + foot
  const x = x0 + Math.max(1, Math.floor((width - inner - 2) / 2));
  const y = Math.max(0, Math.floor((height - boxH) * 0.46));
  const accent = o.alert ? T.warn : T.chorus;
  const border = join(accent, T.bgBox);
  const blankRow = (yy: number) => {
    put(grid, yy, x, '│', border);
    fill(grid, yy, x + 1, x + inner + 1, T.bgBox);
    put(grid, yy, x + inner + 1, '│', border);
  };
  put(grid, y, x, '┌' + '─'.repeat(inner) + '┐', border);
  blankRow(y + 1);
  put(grid, y + 1, x + 2, o.title, join('1', accent, T.bgBox));
  put(grid, y + 2, x, '├' + '─'.repeat(inner) + '┤', border);
  let yy = y + 3;
  free.forEach((l, i) => {
    const sel = o.selected === i;
    blankRow(yy);
    fill(grid, yy, x + 1, x + inner + 1, sel ? T.bgSel : T.bgBox);
    put(grid, yy, x + 2, l, join(T.fg, sel ? T.bgSel : T.bgBox));
    yy++;
  });
  if (free.length && rows.length) blankRow(yy++);
  rows.forEach(([k, label, sel]) => {
    const bg = sel ? T.bgSel : T.bgBox;
    blankRow(yy);
    fill(grid, yy, x + 1, x + inner + 1, bg);
    put(grid, yy, x + 2, k, join('1', accent, bg));
    put(grid, yy, x + 8, label, join(T.fg, bg));
    yy++;
  });
  if (o.foot) {
    put(grid, yy, x, '├' + '─'.repeat(inner) + '┤', border);
    blankRow(yy + 1);
    put(grid, yy + 1, x + 2, o.foot, join(T.dim, T.bgBox));
    yy += 2;
  }
  put(grid, yy, x, '└' + '─'.repeat(inner) + '┘', border);
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
