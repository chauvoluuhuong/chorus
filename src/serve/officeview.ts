// Word (.docx) and Excel (.xlsx) for the file viewer (plan 2026-11-25, P1): a read-only parsing layer. The file's bytes are read
// by the caller; here they are unzipped in memory and turned into safe HTML (Word) or rows of values (Excel). Nothing is written,
// no other app is opened, formulas are never run. No dependency: a minimal zip reader on node:zlib and a small XML reader.
import path from 'node:path';
import zlib from 'node:zlib';

/** A zip this reader can't open: zip64, encrypted, an unknown method, or not a zip at all. */
export class OfficeError extends Error {}

/** one part's uncompressed size at most (a zip bomb stops here); beyond it the part is read in part and marked cut */
export const PART_MAX = 32_000_000;
/** one picture in a Word file at most, and all of them together */
export const IMAGE_MAX = 5_000_000;
export const IMAGES_MAX = 20_000_000;
/** rows of a sheet the viewer gets, and columns of a row */
export const ROWS_MAX = 1000;
export const COLS_MAX = 200;

type Entry = { name: string; method: number; flags: number; comp: number; size: number; local: number };

/** The central directory of a zip held in memory. */
export class Zip {
  readonly entries = new Map<string, Entry>();
  private buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
    const eocd = this.findEocd();
    if (eocd < 0) throw new OfficeError('not a zip');
    if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === 0x07064b50) throw new OfficeError('zip64');
    const count = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    let at = buf.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || at === 0xffffffff) throw new OfficeError('zip64');
    for (let i = 0; i < count; i++) {
      if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw new OfficeError('bad central directory');
      const flags = buf.readUInt16LE(at + 8);
      const method = buf.readUInt16LE(at + 10);
      const comp = buf.readUInt32LE(at + 20);
      const size = buf.readUInt32LE(at + 24);
      const n = buf.readUInt16LE(at + 28), e = buf.readUInt16LE(at + 30), c = buf.readUInt16LE(at + 32);
      const local = buf.readUInt32LE(at + 42);
      if (comp === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new OfficeError('zip64');
      const name = buf.subarray(at + 46, at + 46 + n).toString('utf8');
      this.entries.set(name, { name, method, flags, comp, size, local });
      at += 46 + n + e + c;
    }
  }

  private findEocd() {
    const b = this.buf;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (b.readUInt32LE(i) === 0x06054b50) return i;
    return -1;
  }

  has(name: string) {
    return this.entries.has(name);
  }

  /** A part's bytes, at most `max` of them (`cut` when there was more). */
  read(name: string, max = PART_MAX): { data: Buffer; cut: boolean } | undefined {
    const e = this.entries.get(name);
    if (!e) return undefined;
    if (e.flags & 1) throw new OfficeError('encrypted');
    const b = this.buf;
    if (e.local + 30 > b.length || b.readUInt32LE(e.local) !== 0x04034b50) throw new OfficeError('bad local header');
    const start = e.local + 30 + b.readUInt16LE(e.local + 26) + b.readUInt16LE(e.local + 28);
    const comp = b.subarray(start, Math.min(b.length, start + e.comp));
    if (e.method === 0) return { data: comp.subarray(0, max), cut: comp.length > max };
    if (e.method !== 8) throw new OfficeError(`method ${e.method}`);
    // the whole part, or (too big) the longest start of it that fits: a cut deflate stream decodes up to where it stops
    const inflate = (len: number) => {
      try {
        return zlib.inflateRawSync(comp.subarray(0, len), { maxOutputLength: max, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch (err) {
        if (err instanceof RangeError) return undefined;
        throw new OfficeError('bad deflate data');
      }
    };
    const whole = inflate(comp.length);
    if (whole) return { data: whole, cut: false };
    let lo = 0, hi = comp.length, best = Buffer.alloc(0);
    for (let i = 0; i < 24 && hi - lo > 1; i++) {
      const mid = Math.floor((lo + hi) / 2);
      const d = inflate(mid);
      if (d) [lo, best] = [mid, d];
      else hi = mid;
    }
    return { data: best, cut: true };
  }

  text(name: string, max = PART_MAX) {
    const r = this.read(name, max);
    return r && { text: r.data.toString('utf8'), cut: r.cut };
  }
}

/* ---------- a small XML reader: elements, attributes and text; tolerant of a document cut short ---------- */

export type XNode = { name: string; attrs: Record<string, string>; kids: XNode[]; text?: string };

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export const unxml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENT[e] ?? m;
  });

export function parseXml(src: string): XNode {
  const root: XNode = { name: '#root', attrs: {}, kids: [] };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(src)); ) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.kids.push({ name: '#text', attrs: {}, kids: [], text: m[1] });
    else if (m[6] !== undefined) top.kids.push({ name: '#text', attrs: {}, kids: [], text: unxml(m[6]) });
    else if (m[3]) {
      if (m[2]) {
        // a close tag: up to its element (a stray one is ignored)
        const i = stack.map(n => n.name).lastIndexOf(m[3]);
        if (i > 0) stack.length = i;
      } else {
        const attrs: Record<string, string> = {};
        for (const a of (m[4] ?? '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unxml(a[2] ?? a[3] ?? '');
        const n: XNode = { name: m[3], attrs, kids: [] };
        top.kids.push(n);
        if (!m[5]) stack.push(n);
      }
    }
  }
  return root;
}

const local = (n: string) => n.slice(n.indexOf(':') + 1);
const kid = (n: XNode | undefined, name: string) => n?.kids.find(k => local(k.name) === name);
const kids = (n: XNode | undefined, name: string) => n?.kids.filter(k => local(k.name) === name) ?? [];
const attr = (n: XNode | undefined, name: string) => {
  if (!n) return undefined;
  for (const [k, v] of Object.entries(n.attrs)) if (local(k) === name) return v;
  return undefined;
};
function* walk(n: XNode): Generator<XNode> {
  for (const k of n.kids) {
    yield k;
    yield* walk(k);
  }
}

export const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** a part's relationships: id → target path inside the zip (external targets left out) */
function rels(z: Zip, part: string) {
  const dir = path.posix.dirname(part);
  const file = path.posix.join(dir, '_rels', path.posix.basename(part) + '.rels');
  const out = new Map<string, string>();
  const x = z.text(file, 4_000_000);
  if (!x) return out;
  for (const r of walk(parseXml(x.text))) {
    if (local(r.name) !== 'Relationship' || r.attrs.TargetMode === 'External') continue;
    const t = r.attrs.Target ?? '';
    out.set(r.attrs.Id ?? '', t.startsWith('/') ? t.slice(1) : path.posix.normalize(path.posix.join(dir, t)));
  }
  return out;
}

/* ---------- Word ---------- */

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const on = (n: XNode | undefined) => !!n && !['0', 'false', 'off', 'none'].includes(attr(n, 'val') ?? '');

/**
 * A Word file as HTML that is safe to put into the page: only h1–h6, p, b, i, u, ul/ol/li, table/tr/th/td (colspan, rowspan),
 * br and img with a data: picture from word/media/. Every piece of text from the file is escaped; no other attribute is kept.
 */
export function docxHtml(buf: Buffer): { html: string; cut?: boolean } {
  const z = new Zip(buf);
  const main = 'word/document.xml';
  const doc = z.text(main);
  if (!doc) throw new OfficeError('no word/document.xml');
  const rel = rels(z, main);

  // headings: a style named "heading N" or "Title" (the style's id differs by language, its name does not)
  const level = new Map<string, number>();
  const st = z.text('word/styles.xml', 8_000_000);
  if (st)
    for (const s of walk(parseXml(st.text))) {
      if (local(s.name) !== 'style') continue;
      const name = (attr(kid(s, 'name'), 'val') ?? '').toLowerCase();
      const h = name.match(/^heading ([1-6])$/)?.[1];
      const id = attr(s, 'styleId');
      if (id && (h || name === 'title')) level.set(id, h ? Number(h) : 1);
    }
  const headingOf = (id: string | undefined) => (id ? (level.get(id) ?? (Number(/^heading\s*([1-6])$/i.exec(id)?.[1]) || (/^title$/i.test(id) ? 1 : 0))) : 0);

  // lists: numbered or bullets, from numbering.xml
  const bullet = new Map<string, boolean>();
  const nb = z.text('word/numbering.xml', 8_000_000);
  if (nb) {
    const x = parseXml(nb.text);
    const abs = new Map<string, Map<string, boolean>>();
    for (const a of walk(x))
      if (local(a.name) === 'abstractNum') abs.set(attr(a, 'abstractNumId') ?? '', new Map(kids(a, 'lvl').map(l => [attr(l, 'ilvl') ?? '0', attr(kid(l, 'numFmt'), 'val') === 'bullet'])));
    for (const n of walk(x)) if (local(n.name) === 'num') for (const [lvl, b] of abs.get(attr(kid(n, 'abstractNumId'), 'val') ?? '') ?? []) bullet.set(`${attr(n, 'numId')}:${lvl}`, b);
  }

  let imageBytes = 0, left = 0;
  const picture = (rid: string | undefined) => {
    const target = rid && rel.get(rid);
    const type = target && IMAGE_TYPES[path.posix.extname(target).toLowerCase()];
    if (!target || !type || !target.startsWith('word/media/')) return '';
    const size = z.entries.get(target)?.size ?? 0;
    if (size > IMAGE_MAX || imageBytes + size > IMAGES_MAX) return (left++, '');
    const r = z.read(target, IMAGE_MAX);
    if (!r || r.cut) return (left++, '');
    imageBytes += r.data.length;
    return `<img src="data:${type};base64,${r.data.toString('base64')}">`;
  };

  /** a paragraph's content: its runs, in links, insertions and content controls too; deleted text and field codes left out */
  const runs = (p: XNode): string => {
    let out = '';
    for (const k of p.kids) {
      const n = local(k.name);
      if (n === 'pPr' || n === 'del' || n === 'moveFrom' || n === 'instrText' || n === 'delText' || k.name === '#text') continue;
      if (n !== 'r') {
        out += runs(k);
        continue;
      }
      const rp = kid(k, 'rPr');
      let s = '';
      for (const c of k.kids) {
        const cn = local(c.name);
        if (cn === 't') s += esc(c.kids.map(t => t.text ?? '').join(''));
        else if (cn === 'tab') s += '\t';
        else if (cn === 'br' || cn === 'cr') s += '<br>';
        else if (cn === 'drawing' || cn === 'pict' || cn === 'object')
          for (const d of walk(c)) {
            if (local(d.name) === 'blip') s += picture(attr(d, 'embed'));
            else if (local(d.name) === 'imagedata') s += picture(attr(d, 'id'));
          }
      }
      if (!s) continue;
      if (on(kid(rp, 'u'))) s = `<u>${s}</u>`;
      if (on(kid(rp, 'i'))) s = `<i>${s}</i>`;
      if (on(kid(rp, 'b'))) s = `<b>${s}</b>`;
      out += s;
    }
    return out;
  };

  const table = (t: XNode): string => {
    type Cell = { html: string; th: boolean; colspan: number; rowspan: number };
    const rows: (Cell | null)[][] = [];
    const open = new Map<number, Cell>(); // a vertically merged cell by its first column
    for (const tr of kids(t, 'tr')) {
      const th = !!kid(kid(tr, 'trPr'), 'tblHeader');
      const row: (Cell | null)[] = [];
      let col = 0;
      for (const tc of kids(tr, 'tc')) {
        const pr = kid(tc, 'tcPr');
        const span = Math.max(1, Math.min(100, Number(attr(kid(pr, 'gridSpan'), 'val')) || 1));
        const vm = kid(pr, 'vMerge');
        const v = vm && (attr(vm, 'val') ?? 'continue');
        if (v === 'continue' && open.has(col)) {
          open.get(col)!.rowspan++;
          row.push(null);
        } else {
          // a cell of one paragraph holds its text without the paragraph
          const html = body(tc).replace(/^<p>((?:(?!<\/?p>)[\s\S])*)<\/p>$/, '$1');
          const cell: Cell = { html, th, colspan: span, rowspan: 1 };
          row.push(cell);
          if (v === 'restart') open.set(col, cell);
          else for (let i = col; i < col + span; i++) open.delete(i);
        }
        col += span;
      }
      rows.push(row);
    }
    const cells = (r: (Cell | null)[]) => r.filter((c): c is Cell => !!c).map(c => `<${c.th ? 'th' : 'td'}${c.colspan > 1 ? ` colspan="${c.colspan}"` : ''}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ''}>${c.html}</${c.th ? 'th' : 'td'}>`).join('');
    return `<table>${rows.map(r => `<tr>${cells(r)}</tr>`).join('')}</table>`;
  };

  /** a body (the document's, or a table cell's): paragraphs, lists and tables */
  function body(b: XNode): string {
    let out = '';
    const lists: { tag: 'ul' | 'ol'; li: boolean }[] = [];
    const closeTo = (depth: number) => {
      while (lists.length > depth) {
        const l = lists.pop()!;
        out += (l.li ? '</li>' : '') + `</${l.tag}>`;
      }
    };
    const blocks = (n: XNode) => {
      for (const k of n.kids) {
        const name = local(k.name);
        if (name === 'sdt') blocks(kid(k, 'sdtContent') ?? k);
        else if (name === 'tbl') {
          closeTo(0);
          out += table(k);
        } else if (name === 'p') {
          const pr = kid(k, 'pPr');
          const num = kid(pr, 'numPr');
          const numId = attr(kid(num, 'numId'), 'val');
          const content = runs(k);
          if (num && numId && numId !== '0') {
            const lvl = Math.min(8, Number(attr(kid(num, 'ilvl'), 'val')) || 0);
            const tag = bullet.get(`${numId}:${lvl}`) === false ? 'ol' : 'ul';
            closeTo(lvl + 1);
            const top = lists[lists.length - 1];
            if (top && lists.length === lvl + 1 && top.tag !== tag) closeTo(lvl);
            else if (top && lists.length === lvl + 1 && top.li) (out += '</li>'), (top.li = false);
            while (lists.length < lvl + 1) {
              out += `<${tag}>`;
              lists.push({ tag, li: false });
            }
            out += `<li>${content}`;
            lists[lists.length - 1].li = true;
            continue;
          }
          closeTo(0);
          const h = headingOf(attr(kid(pr, 'pStyle'), 'val'));
          out += h ? `<h${h}>${content}</h${h}>` : `<p>${content || '<br>'}</p>`;
        }
      }
    };
    blocks(b);
    closeTo(0);
    return out;
  }

  const x = parseXml(doc.text);
  const b = [...walk(x)].find(n => local(n.name) === 'body');
  let html = b ? body(b) : '';
  if (left) html += `<p><i>${left === 1 ? 'A picture was' : `${left} pictures were`} left out: too big to show here.</i></p>`;
  return doc.cut ? { html, cut: true } : { html };
}

/* ---------- Excel ---------- */

export type Cell = string | number | boolean | null;
export type Sheet = { name: string; rows: Cell[][]; cut?: boolean };

/** A column's letters to its index: A → 0, AA → 26. */
const colIndex = (ref: string) => {
  let n = 0;
  for (const ch of ref.toUpperCase().match(/^[A-Z]+/)?.[0] ?? '') n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

const textOf = (xml: string) => [...xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '').matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(m => unxml(m[1])).join('');
const attrsOf = (s: string) => Object.fromEntries([...s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(m => [local(m[1]), unxml(m[2] ?? m[3] ?? '')]));

/** Built-in number formats that are dates (ECMA-376 §18.8.30). */
const DATE_IDS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function dateText(serial: number, date1904: boolean, withTime: boolean) {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86_400_000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  return withTime && ms % 86_400_000 ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 10);
}

/**
 * An Excel file's sheets as rows of values: shared and inline strings, numbers, booleans, a formula's cached value (formulas
 * never run), dates as text. The first ROWS_MAX rows of each sheet; `cut` when there were more.
 */
export function xlsxSheets(buf: Buffer): { sheets: Sheet[] } {
  const z = new Zip(buf);
  const wbPart = 'xl/workbook.xml';
  const wb = z.text(wbPart, 8_000_000);
  if (!wb) throw new OfficeError('no xl/workbook.xml');
  const rel = rels(z, wbPart);
  const date1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/.test(wb.text);

  const shared: string[] = [];
  const ss = z.text('xl/sharedStrings.xml');
  if (ss) for (const m of ss.text.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\s*\/>/g)) shared.push(m[1] ? textOf(m[1]) : '');

  // which cell styles are dates
  const dateStyle: boolean[] = [];
  const st = z.text('xl/styles.xml', 8_000_000);
  if (st) {
    const custom = new Map<number, string>();
    for (const m of st.text.matchAll(/<(?:\w+:)?numFmt\b([^>]*?)\/?>/g)) {
      const a = attrsOf(m[1]);
      custom.set(Number(a.numFmtId), a.formatCode ?? '');
    }
    const xfs = st.text.match(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/)?.[1] ?? '';
    for (const m of xfs.matchAll(/<(?:\w+:)?xf\b([^>]*?)\/?>/g)) {
      const id = Number(attrsOf(m[1]).numFmtId ?? 0);
      const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
      dateStyle.push(DATE_IDS.has(id) || (custom.has(id) && /[dy]/i.test(code)) || (custom.has(id) && /m/i.test(code) && /[hs]/i.test(code)));
    }
  }

  const sheets: Sheet[] = [];
  for (const m of wb.text.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
    const a = attrsOf(m[1]);
    const part = rel.get(a.id ?? '');
    const x = part && z.text(part);
    if (!x) {
      sheets.push({ name: a.name ?? 'Sheet', rows: [] });
      continue;
    }
    const rows: Cell[][] = [];
    let cut = x.cut, next = 0;
    for (const r of x.text.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
      const at = Number(attrsOf(r[1]).r) - 1;
      const index = Number.isFinite(at) && at >= next ? at : next;
      if (index >= ROWS_MAX) {
        cut = true;
        break;
      }
      while (rows.length < index) rows.push([]);
      next = index + 1;
      const row: Cell[] = [];
      let col = 0;
      for (const c of (r[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const ca = attrsOf(c[1]);
        const ci = ca.r ? colIndex(ca.r) : col;
        col = Math.max(ci, col) + 1;
        if (ci >= COLS_MAX) {
          cut = true;
          continue;
        }
        const inner = c[2] ?? '';
        const v = inner.match(/<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
        let val: Cell = null;
        if (ca.t === 'inlineStr') val = textOf(inner.match(/<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/)?.[1] ?? '');
        else if (v === undefined) val = null;
        else if (ca.t === 's') val = shared[Number(v)] ?? '';
        else if (ca.t === 'b') val = v.trim() === '1';
        else if (ca.t === 'str' || ca.t === 'e' || ca.t === 'd') val = unxml(v);
        else {
          const n = Number(v);
          val = !Number.isFinite(n) ? unxml(v) : dateStyle[Number(ca.s ?? 0)] ? dateText(n, date1904, n % 1 !== 0) : n;
        }
        while (row.length < ci) row.push(null);
        row[ci] = val;
      }
      while (row.length && (row[row.length - 1] === null || row[row.length - 1] === '')) row.pop();
      rows.push(row);
    }
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    sheets.push(cut ? { name: a.name ?? 'Sheet', rows, cut: true } : { name: a.name ?? 'Sheet', rows });
  }
  return { sheets };
}
