#!/usr/bin/env node
// The file viewer's proof (plan 2026-11-25 chat-view-files, P2; mockup @workspace/mockups/chat-view-files.html scenes 1–7). No
// agent and no model calls: a chat in a temporary CHORUS_HOME reports a markdown, an HTML, a JSON, a CSV, an image, a PDF, a Word
// file, an Excel file, a Keynote deck, a file outside the project and more; headless Chrome opens each from its card and from the
// Files list, at desktop and phone width, light and dark, on the Mac and as a device on the private link.
//
// The device: the same `chorus serve` code with a stand-in remote module (as test/serve/pro.test.ts does), which lets in a request
// with the device cookie. Chrome sends `x-forwarded-for` on every request (so the server treats it as remote) and opens the page at
// chorus-device.localhost (so the page draws a device's view). What the server sends or refuses is the real code.
//
//   node test/smoke/proof-file-viewer.ts [--out <dir>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { ProModule } from '@chauvoluuhuong/chorus-core/pro-loader';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import type { ProLoader } from '../../src/serve/pro.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import { openChrome, sleep } from './chrome.ts';
import { setSize, type Scheme, type Size } from './sizes.ts';

process.env.CHORUS_NO_OPEN = '1'; // the Mac's open command is not run: the page's note says it went
const ROOT = path.resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const branch = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'detached';
const OUT = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(ROOT, '.chorus/proof', branch.replace(/\//g, '-')));
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/^\d\d-.*\.png$/.test(f)) fs.rmSync(path.join(OUT, f));
const log = (s: string) => console.log(s);
const results: { ok: boolean; name: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => (results.push({ ok, name }), log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail.slice(0, 300)})`}`), ok);

/* ---------- the files ---------- */

const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-fv-proof-')));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-fv-proof-home-'));
const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-fv-proof-docs-')));
const put = (rel: string, body: string | Buffer, dir = project) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};

const MD = `# v2.13.0 release notes

The desktop Chat view, ready for everyday use.

## What changed

- **Terminal | Chat**: the switch has clear names now.
- The message box works on the desktop, with \`/\` and \`@\`.
- Background jobs show as one quiet line.

## Numbers

| Check         | Before | After |
|---------------|-------:|------:|
| Serve tests   |     41 |    43 |
| Chat view e2e |      6 |    11 |

## How a message reaches the CLI

\`\`\`mermaid
flowchart LR
  Box[Message box] --> Server --> CLI[CLI in its terminal]
\`\`\`

Install the preview with \`tools/preview-local.sh\`.
`;
const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Chorus</title>
  <style>
    html,body{height:100%;margin:0}
    .hero{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;text-align:center;padding:24px;box-sizing:border-box;background:linear-gradient(160deg,#fdfcf8,#efe9dc);color:#141413;font-family:Georgia,serif}
    h1{margin:0;font-size:44px;line-height:1.1}
    p{margin:0;max-width:440px;font:16px/1.5 -apple-system,sans-serif;color:#3d3d3a}
    a{font:600 14px -apple-system,sans-serif;background:#0f766e;color:#fff;border-radius:999px;padding:9px 20px;text-decoration:none}
  </style>
</head>
<body>
  <section class="hero">
    <h1>Every agent, one place</h1>
    <p>Run Claude Code, Codex and Antigravity side by side,
       from your Mac or your phone.</p>
    <a class="cta" href="/tour">Try Chorus</a>
  </section>
  <script>document.body.dataset.ran = 'yes'</script>
</body>
</html>
`;
const JSON_TEXT = JSON.stringify({ week: '2026-W48', agents: [{ name: 'claude', turns: 412, costUsd: 12.1 }, { name: 'codex', turns: 96, costUsd: 4.9 }, { name: 'agy', turns: 31, costUsd: 1.42 }], costUsd: 18.42 }, null, 2) + '\n';
const plans = ['year', 'life'], lands = ['VN', 'US', 'DE', 'JP'];
const CSV = 'date,plan,country,amount\n' + Array.from({ length: 1204 }, (_, i) => `2026-11-${String(24 - (i % 24)).padStart(2, '0')},${plans[i % 2]},${lands[i % 4]},${i % 2 ? '99.00' : '49.00'}`).join('\n') + '\n';
const MMD = 'flowchart LR\n  A[feature/*] --> B[dev] --> C[main]\n';
const PATCH = `diff --git a/src/desktop/app.js b/src/desktop/app.js
--- a/src/desktop/app.js
+++ b/src/desktop/app.js
@@ -212,7 +212,8 @@ function side()
   const rows = list(S.chats);
-  el.scrollTop = 0;
+  const keep = el.scrollTop;
+  el.scrollTop = keep;
   draw(rows);
`;
const TS = `import { esc } from './util.js';

/** Opens a reported file in the viewer. */
export async function view(chat, id) {
  const r = await fetch(\`/api/chats/\${chat}/reported/\${id}\`);
  if (!r.ok) return gone(id); // the agent moved it
  const kind = kindOf(r);
  return show(kind, await r.text());
}
`;

/** a PNG drawn here: a small "screenshot" of a window */
function png(w: number, h: number) {
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const r = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) {
      let c = [250, 249, 245];
      if (x < w * 0.25) c = [243, 241, 234];
      if (x >= w * 0.25 && x < w * 0.25 + 2) c = [229, 226, 217];
      const bar = (y0: number, x1: number) => y > h * y0 && y < h * y0 + h * 0.04 && x > w * 0.3 && x < w * x1;
      if (bar(0.12, 0.8) || bar(0.22, 0.95) || bar(0.32, 0.7) || bar(0.42, 0.88)) c = [229, 226, 217];
      if (y < h * 0.07) c = [15, 118, 110];
      r.set(c, 1 + x * 3);
    }
    rows.push(r);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** a two-page PDF written by hand */
function pdf() {
  const page = (text: string[]) => `BT /F1 22 Tf 72 740 Td (${text[0]}) Tj /F1 12 Tf 0 -36 Td ${text.slice(1).map(t => `(${t}) Tj 0 -18 Td`).join(' ')} ET`;
  const streams = [page(['Invoice, November', 'Chorus, one year plan', 'Amount: 49.00 USD', 'Paid on 2026-11-02']), page(['Terms', 'Thank you for your order.'])];
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>', `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>', `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => ((offs[i] = out.length), (out += `${i + 1} 0 obj\n${o}\nendobj\n`)));
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** a zip built here (as test/serve/fileview.test.ts does) */
function zip(parts: Record<string, string>) {
  const locals: Buffer[] = [], central: Buffer[] = [];
  let off = 0;
  for (const [name, body] of Object.entries(parts)) {
    const raw = Buffer.from(body), data = zlib.deflateRawSync(raw), n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(zlib.crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(zlib.crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
function docx() {
  const run = (t: string, b = false) => `<w:r>${b ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
  const p = (t: string, style = '') => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${run(t)}</w:p>`;
  const tc = (t: string) => `<w:tc><w:p>${run(t)}</w:p></w:tc>`;
  const li = (t: string) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(t)}</w:p>`;
  const doc = `<w:document ${W}><w:body>${p('Pricing proposal', 'Heading1')}${p('For teams of 5 to 50, from January.')}${p('Plans', 'Heading2')}<w:tbl><w:tr>${tc('Plan')}${tc('Year')}</w:tr><w:tr>${tc('Team')}${tc('$49')}</w:tr><w:tr>${tc('Life')}${tc('$99')}</w:tr></w:tbl>${p('Why now', 'Heading2')}<w:p>${run('Teams ask for ')}${run('one bill', true)}${run(' and a shared Planner.')}</w:p>${li('A seat per person')}${li('Remote access included')}</w:body></w:document>`;
  const styles = `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`;
  const numbering = `<w:numbering ${W}><w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num></w:numbering>`;
  return zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': doc, 'word/styles.xml': styles, 'word/numbering.xml': numbering });
}
function xlsx() {
  const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const names = ['Q1', 'Q2', 'Total'];
  const wb = `<workbook ${NS}><sheets>${names.map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`;
  const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
  const cell = (ref: string, v: string | number) => (typeof v === 'number' ? `<c r="${ref}"><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`);
  const sheet = (months: string[], data: [string, number[]][]) => `<worksheet><sheetData>${[['item', ...months], ...data.map(([k, ns]) => [k, ...ns]), ['Total', ...months.map((_, m) => data.reduce((a, [, ns]) => a + ns[m], 0))]].map((r, y) => `<row r="${y + 1}">${r.map((v, x) => cell(`${'ABCD'[x]}${y + 1}`, v as string | number)).join('')}</row>`).join('')}</sheetData></worksheet>`;
  const items: [string, number[]][] = [['Servers', [120, 120, 140]], ['Ads', [300, 250, 400]], ['Tools', [60, 60, 60]]];
  return zip({ 'xl/workbook.xml': wb, 'xl/_rels/workbook.xml.rels': rels, 'xl/worksheets/sheet1.xml': sheet(['Jan', 'Feb', 'Mar'], items), 'xl/worksheets/sheet2.xml': sheet(['Apr', 'May', 'Jun'], items), 'xl/worksheets/sheet3.xml': sheet(['Q1', 'Q2', 'H1'], items) });
}

const F = {
  md: put('docs/releases/v2.13.0.md', MD),
  html: put('site/hero.html', HTML),
  json: put('reports/usage.json', JSON_TEXT),
  csv: put('data/signups.csv', CSV),
  png: put('shots/sidebar-after.png', png(1440, 900)),
  pdf: put('docs/invoice-11.pdf', pdf()),
  docx: put('docs/pricing-proposal.docx', docx()),
  xlsx: put('data/budget-2027.xlsx', xlsx()),
  key: put('docs/launch-deck.key', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(64_000, 7)])),
  outside: put('Documents/invoice-11.pdf', pdf(), elsewhere),
  mmd: put('docs/release-flow.mmd', MMD),
  patch: put('out/fix-scroll.patch', PATCH),
  ts: put('src/view.ts', TS),
  log: put('out/e2e-full.log', Array.from({ length: 90_000 }, (_, i) => `10:41:${String(i % 60).padStart(2, '0')} run ${i + 1}/90000 chat-view.e2e ✓ opens on Terminal`).join('\n')),
  bin: put('out/weights.txt', Buffer.concat([Buffer.from('weights'), Buffer.alloc(4000, 0)])),
  gone: put('plans/draft.md', '# Draft'),
};

/* ---------- the server: a temporary home, a chat that reported them, a stand-in remote module ---------- */

let deviceOrigin = '';
const stand: ProModule = {
  version: 'stand-in',
  routes: () => ({}),
  mcpTools: () => [],
  ui: () => ({ js: 'window.choruspro={render(){}}', css: '' }),
  onChatEvent() {},
  dispose() {},
  remote: (_c, req) => (String(req.headers.cookie ?? '').includes('chorus_device=ok') ? { pass: true, origins: [deviceOrigin], device: 'proof-phone' } : { answer: { status: 401, headers: { 'content-type': 'text/plain' }, body: 'pair first' } }),
};
const store = new Store(project, { home });
const id = 't_files';
store.createThread({ id, title: 'Planner', agent: 'claude', cwd: project, project, native_session_id: 'proof-1', state: 'waiting' });
const t0 = Date.now() - 10 * 60_000;
const at = (min: number) => new Date(t0 + min * 60_000).toISOString();
const turn = store.db.prepare('INSERT OR REPLACE INTO turns (thread_id,seq,role,text,ts) VALUES (?,?,?,?,?)');
turn.run(id, 1, 'user', 'write the release notes for 2.13 and a short launch deck', at(0));
turn.run(id, 2, 'assistant', 'Done. The release notes are in the docs folder, and I updated the landing hero to match. The deck, the invoice and the data are below too.', at(1));
const rep: Record<string, number> = {};
const titles: Record<string, string> = { md: 'v2.13.0 release notes', html: 'Landing hero, version 3', key: 'Launch deck', json: 'Usage this week', csv: 'Sign-ups', png: 'Sidebar after the fix', pdf: 'Invoice, November (project copy)', docx: 'Pricing proposal', xlsx: 'Budget 2027', outside: 'Invoice, November', mmd: 'Release flow', patch: 'The fix, as a patch', ts: 'view.ts', log: 'Full e2e log', bin: 'model weights', gone: 'Draft plan' };
for (const k of Object.keys(titles)) rep[k] = store.reportArtifact(id, F[k as keyof typeof F], titles[k]).id;
store.db.prepare('UPDATE reported SET ts = ? WHERE thread_id = ?').run(at(2), id);
// an old chat's own folder holds a file too (a Files row with ?p=)
put('notes/summary.md', '# Summary\n\nThe week in one page.\n', store.artifactsDir(id));
store.scanArtifacts(id);
const proLoader: ProLoader = { dev: true, load: async () => stand, activate: async () => stand };
const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (_a, o) => ({ bin: process.execPath, args: [], cwd: o.cwd }) });
c.restore();
const srv = new ChorusServer({ controller: c, token: 'f'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 'proof', agents: [], ms: 1 }), proLoader });
const base = await srv.start(0);
const port = new URL(base).port;
deviceOrigin = `http://chorus-device.localhost:${port}`;
process.on('exit', () => (srv.close(), c.stop(), store.close()));

log(`serve ${base} · project ${project} · home ${home}`);

/* ---------- Chrome ---------- */

const chrome = await openChrome({ out: OUT, width: 1280, height: 800, log });
const { cdp, js, until, click, shot } = chrome;
let size: Size = 'desktop', scheme: Scheme = 'light';
const look = async (s: Size, sc: Scheme) => ((size = s), (scheme = sc), await setSize(chrome, s, sc));
const tag = () => `${size}-${scheme}`;

async function openApp(device: boolean) {
  await cdp('Network.enable');
  if (device) {
    await cdp('Network.setExtraHTTPHeaders', { headers: { 'x-forwarded-for': '100.64.0.2' } });
    await cdp('Network.setCookie', { name: 'chorus_device', value: 'ok', domain: 'chorus-device.localhost', path: '/' });
    await cdp('Page.navigate', { url: `${deviceOrigin}/#/chat/${id}` });
  } else {
    await cdp('Network.setExtraHTTPHeaders', { headers: {} });
    await cdp('Page.navigate', { url: `${base}/?token=${'f'.repeat(48)}#/chat/${id}` });
  }
  await until(() => js<boolean>(`!!document.querySelector('#chat-col')`), 15000);
  // the Chat view (a wider screen opens on the Terminal view)
  await js(`localStorage.setItem('chorus.chatView.${size}', 'chat')`);
  await cdp('Page.reload');
  await until(() => js<boolean>(`!!document.querySelector('.cv-card.art')`), 15000);
  await sleep(600);
}
const viewer = () => js<boolean>(`!!document.querySelector('.fv-wrap .fv')`);
const viewerText = () => js<string>(`document.querySelector('.fv-wrap')?.innerText ?? ''`);
const note = () => js<string>(`document.querySelector('.fv-note')?.innerText ?? ''`);
const toasts = () => js<string>(`[...document.querySelectorAll('#toasts .toast')].map(t => t.innerText).join(' | ')`);
const closeAll = async () => {
  await js(`document.querySelector('.fv-wrap') && document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await js(`document.querySelector('.fv-note [data-fv="got"]')?.click()`);
  await sleep(200);
};
/** a card's Open in the Chat view, by the file's report id */
const openCard = async (k: string, where: 'go' | 'card' = 'go') => {
  await closeAll();
  await js(`document.querySelector('.cv-card.art[data-arg="${rep[k]}"]')?.scrollIntoView({ block: 'center' })`);
  await sleep(250);
  return click(where === 'go' ? `.cv-card.art[data-arg="${rep[k]}"] .go` : `.cv-card.art[data-arg="${rep[k]}"] .ti`);
};
const openFiles = async () => {
  if (await js<boolean>(`!!document.querySelector('.drawer:not([hidden]) .art-row, .art-row')`)) return;
  if (size === 'phone') await click('.chat-tabs button, [data-act="chat-tab"]', /Files/);
  else await click('[data-act="side"][data-arg="artifacts"], [data-act="drawer"][data-arg="artifacts"]');
  await until(() => js<boolean>(`!!document.querySelector('.art-row')`), 5000);
};
const openRow = async (k: string) => {
  await closeAll();
  await openFiles();
  return click(`.art-row[data-arg="${rep[k]}"]`);
};

/* ---------- on the Mac: desktop ---------- */

log('\n— on the Mac, desktop width —');
await look('desktop', 'light');
await openApp(false);
await shot(`scene1-cards-${tag()}`, 'Scene 1: the cards in the chat, one ↗ Open each');
check('every file card has one ↗ Open', await js<boolean>(`document.querySelectorAll('.cv-card.art').length >= 15 && [...document.querySelectorAll('.cv-card.art')].every(c => c.querySelectorAll('.go').length === 1 && /Open/.test(c.querySelector('.go').textContent))`));
check("the Keynote card says Chorus can't show it, with its size", await until(async () => /KB · Chorus can't show Keynote files/.test(await js<string>(`document.querySelector('.cv-card.art[data-arg="${rep.key}"]')?.innerText ?? ''`)), 4000));

await openCard('md');
check('Open on the markdown card opens the viewer in Preview', (await until(viewer, 4000)) && (await js<boolean>(`document.querySelector('.fv-modes button.on')?.dataset.m === 'pv'`)));
await until(() => js<boolean>(`!!document.querySelector('.fv-b .cv-dia.ok svg')`), 6000);
await shot(`scene2-preview-md-${tag()}`, 'Scene 2: Preview of a markdown file (table, mermaid drawn)');
await click('.fv-modes button', /Raw/);
check('Raw: line numbers, wrap on for prose', await js<boolean>(`!!document.querySelector('.fv-raw.wrap > div') && /lines/.test(document.querySelector('.fv-h .nm span').textContent)`));
await shot(`scene3-raw-md-${tag()}`, 'Scene 3: Raw, with Wrap on');
await closeAll();

await openCard('html', 'card');
check('a click on the HTML card (not its button) opens the viewer', await until(viewer, 4000));
await until(() => js<boolean>(`!!document.querySelector('.fv-frame iframe')`), 3000);
await sleep(600);
check('the page is in a sandboxed frame; its script did not run', await js<boolean>(`document.querySelector('.fv-frame iframe').getAttribute('sandbox') === ''`));
await shot(`scene4-html-preview-${tag()}`, 'Scene 4: HTML in Preview, sandboxed; Desktop | Phone');
await click('.fv-width button', /Phone/);
await shot(`scene4-html-phone-width-${tag()}`, 'Scene 4: Phone width');
await click('.fv-modes button', /Raw/);
await shot(`scene4-html-raw-${tag()}`, 'Scene 4: HTML in Raw');

for (const [k, label] of [['json', 'JSON tree'], ['csv', 'CSV table (1,204 rows: first 1,000)'], ['png', 'image on a checkerboard'], ['pdf', 'PDF'], ['docx', 'Word, read by Chorus'], ['xlsx', 'Excel, a tab per sheet'], ['mmd', 'mermaid file'], ['patch', 'patch'], ['ts', 'code: Raw only']] as const) {
  await openCard(k);
  const ok = await until(viewer, 4000);
  await sleep(k === 'pdf' || k === 'mmd' ? 1500 : 500);
  check(`${k}: opens in the viewer`, ok, await viewerText());
  if (k === 'xlsx') await click('.fv-tabs button', /Q2/);
  await shot(`scene5-${k}-${tag()}`, `Scene 5: ${label}`);
}
check('code has no Preview | Raw switch', !(await js<boolean>(`!!document.querySelector('.fv-modes')`)));
check('image, PDF, Word and Excel have Raw off', await (async () => {
  for (const k of ['png', 'pdf', 'docx', 'xlsx']) {
    await openCard(k);
    await until(viewer, 3000);
    if (!(await js<boolean>(`document.querySelector('.fv-modes button[data-m="raw"]')?.disabled === true`))) return false;
  }
  return true;
})());

await openCard('key');
check('on the Mac, a Keynote deck goes to the Mac\'s own app, with a note', await until(async () => /Opened launch-deck\.key/.test(await toasts()), 3000), await toasts());
check('…and no viewer', !(await viewer()));
await shot(`scene6-mac-open-${tag()}`, "Scene 6: a file Chorus can't show opens in the Mac's own app");
await openCard('log');
await until(viewer, 3000);
check('too big: the first 2 MB and a strip', /Showing the first 2 MB of/.test(await viewerText()));
await shot(`scene6-big-${tag()}`, 'Scene 6: too big, the strip');
fs.rmSync(F.gone); // reported, then the agent removed it (its card is still in the chat)
await openCard('gone');
await until(viewer, 3000);
check('gone: said inside the viewer', /no longer there/.test(await viewerText()));
await shot(`scene6-gone-${tag()}`, 'Scene 6: gone');
await openCard('bin');
check('on the Mac, a .txt that is binary goes to its app', await until(async () => /Opened weights\.txt/.test(await toasts()), 3000));
await closeAll();

// the Files list: the same Open, the same viewer, the row marked
await openRow('md');
check('Files row: the same viewer, in Preview', (await until(viewer, 4000)) && (await js<boolean>(`document.querySelector('.fv-modes button.on')?.dataset.m === 'pv'`)));
check('…and its row is marked "open now"', await until(() => js<boolean>(`/open now/.test(document.querySelector('.art-row.sel')?.innerText ?? '')`), 2000));
await shot(`scene1-files-list-${tag()}`, 'Scene 1 (below): opened from the Files list; the list stays beside it, the row marked');
check('Files rows: no "Open on the Mac" badge, one ↗ Open each', await js<boolean>(`!document.body.innerText.includes('Open on the Mac') && [...document.querySelectorAll('.art-row')].every(r => /Open/.test(r.querySelector('.art-go')?.textContent ?? ''))`));
await click('.art-row', /summary\.md/);
check("an old chat's folder file (?p=) opens the same way", await until(async () => /The week in one page/.test(await viewerText()), 3000));
await closeAll();
await js(`document.querySelectorAll('#toasts .toast').forEach(t => t.remove())`);
await openRow('key');
check('Files row on a Keynote deck: the Mac\'s app, as the card', await until(async () => /Opened launch-deck\.key/.test(await toasts()), 3000), await toasts());

// live: the agent edits the open file
await closeAll();
await openCard('md');
await until(viewer, 3000);
fs.appendFileSync(F.md, '\n## Added while open\n\nThis line came in while the viewer was open.\n');
fs.utimesSync(F.md, new Date(), new Date(Date.now() + 2000));
check('live: the open file reloads in place when the agent edits it', await until(async () => /Added while open/.test(await viewerText()), 12000));
await closeAll();

/* ---------- dark, desktop ---------- */
log('\n— dark —');
await look('desktop', 'dark');
await sleep(300);
await shot(`scene1-cards-${tag()}`, 'Scene 1, dark');
await openCard('md');
await until(viewer, 3000);
await sleep(800);
await shot(`scene2-preview-md-${tag()}`, 'Scene 2, dark');
await click('.fv-modes button', /Raw/);
await shot(`scene3-raw-md-${tag()}`, 'Scene 3, dark');
for (const k of ['json', 'xlsx', 'patch']) {
  await openCard(k);
  await until(viewer, 3000);
  await shot(`scene5-${k}-${tag()}`, `Scene 5, dark: ${k}`);
}
await closeAll();

/* ---------- a phone (375 wide) on the Mac ---------- */
log('\n— phone width —');
await cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
await cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
size = 'phone';
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
scheme = 'light';
await openApp(false);
await openCard('md');
check('phone: full screen, Preview first', (await until(viewer, 4000)) && (await js<boolean>(`document.querySelector('.fv-wrap').classList.contains('phone')`)));
await sleep(600);
await shot(`scene7B-phone-preview-mac-${tag()}`, 'Phone width on the Mac: full screen, Preview | Raw at the top');
await closeAll();

/* ---------- as a device on the private link ---------- */
log('\n— remotely (a device on the private link) —');
await openApp(true);
check('the device draws no Mac-only text', !(await js<string>('document.body.innerText')).includes('Open on the Mac'));
await shot(`scene7A-cards-remote-${tag()}`, 'Scene 7 A: the cards, remotely');
await openCard('md');
check('remotely, a file it can show opens in the viewer (B)', await until(viewer, 4000));
await sleep(600);
await shot(`scene7B-preview-remote-${tag()}`, 'Scene 7 B: a file it can show, remotely (full screen)');
await click('.fv-modes button', /Raw/);
await shot(`scene7B-raw-remote-${tag()}`, 'Scene 7 B: Raw, remotely');
await openCard('key');
check('remotely, a Keynote deck: "Keynote files can\'t be opened here" (C)', await until(async () => /Keynote files can't be opened here/.test(await note()), 3000), await note());
await shot(`scene7C-cant-open-${tag()}`, "Scene 7 C: a type it can't show");
await openCard('outside');
check('remotely, a file outside the project: "This file stays on your Mac" (D)', await until(async () => /This file stays on your Mac/.test(await note()), 3000), await note());
await shot(`scene7D-stays-on-mac-${tag()}`, 'Scene 7 D: a file outside the project');
await closeAll();
await openCard('bin');
check('remotely, a .txt that is binary: "This file isn\'t text" in the viewer', await until(async () => /isn't text/.test(await viewerText()), 3000));
await shot(`scene6-binary-remote-${tag()}`, "Scene 6: not text (shows only remotely)");
await openCard('pdf');
await until(viewer, 3000);
await sleep(1200);
await shot(`scene7-pdf-remote-${tag()}`, 'A PDF inside the project, remotely');
await openRow('outside');
check('the Files tab remotely: the same message as the card (E → D)', await until(async () => /This file stays on your Mac/.test(await note()), 3000));
await closeAll();
await openFiles();
await shot(`scene7E-files-tab-remote-${tag()}`, 'Scene 7 E: the Files tab remotely, every row the same Open');
await openRow('key');
check('the Files tab remotely: Keynote → the same message as the card (E → C)', await until(async () => /Keynote files can't be opened here/.test(await note()), 3000));
await closeAll();
await openRow('docx');
check('the Files tab remotely: Word opens in the viewer', await until(async () => /Pricing proposal/.test(await viewerText()), 3000));
await shot(`scene7-docx-remote-${tag()}`, 'Word, remotely (read on the Mac, sent as a page)');
await closeAll();

// remotely at desktop width: the window and the small dialog
await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await cdp('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
size = 'desktop';
await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
scheme = 'dark';
await openApp(true);
await openCard('key');
await until(async () => /can't be opened here/.test(await note()), 3000);
await shot(`scene7-dialog-remote-${tag()}`, 'Remotely on a wider screen: the message is a small dialog');
await closeAll();
await openCard('csv');
await until(viewer, 3000);
await shot(`scene7-csv-remote-${tag()}`, 'Remotely on a wider screen: the viewer is a window');
await closeAll();

const bad = results.filter(r => !r.ok);
log(`\n${results.length - bad.length}/${results.length} checks passed · pictures in ${path.relative(ROOT, OUT)}`);
fs.writeFileSync(path.join(OUT, 'checks.txt'), results.map(r => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`).join('\n') + '\n');
chrome.close();
process.exit(bad.length ? 1 : 0);
