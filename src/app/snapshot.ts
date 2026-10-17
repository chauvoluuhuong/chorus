// Turn a screen into an HTML page and a PNG, for e2e proof screenshots (docs/proof/).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VirtualScreen } from './screen.ts';

const BASE16 = ['#1d1f21', '#cc6666', '#b5bd68', '#f0c674', '#81a2be', '#b294bb', '#8abeb7', '#c5c8c6', '#969896', '#ff6b6b', '#c3e88d', '#ffe08a', '#82aaff', '#c792ea', '#89ddff', '#ffffff'];
const DEFAULT_FG = '#d4d4d4';
const DEFAULT_BG = '#1e1e1e';

function palette(n: number): string {
  if (n < 16) return BASE16[n];
  if (n < 232) {
    const i = n - 16;
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${v(Math.floor(i / 36))},${v(Math.floor((i % 36) / 6))},${v(i % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

function css(s: string): string {
  if (!s) return '';
  const p = s.split(';').map(Number);
  let fg = '';
  let bg = '';
  let bold = false, dim = false, ital = false, under = false, inv = false, strike = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === 1) bold = true;
    else if (c === 2) dim = true;
    else if (c === 3) ital = true;
    else if (c === 4) under = true;
    else if (c === 7) inv = true;
    else if (c === 9) strike = true;
    else if (c === 38 || c === 48) {
      let col = '';
      if (p[i + 1] === 5) { col = palette(p[i + 2]); i += 2; }
      else if (p[i + 1] === 2) { col = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4; }
      if (c === 38) fg = col; else bg = col;
    }
  }
  if (inv) [fg, bg] = [bg || DEFAULT_BG, fg || DEFAULT_FG];
  return [fg && `color:${fg}`, bg && `background:${bg}`, bold && 'font-weight:700', dim && 'opacity:.6', ital && 'font-style:italic', (under || strike) && `text-decoration:${[under && 'underline', strike && 'line-through'].filter(Boolean).join(' ')}`].filter(Boolean).join(';');
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Screens of the agents show the signed-in account; proof images and texts must not carry it. Cells keep their width. */
export function maskRow(cells: { t: string; s: string }[]): { t: string; s: string }[] {
  const text = cells.map(c => c.t || '\0').join('');
  const out = cells.map(c => ({ ...c }));
  for (const m of text.matchAll(EMAIL)) for (let i = m.index!; i < m.index! + m[0].length; i++) if (out[i].t) out[i].t = '•';
  return out;
}

export function maskText(line: string): string {
  return line.replace(EMAIL, m => '•'.repeat(m.length));
}

export function screenToHtml(screen: VirtualScreen, caption?: string): string {
  const lines: string[] = [];
  for (let y = 0; y < screen.rows; y++) {
    let html = '';
    let run = '';
    let style: string | undefined;
    const flush = () => {
      if (run) html += style ? `<span style="${style}">${esc(run)}</span>` : esc(run);
      run = '';
    };
    for (const c of maskRow(screen.row(y))) {
      if (c.t === '') continue;
      const st = css(c.s);
      if (st !== style) { flush(); style = st; }
      run += c.t;
    }
    flush();
    lines.push(html);
  }
  const cap = caption ? `<div class="cap">${esc(caption)}</div>` : '';
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#111;padding:14px 16px}
.cap{font:600 15px -apple-system,Helvetica,sans-serif;color:#9cdcfe;margin:0 0 10px}
pre{margin:0;background:${DEFAULT_BG};color:${DEFAULT_FG};padding:10px 12px;border-radius:8px;font:14px/1.28 Menlo,"SF Mono",monospace;white-space:pre;display:inline-block;border:1px solid #333}
</style>${cap}<pre>${lines.join('\n')}</pre>`;
}

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** Save a PNG of the screen. Returns false (and writes the HTML next to it) when Chrome is unavailable. */
export function saveScreenshot(screen: VirtualScreen, file: string, caption?: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const html = screenToHtml(screen, caption);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-shot-')), 'screen.html');
  fs.writeFileSync(tmp, html);
  if (!fs.existsSync(CHROME)) {
    fs.writeFileSync(file.replace(/\.png$/, '.html'), html);
    return false;
  }
  // Menlo 14px is ~8.43px wide per column; leave room for the padding so the right edge is never clipped
  const w = Math.ceil(screen.cols * 8.6) + 90;
  const h = Math.ceil(screen.rows * 17.9) + (caption ? 100 : 70);
  const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${w},${h}`, `--screenshot=${file}`, `file://${tmp}`], { stdio: 'ignore', timeout: 30000 });
  return r.status === 0 && fs.existsSync(file);
}
