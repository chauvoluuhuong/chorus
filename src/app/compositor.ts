// Draws the app frame: top bar | sidebar (projects and chats) | active thread's screen or a pane | status bar | overlay.
// Pure functions over cells, so the layout can be tested without a terminal. The look follows docs/mockups/chorus-cli.html.
//
// Anything clickable is registered as a hit region (`Hit`): compose() returns them with the grid and the app looks a click
// up there instead of redoing the layout arithmetic. Three looks, used the same everywhere (docs/ui-plan.md):
// a button is a filled chip (BTN), a link is underlined accent text (LINK), a list row lights up under the mouse (hover).
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
  /** a sidebar button (New chat, Skills, Memory) */
  bgBtn: '48;2;34;48;58',
  bgStatus: '48;2;29;37;48',
  bgWarn: '48;2;58;44;18',
  bgBrand: '48;2;79;193;182',
  fgBrand: '38;2;11;26;25',
  bgBox: '48;2;24;29;37',
  bgErr: '48;2;74;31;31',
  bgOk: '48;2;31;58;38',
};
export const agentStyle = (agent: string) => (agent === 'claude' ? T.claude : agent === 'codex' ? T.codex : agent === 'agy' ? T.agy : T.fg);
const join = (...p: (string | undefined | false)[]) => p.filter(Boolean).join(';');

/** A button is a filled chip, a link is underlined accent text. */
export const BTN = join('1', T.chorus, T.bgSel);
export const LINK = join('4', T.chorus);
export const BTN_OK = join('1', T.ok, T.bgOk);
export const BTN_BAD = join('1', T.err, T.bgErr);

/** A clickable rectangle: x0..x1 and y0..y1 are half-open, in screen cells (0-based). */
export interface Hit {
  id: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/** One styled piece of text: [text, style, hit id]. A hit id makes the piece clickable. */
export type Seg = [string, string?, string?];
export type RichLine = string | Seg[];
/** A pane line that is a whole clickable row (lists): the selected row gets a background. */
export interface PaneRow {
  line: RichLine;
  hit?: string;
  sel?: boolean;
}
export type PaneLine = RichLine | PaneRow;
const isRow = (l: PaneLine): l is PaneRow => typeof l === 'object' && !Array.isArray(l);

export type SideRow =
  | { kind: 'new'; /** the New chat screen is open */ active?: boolean }
  | { kind: 'project'; cwd: string; name: string; open: boolean; count: number; /** chats in it waiting for an approval */ waiting: number; active: boolean }
  | { kind: 'chat'; index: number; title: string; agent: string; state: ItemState; active: boolean; child?: boolean }
  | { kind: 'skills'; active: boolean }
  | { kind: 'memory'; active: boolean };

export interface Overlay {
  title: string;
  /** free lines (forms): the selected one is highlighted */
  lines?: string[];
  /** key + label rows (menus): the selected one is highlighted; the 4th element is the hit id */
  rows?: [string, string, boolean?, string?][];
  selected?: number;
  foot?: string;
  alert?: boolean;
}

export interface StatusBar {
  title: string;
  agent: string;
  model?: string;
  /** reasoning effort chosen for the chat */
  effort?: string;
  from?: string;
  /** plan usage 0..100 */
  usage?: number;
  /** context window use 0..100 */
  ctx?: number;
  artifacts: number;
  toast?: string;
  warn?: boolean;
  /** the chat runs with permission prompts off */
  skip?: boolean;
}

export interface TopBar {
  back: boolean;
  /** path parts; the last one is plain text, the others are links */
  crumb: string[];
  waiting: number;
}

export interface View {
  cols: number;
  rows: number;
  /** the user's choice (menu "b"); the width still decides whether it fits */
  sidebarOn: boolean;
  side: SideRow[];
  /** first sidebar line shown when you scrolled it yourself; undefined follows the selected chat */
  sideScroll?: number;
  top?: TopBar;
  screen?: VirtualScreen;
  /** segmented bar for the current thread; `message` replaces it (flash, warnings, no thread yet) */
  statusBar?: StatusBar;
  message?: string;
  statusRight: string;
  overlay?: Overlay;
  /** replaces the thread area (new chat, approvals, memory, skills, files, activity, help …) */
  pane?: { title: string; lines: PaneLine[]; hint: RichLine; /** the lines carry their own heading: no title row */ bare?: boolean };
  /** how the menu key is named in the hints */
  menuLabel?: string;
  /** hit id under the mouse: its region lights up */
  hover?: string;
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

/** Draws segments and registers a hit for every piece that has an id. Returns the x after the last cell. */
function putRich(grid: Grid, y: number, x: number, line: RichLine, base = '', maxX = grid[0].length, hits?: Hit[]): number {
  const segs: Seg[] = typeof line === 'string' ? [[line]] : line;
  let cx = x;
  for (const [text, st, id] of segs) {
    put(grid, y, cx, text, join(base, st), maxX);
    const w = [...text].length;
    if (id && hits) hits.push({ id, x0: cx, x1: Math.min(maxX, cx + w), y0: y, y1: y + 1 });
    cx += w;
  }
  return cx;
}

function fill(grid: Grid, y: number, x0: number, x1: number, s: string) {
  for (let x = x0; x < x1; x++) if (grid[y]?.[x]) grid[y][x] = { t: ' ', s };
}

const width = (line: RichLine) => (typeof line === 'string' ? [...line].length : line.reduce((n, [t]) => n + [...t].length, 0));

/* ---------- layout ---------- */

export const MIN_COLS = 50;
export const MIN_ROWS = 12;
export type SideMode = 'full' | 'narrow' | 'icons' | 'hidden';

/**
 * The window is split into a top bar (row 0), the middle (sidebar | content) and the status line (last row).
 * Chorus's own parts shrink first (docs/mockups/chorus-cli.html, "Window size"): 110+ columns full sidebar, 90-109 narrow,
 * 70-89 icons, 50-69 hidden, below 50x12 a "too small" screen.
 */
export function layout(cols: number, rows: number, sidebarOn = true) {
  const tooSmall = cols < MIN_COLS || rows < MIN_ROWS;
  const mode: SideMode = !sidebarOn || tooSmall ? 'hidden' : cols >= 110 ? 'full' : cols >= 90 ? 'narrow' : cols >= 70 ? 'icons' : 'hidden';
  const sidebar = { full: 28, narrow: 20, icons: 5, hidden: 0 }[mode];
  const contentX = sidebar ? sidebar + 1 : 0;
  return { tooSmall, mode, sidebar, contentX, contentY: 1, contentCols: Math.max(1, cols - contentX), contentRows: Math.max(1, rows - 2) };
}

/* ---------- compose ---------- */

export function compose(v: View): { grid: Grid; cursor: { x: number; y: number } | null; hits: Hit[]; sideOffset: number; sideMax: number } {
  const L = layout(v.cols, v.rows, v.sidebarOn);
  const grid = blank(v.cols, v.rows);
  const hits: Hit[] = [];
  if (L.tooSmall) {
    const msg = `window too small: ${v.cols}×${v.rows}, chorus needs ${MIN_COLS}×${MIN_ROWS}`;
    put(grid, Math.floor(v.rows / 2), Math.max(0, Math.floor((v.cols - msg.length) / 2)), msg, T.warn);
    put(grid, v.rows - 1, 0, 'your chats keep running', T.dim);
    return { grid, cursor: null, hits, sideOffset: 0, sideMax: 0 };
  }
  const right = L.contentX + L.contentCols;
  const Y = L.contentY;

  drawTop(grid, v, hits);
  // a full-area screen (New chat, Approvals, Memory …) has no status line, like the mockup: its key hints are the bottom row
  const rowsHere = v.pane ? L.contentRows + 1 : L.contentRows;
  const sideInfo = L.sidebar ? drawSidebar(grid, v.side, L.mode, L.sidebar, Y, rowsHere, hits, v.sideScroll) : { offset: 0, max: 0 };

  if (v.pane) {
    const titled = !v.pane.bare;
    // a blank row under the top bar; plain lines start 4 cells in, list rows 2 (their ▸ sits in the gap)
    let y = Y + 1;
    if (titled) {
      const [head, ...rest] = v.pane.title.split(' · ');
      putRich(grid, y, L.contentX + 4, [[head, join('1', T.chorus)], ...(rest.length ? ([[`  ·  ${rest.join(' · ')}`, T.fg]] as Seg[]) : [])], '', right);
      y += 2;
    }
    v.pane.lines.slice(0, paneRoom(L.contentRows, titled)).forEach((line, i) => {
      const yy = y + i;
      if (isRow(line)) {
        if (line.sel) fill(grid, yy, L.contentX, right, T.bgSel);
        if (line.hit) hits.push({ id: line.hit, x0: L.contentX, x1: right, y0: yy, y1: yy + 1 });
        putRich(grid, yy, L.contentX + 2, line.line, line.sel ? T.bgSel : '', right, hits);
      } else putRich(grid, yy, L.contentX + 4, line, '', right, hits);
    });
    const hy = Y + rowsHere - 1;
    const end = putRich(grid, hy, L.contentX + 4, v.pane.hint, '', right, hits);
    // a flash (approved …, path copied …) has no status line to go to: it shows at the right of the hint row
    if (v.message) {
      const m = v.message.length > right - end - 6 ? v.message.slice(0, Math.max(0, right - end - 7)) + '…' : v.message;
      if (m.length > 1) put(grid, hy, right - m.length - 2, m, T.ok, right);
    }
  } else if (v.screen) {
    for (let y = 0; y < L.contentRows; y++) {
      const row = v.screen.row(y, L.contentCols);
      for (let x = 0; x < row.length; x++) grid[Y + y][L.contentX + x] = row[x];
    }
  }

  if (!v.pane) drawStatus(grid, v, hits);

  let cursor: { x: number; y: number } | null = null;
  if (v.screen && !v.overlay && !v.pane) {
    const c = v.screen.cursor();
    if (!c.hidden && c.y < L.contentRows && c.x < L.contentCols) cursor = { x: L.contentX + c.x, y: Y + c.y };
  }

  if (v.overlay) drawOverlay(grid, v.overlay, L.contentX, L.contentCols, Y, L.contentRows, hits);

  if (v.hover) lightUp(grid, hits, v.hover);
  return { grid, cursor, hits, sideOffset: sideInfo.offset, sideMax: sideInfo.max };
}

/** Lines a pane can show: the content area minus its title row (unless bare) and the hint row. */
export const paneRoom = (contentRows: number, titled: boolean) => contentRows - 1 - (titled ? 2 : 0); // + the status row, − the top gap and the hints, − title and its gap

/** Hover: the region under the mouse gets the selection background. */
function lightUp(grid: Grid, hits: Hit[], id: string) {
  for (const h of hits) {
    if (h.id !== id) continue;
    for (let y = h.y0; y < h.y1; y++)
      for (let x = h.x0; x < h.x1; x++) {
        const c = grid[y]?.[x];
        if (c) grid[y][x] = { t: c.t, s: join(c.s.replace(/48;2;\d+;\d+;\d+/, ''), T.bgSel) };
      }
  }
}

/* ---------- top bar ---------- */

function drawTop(grid: Grid, v: View, hits: Hit[]) {
  const cols = v.cols;
  fill(grid, 0, 0, cols, T.bgStatus);
  const top = v.top;
  if (!top) return;
  // right side first, so the path can be cut before it touches the buttons
  const small = cols < 90; // icons or hidden sidebar: the buttons shrink to their glyphs
  const menu = small ? ' ☰ ' : ` ☰ Menu ${v.menuLabel ?? ''}`.trimEnd() + ' ';
  const waiting = top.waiting ? ` ! ${top.waiting}${small ? '' : ' waiting'} ` : '';
  let rx = cols - menu.length - 1;
  putRich(grid, 0, rx, [small || !v.menuLabel ? [menu, BTN, 'menu'] : [' ☰ Menu ', BTN, 'menu'], ...(small || !v.menuLabel ? [] : ([[`${v.menuLabel} `, join(T.dim, T.bgSel), 'menu']] as Seg[]))], T.bgStatus, cols, hits);
  if (waiting) {
    rx -= waiting.length + 2;
    putRich(grid, 0, rx, [[waiting, join('1', T.err, T.bgErr), 'approvals']], T.bgStatus, cols, hits);
  }
  const room = rx - 2; // the path ends here, with a gap before the buttons
  let x = 1;
  if (top.back) x = putRich(grid, 0, x, [[' ‹ Back ', BTN, 'back']], T.bgStatus, room, hits) + 2;
  let cut = false;
  top.crumb.forEach((part, i) => {
    if (cut) return;
    const last = i === top.crumb.length - 1;
    // no room for a separator and at least two characters of the next part: the path ends in an ellipsis
    if (i && x + 3 + 2 > room) {
      put(grid, 0, x, '…', join(T.dim, T.bgStatus), room + 1);
      cut = true;
      return;
    }
    if (i) x = putRich(grid, 0, x, [[' / ', T.dim]], T.bgStatus, room);
    const w = [...part].length;
    // a part that does not fit is cut with an ellipsis (the last part, the chat title, goes first)
    const text = x + w > room && room - x > 1 ? [...part].slice(0, Math.max(1, room - x - 1)).join('') + '…' : part;
    x = putRich(grid, 0, x, [[text, last ? join('1', T.fg) : LINK, last ? undefined : `crumb:${i}`]], T.bgStatus, room, hits);
  });
}

/* ---------- sidebar ---------- */

function stateOf(state: ItemState, active: boolean): { ch: string; s: string; label: string } {
  if (state === 'idle' && !active) return { ch: '◐', s: T.warn, label: 'waiting for you' };
  return GLYPH[state];
}

function drawSidebar(grid: Grid, rows: SideRow[], mode: SideMode, w: number, y0: number, height: number, hits: Hit[], scroll?: number): { offset: number; max: number } {
  for (let y = 0; y < height; y++) {
    fill(grid, y0 + y, 0, w, T.bgSide);
    put(grid, y0 + y, w, '│', T.line);
  }
  const top = rows.filter(r => r.kind !== 'skills' && r.kind !== 'memory');
  const foot = rows.filter(r => r.kind === 'skills' || r.kind === 'memory');
  // Skills and Memory: one button row each under a rule, with a blank row above each (the mockup's gaps); tight windows drop the gaps
  const spaced = height >= 16;
  const footH = foot.length ? foot.length * (spaced ? 2 : 1) + 1 + (spaced ? 1 : 0) : 0; // spaced: a blank row under Memory, above the status bar
  const listH = Math.max(1, height - footH);
  // the list as drawn: a blank row, New chat, a blank row, the PROJECTS heading, then projects and chats
  const lines: (SideRow | 'heading' | 'gap')[] = ['gap'];
  for (const r of top) {
    lines.push(r);
    if (r.kind === 'new' && mode !== 'icons') lines.push('gap', 'heading');
    else if (r.kind === 'new') lines.push('gap');
  }
  // the selected chat stays in view unless you scrolled yourself; with more lines than room, the first and last rows may carry a hint
  const sel = Math.max(0, lines.findIndex(r => typeof r !== 'string' && (r.kind === 'chat' || r.kind === 'project') && r.active));
  const max = Math.max(0, lines.length - listH);
  const offset = Math.max(0, Math.min(max, scroll ?? (sel - listH + 3)));
  lines.slice(offset, offset + listH).forEach((r, i) => {
    if (r === 'gap') return;
    if (r === 'heading') put(grid, y0 + i, 2, 'PROJECTS', join(T.dim, T.bgSide), w);
    else drawSideRow(grid, r, mode, w, y0 + i, hits);
  });
  const chatsIn = (from: number, to: number) => lines.slice(from, to).filter(r => typeof r !== 'string' && r.kind === 'chat').length;
  const hint = (y: number, glyph: string, n: number, id: string) => {
    fill(grid, y, 0, w, T.bgSide);
    const text = mode === 'icons' ? glyph : `${glyph} ${n} more chat${n === 1 ? '' : 's'}`;
    put(grid, y, mode === 'icons' ? 2 : 2, text, join('1', T.chorus, T.bgSide), w);
    hits.push({ id, x0: 0, x1: w, y0: y, y1: y + 1 });
  };
  if (offset > 0) hint(y0, '▲', chatsIn(0, offset), 'side:up');
  if (offset + listH < lines.length) hint(y0 + listH - 1, '▼', chatsIn(offset + listH, lines.length), 'side:down');
  if (footH) {
    for (let x = 0; x < w; x++) grid[y0 + listH][x] = { t: '─', s: join(T.line, T.bgSide) };
    foot.forEach((r, i) => drawSideRow(grid, r, mode, w, y0 + listH + 1 + (spaced ? 2 * i + 1 : i), hits));
  }
  return { offset, max };
}

function drawSideRow(grid: Grid, r: SideRow, mode: SideMode, w: number, y: number, hits: Hit[]) {
  const icons = mode === 'icons';
  const bg = (on: boolean) => (on ? T.bgSel : T.bgSide);
  const rowHit = (id: string) => hits.push({ id, x0: 0, x1: w, y0: y, y1: y + 1 });
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s);
  // New chat, Skills and Memory are buttons: a filled row one cell in from each edge, like the mockup
  if (r.kind === 'new') {
    rowHit('new');
    const b = r.active ? T.bgSel : T.bgBtn;
    fill(grid, y, 1, w - 1, b);
    put(grid, y, icons ? Math.max(1, (w - 1) >> 1) : 2, icons ? '+' : '+ New chat', join('1', T.chorus, b), w - 1);
    if (mode === 'full') put(grid, y, w - 3, 'n', join(T.dim, b), w - 1);
    return;
  }
  if (r.kind === 'skills' || r.kind === 'memory') {
    const b = r.active ? T.bgSel : T.bgBtn;
    fill(grid, y, 1, w - 1, b);
    rowHit(r.kind);
    const glyph = r.kind === 'skills' ? '✦' : '◫';
    put(grid, y, icons ? Math.max(1, (w - 1) >> 1) : 2, glyph, join(r.active ? T.chorus : T.dim, b), w - 1);
    if (!icons) put(grid, y, 4, r.kind === 'skills' ? 'Skills' : 'Memory', join(r.active ? T.fg : T.dim, b), w - 1); // dim like the mockup's footer
    return;
  }
  if (r.kind === 'project') {
    const b = bg(false);
    rowHit(`project:${r.cwd}`);
    put(grid, y, icons ? 1 : 2, r.open ? '▾' : '▸', join(T.dim, b), w);
    if (icons) {
      // no room for a name: the caret, and a ! when a chat in it is waiting
      if (r.waiting) put(grid, y, 3, '!', join('1', T.err, b), w);
      return;
    }
    // "▾ cake-shop !2": the count (or the waiting chats, in red) right after the name; an open project is bold
    const badge = r.waiting ? `!${r.waiting}` : String(r.count);
    const name = clip(r.name, w - 6 - badge.length);
    put(grid, y, 4, name, r.open ? join('1', T.fg, b) : join(T.dim, b), w);
    put(grid, y, 4 + [...name].length + 1, badge, r.waiting ? join('1', T.err, b) : join(T.dim, b), w);
    return;
  }
  const b = bg(r.active);
  const g = stateOf(r.state, r.active);
  fill(grid, y, 0, w, b);
  rowHit(`chat:${r.index}`);
  if (r.active) put(grid, y, 0, '▎', join(T.chorus, b), w);
  if (icons) {
    put(grid, y, 2, g.ch, join(g.s, b), w); // just the state dot
    return;
  }
  // "● Cake order page  claude" at the project's indent; a chat continued from another: "◐ ↳ Cake order …", two cells in
  let x = r.child ? 6 : 4; // chats sit under their project's name
  put(grid, y, x, g.ch, join(g.s, b), w);
  x += 2;
  if (r.child) {
    put(grid, y, x, '↳', join(T.dim, b), w);
    x += 2;
  }
  const agentRoom = mode === 'full' ? r.agent.length + 1 : 0;
  put(grid, y, x, clip(r.title, w - x - 1 - agentRoom), join(r.active ? '1' : '', T.fg, b), w - 1);
  if (agentRoom) put(grid, y, w - r.agent.length - 1, r.agent, join(agentStyle(r.agent), b), w);
}

/* ---------- status line ---------- */

/** "claude-opus-5-5" → "opus 5.5": the name you picked, not the API id */
export const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)(-\d{8})?$/, ' $1.$2');

function meter(pct: number): { text: string; s: string } {
  const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
  return { text: '▮'.repeat(filled) + '▱'.repeat(10 - filled), s: pct >= 90 ? T.err : pct >= 75 ? T.warn : T.ok };
}

/** Parts drop in this order when the window gets narrow: model, ctx, artifacts text, meter (docs/ui-plan.md item 6). */
function statusSegs(v: View, bg: string, level: number): Seg[] {
  const segs: Seg[] = [[' chorus ', join('1', T.fgBrand, T.bgBrand)]];
  const sep: Seg = ['│', join(T.line, bg)];
  const sb = v.statusBar;
  if (v.message || !sb) return [...segs, [` ${v.message ?? 'no chats'} `, join(T.fg, bg)]];
  segs.push([` ${sb.title} `, join(T.fg, bg)], sep);
  segs.push([` ${sb.agent}${sb.model && level < 1 ? ' · ' + shortModel(sb.model) : ''}${sb.effort && level < 1 ? ' · ' + sb.effort : ''}`, join(agentStyle(sb.agent), bg)]);
  if (sb.skip) segs.push([' skip', join('1', T.warn, bg)]);
  if (sb.from) segs.push([' from ', join(T.dim, bg)], [sb.from, join(agentStyle(sb.from), bg)]);
  segs.push([' ', bg], sep);
  if (sb.usage !== undefined) {
    const m = meter(sb.usage);
    segs.push([' 5h ', join(T.fg, bg)]);
    if (level < 3) segs.push([m.text, join(m.s, bg)], [' ', bg]);
    segs.push([`${Math.round(sb.usage)}%`, join(T.fg, bg)]);
    if (sb.warn) segs.push([' limit', join(T.err, bg)]);
    segs.push([' ', bg], sep);
  }
  if (sb.ctx !== undefined && level < 2) segs.push([` ctx ${Math.round(sb.ctx)}%`, join(sb.ctx >= 85 ? T.warn : T.fg, bg)], [' ', bg], sep);
  segs.push([level < 2 ? ` ${sb.artifacts} artifact${sb.artifacts === 1 ? '' : 's'}` : ` ${sb.artifacts}◆`, join(T.fg, bg), 'artifacts']);
  if (sb.toast) segs.push([` ${sb.toast}`, join(T.ok, bg)]);
  segs.push([' ', bg]);
  return segs;
}

function drawStatus(grid: Grid, v: View, hits: Hit[]) {
  const y = v.rows - 1;
  const bg = v.statusBar?.warn ? T.bgWarn : T.bgStatus;
  fill(grid, y, 0, v.cols, bg);
  // right side: a hint while the menu is open, else the menu button (a chip, like the mockup's "☰ menu")
  const chipText = v.cols < 90 ? ' ☰ ' : ' ☰ menu ';
  const right = v.statusRight ? ` ${v.statusRight} ` : chipText;
  let segs = statusSegs(v, bg, 0);
  for (let level = 0; level <= 3; level++) {
    segs = statusSegs(v, bg, level);
    if (width(segs) + right.length + 1 <= v.cols) break;
  }
  const used = putRich(grid, y, 0, segs, '', v.cols, hits);
  if (used + right.length < v.cols) {
    if (v.statusRight) put(grid, y, v.cols - right.length, right, join(T.dim, bg));
    else putRich(grid, y, v.cols - right.length - 1, [[right, join('1', T.chorus, T.bgSel), 'menu']], '', v.cols, hits);
  }
}

/* ---------- overlay ---------- */

function drawOverlay(grid: Grid, o: Overlay, x0: number, w: number, y0: number, height: number, hits: Hit[]) {
  const free = o.lines ?? [];
  const rows = o.rows ?? [];
  const body = free.length + rows.length + (free.length && rows.length ? 1 : 0);
  const inner = Math.min(w - 4, Math.max(o.title.length + 4, o.foot?.length ?? 0, ...free.map(l => l.length + 2), ...rows.map(r => r[1].length + 8), 34));
  const boxH = body + 2 + 2 + (o.foot ? 2 : 0); // borders, title + rule, foot rule + foot
  const x = x0 + Math.max(1, Math.floor((w - inner - 2) / 2));
  const y = y0 + Math.max(0, Math.floor((height - boxH) * 0.46));
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
  rows.forEach(([k, label, sel, hit]) => {
    const bg = sel ? T.bgSel : T.bgBox;
    blankRow(yy);
    fill(grid, yy, x + 1, x + inner + 1, bg);
    put(grid, yy, x + 2, k, join('1', accent, bg));
    put(grid, yy, x + (k === '▸' || k === ' ' ? 4 : 8), label, join(T.fg, bg)); // a choice list (▸ codex) has no key column
    if (hit) hits.push({ id: hit, x0: x + 1, x1: x + inner + 1, y0: yy, y1: yy + 1 });
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

/* ---------- output ---------- */

export function rowToAnsi(row: Cell[]): string {
  let out = '';
  let last = '';
  for (const c of row) {
    if (c.t === '') continue;
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

/** Which hit is at this 0-based cell? The last registered wins (overlays are drawn after the content). */
export function hitAt(hits: Hit[], x: number, y: number): string | undefined {
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (x >= h.x0 && x < h.x1 && y >= h.y0 && y < h.y1) return h.id;
  }
  return undefined;
}
