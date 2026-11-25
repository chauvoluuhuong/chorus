// What a file is and what the file viewer shows of it (plan 2026-11-25, P1). The kind comes from the extension, then the first
// 8 KB are sniffed (a NUL byte: not text). Text comes whole up to TEXT_MAX (then cut), media is served up to MEDIA_MAX. Word and
// Excel go through the read-only parsing layer (officeview.ts). The file is only ever read: never written, moved, copied or opened.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { docxHtml, type Sheet, xlsxSheets } from './officeview.ts';

export type FileKind = 'markdown' | 'html' | 'mermaid' | 'json' | 'csv' | 'diff' | 'svg' | 'image' | 'pdf' | 'docx' | 'xlsx' | 'code' | 'text' | 'none';
/** why the viewer shows a message instead: outside the chat's project (remotely), gone, too big, not text, a type it can't show */
export type Why = 'outside' | 'gone' | 'big' | 'binary' | 'type';
export type FileView = { kind: FileKind; title: string; path: string; rel?: string; size?: number; mtime?: string; text?: string; cut?: boolean; html?: string; sheets?: Sheet[]; why?: Why; type?: string };

export const TEXT_MAX = 2_000_000;
export const MEDIA_MAX = 50_000_000;
export const SNIFF = 8192;

const KINDS: Record<string, FileKind> = {};
const add = (kind: FileKind, exts: string) => exts.split(' ').forEach(e => (KINDS['.' + e] = kind));
add('markdown', 'md markdown mdown mkd mdx');
add('html', 'html htm xhtml');
add('mermaid', 'mmd mermaid');
add('json', 'json geojson webmanifest');
add('csv', 'csv tsv');
add('diff', 'diff patch');
add('svg', 'svg');
add('image', 'png jpg jpeg gif webp bmp ico avif');
add('pdf', 'pdf');
add('docx', 'docx');
add('xlsx', 'xlsx');
add(
  'code',
  'ts tsx mts cts js jsx mjs cjs py pyw rb go rs java kt kts swift c h cc cpp cxx hpp hh m mm cs fs php pl pm lua r dart scala clj ex exs erl hs ml elm zig nim sh bash zsh fish ps1 bat cmd css scss sass less sql graphql gql proto yaml yml toml ini cfg conf xml xsl plist gradle cmake vue svelte astro tf hcl nix dockerfile makefile',
);
add('text', 'txt text log rst adoc org tex bib srt vtt env properties gitignore editorconfig jsonl ndjson lock');

/** files the viewer can't show, by the name people know them by (the message says "<Type> files can't be opened here") */
const TYPE_NAMES: Record<string, string> = {
  '.key': 'Keynote', '.pages': 'Pages', '.numbers': 'Numbers', '.ppt': 'PowerPoint', '.pptx': 'PowerPoint', '.pps': 'PowerPoint', '.ppsx': 'PowerPoint',
  '.doc': 'Word 97–2003', '.xls': 'Excel 97–2003', '.xlsm': 'Excel with macros', '.xlsb': 'Excel binary', '.docm': 'Word with macros', '.odt': 'OpenDocument', '.ods': 'OpenDocument', '.odp': 'OpenDocument', '.rtf': 'RTF',
  '.zip': 'zip', '.gz': 'gzip', '.tgz': 'gzip', '.tar': 'tar', '.7z': '7-Zip', '.rar': 'RAR', '.dmg': 'Disk image', '.iso': 'Disk image', '.pkg': 'Installer',
  '.mp4': 'Video', '.mov': 'Video', '.m4v': 'Video', '.webm': 'Video', '.avi': 'Video', '.mkv': 'Video', '.mp3': 'Audio', '.m4a': 'Audio', '.wav': 'Audio', '.aac': 'Audio', '.flac': 'Audio', '.ogg': 'Audio',
  '.psd': 'Photoshop', '.ai': 'Illustrator', '.sketch': 'Sketch', '.fig': 'Figma', '.heic': 'HEIC', '.tif': 'TIFF', '.tiff': 'TIFF', '.raw': 'Camera raw',
  '.app': 'App', '.exe': 'Windows program', '.dll': 'Library', '.so': 'Library', '.dylib': 'Library', '.wasm': 'WebAssembly', '.sqlite': 'Database', '.db': 'Database',
  '.ttf': 'Font', '.otf': 'Font', '.woff': 'Font', '.woff2': 'Font', '.epub': 'EPUB',
};

const TEXT_KINDS = new Set<FileKind>(['markdown', 'html', 'mermaid', 'json', 'csv', 'diff', 'svg', 'code', 'text']);
const MEDIA_KINDS = new Set<FileKind>(['image', 'pdf', 'docx', 'xlsx']);

const extOf = (name: string) => {
  const base = path.basename(name).toLowerCase();
  if (base === 'dockerfile' || base === 'makefile') return '.' + base;
  return path.extname(base);
};

/** A file's kind from its name alone; a type the viewer can't show gets its name. */
export function kindOf(name: string): { kind: FileKind; type?: string } {
  const ext = extOf(name);
  const kind = KINDS[ext];
  if (kind) return { kind };
  return { kind: 'none', ...(TYPE_NAMES[ext] ? { type: TYPE_NAMES[ext] } : {}) };
}

/** a path as the page shows it: under the home folder as ~/… */
export const tilde = (p: string) => {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
};

/** the first bytes of a file, read only */
function head(abs: string, n: number) {
  const fd = fs.openSync(abs, 'r');
  try {
    const b = Buffer.alloc(n);
    return b.subarray(0, fs.readSync(fd, b, 0, n, 0));
  } finally {
    fs.closeSync(fd);
  }
}

export const looksBinary = (b: Buffer) => b.includes(0);

/** UTF-8 text from bytes; a character cut in two at the end is dropped */
const utf8 = (b: Buffer, cut: boolean) => {
  const t = new TextDecoder('utf-8').decode(b);
  return cut ? t.replace(/�+$/, '') : t;
};

/**
 * What the viewer gets for a file this request may see: its kind and, for text, Word and Excel, its content. `why` says why there
 * is no content: gone, big (media over MEDIA_MAX), binary (a text kind that is not text), type (a kind it can't show).
 */
export function viewFile(abs: string, meta: { title?: string; rel?: string } = {}): FileView {
  const base: FileView = { kind: kindOf(abs).kind, title: meta.title ?? path.basename(abs), path: tilde(abs), ...(meta.rel ? { rel: meta.rel } : {}) };
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
    if (!st.isFile()) throw new Error('not a file');
  } catch {
    return { ...base, why: 'gone' };
  }
  const v: FileView = { ...base, size: st.size, mtime: st.mtime.toISOString() };
  const { kind, type } = kindOf(abs);
  try {
    if (kind === 'none') {
      if (type) return { ...v, why: 'type', type };
      // no extension it knows: text if it sniffs as text, else a type it can't show
      const ext = extOf(abs);
      if (st.size === 0 || !looksBinary(head(abs, SNIFF))) return text({ ...v, kind: 'text' }, abs, st.size);
      return ext ? { ...v, why: 'type', type: ext.slice(1).toUpperCase() } : { ...v, why: 'binary' };
    }
    if (TEXT_KINDS.has(kind)) {
      if (looksBinary(head(abs, SNIFF))) return { ...v, why: 'binary' };
      return text(v, abs, st.size);
    }
    if (MEDIA_KINDS.has(kind) && st.size > MEDIA_MAX) return { ...v, why: 'big' };
    if (kind === 'docx' || kind === 'xlsx') {
      const bytes = fs.readFileSync(abs);
      try {
        if (kind === 'docx') {
          const d = docxHtml(bytes);
          return { ...v, html: d.html, ...(d.cut ? { cut: true } : {}) };
        }
        const x = xlsxSheets(bytes);
        return { ...v, sheets: x.sheets, ...(x.sheets.some(s => s.cut) ? { cut: true } : {}) };
      } catch {
        // zip64, encrypted (a password-protected Office file is no zip at all), or broken
        return { ...v, why: 'type', type: kind === 'docx' ? 'Word (protected or damaged)' : 'Excel (protected or damaged)' };
      }
    }
    return v; // image, pdf: the page loads the bytes from files/raw
  } catch {
    return { ...base, why: 'gone' };
  }
}

/** A file the viewer only names, with why it shows a message (gone, or outside the chat's project remotely): nothing is read. */
export const fileNote = (abs: string, meta: { title?: string; rel?: string }, why: Why): FileView => ({ kind: kindOf(abs).kind, title: meta.title ?? path.basename(abs), path: tilde(abs), ...(meta.rel ? { rel: meta.rel } : {}), why });

function text(v: FileView, abs: string, size: number): FileView {
  const cut = size > TEXT_MAX;
  const bytes = cut ? head(abs, TEXT_MAX) : fs.readFileSync(abs);
  return { ...v, text: utf8(bytes, cut), ...(cut ? { cut: true } : {}) };
}
