#!/usr/bin/env node
// Report issue with screenshots, sent to the Chorus team's admin page (plan 2026-11-13), and the Welcome's note on which AI CLI
// fits best (plan 2026-11-14). Drives the desktop page in headless Chrome over a fresh Chorus home, with notifications off, and
// saves each screen beside its scene of ui-mockup-v3.html in .chorus/proof/<branch>/. No model calls: the Doctor only runs its
// short check of the CLIs on this Mac.
//
//   node test/smoke/proof-report-images.ts [--out <dir>] [--admin <chorus-admin checkout>]
//
// Without --admin a fake backend in this process answers POST /v1/reports and PUT /v1/reports/<id>/images/<n>. With --admin the
// chorus-admin server of that checkout runs locally (its in-memory store, never the live one) and the report and its image are
// read back through its admin route.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openChrome, sleep } from './chrome.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'src/cli/index.ts');
const argv = process.argv.slice(2);
const arg = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const OUT = path.resolve(arg('--out') ?? path.join(ROOT, '.chorus/proof/report-images-run'));
const ADMIN = arg('--admin');
const MOCK = path.join(os.homedir(), 'chorus-workspace/mockups/ui-mockup-v3.html');
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${detail}` : ''}`);
  return ok;
}

/* ---------- the backend: a fake one here, or chorus-admin's own server run locally ---------- */
interface Got { body: any; images: { n: string; type: string; bytes: number; id: string; key: string; head: string }[] }
const got: Got[] = [];
let down = false;
let admin: { base: string; token: string; proc?: ChildProcess } | undefined;
let backend: string;
const sockets = new Set<net.Socket>();
if (ADMIN) {
  admin = await startAdmin(ADMIN);
  backend = admin.base;
} else {
  const fake = http.createServer((req, res) => {
    if (down) return void req.socket.destroy();
    const parts: Buffer[] = [];
    req.on('data', d => parts.push(d));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      const json = (code: number, v: object) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
      if (req.method === 'POST' && req.url === '/v1/reports') {
        const b = JSON.parse(body.toString('utf8'));
        got.push({ body: b, images: [] });
        return json(201, { id: `rep${got.length}`, ref: 'R-7K2F9' });
      }
      const m = req.url?.match(/^\/v1\/reports\/rep(\d+)\/images\/(\d+)$/);
      if (req.method === 'PUT' && m) {
        got[Number(m[1]) - 1]?.images.push({ n: m[2], type: String(req.headers['content-type']), bytes: body.length, id: String(req.headers['x-installation-id']), key: String(req.headers['x-installation-key'] ?? '').slice(0, 4), head: body.subarray(0, 4).toString('hex') });
        return json(200, { ok: true });
      }
      json(404, { error: 'not found' });
    });
  });
  fake.on('connection', s => (sockets.add(s), s.on('close', () => sockets.delete(s))));
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
  backend = `http://127.0.0.1:${(fake.address() as net.AddressInfo).port}`;
}

/** chorus-admin's local run from a checkout (test/local-admin.mjs: its API with the in-memory store and bucket, a stand-in admin
 *  sign-in, four sample reports); never the live backend. */
async function startAdmin(dir: string) {
  const free = () => new Promise<number>(r => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
  const [api, web] = [await free(), await free()];
  const env = { ...process.env, API_PORT: String(api), WEB_PORT: String(web) } as Record<string, string>;
  for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIRESTORE_EMULATOR_HOST']) delete env[k];
  const p = spawn(process.execPath, [path.join(dir, 'test/local-admin.mjs')], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [p.stdout!, p.stderr!]) s.on('data', d => fs.appendFileSync(path.join(OUT, 'admin.log'), d));
  await new Promise<void>((resolve, reject) => {
    let buf = '';
    p.stdout!.on('data', d => ((buf += d), /API: http/.test(buf) && resolve()));
    p.on('exit', c => reject(new Error(`chorus-admin's local run exited ${c}: ${buf}`)));
    setTimeout(() => reject(new Error(`chorus-admin's local run did not start: ${buf}`)), 30_000);
  });
  console.log(`chorus-admin local run: API http://127.0.0.1:${api} · admin http://127.0.0.1:${web}/admin/`);
  return { base: `http://127.0.0.1:${api}`, token: 'local-admin', proc: p };
}

/* ---------- chorus serve over a fresh home, notifications off ---------- */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-report-'));
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-report-proj-')));
const env = { ...process.env, CHORUS_NO_OPEN: '1', CHORUS_HOME: path.join(home, 'chorus'), CHORUS_DOCTOR_HOME: home, CHORUS_NOTIFICATIONS: '0', CHORUS_REPORTS_API: backend } as Record<string, string>;
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];
let serve: ChildProcess | undefined;
function startServe(): Promise<string> {
  const p = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  serve = p;
  p.stderr!.on('data', d => fs.appendFileSync(path.join(OUT, 'serve.log'), d));
  return new Promise((resolve, reject) => {
    let buf = '';
    p.stdout!.on('data', d => {
      buf += d;
      const m = buf.match(/chorus serve: (\S+)/);
      if (m) resolve(m[1]);
    });
    p.on('exit', c => reject(new Error(`serve exited ${c}: ${buf}`)));
  });
}
process.on('exit', () => (serve?.kill('SIGTERM'), admin?.proc?.kill('SIGTERM')));

const chrome = await openChrome({ out: OUT, width: 1440, height: 1000, log: s => console.log(s) });
const { cdp, js, shot, until, click } = chrome;
const pairs: [string, string, string][] = [];

console.log('Welcome: which AI CLI fits best');
await cdp('Page.navigate', { url: await startServe() });
await until(() => js<boolean>('chorus.S.view.name === "welcome" && !!document.querySelector(".wl-strip")'), 15_000);
await sleep(1500);
const strip = await js<string>('document.querySelector(".page.welcome .lead + .wl-strip")?.textContent ?? ""');
check('one strip under the lead, with the three marks and the words of the mockup', strip.includes('Thank you for supporting Chorus. It works best with C Claude Code today: every feature is built and tested with it first. X Codex and A Antigravity work too, and we\'re still improving them. Use any of them, and switch at any time.') && (await js<number>('document.querySelectorAll(".wl-strip .badge.mini").length')) === 3, strip);
await shot('app-welcome_strip', 'Welcome: which CLI fits best (strip)');
pairs.push(['app-welcome_strip', 'mock-welcome_strip', 'Welcome: which CLI fits best (strip)']);

console.log('New chat: the faint line with Codex picked');
await click('.plan-card button', /Keep Community/);
await sleep(1500);
if (await js<boolean>('!!document.querySelector("#doctor-pop")')) (await click('#fr-foot button', /start using Chorus|Continue/), await sleep(800));
await js(`chorus.go({ name: 'new' })`);
await until(() => js<boolean>('!!document.querySelector("#nc-prompt")'), 10_000);
const hint = () => js<string>('document.querySelector(".nc-hint")?.textContent ?? ""');
const claudeHint = await hint();
/** the first picker (the agent, or with the optional module who), then the agent's row */
const pick = async (agent: string) => (await click('.nc-left .nc-pk'), await click(`.nc-menu [data-act="nc-agent"][data-arg="${agent}"]`), await sleep(500));
await pick('codex');
await sleep(500);
const codexHint = await hint();
await shot('app-new', 'New chat with Codex picked: the faint line');
pairs.push(['app-new', 'mock-new', 'New chat with Codex picked (UC-01)']);
await pick('agy');
await sleep(400);
const agyHint = await hint();
check('Codex / Antigravity picked: the faint line says it works and Claude Code works best; Claude Code picked: the usual hint',
  codexHint === "Codex works, and we're still improving it. Claude Code works best today." && agyHint === "Antigravity works, and we're still improving it. Claude Code works best today." && /you talk to the agent in its own screen/.test(claudeHint), JSON.stringify({ claudeHint, codexHint, agyHint }));
await pick('claude');

console.log('Report issue: screenshots, details, not reached, sent');
await js(`chorus.go({ name: 'doctor' })`);
await sleep(1000);
await click('#view button', /Report issue/);
await until(() => js<boolean>('!!document.querySelector("#rp-shots")'), 30_000);
const form = await js<{ type: boolean; github: boolean; chips: string[] }>(`({ type: !!document.querySelector('#doc-issue-kind'), github: /github/i.test(document.querySelector('#doc-report-pop').textContent), chips: [...document.querySelectorAll('.rp-chip')].map(c => c.textContent) })`);
check('no Type field, no words about GitHub; the setup chips (app and channel, core, install, OS and arch, each CLI)', !form.type && !form.github && form.chips.length === 7 && /^Chorus .+ · (preview|production|dev)$/.test(form.chips[0]) && form.chips.some(c => /^Claude Code/.test(c)), JSON.stringify(form));
// two screenshots: a large one by the file picker (made smaller), a small one pasted (kept as it is)
const big = path.join(OUT, 'doctor-page.png');
const png = (w: number, h: number, noise: number) => js<string>(`(() => { const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h}; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, ${w}, ${h}); gr.addColorStop(0, '#DCE7F5'); gr.addColorStop(1, '#F4E6D8'); g.fillStyle = gr; g.fillRect(0, 0, ${w}, ${h}); for (let i = 0; i < ${noise}; i++) { g.fillStyle = 'hsl(' + (i * 37 % 360) + ',60%,' + (30 + i % 50) + '%)'; g.fillRect((i * 7919) % ${w}, (i * 104729) % ${h}, 3 + i % 40, 2 + i % 9); } g.fillStyle = '#141413'; g.font = '48px sans-serif'; g.fillText('Doctor', 60, 90); return c.toDataURL('image/png').split(',')[1]; })()`);
fs.writeFileSync(big, Buffer.from(await png(3024, 1964, 60_000), 'base64'));
const bigSize = fs.statSync(big).size;
const { result } = await cdp('Runtime.evaluate', { expression: 'document.querySelector("#rp-file")' });
await cdp('DOM.setFileInputFiles', { files: [big], objectId: result.objectId });
await until(() => js<boolean>('document.querySelectorAll(".rp-shot").length === 1'), 15_000);
const small = await png(1280, 800, 300);
await js(`(() => { const b = Uint8Array.from(atob(${JSON.stringify(small)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([b], 'Screenshot 14.02.31.png', { type: 'image/png' })); document.querySelector('#doc-issue-what').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); })()`);
await until(() => js<boolean>('document.querySelectorAll(".rp-shot").length === 2'), 15_000);
const shots = await js<{ name: string; size: number; type: string; w: number; scaled: boolean }[]>(`Promise.all(chorus.S.report.shots.map(async x => { const b = await createImageBitmap(x.blob); return { name: x.name, size: x.blob.size, type: x.type, w: Math.max(b.width, b.height), scaled: x.scaled }; }))`);
check(`the file picker's ${(bigSize / 1e6).toFixed(1)} MB PNG is made smaller (≤ 1 MB, longest side ≤ 2000 px); the pasted small PNG is kept`, shots.length === 2 && shots[0].scaled && shots[0].size <= 1_000_000 && shots[0].w <= 2000 && !shots[1].scaled && shots[1].type === 'image/png', JSON.stringify(shots));
await js(`document.querySelector('#rp-shots').scrollIntoView({ block: 'center' })`);
await shot('app-doc_report_shots', 'Report issue: 2 screenshots attached');
pairs.push(['app-doc_report_shots', 'mock-doc_report_shots', 'Report issue: 2 screenshots attached (UC-13)']);
// a third, then remove it: removable, and the count follows
await js(`(() => { const b = Uint8Array.from(atob(${JSON.stringify(small)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([b], 'third.png', { type: 'image/png' })); document.querySelector('#doc-report-pop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
await until(() => js<boolean>('document.querySelectorAll(".rp-shot").length === 3'), 15_000);
const dropped = await js<string>('document.querySelector("#rp-count").textContent');
await click('.rp-shot:nth-child(3) .rp-rm');
check('a dropped image is added (3 of 4) and × removes it', dropped === '3 of 4' && (await js<string>('document.querySelector("#rp-count").textContent')) === '2 of 4');

await click('#doc-report-pop details summary');
await sleep(300);
const details = await js<string>('document.querySelector("#doc-issue-body").value');
const want = ['### Chorus', '- App: Chorus ', 'chorus-core ', '### This machine', '| CLI | Installed | State | Newest tested | Newest release | Install | Login |', '### Detailed tests on file', '### Use'];
const user = os.userInfo().username, hostName = os.hostname();
check('All details: the sections of the mockup, nothing that names the machine or the person', want.every(w => details.includes(w)) && !details.includes(hostName) && !new RegExp(`\\b${user}\\b`).test(details) && !details.includes(os.homedir()), want.filter(w => !details.includes(w)).join(', '));
await js(`document.querySelector('#doc-report-pop details').scrollIntoView({ block: 'start' })`);
await shot('app-doc_report_details', 'Report issue: all details open');
pairs.push(['app-doc_report_details', 'mock-doc_report_details', 'Report issue: all details open (UC-13)']);
await click('#doc-report-pop details summary');

await click('#doc-issue-title');
await chrome.typeLine('Codex approval prompt not seen', false);
await click('#doc-issue-what');
await chrome.typeLine('Started a Codex chat, it asked to run npm test, Chorus showed nothing.', false);
await click('#doc-issue-email');
await chrome.typeLine('me@example.com', false);
down = true;
for (const s of sockets) s.destroy();
const adminDown = admin?.proc;
if (adminDown) adminDown.kill('SIGSTOP');
await click('#rp-send');
await until(() => js<boolean>('!document.querySelector("#rp-error").hidden'), 40_000);
const off = await js<{ err: string; btn: string; title: string; shots: number }>(`({ err: document.querySelector('#rp-error').textContent, btn: document.querySelector('#rp-send').textContent, title: document.querySelector('#doc-issue-title').value, shots: document.querySelectorAll('.rp-shot').length })`);
check('the service not reached: the dialog stays, says so, Try again; nothing is lost', /could not be reached\. Nothing is lost/.test(off.err) && off.btn === 'Try again' && off.title === 'Codex approval prompt not seen' && off.shots === 2, JSON.stringify(off));
await shot('app-doc_report_offline', 'Report issue: service not reached');
pairs.push(['app-doc_report_offline', 'mock-doc_report_offline', 'Report issue: service not reached (UC-13)']);

down = false;
if (adminDown) adminDown.kill('SIGCONT');
await click('#rp-send', /Try again/);
await until(() => js<boolean>('!!document.querySelector("#rp-ref")'), 40_000);
const ref = await js<string>('document.querySelector("#rp-ref").textContent');
await click('.rp-ref button', /Copy/);
await shot('app-doc_report_sent', 'Report issue: sent, with reference');
pairs.push(['app-doc_report_sent', 'mock-doc_report_sent', 'Report issue: sent, with reference (UC-13)']);
const sentText = await js<string>('document.querySelector("#doc-report-pop").textContent');
check('sent: the reference with Copy, and the number of screenshots', /^R-[A-Z0-9]{4,}$/.test(ref) && /with 2 screenshots/.test(sentText), `${ref} · ${sentText}`);

if (!admin) {
  const r = got.at(-1);
  const b = r?.body ?? {};
  check('the backend got one report: installation ID and key, title, what, details, email, setup, platform, app version, 2 images',
    got.length === 1 && typeof b.installationId === 'string' && b.installationKey?.length > 20 && b.title === 'Codex approval prompt not seen' && /npm test/.test(b.what) && b.details.includes('### Chorus') && b.email === 'me@example.com' && b.setup?.channel && b.setup?.clis?.some((c: any) => c.id === 'claude') && b.platform === process.platform && b.appVersion && b.imageCount === 2, JSON.stringify({ n: got.length, b: { ...b, details: `${String(b.details).length} chars`, installationKey: '…' } }));
  check('then each image by PUT /v1/reports/<id>/images/<n>: its type, ≤ 1.5 MB, the installation ID and key in headers',
    r?.images.length === 2 && r.images.every((x, i) => x.n === String(i + 1) && /^image\/(png|jpeg|webp)$/.test(x.type) && x.bytes <= 1_500_000 && x.id === b.installationId && x.key.length === 4), JSON.stringify(r?.images));
  check('the installation ID is the notifications\' file, made though notifications are off', fs.existsSync(path.join(home, 'chorus/notifications/inbox.json')) && JSON.parse(fs.readFileSync(path.join(home, 'chorus/notifications/inbox.json'), 'utf8')).installationId === b.installationId);
} else {
  // read it back through the admin route
  const h = { authorization: `Bearer ${admin.token}` };
  const list = (await (await fetch(`${admin.base}/admin/reports`, { headers: h })).json()) as any;
  const item = (list.reports ?? []).find((x: any) => x.ref === ref);
  const rep = item ? ((await (await fetch(`${admin.base}/admin/reports/${encodeURIComponent(item.id)}`, { headers: h })).json()) as any) : undefined;
  const img = item ? await fetch(`${admin.base}/admin/reports/${encodeURIComponent(item.id)}/images/1`, { headers: h }) : undefined;
  const bytes = img?.ok ? Buffer.from(await img.arrayBuffer()) : Buffer.alloc(0);
  fs.writeFileSync(path.join(OUT, 'admin-report.json'), JSON.stringify({ list: { ...list, reports: undefined }, item, report: { ...rep, details: `${String(rep?.details ?? '').length} chars` } }, null, 2));
  check('chorus-admin (local run) stored the report: listed by its reference, with its text, email and setup', !!item && rep?.title === 'Codex approval prompt not seen' && /npm test/.test(rep?.what ?? '') && rep?.email === 'me@example.com' && rep?.setup?.clis?.length === 3 && rep?.images?.length === 2, JSON.stringify({ item, keys: Object.keys(rep ?? {}) }));
  check('and its image, read through the admin route', !!img?.ok && bytes.length > 1000 && /^image\//.test(img.headers.get('content-type') ?? ''), `${img?.status} ${img?.headers.get('content-type')} ${bytes.length}`);
  if (bytes.length) fs.writeFileSync(path.join(OUT, 'admin-image-1'), bytes);
}

/* ---------- the mockup's scenes, the same size ---------- */
const scene = async (id: string, slug: string, then = '') => {
  await cdp('Page.navigate', { url: `file://${MOCK}` });
  await until(() => js('!!document.querySelector("#scenarios button")'), 8000);
  await js(`document.querySelector('#scenarios [data-scn="${id}"]')?.click()`);
  await sleep(1200);
  if (then) (await js(then), await sleep(600));
  await js(`document.getElementById('window')?.scrollIntoView()`);
  await shot(slug, slug);
};
await scene('welcome_strip', 'mock-welcome_strip');
await scene('new', 'mock-new', `(async () => { document.querySelector('[data-a="nc-menu"][data-arg="who"], [data-a="nc-menu"][data-arg="agent"]')?.click(); await new Promise(r => setTimeout(r, 300)); document.querySelector('[data-a="nc-agent"][data-arg="codex"]')?.click(); })()`);
for (const id of ['doc_report_shots', 'doc_report_details', 'doc_report_offline', 'doc_report_sent']) await scene(id, `mock-${id}`);

/* ---------- each screen beside its scene ---------- */
const branch = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const dest = path.join(ROOT, '.chorus/proof', branch);
fs.mkdirSync(dest, { recursive: true });
const file = (slug: string) => fs.readdirSync(OUT).filter(f => f.replace(/^\d+-/, '') === `${slug}.png`).sort().at(-1);
for (const [a, m, label] of pairs) {
  const fa = file(a), fm = file(m);
  if (!fa || !fm) continue;
  fs.copyFileSync(path.join(OUT, fa), path.join(dest, `${a}.png`));
  fs.copyFileSync(path.join(OUT, fm), path.join(dest, `${m}.png`));
  const page = path.join(dest, 'pair.html');
  fs.writeFileSync(page, `<!doctype html><body style="margin:0;font:600 15px system-ui;background:#ddd"><div style="padding:8px 14px">${label}: the app (left) · the mockup (right)</div><div style="display:flex;gap:12px;padding:0 12px;align-items:flex-start"><img src="${a}.png" style="width:1440px"><img src="${m}.png" style="width:1440px"></div></body>`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 2920, height: 1050, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: `file://${page}` });
  await sleep(700);
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(dest, `pair-${a.replace(/^app-/, '')}.png`), Buffer.from(data, 'base64'));
  fs.rmSync(page, { force: true });
}
check('each screen saved beside its mockup scene', pairs.every(([a]) => fs.existsSync(path.join(dest, `pair-${a.replace(/^app-/, '')}.png`))), dest);

chrome.close();
serve?.kill('SIGTERM');
admin?.proc?.kill('SIGTERM');
console.log(`${failed ? `${failed} FAILED` : 'all passed'} · screenshots in ${OUT}, pairs in ${dest}`);
process.exit(failed ? 1 : 0);
