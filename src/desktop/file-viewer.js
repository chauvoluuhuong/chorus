// The file viewer (plan 2026-11-25 chat-view-files, mockup @workspace/mockups/chat-view-files.html scenes 1–7). One `openFile()`
// decides where a file opens, and both a file card in the Chat view and a row of the Files list call it, so the two can never behave
// differently:
//   - a file the viewer can show: the viewer, always in Preview first (Raw one click away); a window over the chat, full screen on a
//     phone. Gone, too big and (remotely) not-text files say so inside the viewer.
//   - on the Mac, a file it can't show (a type it can't show, or not text): the Mac's own open command, with a short note.
//   - remotely (the private link), a type it can't show: "<Type> files can't be opened here"; a file outside the chat's project:
//     "This file stays on your Mac". One Got it; a bottom sheet on a phone, a small dialog wider.
// What a file is and its content come from the server (GET /api/chats/:id/files/view, src/serve/fileview.ts); images, PDFs and HTML
// load from …/files/raw (sandboxed). The renderers below are plain functions of the server's answer, so they can be tested.
import { mdFull } from './md.js';
import { diagramHtml, drawDiagrams } from './mermaid.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const base = p => String(p ?? '').split('/').pop();

/** 2.1 KB, 6.2 MB */
export function fmtSize(n) {
  if (n == null || !isFinite(n)) return '';
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} KB`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)} MB`;
}

const extOf = p => {
  const b = base(p).toLowerCase();
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i + 1) : '';
};

/** the type square's colour per extension (mockup .ft classes) */
const SQ = { md: 'md', markdown: 'md', mdx: 'md', mmd: 'md', mermaid: 'md', html: 'html', htm: 'html', json: 'json', geojson: 'json', jsonl: 'json', csv: 'csv', tsv: 'csv', png: 'img', jpg: 'img', jpeg: 'img', gif: 'img', webp: 'img', svg: 'img', bmp: 'img', ico: 'img', avif: 'img', heic: 'img', tif: 'img', tiff: 'img', pdf: 'pdf', docx: 'word', doc: 'word', docm: 'word', pages: 'word', xlsx: 'xls', xls: 'xls', xlsm: 'xls', numbers: 'xls', key: 'key', ppt: 'key', pptx: 'key' };
const SQ_LABEL = { markdown: 'MD', mermaid: 'MMD', mdown: 'MD' };

/** The file-type square (mockup .ft): the extension in a coloured square. `size`: '' | 'sm' | 'lg'. */
export function fileSquare(p, { size = '', link = false } = {}) {
  if (link) return `<span class="ft${size ? ` ${size}` : ''} code">URL</span>`;
  const ext = extOf(p);
  const label = SQ_LABEL[ext] ?? (ext.toUpperCase().slice(0, 4) || 'FILE');
  return `<span class="ft${size ? ` ${size}` : ''} ${SQ[ext] ?? 'code'}">${esc(label)}</span>`;
}

/** A card's kind word (its header's right side): MARKDOWN, HTML, … or the type's own name (KEYNOTE). */
export function artLabel(c) {
  if (c.link) return 'LINK';
  const k = { html: 'HTML', markdown: 'MARKDOWN', mermaid: 'MERMAID', json: 'JSON', csv: extOf(c.target) === 'tsv' ? 'TSV' : 'CSV', diff: 'PATCH', svg: 'SVG', image: 'IMAGE', pdf: 'PDF', docx: 'WORD', xlsx: 'EXCEL', code: 'CODE', text: 'TEXT' }[c.kind];
  return k ?? (c.fileType ? String(c.fileType).toUpperCase() : 'FILE');
}

/**
 * Where a file opens, from the view endpoint's answer (the scene 1 table): 'viewer', 'mac' (the Mac's own open command) or
 * 'note' (remotely: the kind message). Gone and too big show inside the viewer everywhere; not-text inside it only remotely.
 */
export function routeOf(v, onMac) {
  if (v.why === 'outside') return 'note';
  if (v.why === 'type') return onMac ? 'mac' : 'note';
  if (v.why === 'binary') return onMac ? 'mac' : 'viewer';
  return 'viewer';
}

/** The viewer's modes: Preview and Raw; code and text have Raw only (no switch); images, PDF, Word and Excel have no Raw. */
export function modesOf(v) {
  if (v.why) return { pv: false, raw: false, sw: false };
  if (v.kind === 'code' || v.kind === 'text') return { pv: false, raw: true, sw: false };
  if (['image', 'pdf', 'docx', 'xlsx'].includes(v.kind)) return { pv: true, raw: false, sw: true };
  return { pv: true, raw: true, sw: true };
}

/** Wrap is on for prose (markdown, text) and off for code, JSON, CSV and HTML, where a line is one record. */
export const wrapsByDefault = v => ['markdown', 'text', 'mermaid'].includes(v.kind);

/** A card's line for a file it can't show (scene 1): "6.2 MB · Chorus can't show Keynote files". '' when there is nothing to say. */
export function cardSum(v) {
  const size = fmtSize(v.size);
  if (v.why === 'type') return [size, `Chorus can't show ${v.type ?? extOf(v.path).toUpperCase()} files`].filter(Boolean).join(' · ');
  if (v.why === 'binary') return [size, "it isn't text"].filter(Boolean).join(' · ');
  return size;
}

/** The kind message (scene 7 C and D): title, words, and the path it names. Escaped HTML. */
export function noteHtml(v) {
  const where = v.rel ?? v.path;
  if (v.why === 'outside')
    return { title: 'This file stays on your Mac', body: `<b>${esc(v.title)}</b> is saved outside this chat's project. To keep the rest of your Mac private, Chorus only sends files from inside the project when you're away.`, where };
  const type = v.type ?? (extOf(v.path).toUpperCase() || 'These');
  return { title: `${type} files can't be opened here`, body: `Chorus can show text, web pages, images, PDFs, Word and Excel files, but not ${esc(type)} files. You'll find <b>${esc(v.title)}</b> on your Mac, ready to open when you're back.`, where };
}

/* ---------- Raw: the file's text with line numbers and light colours (nothing reformatted) ---------- */

const KW = 'import|from|export|default|const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|async|await|class|extends|new|try|catch|finally|throw|typeof|instanceof|in|of|yield|def|lambda|pass|elif|with|as|fn|pub|use|mod|impl|struct|enum|trait|type|interface|match|package|func|go|defer|select|range|public|private|protected|static|void|true|false|null|undefined|None|True|False|nil|self|this|echo|then|fi|done|esac';
const STR = String.raw`"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|` + '`(?:[^`\\\\]|\\\\.)*`';
const RX = {
  slash: new RegExp(String.raw`(?<m>\/\/.*$|\/\*.*?\*\/)|(?<s>${STR})|(?<k>\b(?:${KW})\b)|(?<n2>\b\d+(?:\.\d+)?\b)`, 'g'),
  hash: new RegExp(String.raw`(?<m>(?:^|\s)#.*$)|(?<s>${STR})|(?<at>^\s*[\w.-]+(?=\s*[:=]))|(?<k>\b(?:${KW})\b)|(?<n2>\b\d+(?:\.\d+)?\b)`, 'g'),
  xml: /(?<m><!--.*?-->)|(?<tg><\/?[\w:.-]+|\/?>)|(?<at>\b[\w:-]+(?==))|(?<s>"[^"]*"|'[^']*')/g,
  json: /(?<k>"(?:[^"\\]|\\.)*"(?=\s*:))|(?<s>"(?:[^"\\]|\\.)*")|(?<n2>-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\btrue\b|\bfalse\b|\bnull\b)/g,
  md: /(?<b>\*\*[^*]+\*\*)|(?<c>`[^`]+`)|(?<m>^\s*(?:[-*+]|\d+[.)])\s|\|)|(?<k>\[[^\]]*\]\([^)]*\))/g,
};
const HASH = new Set(['py', 'pyw', 'sh', 'bash', 'zsh', 'fish', 'yaml', 'yml', 'toml', 'rb', 'pl', 'pm', 'r', 'conf', 'cfg', 'ini', 'properties', 'env', 'dockerfile', 'makefile', 'gitignore', 'editorconfig', 'cmake', 'nix', 'tf', 'hcl', 'ex', 'exs']);

/** One line through a pattern of named groups: each match wrapped in its group's class, the rest escaped. */
function tok(line, re) {
  let out = '';
  let last = 0;
  re.lastIndex = 0;
  for (const m of line.matchAll(re)) {
    if (!m[0]) continue;
    out += esc(line.slice(last, m.index));
    const g = Object.entries(m.groups ?? {}).find(([, x]) => x !== undefined)?.[0];
    out += g ? `<span class="${g}">${esc(m[0])}</span>` : esc(m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(line.slice(last));
}

/** The pattern for a file's Raw colours, by its kind and extension. */
function patternOf(kind, p) {
  const ext = extOf(p) || base(p).toLowerCase();
  if (kind === 'html' || kind === 'svg' || ['xml', 'xsl', 'plist', 'vue', 'svelte', 'astro'].includes(ext)) return 'xml';
  if (kind === 'json' || ext === 'jsonl' || ext === 'ndjson') return 'json';
  if (kind === 'markdown') return 'md';
  if (kind === 'diff') return 'diff';
  if (kind === 'csv') return 'csv';
  if (kind === 'code') return HASH.has(ext) ? 'hash' : 'slash';
  return '';
}

/** Raw (scene 3): one div per line (CSS numbers them), lightly coloured. A JSON file saved on one long line is shown indented. */
export function rawHtml(text, kind, p) {
  let t = String(text ?? '');
  if (kind === 'json' && !t.trim().includes('\n') && t.length > 120) {
    try {
      t = JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not JSON after all: as saved */
    }
  }
  const lines = t.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const pat = patternOf(kind, p);
  const sep = extOf(p) === 'tsv' ? '\t' : ',';
  let fence = false;
  return lines
    .map(l => {
      let h;
      if (pat === 'md') {
        if (/^\s*(```|~~~)/.test(l)) ((h = `<span class="m">${esc(l)}</span>`), (fence = !fence));
        else if (fence) h = `<span class="c">${esc(l)}</span>`;
        else if (/^#{1,6}\s/.test(l)) h = `<span class="h">${esc(l)}</span>`;
        else h = tok(l, RX.md);
      } else if (pat === 'diff') h = /^(\+\+\+|---|diff |index )/.test(l) ? `<span class="m">${esc(l)}</span>` : /^@@/.test(l) ? `<span class="k">${esc(l)}</span>` : /^\+/.test(l) ? `<span class="s">${esc(l)}</span>` : /^-/.test(l) ? `<span class="bad">${esc(l)}</span>` : esc(l);
      else if (pat === 'csv') h = esc(l).split(esc(sep)).join(`<span class="m">${sep === '\t' ? '\t' : ','}</span>`);
      else if (pat) h = tok(l, RX[pat]);
      else h = esc(l);
      return `<div>${h || ' '}</div>`;
    })
    .join('');
}
export const lineCount = text => {
  const n = String(text ?? '').split(/\r?\n/).length;
  return String(text ?? '').endsWith('\n') ? n - 1 : n;
};

/* ---------- Preview renderers ---------- */

/** A JSON value as a tree you can fold (scene 5): the first two levels open, a closed node shows its first entries. */
export function jsonTreeHtml(value) {
  const LIMIT = 1000;
  const scalar = x => (typeof x === 'string' ? `<span class="s">${esc(JSON.stringify(x))}</span>` : `<span class="n2">${esc(String(x))}</span>`);
  const peek = x => {
    const arr = Array.isArray(x);
    const parts = (arr ? x.slice(0, 3).map(y => [null, y]) : Object.entries(x).slice(0, 3)).map(([k, y]) => `${k === null ? '' : `${k}: `}${y && typeof y === 'object' ? (Array.isArray(y) ? '[…]' : '{…}') : JSON.stringify(y)}`);
    const s = parts.join(', ');
    return `${arr ? '[' : '{'} ${s.length > 70 ? s.slice(0, 70) : s}${s.length > 70 || (arr ? x.length : Object.keys(x).length) > 3 ? ' …' : ''} ${arr ? ']' : '}'}`;
  };
  const node = (key, val, depth) => {
    const k = key === null ? '' : `<span class="${typeof key === 'number' ? 'm' : 'k'}">${typeof key === 'number' ? key : esc(JSON.stringify(key))}</span>: `;
    if (!val || typeof val !== 'object') return `<div class="jl">${k}${val === null ? '<span class="n2">null</span>' : scalar(val)}</div>`;
    const arr = Array.isArray(val);
    const entries = arr ? val.map((x, i) => [i, x]) : Object.entries(val);
    if (!entries.length) return `<div class="jl">${k}<span class="m">${arr ? '[]' : '{}'}</span></div>`;
    const n = entries.length;
    const count = arr ? `[ ${n} ${n === 1 ? 'item' : 'items'} ]` : `{ ${n} ${n === 1 ? 'key' : 'keys'} }`;
    const kids = entries.slice(0, LIMIT).map(([kk, vv]) => node(kk, vv, depth + 1)).join('');
    const more = n > LIMIT ? `<div class="jl m">… ${n - LIMIT} more</div>` : '';
    return `<details${depth < 2 ? ' open' : ''}><summary>${k}<span class="m jc">${count}</span><span class="m jp">${esc(peek(val))}</span></summary><div class="jk">${kids}${more}</div></details>`;
  };
  return `<div class="fv-tree">${node(null, value, 0)}</div>`;
}

/** CSV/TSV text as rows of cells (quotes, doubled quotes, line breaks in quotes). */
export function parseCsv(text, sep = ',') {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') (f += '"'), i++;
      else if (ch === '"') q = false;
      else f += ch;
    } else if (ch === '"' && f === '') q = true;
    else if (ch === sep) row.push(f), (f = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(f), rows.push(row), (row = []), (f = '');
    } else f += ch;
  }
  if (f !== '' || row.length) row.push(f), rows.push(row);
  return rows;
}

const NUM = /^-?[\d,]*\.?\d+(?:[eE][+-]?\d+)?%?$/;
/** A table with a fixed header (CSV, TSV, a sheet). Numbers sit right. The first 1,000 rows. */
export function tableHtml(rows, { max = 1000 } = {}) {
  if (!rows.length) return '<div class="fv-empty"><p>This table is empty.</p></div>';
  const [head, ...body] = rows;
  const shown = body.slice(0, max);
  const cols = Math.max(head.length, ...shown.slice(0, 200).map(r => r.length));
  const numeric = Array.from({ length: cols }, (_, c) => {
    const vals = shown.slice(0, 100).map(r => r[c]).filter(x => x !== '' && x != null);
    return vals.length > 0 && vals.every(x => typeof x === 'number' || NUM.test(String(x).trim()));
  });
  const cell = (x, c, tag) => `<${tag}${numeric[c] ? ' class="r"' : ''}>${esc(x == null ? '' : typeof x === 'boolean' ? (x ? 'TRUE' : 'FALSE') : x)}</${tag}>`;
  const th = Array.from({ length: cols }, (_, c) => cell(head[c], c, 'th')).join('');
  const tr = shown.map(r => `<tr>${Array.from({ length: cols }, (_, c) => cell(r[c], c, 'td')).join('')}</tr>`).join('');
  return `<table class="fv-tbl"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

/** A patch with its added and removed lines in green and red (scene 5). */
export function diffHtml(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return `<div class="fv-diff">${lines.map(l => `<div${/^(\+\+\+|---)/.test(l) ? ' class="hk"' : /^\+/.test(l) ? ' class="ad"' : /^-/.test(l) ? ' class="rm"' : /^(@@|diff |index )/.test(l) ? ' class="hk"' : ''}>${esc(l) || ' '}</div>`).join('')}</div>`;
}

/** The strip over the body when not everything is shown. */
export function stripText(v, extra = {}) {
  if (v.kind === 'csv' && extra.rows > 1000) return `Showing the first 1,000 of ${extra.rows.toLocaleString('en-US')} rows.`;
  // a sheet cut short says so under its own table
  if (!v.cut || v.kind === 'xlsx') return '';
  if (v.kind === 'docx') return 'This document is long: its first part is shown.';
  return `Showing the first 2 MB of ${fmtSize(v.size)}.`;
}

/** What the viewer says instead of the file (scene 6): gone, too big, not text. */
export function stateHtml(v) {
  if (v.why === 'gone') return `<div class="fv-empty">${ICON.eyeoff}<h4>This file is no longer there</h4><p>The agent may have moved or deleted it after it reported it.</p><div class="acts"><button class="btn" data-fv="copy-path">${ICON.copy}Copy path</button></div></div>`;
  if (v.why === 'binary') {
    const ext = extOf(v.path);
    return `<div class="fv-empty"><span class="ft lg code">BIN</span><h4>This file isn't text</h4><p>${ext ? `Its name ends in .${esc(ext)}, but it holds binary data, so there is nothing to show here.` : 'It holds binary data, so there is nothing to show here.'}</p></div>`;
  }
  if (v.why === 'big') return `<div class="fv-empty">${fileSquare(v.path, { size: 'lg' })}<h4>This file is too big to show here</h4><p>It is ${esc(fmtSize(v.size))}. Chorus shows images, PDFs, Word and Excel files up to 50 MB.</p></div>`;
  return '';
}

const ICON = {
  eye: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>',
  ext: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>',
  copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>',
  x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
  wrap: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8m0 0 1.5-1.5M8 12l1.5 1.5M2.5 12h3"/></svg>',
  eyeoff: '<svg class="off" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 2l12 12M6.6 4c.45-.1.92-.5 1.4-.5 4 0 6.5 4.5 6.5 4.5s-.6 1.1-1.7 2.2M4.2 5.2C2.5 6.4 1.5 8 1.5 8S4 12.5 8 12.5c1 0 1.9-.3 2.7-.7"/></svg>',
};
/** the ↗ of Open, for the card and the Files row */
export const OPEN_ICON = ICON.ext;

/** "2 min ago" */
export function agoText(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/* ---------- the page: open, the viewer, the note ---------- */

/** the one viewer open now: { h, o (what was asked), v (the answer), mode, wrap, sheet, narrow, el, rev } */
let cur = null;

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
const CMD = MAC ? '⌘' : 'Ctrl';
const q = o => (o.r != null ? `r=${encodeURIComponent(o.r)}` : `p=${encodeURIComponent(o.p)}`);
const url = (o, what) => `/api/chats/${encodeURIComponent(o.chat)}/files/${what}?${q(o)}`;
const phone = h => (h.size?.() ?? document.documentElement.dataset.size) === 'phone';

/** The file open in the viewer now, if any: { chat, r } or { chat, p }. */
export const openNow = () => (cur ? { chat: cur.o.chat, ...(cur.o.r != null ? { r: cur.o.r } : { p: cur.o.p }) } : null);

/**
 * Opens a chat's file: `{ chat, r }` (a reported file's id) or `{ chat, p }` (a path in the chat's artifacts folder); `link` and
 * `target` for a reported link. `h`: { api, toast, onMac, size(), mermaidUrl, rev(chat), onChange() }.
 */
export async function openFile(h, o) {
  if (o.link) {
    // a link opens as it does today: the Mac's browser on the Mac; remotely, this browser's new tab
    if (h.onMac) return void h.api('POST', `/api/chats/${encodeURIComponent(o.chat)}/open-report`, { id: Number(o.r) }).then(r => r.error && h.toast(r.error), e => h.toast(e.message));
    const w = window.open(o.target, '_blank', 'noopener');
    if (w) w.opener = null;
    return;
  }
  let v;
  try {
    v = await h.api('GET', url(o, 'view'));
  } catch (e) {
    return void h.toast(e.message);
  }
  const where = routeOf(v, h.onMac);
  if (where === 'mac') return openOnMac(h, o, v);
  if (where === 'note') return showNote(h, v);
  show(h, o, v);
}

/** The Mac's own open command, as the Files list did before; a short note says it went. */
async function openOnMac(h, o, v) {
  try {
    const r = o.r != null ? await h.api('POST', `/api/chats/${encodeURIComponent(o.chat)}/open-report`, { id: Number(o.r) }) : await h.api('POST', `/api/chats/${encodeURIComponent(o.chat)}/open`, { path: o.p });
    if (r?.error) return void h.toast(r.error);
    h.toast(`Opened ${base(v.path) || v.title}`);
  } catch (e) {
    h.toast(e.message);
  }
}

/** Remotely: the kind message, with one Got it (a bottom sheet on a phone, a small dialog wider). */
function showNote(h, v) {
  document.querySelector('.fv-note-wrap')?.remove();
  const n = noteHtml(v);
  const el = document.createElement('div');
  el.className = 'cv-sheet-wrap fv-note-wrap';
  el.innerHTML = `<div class="cv-sheet fv-note" role="dialog" aria-modal="true" aria-label="${esc(n.title)}"><div class="grab"></div>${fileSquare(v.path, { size: 'lg' })}<h3>${esc(n.title)}</h3><p>${n.body}</p><span class="path">${esc(n.where)}</span><button class="btn primary" data-fv="got">Got it</button></div>`;
  const close = () => (el.remove(), document.removeEventListener('keydown', key, true));
  const key = e => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), close());
  el.addEventListener('click', e => (e.target === el || e.target.closest('[data-fv="got"]')) && close());
  document.addEventListener('keydown', key, true);
  document.body.append(el);
  el.querySelector('[data-fv="got"]').focus({ preventScroll: true });
}

/** Closes the viewer. */
export function closeFile() {
  if (!cur) return;
  const h = cur.h;
  cur.el.remove();
  document.removeEventListener('keydown', onKey, true);
  removeEventListener('resize', place);
  cur = null;
  h.onChange?.();
}

function onKey(e) {
  if (!cur) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeFile();
  } else if (e.key === '/' && (e.metaKey || e.ctrlKey) && modesOf(cur.v).sw && modesOf(cur.v).raw) {
    e.preventDefault();
    e.stopPropagation();
    setMode(cur.mode === 'pv' ? 'raw' : 'pv');
  }
}

/** Desktop and tablet: the window sits over the chat column (its head included), so the Files list beside it stays in reach. */
function place() {
  if (!cur || cur.narrow) return;
  const col = document.getElementById('chat-col');
  const head = document.querySelector('.chat-head');
  const r = col?.getBoundingClientRect();
  const s = cur.el.style;
  if (!r || !r.width) return void (s.inset = '0');
  const top = head?.getBoundingClientRect().top ?? r.top;
  s.inset = `${Math.max(0, top)}px ${Math.max(0, innerWidth - r.right)}px ${Math.max(0, innerHeight - r.bottom)}px ${Math.max(0, r.left)}px`;
}

function show(h, o, v) {
  const same = cur && cur.o.chat === o.chat && cur.o.r === o.r && cur.o.p === o.p;
  if (cur && !same) closeFile();
  if (!cur) {
    const m = modesOf(v);
    const el = document.createElement('div');
    cur = { h, o, v, mode: m.pv ? 'pv' : 'raw', wrap: wrapsByDefault(v), sheet: 0, narrowPage: false, narrow: phone(h), el, rev: h.rev?.(o.chat) };
    el.className = `fv-wrap${cur.narrow ? ' phone' : ''}`;
    el.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey, true);
    addEventListener('resize', place);
    document.body.append(el);
    place();
  }
  cur.v = v;
  draw();
  h.onChange?.();
}

function onClick(e) {
  if (!cur) return;
  if (e.target === cur.el) return closeFile();
  const b = e.target.closest('[data-fv]');
  if (!b || b.disabled) return;
  const what = b.dataset.fv;
  if (what === 'close') closeFile();
  else if (what === 'mode') setMode(b.dataset.m);
  else if (what === 'wrap') (cur.wrap = !cur.wrap), draw({ keep: true });
  else if (what === 'width') (cur.narrowPage = b.dataset.m === 'phone'), draw({ keep: true });
  else if (what === 'sheet') (cur.sheet = Number(b.dataset.i) || 0), draw();
  else if (what === 'copy') void copy(copyText());
  else if (what === 'copy-path') void copy(cur.v.path, 'Path copied');
  else if (what === 'zoom') b.closest('.fv-check')?.classList.toggle('full');
}

function setMode(m) {
  if (!cur || cur.mode === m) return;
  cur.mode = m;
  draw();
}

async function copy(text, done = 'Copied') {
  try {
    await navigator.clipboard.writeText(text ?? '');
    cur?.h.toast(done);
  } catch {
    cur?.h.toast("This browser didn't allow copying here.");
  }
}

function copyText() {
  const v = cur.v;
  if (v.text != null) return v.text;
  if (v.kind === 'xlsx') return (v.sheets?.[cur.sheet]?.rows ?? []).map(r => r.map(x => (x == null ? '' : String(x))).join('\t')).join('\n');
  return cur.el.querySelector('.fv-b')?.innerText ?? '';
}

/** Draws the header, the body and the footer for what is open; `keep` keeps the body's scroll (a live update, Wrap, a width). */
function draw({ keep = false } = {}) {
  const { h, o, v, el } = cur;
  const m = modesOf(v);
  const narrow = cur.narrow;
  const bodyWas = el.querySelector('.fv-b');
  const scroll = keep && bodyWas ? [bodyWas.scrollTop, bodyWas.scrollLeft] : null;
  const raw = cur.mode === 'raw';
  const text = v.text != null;
  const sub = [v.rel ?? v.path, fmtSize(v.size), raw && text ? `${lineCount(v.text).toLocaleString('en-US')} lines` : ''].filter(Boolean).join(' · ');
  const btn = (fv, icon, title, extra = '') => `<button class="ibtn" data-fv="${fv}" title="${esc(title)}" aria-label="${esc(title)}"${extra}>${icon}</button>`;
  const seg = m.sw
    ? `<span class="seg fv-modes" role="tablist"><button class="${raw ? '' : 'on'}" data-fv="mode" data-m="pv" role="tab" aria-selected="${!raw}">${ICON.eye}Preview</button><button class="${raw ? 'on' : ''}" data-fv="mode" data-m="raw" role="tab" aria-selected="${raw}"${m.raw ? '' : ` disabled title="${esc(v.kind === 'image' ? 'An image has no text to show' : v.kind === 'pdf' ? 'A PDF has no text to show here' : v.kind === 'docx' ? 'A Word file has no plain text to show' : 'An Excel file has no plain text to show')}"`}>Raw</button></span>`
    : '';
  const width = v.kind === 'html' && !raw && !narrow && !v.why ? `<span class="seg fv-width" title="Page width"><button class="${cur.narrowPage ? '' : 'on'}" data-fv="width" data-m="desktop">Desktop</button><button class="${cur.narrowPage ? 'on' : ''}" data-fv="width" data-m="phone">Phone</button></span>` : '';
  const wrap = raw && text ? btn('wrap', ICON.wrap, cur.wrap ? 'Wrap long lines: on' : 'Wrap long lines', cur.wrap ? ' aria-pressed="true"' : ' aria-pressed="false"') : '';
  const canCopy = !v.why && (text || v.kind === 'docx' || v.kind === 'xlsx');
  const cp = canCopy ? btn('copy', ICON.copy, "Copy the file's text") : '';
  const head = narrow
    ? `<div class="fv-h"><button class="pv-back" data-fv="close" aria-label="Back">‹</button><div class="nm"><b>${esc(v.title)}</b><span>${esc(v.rel ?? v.path)}</span></div>${wrap}${cp}</div>${seg ? `<div class="fv-pseg">${seg}</div>` : ''}`
    : `<div class="fv-h">${fileSquare(v.path)}<div class="nm"><b>${esc(v.title)}</b><span>${esc(sub)}</span></div>${seg}${seg || width || wrap || cp ? '<span class="vsep"></span>' : ''}${width}${wrap}${cp}${btn('close', ICON.x, 'Close (Esc)')}</div>`;
  const rows = v.kind === 'csv' && !raw && text ? parseCsv(v.text, extOf(v.path) === 'tsv' ? '\t' : ',') : null;
  const strip = v.why ? '' : stripText(v, { rows: rows ? rows.length - 1 : 0 });
  const body = v.why ? stateHtml(v) : raw ? `<div class="fv-raw${cur.wrap ? ' wrap' : ''}">${rawHtml(v.text, v.kind, v.path)}</div>` : previewHtml(v, rows);
  const live = v.kind === 'html' && !raw ? '<span class="live">Reloads while the agent edits it</span><span>· Sandboxed: its scripts and forms don\'t run here</span>' : '<span class="live">Updates while the agent edits it</span>';
  const keys = raw ? `<span>Select lines and <kbd>${CMD}</kbd><kbd>C</kbd>, or Copy for the whole file</span>` : `<span><kbd>Esc</kbd> close${m.sw && m.raw ? ` · <kbd>${CMD}</kbd><kbd>/</kbd> Preview or Raw` : ''}</span>`;
  const foot = narrow || v.why === 'gone' ? '' : `<div class="fv-f">${v.mtime ? `<span>Edited ${esc(agoText(v.mtime))}</span>` : ''}${v.why ? '' : live}<span class="grow"></span>${keys}</div>`;
  el.innerHTML = `<div class="fv fv-k-${esc(v.kind)}${raw ? ' is-raw' : ''}" role="dialog" aria-modal="true" aria-label="${esc(v.title)}">${head}${strip ? `<div class="fv-strip">${esc(strip)}</div>` : ''}<div class="fv-b">${body}</div>${foot}</div>`;
  const b = el.querySelector('.fv-b');
  if (!raw && !v.why && (v.kind === 'markdown' || v.kind === 'mermaid')) void drawDiagrams(b, { url: h.mermaidUrl });
  if (scroll) [b.scrollTop, b.scrollLeft] = scroll;
  if (!el.contains(document.activeElement)) el.querySelector('[data-fv="close"]')?.focus({ preventScroll: true });
}

/** The Preview body for the open file. */
function previewHtml(v, rows) {
  const src = `${url(cur.o, 'raw')}${cur.rev != null ? `&v=${encodeURIComponent(cur.rev)}` : ''}`;
  switch (v.kind) {
    case 'markdown':
      return `<div class="fv-doc cv-a">${mdFull(v.text)}</div>`;
    case 'mermaid':
      return `<div class="fv-doc fv-dia">${diagramHtml(v.text)}</div>`;
    case 'html':
      return `<div class="fv-frame${cur.narrowPage ? ' narrow' : ''}"><div class="fr"><iframe sandbox="" src="${esc(src)}" title="${esc(v.title)}"></iframe></div></div>`;
    case 'svg':
    case 'image':
      return `<div class="fv-check"><img src="${esc(src)}" alt="${esc(v.title)}" data-fv="zoom" title="Show at full size"></div>`;
    case 'pdf':
      return `<iframe class="fv-pdf" src="${esc(src)}" title="${esc(v.title)}"></iframe>`;
    case 'json': {
      try {
        return jsonTreeHtml(JSON.parse(v.text));
      } catch {
        return `<div class="fv-strip">This JSON doesn't read as JSON${v.cut ? ' (it was cut at 2 MB)' : ''}; here is its text.</div><div class="fv-raw">${rawHtml(v.text, 'json', v.path)}</div>`;
      }
    }
    case 'csv':
      return `<div class="fv-table">${tableHtml(rows ?? [])}</div>`;
    case 'diff':
      return diffHtml(v.text);
    case 'docx':
      return `<div class="fv-doc fv-docx">${v.html ?? ''}</div>`;
    case 'xlsx': {
      const sheets = v.sheets ?? [];
      const i = Math.min(cur.sheet, Math.max(0, sheets.length - 1));
      const tabs = sheets.length > 1 ? `<div class="fv-tabs" role="tablist">${sheets.map((s, k) => `<button class="${k === i ? 'on' : ''}" data-fv="sheet" data-i="${k}" role="tab" aria-selected="${k === i}">${esc(s.name)}</button>`).join('')}</div>` : '';
      const s = sheets[i];
      return `${tabs}<div class="fv-table">${s ? tableHtml(s.rows.map(r => r.map(x => (x == null ? '' : x)))) : '<div class="fv-empty"><p>This workbook has no sheets.</p></div>'}</div>${s?.cut ? '<div class="fv-strip bottom">Showing the first 1,000 rows of this sheet.</div>' : ''}`;
    }
    default:
      return `<div class="fv-raw${cur.wrap ? ' wrap' : ''}">${rawHtml(v.text, v.kind, v.path)}</div>`;
  }
}

/**
 * The page's state changed: when the open file's chat has a new artifacts revision (the agent edited a reported file, or one in
 * its folder), the viewer asks again and draws in place, keeping the scroll.
 */
export async function fileViewerState() {
  if (!cur) return;
  const rev = cur.h.rev?.(cur.o.chat);
  if (rev == null || rev === cur.rev) return;
  cur.rev = rev;
  const was = cur;
  let v;
  try {
    v = await cur.h.api('GET', url(cur.o, 'view'));
  } catch {
    return;
  }
  if (cur !== was) return;
  cur.v = v;
  if (cur.mode === 'raw' && !modesOf(v).raw) cur.mode = 'pv';
  if (cur.mode === 'pv' && !modesOf(v).pv) cur.mode = 'raw';
  draw({ keep: true });
}
