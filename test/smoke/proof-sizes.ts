#!/usr/bin/env node
// `npm run proof:desktop -- --sizes` (docs/features/responsive.md): every screen of the desktop page at a phone (390 × 844), a tablet
// (820 × 1180) and a desktop (1280 × 800), in light and dark, with fake agents (no model calls). On each screen: the page never
// scrolls sideways, no visible control is cut off by the screen, and on touch every button, link and field is at least 36 px tall
// (list, sheet and tab-bar rows 44) and every text field uses 16 px text. The desktop screens are also taken from the last
// release (--before <ref>, the newest vX.Y.Z tag by default) and compared pixel by pixel: the desktop must look as it did.
// The optional module's screens run in chorus-core's harness with Pro unlocked (its test/pro-e2e/checks/sizes.ts), with these checks.
//
//   node test/smoke/proof-desktop.ts --sizes [--out <dir>] [--before <ref>|none] [--open]
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/core/store.ts';
import { openChrome, sleep } from './chrome.ts';
import { openReport, writeReport } from './report.ts';
import { pixelDiff, problems, setSize, SIZES, summary, type Scheme, type Size } from './sizes.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const opt = (n: string, d = '') => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const branch = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'detached';
const OUT = path.resolve(opt('out') || path.join(ROOT, '.chorus/proof', branch, 'sizes'));
const newestRelease = spawnSync('git', ['tag', '-l', 'v*', '--sort=-v:refname'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').find(t => /^v\d+\.\d+\.\d+$/.test(t)) ?? '';
const BEFORE = opt('before', newestRelease);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const log = (s: string) => console.log(s);
const results: { ok: boolean; name: string; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ ok, name, detail });
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail.slice(0, 400)})`}`);
  return ok;
}

/* ---------- three projects, chats with records, skills: the same data for the release and for this branch ---------- */

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const shop = tmp('cake-shop-');
const api = tmp('orders-api-');
const site = tmp('landing-page-');
for (const p of [shop, api, site]) spawnSync('git', ['init', '-q'], { cwd: p });
const home = tmp('chorus-sizes-home-');
const userHome = tmp('chorus-sizes-uh-');
fs.mkdirSync(path.join(userHome, '.claude/skills/release-notes'), { recursive: true });
fs.writeFileSync(path.join(userHome, '.claude/skills/release-notes/SKILL.md'), '---\nname: release-notes\ndescription: Draft release notes from the commit log\n---\nbody\n');
fs.mkdirSync(path.join(shop, '.chorus/skills/cake-pricing'), { recursive: true });
fs.writeFileSync(path.join(shop, '.chorus/skills/cake-pricing/SKILL.md'), '---\nname: cake-pricing\ndescription: Price a cake from its size, layers and toppings, using the table in pricing.md\n---\nUse the table.\n');
{
  const s = new Store(shop, { home });
  const seed = (id: string, title: string, agent: 'claude' | 'codex' | 'agy', cwd: string, turns: [string, string], files: string[]) => {
    s.createThread({ id, title, agent, cwd, project: cwd, native_session_id: `${id}-session`, state: 'waiting' });
    s.recordSession(id, { agent, turns: [{ seq: 1, role: 'user', text: turns[0] }, { seq: 2, role: 'assistant', text: turns[1] }], toolCalls: files.map((f, i) => ({ id: `${id}-w${i}`, turnSeq: 1, tool: 'Write', target: path.join(cwd, f), status: 'ok' as const })), usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 0 } });
  };
  seed('t_export', 'Fix the export zip for long chats', 'codex', shop, ['The export runs out of memory on long chats', 'Streams files now; 400 chats export in 6 s.'], ['src/export/zip.ts']);
  seed('t_cart', 'Cart total rounds the wrong way for discounts', 'claude', shop, ['The cart total is off by a cent with a 15% discount', 'Rounding happens once, at the end; tests added.'], ['src/cart/total.ts', 'test/cart.test.ts']);
  seed('t_limit', 'Rate limiter for the public API', 'codex', api, ['Add a per-key rate limit to the public API', 'Limiter in place; 40 tests pass.'], ['src/limit.ts']);
  seed('t_hero', 'Landing page hero copy', 'agy', site, ['Write three versions of the hero line', 'Three versions in hero.md.'], ['hero.md']);
  s.close();
}
const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORUS_HOME: home, CHORUS_SKILLS_HOME: userHome, CHORUS_NO_OPEN: '1', CHORUS_NOTIFICATIONS: '0', CHORUS_UPDATES: '0', CHORUS_FAKE_AGENTS: '1', CHORUS_PROJECT: shop,
  // no licence server: no Community join and no released paid bundle here (chorus-core's harness runs the Pro screens, unlocked)
  CHORUS_LICENCE_URL: 'http://127.0.0.1:9' };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];

/* ---------- chorus serve: this checkout, or the release's ---------- */

let serve: ChildProcess | undefined;
function startServe(root: string): Promise<string> {
  const p = spawn(process.execPath, [path.join(root, 'src/cli/index.ts'), 'serve', '--port', '0'], { cwd: shop, env, stdio: ['ignore', 'pipe', 'pipe'] });
  serve = p;
  p.stderr!.on('data', d => fs.appendFileSync(path.join(OUT, 'serve.log'), d));
  return new Promise((resolve, reject) => {
    let buf = '';
    p.stdout!.on('data', d => {
      buf += d;
      const m = buf.match(/chorus serve: (\S+)/);
      if (m) resolve(m[1]);
    });
    p.once('exit', c => reject(new Error(`serve exited ${c}: ${buf}`)));
  });
}
async function stopServe() {
  if (!serve || serve.exitCode !== null) return;
  const gone = new Promise(r => serve!.once('exit', r));
  serve.kill('SIGTERM');
  await gone;
}
process.on('exit', () => serve?.kill('SIGTERM'));

const chrome = await openChrome({ out: OUT, width: 1280, height: 800, log });
const { cdp, js, until, click, has } = chrome;
const shots: { file: string; caption: string }[] = [];
let n = 0;
async function shot(slug: string, caption: string) {
  await sleep(300);
  const file = `${String(++n).padStart(3, '0')}-${slug}.png`;
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
  shots.push({ file, caption });
  return file;
}
/** A first launch: the doctor's screen and the Welcome come first; they are closed the way a person does. */
async function settle() {
  await until(() => js<boolean>('!!(window.chorus && chorus.S.state)'), 20000);
  for (let i = 0; i < 10; i++) {
    if (await has('button', /Skip, start using Chorus|Start using Chorus|Continue to the app/)) await click('[data-act="doc-continue"]');
    else if (await js<boolean>('chorus.S.view.name === "welcome"')) await click('[data-act="plan-community"]');
    else if (i > 2) break;
    await sleep(500);
  }
}
const goTo = async (view: object) => {
  // the pointer rests in a corner: a hovered row is not a difference between two builds
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 799 });
  await js(`chorus.go(${JSON.stringify(view)})`);
  await sleep(500);
};
const live: string[] = [];

interface Screen {
  id: string;
  label: string;
  sizes?: Size[];
  open: () => Promise<unknown>;
  close?: () => Promise<unknown>;
}
const chatId = () => live[0] ?? 't_cart';
const SCREENS: Screen[] = [
  { id: 'home', label: 'Home', sizes: ['phone'], open: () => goTo({ name: 'home' }) },
  { id: 'chats', label: 'Chats', sizes: ['phone'], open: () => goTo({ name: 'chats' }) },
  { id: 'more', label: 'More', sizes: ['phone'], open: () => goTo({ name: 'more' }) },
  { id: 'sidebar', label: 'The sidebar over the page', sizes: ['tablet'], open: async () => { await goTo({ name: 'new' }); await click('[data-act="menu"]'); }, close: () => click('.side-scrim') },
  { id: 'new', label: 'New chat', open: () => goTo({ name: 'new' }) },
  { id: 'new-menu', label: 'New chat, a picker open', open: async () => { await goTo({ name: 'new' }); await until(() => js<boolean>('!!document.querySelector(".nc-pk")'), 8000); await click('.nc-pk'); }, close: () => js('chorus.S.ncMenu = null') },
  { id: 'chat', label: 'A chat that asks', open: async () => { await goTo({ name: 'chat', id: chatId() }); await sleep(800); } },
  { id: 'chat-sheet', label: 'The chat’s ⋯ sheet', sizes: ['phone'], open: async () => { await goTo({ name: 'chat', id: chatId() }); await click('[data-act="chat-menu"]'); }, close: () => js('chorus.S.sheet = null; document.querySelector("#sheet")?.remove()') },
  { id: 'drawer', label: 'Artifacts drawer', open: async () => { await goTo({ name: 'chat', id: chatId() }); if (!(await js<boolean>('chorus.S.drawer === "artifacts"'))) await js(`document.querySelector('[data-act="drawer"][data-arg="artifacts"], [data-act="drawer-to"][data-arg="artifacts"]')?.click()`); await sleep(700); }, close: () => js(`chorus.S.drawer = null`) },
  { id: 'approvals', label: 'Approvals', open: () => goTo({ name: 'approvals' }) },
  { id: 'memory', label: 'Memory', open: async () => { await goTo({ name: 'memory' }); await until(() => js<boolean>('chorus.S.mem.items.length > 0'), 8000); await sleep(300); } },
  { id: 'memory-record', label: 'A record in Memory', sizes: ['phone'], open: async () => { await goTo({ name: 'memory' }); await until(() => js<boolean>('chorus.S.mem.items.length > 0'), 8000); await click('.mem .rows .item'); } },
  { id: 'skills', label: 'Skills', open: async () => { await goTo({ name: 'skills' }); await until(() => js<boolean>('!!chorus.S.skills'), 8000); } },
  { id: 'doctor', label: 'Doctor', open: async () => { await goTo({ name: 'doctor' }); await sleep(600); } },
  { id: 'notifications', label: 'Notifications', open: async () => { await goTo({ name: 'new' }); await js(`document.querySelector('[data-act="news-toggle"]')?.click()`); await sleep(500); }, close: () => js(`document.querySelector('#news').hidden = true`) },
  { id: 'dialog', label: 'A dialog (delete a chat?)', open: async () => { await goTo({ name: 'chat', id: chatId() }); await js(`fetch('/api/chats/${chatId()}', { method: 'DELETE', headers: { 'x-chorus': '1' } })`); await until(() => js<boolean>('!!document.querySelector("[data-dialog]")'), 8000); }, close: async () => { await js(`(() => { const d = document.querySelector('[data-dialog]'); if (!d) return; return fetch('/api/dialogs/' + d.dataset.dialog, { method: 'POST', headers: { 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ value: null }) }).then(() => d.remove()); })()`); await sleep(300); } },
];
// what the release must still look like at 1280 px (Home, Chats and More don't exist there)
const COMPARE = ['new', 'approvals', 'memory', 'skills', 'doctor'];

/* ---------- 1. the release, at 1280 px (before) ---------- */

const before = new Map<string, Buffer>();
let beforeDir = '';
if (BEFORE && BEFORE !== 'none') {
  log(`1. the desktop page of ${BEFORE} (before)`);
  beforeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-before-'));
  const add = spawnSync('git', ['worktree', 'add', '-q', '--detach', beforeDir, BEFORE], { cwd: ROOT, encoding: 'utf8' });
  if (add.status !== 0) check(`the release ${BEFORE} can be checked out to compare with`, false, add.stderr);
  else {
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(beforeDir, 'node_modules'));
    await cdp('Page.navigate', { url: await startServe(beforeDir) });
    await setSize(chrome, 'desktop', 'light');
    await settle();
    for (const id of COMPARE) {
      const s = SCREENS.find(x => x.id === id)!;
      await s.open();
      await sleep(400);
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
      before.set(id, Buffer.from(data, 'base64'));
      fs.writeFileSync(path.join(OUT, `before-${id}.png`), before.get(id)!);
      await s.close?.();
    }
    await stopServe();
  }
}

/* ---------- 2. this branch ---------- */

log('2. this branch: the same data, live fake chats and an approval card');
await cdp('Page.navigate', { url: await startServe(ROOT) });
await setSize(chrome, 'desktop', 'light');
await settle();
check('the page loads with the seeded chats of three projects', await until(() => js<boolean>('chorus.S.state.chats.length >= 4'), 15000));

// desktop as it was: the same screens, before any live chat changes the sidebar
for (const id of COMPARE) {
  const s = SCREENS.find(x => x.id === id)!;
  await s.open();
  await sleep(400);
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  const after = Buffer.from(data, 'base64');
  fs.writeFileSync(path.join(OUT, `after-${id}.png`), after);
  await s.close?.();
  if (!before.has(id)) continue;
  const d = await pixelDiff(chrome, before.get(id)!, after);
  shots.push({ file: `before-${id}.png`, caption: `Desktop 1280 · ${s.label} · before (${BEFORE})` }, { file: `after-${id}.png`, caption: `Desktop 1280 · ${s.label} · after: ${(d * 100).toFixed(2)} % of pixels differ` });
  check(`desktop 1280 · ${s.label} looks as in ${BEFORE} (${(d * 100).toFixed(2)} % of pixels differ)`, d < 0.01, `${(d * 100).toFixed(2)} %`);
}

// two live chats (fake agents), one with an approval card asked through Chorus's MCP server
for (const [agent, folder, prompt] of [['claude', shop, 'Make the order page work on a phone'], ['codex', api, 'Add paging to the orders endpoint']] as const) {
  const r = await js<{ id?: string; error?: string }>(`fetch('/api/chats', { method: 'POST', headers: { 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify(${JSON.stringify({ agent, folder, prompt, model: 'default', effort: 'default', skip: false })}) }).then(r => r.json())`);
  if (r.id) live.push(r.id);
}
check('two live chats start (fake agents)', live.length === 2 && (await until(() => js<boolean>(`${JSON.stringify(live)}.every(id => chorus.S.state.chats.some(c => c.id === id))`), 15000)));
const rpc = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'proof', version: '1' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'request_approval', arguments: { question: 'Ship the order page today?', details: 'The page works on a phone and its tests pass. Shipping today leaves the checkout button disabled until the payment webhook is done.', options: ['Ship it today', 'Wait for checkout', 'Ship behind a flag'] } } },
].map(m => JSON.stringify(m)).join('\n') + '\n';
spawnSync(process.execPath, [path.join(ROOT, 'src/cli/index.ts'), 'mcp', '--thread', chatId()], { cwd: shop, env, input: rpc, encoding: 'utf8', timeout: 20000 });
check('the approval card reaches the page', await until(() => js<boolean>('chorus.S.state.approvals.length > 0'), 15000));

/* ---------- 3. every screen at three sizes, light and dark ---------- */

const sizes = Object.keys(SIZES) as Size[];
for (const scheme of ['light', 'dark'] as Scheme[]) {
  for (const size of sizes) {
    log(`3. ${size} (${SIZES[size].width} × ${SIZES[size].height}), ${scheme}`);
    await setSize(chrome, size, scheme);
    await sleep(600);
    check(`${size}: the page says it is a ${size} (data-size)`, (await js<string>('document.documentElement.dataset.size')) === size);
    for (const s of SCREENS.filter(x => !x.sizes || x.sizes.includes(size))) {
      await s.open();
      await sleep(350);
      const p = await problems(chrome, SIZES[size].touch);
      const bad = summary(p);
      check(`${size} ${scheme} · ${s.label}: no sideways scroll, nothing cut off${SIZES[size].touch ? ', touch sizes' : ''}`, !bad, bad);
      await shot(`${size}-${scheme}-${s.id}`, `${size[0].toUpperCase()}${size.slice(1)} ${SIZES[size].width} × ${SIZES[size].height} · ${scheme} · ${s.label}${bad ? `  ⚠ ${bad}` : ''}`);
      await s.close?.();
    }
  }
}

/* ---------- report ---------- */

chrome.close();
await stopServe();
if (beforeDir) spawnSync('git', ['worktree', 'remove', '--force', beforeDir], { cwd: ROOT });
const file = writeReport(OUT, 'Chorus desktop page: phone, tablet and desktop', `Every screen at 390 × 844, 820 × 1180 and 1280 × 800, light and dark, with fake agents. The desktop screens are compared with ${BEFORE || 'nothing'} pixel by pixel.`, results, shots, []);
fs.rmSync(path.join(OUT, 'serve.log'), { force: true });
const failed = results.filter(r => !r.ok).length;
log(`\n${failed ? 'FAILED' : 'OK'}: ${results.length - failed}/${results.length} checks.\nReport: ${file}`);
if (argv.includes('--open')) openReport(file);
process.exit(failed ? 1 : 0);
