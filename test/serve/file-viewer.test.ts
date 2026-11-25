// The file viewer's page side (plan 2026-11-25 chat-view-files, P2; mockup chat-view-files.html): where a file opens (the scene 1
// table), the modes, the kind messages, and the renderers. The card and the Files row call the same openFile, checked here in app.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
// @ts-expect-error: a page module, plain JavaScript
import { agoText, artLabel, cardSum, diffHtml, fileSquare, fmtSize, jsonTreeHtml, lineCount, modesOf, noteHtml, parseCsv, rawHtml, routeOf, stateHtml, stripText, tableHtml, wrapsByDefault } from '../../src/desktop/file-viewer.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

test('where a file opens: the viewer, the Mac\'s own app, or the kind message (scene 1\'s table)', () => {
  const v = (o: object) => ({ kind: 'markdown', title: 't', path: '~/p/a.md', ...o });
  // a file it can show: the viewer, on the Mac and remotely
  assert.equal(routeOf(v({ text: '#' }), true), 'viewer');
  assert.equal(routeOf(v({ text: '#' }), false), 'viewer');
  // a type it can't show: the Mac's app on the Mac, the message remotely
  assert.equal(routeOf(v({ kind: 'none', why: 'type', type: 'Keynote' }), true), 'mac');
  assert.equal(routeOf(v({ kind: 'none', why: 'type', type: 'Keynote' }), false), 'note');
  // a file outside the project (only remotely does the server say so)
  assert.equal(routeOf(v({ why: 'outside' }), false), 'note');
  // not text: the Mac's app on the Mac; remotely the viewer says so
  assert.equal(routeOf(v({ kind: 'text', why: 'binary' }), true), 'mac');
  assert.equal(routeOf(v({ kind: 'text', why: 'binary' }), false), 'viewer');
  // gone and too big: inside the viewer everywhere
  for (const onMac of [true, false]) for (const why of ['gone', 'big']) assert.equal(routeOf(v({ why }), onMac), 'viewer');
});

test('modes: Preview first; code and text Raw only; no Raw for images, PDF, Word and Excel', () => {
  assert.deepEqual(modesOf({ kind: 'markdown' }), { pv: true, raw: true, sw: true });
  assert.deepEqual(modesOf({ kind: 'html' }), { pv: true, raw: true, sw: true });
  for (const kind of ['code', 'text']) assert.deepEqual(modesOf({ kind }), { pv: false, raw: true, sw: false });
  for (const kind of ['image', 'pdf', 'docx', 'xlsx']) assert.deepEqual(modesOf({ kind }), { pv: true, raw: false, sw: true });
  assert.equal(wrapsByDefault({ kind: 'markdown' }), true);
  assert.equal(wrapsByDefault({ kind: 'json' }), false);
  assert.equal(wrapsByDefault({ kind: 'code' }), false);
});

test('the two messages remotely, and the card line for a file it can\'t show', () => {
  const c = noteHtml({ kind: 'none', why: 'type', type: 'Keynote', title: 'Launch <deck>', path: '~/p/docs/launch-deck.key', rel: 'docs/launch-deck.key' });
  assert.equal(c.title, "Keynote files can't be opened here");
  assert.match(c.body, /Chorus can show text, web pages, images, PDFs, Word and Excel files, but not Keynote files\./);
  assert.match(c.body, /<b>Launch &lt;deck&gt;<\/b> on your Mac/);
  assert.equal(c.where, 'docs/launch-deck.key');
  const d = noteHtml({ kind: 'pdf', why: 'outside', title: 'Invoice', path: '~/Documents/invoice-11.pdf' });
  assert.equal(d.title, 'This file stays on your Mac');
  assert.match(d.body, /saved outside this chat's project/);
  assert.equal(d.where, '~/Documents/invoice-11.pdf');
  assert.equal(cardSum({ why: 'type', type: 'Keynote', size: 6_200_000, path: 'a.key' }), "6.2 MB · Chorus can't show Keynote files");
  assert.equal(cardSum({ why: 'outside', path: 'a.key' }), '');
  assert.equal(cardSum({ kind: 'image', size: 84_000 }), '84 KB');
  assert.deepEqual([fmtSize(512), fmtSize(2100), fmtSize(84_000), fmtSize(6_200_000), fmtSize(48_000_000)], ['512 B', '2.1 KB', '84 KB', '6.2 MB', '48 MB']);
});

test('type squares and card labels', () => {
  assert.equal(fileSquare('docs/a.md'), '<span class="ft md">MD</span>');
  assert.equal(fileSquare('x/launch-deck.key', { size: 'sm' }), '<span class="ft sm key">KEY</span>');
  assert.equal(fileSquare('a.xlsx'), '<span class="ft xls">XLSX</span>');
  assert.equal(fileSquare('Makefile'), '<span class="ft code">FILE</span>');
  assert.equal(fileSquare('https://x', { link: true }), '<span class="ft code">URL</span>');
  assert.equal(artLabel({ kind: 'file', fileType: 'Keynote', target: 'a.key' }), 'KEYNOTE');
  assert.equal(artLabel({ kind: 'csv', target: 'a.tsv' }), 'TSV');
  assert.equal(artLabel({ kind: 'docx', target: 'a.docx' }), 'WORD');
  assert.equal(artLabel({ kind: 'file', target: 'a.bin' }), 'FILE');
});

test('Raw: one line each, escaped, lightly coloured; a one-line JSON indented', () => {
  const md = rawHtml('# Title\n\n**bold** and `code` <script>\n```\nx\n```\n', 'markdown', 'a.md');
  assert.equal((md.match(/<div>/g) ?? []).length, 6, 'the last newline makes no empty line');
  assert.match(md, /<span class="h"># Title<\/span>/);
  assert.match(md, /<span class="b">\*\*bold\*\*<\/span>/);
  assert.match(md, /<span class="c">`code`<\/span> &lt;script&gt;/);
  assert.ok(!md.includes('<script>'));
  const html = rawHtml('<a href="x" onclick="y">t</a>', 'html', 'a.html');
  assert.match(html, /<span class="tg">&lt;a<\/span> <span class="at">href<\/span>=<span class="s">&quot;x&quot;<\/span>/);
  const ts = rawHtml("const a = 'x'; // note", 'code', 'a.ts');
  assert.match(ts, /<span class="k">const<\/span> a = <span class="s">&#39;x&#39;<\/span>; <span class="m">\/\/ note<\/span>/);
  const py = rawHtml('x = 1  # note', 'code', 'a.py');
  assert.match(py, /<span class="at">x<\/span> = <span class="n2">1<\/span> <span class="m"> # note<\/span>/);
  const one = rawHtml(JSON.stringify({ a: 'x'.repeat(200), b: [1, 2] }), 'json', 'a.json');
  assert.ok((one.match(/<div>/g) ?? []).length > 3, 'indented');
  assert.equal(lineCount('a\nb\n'), 2);
  assert.equal(lineCount('a\nb'), 2);
});

test('JSON tree: folds, the first two levels open, closed nodes show their first entries, everything escaped', () => {
  const h = jsonTreeHtml({ week: '2026-W48', agents: [{ name: 'claude', turns: 412 }], '<k>': '<v>', n: null });
  assert.match(h, /^<div class="fv-tree"><details open><summary><span class="m jc">\{ 4 keys \}<\/span>/);
  assert.match(h, /<details open><summary><span class="k">&quot;agents&quot;<\/span>: <span class="m jc">\[ 1 item \]<\/span>/);
  assert.match(h, /<details><summary><span class="m">0<\/span>: <span class="m jc">\{ 2 keys \}<\/span><span class="m jp">\{ name: &quot;claude&quot;, turns: 412 \}<\/span>/);
  assert.ok(h.includes('&quot;&lt;k&gt;&quot;') && h.includes('&quot;&lt;v&gt;&quot;') && !h.includes('<k>'));
  assert.match(h, /<span class="n2">null<\/span>/);
});

test('CSV: quotes, doubled quotes, line breaks in quotes; a table with a fixed header, numbers right, 1,000 rows', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\r\n"two\nlines",3\n'), [['a', 'b'], ['x, y', 'say "hi"'], ['two\nlines', '3']]);
  assert.deepEqual(parseCsv('a\tb\n1\t2', '\t'), [['a', 'b'], ['1', '2']]);
  const rows = [['date', 'amount'], ...Array.from({ length: 1500 }, (_, i) => [`d${i}`, `${i}.00`])];
  const t = tableHtml(rows);
  assert.match(t, /<thead><tr><th>date<\/th><th class="r">amount<\/th><\/tr><\/thead>/);
  assert.equal((t.match(/<tr>/g) ?? []).length, 1001, 'the header and the first 1,000 rows');
  assert.ok(tableHtml([['<b>'], ['<i>']]).includes('&lt;i&gt;'));
  assert.equal(stripText({ kind: 'csv' }, { rows: 1204 }), 'Showing the first 1,000 of 1,204 rows.');
  assert.equal(stripText({ kind: 'code', cut: true, size: 48_000_000 }), 'Showing the first 2 MB of 48 MB.');
  assert.equal(stripText({ kind: 'xlsx', cut: true }), '', 'a cut sheet says so under its own table');
  assert.equal(stripText({ kind: 'markdown' }), '');
});

test('a patch is coloured; the viewer\'s states say what happened', () => {
  const d = diffHtml('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old <b>\n+new\n same\n');
  assert.match(d, /<div class="rm">-old &lt;b&gt;<\/div><div class="ad">\+new<\/div><div> same<\/div>/);
  assert.match(d, /<div class="hk">--- a\/x<\/div><div class="hk">\+\+\+ b\/x<\/div><div class="hk">@@/);
  assert.match(stateHtml({ why: 'gone', path: '~/p/a.md' }), /This file is no longer there.*Copy path/s);
  assert.match(stateHtml({ why: 'binary', path: '~/p/out/weights.txt' }), /This file isn't text.*Its name ends in \.txt/s);
  assert.match(stateHtml({ why: 'big', path: '~/a.png', size: 60_000_000 }), /too big.*60 MB/s);
  assert.equal(agoText(new Date(Date.now() - 120_000).toISOString()), '2 min ago');
  assert.equal(agoText(new Date().toISOString()), 'just now');
});

test('the card and the Files row both open files through openFile; no "Open on the Mac" badge or private-link note', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src/desktop/app.js'), 'utf8');
  const cv = fs.readFileSync(path.join(ROOT, 'src/desktop/chat-view.js'), 'utf8');
  assert.ok(!app.includes('>Open on the Mac<'), 'the badge is gone');
  assert.ok(!app.includes('Over the private link. Files inside'), 'the note is gone');
  assert.match(app, /case 'art-report': \{[^}]*openFile\(fileViewerH,/s);
  assert.match(app, /case 'art-open':\s*return openFile\(fileViewerH, \{ chat: S\.view\.id, p: arg \}\)/);
  assert.match(app, /openFile: o => void openFile\(fileViewerH, o\)/);
  assert.match(cv, /function openArtifact\(rid\) \{[^}]*h\.openFile\(/s);
  // the whole card is the button too, and its one Open
  assert.match(cv, /<div class="cv-card art" data-cv="art" data-arg="\$\{c\.id\}">/);
  assert.match(cv, /<button class="go" data-cv="art" data-arg="\$\{c\.id\}">\$\{OPEN_ICON\}Open<\/button>/);
});

test('a reply\'s inline code that names a file becomes a link to the viewer; other code does not (phone e2e 2026-11-25)', async () => {
  // @ts-expect-error: a page module, plain JavaScript
  const { isFilePath } = await import('../../src/desktop/chat-view.js');
  for (const yes of ['tiem-banh-may.html', 'site/hero.html', '/Users/me/run/cake-shop-site/hello.html', '~/notes/plan.md', 'tools/preview-local.sh', 'package.json', '.env.example'])
    assert.equal(isFilePath(yes), true, yes);
  for (const no of ['feature/single-file', 'npm test', 'https://x.dev/a.html', '--flag.x', '2.14.1', '/', '@', 'a b.md', 'git log --oneline', '<div>.x'])
    assert.equal(isFilePath(no), false, no);
});

