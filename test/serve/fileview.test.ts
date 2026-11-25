// The file viewer's server side (plan 2026-11-25, P1): a file's kind, the sniff, the caps, and Word/Excel through the parsing layer.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { kindOf, MEDIA_MAX, TEXT_MAX, viewFile } from '../../src/serve/fileview.ts';
import { docxHtml, OfficeError, ROWS_MAX, xlsxSheets, Zip } from '../../src/serve/officeview.ts';

/** A zip built here (no fixture binaries): each part deflated, or stored when `stored`. */
export function zip(parts: Record<string, string | Buffer>, o: { stored?: boolean; encrypt?: string } = {}) {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const [name, body] of Object.entries(parts)) {
    const raw = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const data = o.stored ? raw : zlib.deflateRawSync(raw);
    const n = Buffer.from(name);
    const flags = o.encrypt === name ? 1 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(o.stored ? 0 : 8, 8);
    lh.writeUInt32LE(zlib.crc32(raw), 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(o.stored ? 0 : 8, 10);
    ch.writeUInt32LE(zlib.crc32(raw), 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

/** a small Word file: a heading, styled runs, a bullet list, a numbered list, a table with merged cells, a picture */
export function sampleDocx(extra = '') {
  const run = (t: string, pr = '') => `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
  const li = (num: number, t: string, lvl = 0) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="${num}"/></w:numPr></w:pPr>${run(t)}</w:p>`;
  const tc = (t: string, pr = '') => `<w:tc>${pr ? `<w:tcPr>${pr}</w:tcPr>` : ''}<w:p>${run(t)}</w:p></w:tc>`;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>
<w:p><w:pPr><w:pStyle w:val="Kop1"/></w:pPr>${run('Quarterly plan')}</w:p>
<w:p>${run('Plain, ')}${run('bold', '<w:b/>')}${run(', ')}${run('italic', '<w:i/>')}${run(', ')}${run('under', '<w:u w:val="single"/>')}${run(' and not bold', '<w:b w:val="0"/>')}</w:p>
${li(1, 'first bullet')}${li(1, 'nested', 1)}${li(1, 'second bullet')}${li(2, 'step one')}${li(2, 'step two')}
<w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr>${tc('Name')}${tc('Q1 and Q2', '<w:gridSpan w:val="2"/>')}</w:tr>
<w:tr>${tc('Ann', '<w:vMerge w:val="restart"/>')}${tc('1')}${tc('2')}</w:tr>
<w:tr>${tc('', '<w:vMerge/>')}${tc('3')}${tc('4')}</w:tr></w:tbl>
<w:p><w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="rIdImg"/></a:graphicData></a:graphic></w:drawing></w:r></w:p>
<w:p><w:del><w:r><w:delText>deleted words</w:delText></w:r></w:del><w:ins><w:r><w:t>inserted words</w:t></w:r></w:ins></w:p>
${extra}
</w:body></w:document>`;
  const styles = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Kop1"><w:name w:val="heading 1"/></w:style></w:styles>`;
  const numbering = `<w:numbering ${W}><w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:abstractNum w:abstractNumId="11"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="11"/></w:num></w:numbering>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="image" Target="media/image1.png"/><Relationship Id="rIdOut" Type="image" Target="https://evil.example/x.png" TargetMode="External"/></Relationships>`;
  return zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': doc, 'word/styles.xml': styles, 'word/numbering.xml': numbering, 'word/_rels/document.xml.rels': rels, 'word/media/image1.png': PNG });
}

/** a small Excel file: shared and inline strings, numbers, booleans, a formula with its cached value, a date, a gap */
export function sampleXlsx(rows = '') {
  const wb = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sales &amp; costs" sheetId="1" r:id="rId1"/><sheet name="Empty" sheetId="2" r:id="rId2"/></sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`;
  const ss = `<sst><si><t>Region</t></si><si><r><t>To</t></r><r><t>tal</t></r><rPh><t>ignored</t></rPh></si><si><t>&lt;script&gt;</t></si></sst>`;
  const styles = `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>`;
  const sheet = `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Note</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>12.5</v></c><c r="D2" t="b"><v>1</v></c></row>
<row r="4"><c r="A4"><f>SUM(B2:B3)</f><v>42</v></c><c r="B4" t="str"><f>CONCAT("a","b")</f><v>ab</v></c><c r="C4" s="1"><v>45658</v></c><c r="D4" t="e"><v>#DIV/0!</v></c></row>
${rows}
</sheetData></worksheet>`;
  return zip({ 'xl/workbook.xml': wb, 'xl/_rels/workbook.xml.rels': rels, 'xl/sharedStrings.xml': ss, 'xl/styles.xml': styles, 'xl/worksheets/sheet1.xml': sheet, 'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>' });
}

const dir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-fv-')));

test('kindOf: every kind by its extension; a type it cannot show gets its name', () => {
  const want: [string, string][] = [
    ['a.md', 'markdown'], ['a.HTML', 'html'], ['a.mmd', 'mermaid'], ['a.json', 'json'], ['a.csv', 'csv'], ['a.tsv', 'csv'], ['a.diff', 'diff'], ['a.patch', 'diff'],
    ['a.svg', 'svg'], ['a.png', 'image'], ['a.jpeg', 'image'], ['a.pdf', 'pdf'], ['a.docx', 'docx'], ['a.xlsx', 'xlsx'], ['a.ts', 'code'], ['Dockerfile', 'code'], ['a.txt', 'text'], ['a.log', 'text'],
  ];
  for (const [n, k] of want) assert.equal(kindOf(n).kind, k, n);
  assert.deepEqual(kindOf('deck.key'), { kind: 'none', type: 'Keynote' });
  assert.deepEqual(kindOf('deck.pptx'), { kind: 'none', type: 'PowerPoint' });
  assert.deepEqual(kindOf('a.zip'), { kind: 'none', type: 'zip' });
  assert.deepEqual(kindOf('a.weird'), { kind: 'none' });
});

test('viewFile: text kinds carry their text; image and pdf only their facts; a type it cannot show says so', () => {
  const d = dir();
  const put = (n: string, b: string | Buffer) => (fs.writeFileSync(path.join(d, n), b), path.join(d, n));
  const md = viewFile(put('plan.md', '# Plan\nnaïve ✓'), { title: 'The plan', rel: 'plan.md' });
  assert.equal(md.kind, 'markdown');
  assert.equal(md.text, '# Plan\nnaïve ✓');
  assert.equal(md.title, 'The plan');
  assert.equal(md.rel, 'plan.md');
  assert.equal(md.size, Buffer.byteLength('# Plan\nnaïve ✓'));
  assert.ok(md.mtime && !md.why && !md.cut);
  for (const [n, k] of [['a.json', 'json'], ['a.csv', 'csv'], ['a.diff', 'diff'], ['a.html', 'html'], ['a.mmd', 'mermaid'], ['a.svg', 'svg'], ['a.py', 'code'], ['a.txt', 'text']] as const) {
    const v = viewFile(put(n, `content of ${n}`));
    assert.equal(v.kind, k);
    assert.equal(v.text, `content of ${n}`);
  }
  const png = viewFile(put('shot.png', PNG));
  assert.equal(png.kind, 'image');
  assert.equal(png.text, undefined);
  assert.equal(png.why, undefined);
  assert.equal(viewFile(put('a.pdf', '%PDF-1.4')).kind, 'pdf');
  const key = viewFile(put('deck.key', 'x'));
  assert.deepEqual([key.kind, key.why, key.type], ['none', 'type', 'Keynote']);
  // the path is shown under ~ when it is in the home folder
  assert.ok(!viewFile(path.join(os.homedir(), 'no-such-file-chorus.md')).path.startsWith(os.homedir()));
});

test('viewFile: the sniff: a text kind with a NUL byte is not text; an unknown name is text when it sniffs as text', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'fake.txt'), Buffer.from([0x68, 0x00, 0x69]));
  const b = viewFile(path.join(d, 'fake.txt'));
  assert.deepEqual([b.kind, b.why, b.text], ['text', 'binary', undefined]);
  fs.writeFileSync(path.join(d, 'README'), 'just words');
  assert.deepEqual([viewFile(path.join(d, 'README')).kind, viewFile(path.join(d, 'README')).text], ['text', 'just words']);
  fs.writeFileSync(path.join(d, 'blob.weird'), Buffer.from([1, 0, 2]));
  const w = viewFile(path.join(d, 'blob.weird'));
  assert.deepEqual([w.kind, w.why, w.type], ['none', 'type', 'WEIRD']);
  fs.writeFileSync(path.join(d, 'blob'), Buffer.from([1, 0, 2]));
  assert.equal(viewFile(path.join(d, 'blob')).why, 'binary');
  // the NUL counts only in the first 8 KB
  fs.writeFileSync(path.join(d, 'late.txt'), Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]));
  assert.equal(viewFile(path.join(d, 'late.txt')).why, undefined);
});

test('viewFile: caps: text is cut at 2 MB (a character split in two is dropped); media over 50 MB is big; a missing file is gone', () => {
  const d = dir();
  const big = path.join(d, 'big.log');
  // 'é' is 2 bytes: put one across the 2 MB line
  fs.writeFileSync(big, Buffer.concat([Buffer.alloc(TEXT_MAX - 1, 0x61), Buffer.from('é'), Buffer.alloc(10, 0x62)]));
  const v = viewFile(big);
  assert.equal(v.cut, true);
  assert.equal(v.text!.length, TEXT_MAX - 1);
  assert.ok(!v.text!.includes('�'));
  const pdf = path.join(d, 'huge.pdf');
  fs.closeSync(fs.openSync(pdf, 'w'));
  fs.truncateSync(pdf, MEDIA_MAX + 1); // sparse: no 50 MB written
  assert.equal(viewFile(pdf).why, 'big');
  const gone = viewFile(path.join(d, 'gone.md'), { title: 'Gone' });
  assert.deepEqual([gone.kind, gone.why, gone.title, gone.size], ['markdown', 'gone', 'Gone', undefined]);
  // a folder is no file
  assert.equal(viewFile(d).why, 'gone');
});

test('viewFile never changes the file: same bytes and the same modified time after a view of each kind', () => {
  const d = dir();
  const files = { 'a.docx': sampleDocx(), 'a.xlsx': sampleXlsx(), 'a.md': '# x' };
  for (const [n, b] of Object.entries(files)) {
    const p = path.join(d, n);
    fs.writeFileSync(p, b);
    fs.utimesSync(p, new Date(2020, 0, 1), new Date(2020, 0, 1));
    viewFile(p);
    assert.deepEqual(fs.readFileSync(p), Buffer.from(b));
    assert.equal(fs.statSync(p).mtimeMs, new Date(2020, 0, 1).getTime());
  }
  assert.deepEqual(fs.readdirSync(d).sort(), Object.keys(files).sort(), 'nothing new beside them');
});

test('Zip: stored and deflate parts; zip64, encrypted, an unknown method and no zip at all cannot be read', () => {
  for (const stored of [false, true]) {
    const z = new Zip(zip({ 'a.txt': 'hello', 'b/c.xml': '<x/>' }, { stored }));
    assert.equal(z.text('a.txt')?.text, 'hello');
    assert.equal(z.text('b/c.xml')?.text, '<x/>');
    assert.equal(z.read('nope'), undefined);
  }
  assert.throws(() => new Zip(Buffer.from('not a zip at all, just words')), OfficeError);
  assert.throws(() => new Zip(zip({ 'a.txt': 'x' }, { encrypt: 'a.txt' })).read('a.txt'), /encrypted/);
  const z64 = zip({ 'a.txt': 'x' });
  z64.writeUInt16LE(0xffff, z64.length - 22 + 10);
  assert.throws(() => new Zip(z64), /zip64/);
  const m = zip({ 'a.txt': 'x' }, { stored: true });
  const cd = m.readUInt32LE(m.length - 22 + 16);
  m.writeUInt16LE(12, cd + 10); // bzip2
  assert.throws(() => new Zip(m).read('a.txt'), /method 12/);
  // a part bigger than asked for: the start of it, marked cut
  const big = new Zip(zip({ 'big.txt': 'a'.repeat(100_000) }));
  const r = big.read('big.txt', 1000)!;
  assert.equal(r.cut, true);
  assert.ok(r.data.length <= 1000 && r.data.length > 0 && r.data.every(c => c === 0x61));
});

test('docxHtml: headings, bold/italic/underline, lists, a table with merged cells, a picture as a data URL; deleted text left out', () => {
  const { html } = docxHtml(sampleDocx());
  assert.match(html, /^<h1>Quarterly plan<\/h1>/);
  assert.match(html, /<p>Plain, <b>bold<\/b>, <i>italic<\/i>, <u>under<\/u> and not bold<\/p>/);
  assert.match(html, /<ul><li>first bullet<ul><li>nested<\/li><\/ul><\/li><li>second bullet<\/li><\/ul><ol><li>step one<\/li><li>step two<\/li><\/ol>/);
  assert.match(html, /<table><tr><th>Name<\/th><th colspan="2">Q1 and Q2<\/th><\/tr><tr><td rowspan="2">Ann<\/td><td>1<\/td><td>2<\/td><\/tr><tr><td>3<\/td><td>4<\/td><\/tr><\/table>/);
  assert.ok(html.includes(`<img src="data:image/png;base64,${PNG.toString('base64')}">`));
  assert.ok(!html.includes('evil.example'));
  assert.ok(html.includes('inserted words') && !html.includes('deleted words'));
});

test('docxHtml: hostile text is escaped and only whitelisted tags come out, with no attribute from the file but colspan/rowspan', () => {
  const hostile = [
    '<w:p><w:r><w:t>&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt; &amp;amp; "q" \'s\'</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:pStyle w:val="&quot; onclick=&quot;x"/></w:pPr><w:r><w:t>style</w:t></w:r></w:p>',
    '<w:p><w:r><w:script>alert(3)</w:script><w:t>after</w:t></w:r></w:p>',
    '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2&quot; onmouseover=&quot;x"/></w:tcPr><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
    '<w:p><w:r><w:drawing><a:blip r:embed="rIdOut"/></w:drawing></w:r></w:p>',
  ].join('');
  const { html } = docxHtml(sampleDocx(hostile));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt; &amp;amp; &quot;q&quot; &#39;s&#39;'));
  assert.ok(!/<script|onerror=|onclick|onmouseover|alert\(3\)/i.test(html.replace(/&lt;[^]*?&gt;/g, '')));
  const tags = [...html.matchAll(/<\/?([a-z0-9]+)([^>]*)>/g)];
  for (const [, tag, attrs] of tags) {
    assert.ok(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'b', 'i', 'u', 'ul', 'ol', 'li', 'table', 'tr', 'th', 'td', 'br', 'img'].includes(tag), tag);
    const names = [...attrs.matchAll(/\s([\w-]+)=/g)].map(m => m[1]);
    for (const n of names) assert.ok(tag === 'img' ? n === 'src' : ['colspan', 'rowspan'].includes(n), `${tag} ${n}`);
    if (tag === 'img') assert.match(attrs, /^ src="data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+"$/);
    if (/colspan|rowspan/.test(attrs)) assert.match(attrs, /^( (colspan|rowspan)="\d+")+$/);
  }
  assert.throws(() => docxHtml(zip({ 'other.xml': '<x/>' })), OfficeError);
});

test('xlsxSheets: shared and inline strings, numbers, booleans, cached formula values (never run), dates; first 1,000 rows and a flag', () => {
  const { sheets } = xlsxSheets(sampleXlsx());
  assert.deepEqual(sheets.map(s => s.name), ['Sales & costs', 'Empty']);
  assert.deepEqual(sheets[0].rows, [
    ['Region', 'Total', 'Note'],
    ['<script>', 12.5, null, true],
    [],
    [42, 'ab', '2025-01-01', '#DIV/0!'],
  ]);
  assert.equal(sheets[0].cut, undefined);
  assert.deepEqual(sheets[1], { name: 'Empty', rows: [] });
  const many = Array.from({ length: ROWS_MAX + 5 }, (_, i) => `<row r="${i + 5}"><c r="A${i + 5}"><v>${i}</v></c></row>`).join('');
  const big = xlsxSheets(sampleXlsx(many)).sheets[0];
  assert.equal(big.rows.length, ROWS_MAX);
  assert.equal(big.cut, true);
  assert.throws(() => xlsxSheets(zip({ 'x.xml': '<x/>' })), OfficeError);
});

test('viewFile: Word gives html, Excel gives sheets; a protected or broken one cannot be opened', () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'r.docx'), sampleDocx());
  fs.writeFileSync(path.join(d, 'r.xlsx'), sampleXlsx());
  const w = viewFile(path.join(d, 'r.docx'));
  assert.equal(w.kind, 'docx');
  assert.match(w.html!, /<h1>Quarterly plan<\/h1>/);
  const x = viewFile(path.join(d, 'r.xlsx'));
  assert.equal(x.kind, 'xlsx');
  assert.equal(x.sheets![0].rows[0][0], 'Region');
  // a password-protected Office file is a compound file, not a zip
  fs.writeFileSync(path.join(d, 'locked.docx'), Buffer.from('d0cf11e0a1b11ae1', 'hex'));
  const l = viewFile(path.join(d, 'locked.docx'));
  assert.deepEqual([l.kind, l.why, l.type], ['docx', 'type', 'Word (protected or damaged)']);
});
