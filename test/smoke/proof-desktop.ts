#!/usr/bin/env node
// Phase 5 proof (architecture §2): the desktop app over `chorus serve`, with the real Claude Code and the real Codex.
// The page is driven in Chrome (headless, over the DevTools protocol) with real mouse clicks and key presses, like a person:
// New chat with a first message, a second chat with skip permissions, an approval answered from the inbox while another chat
// is in front, artifacts, activity, handoff Claude → Codex, Memory, Skills, a restart that resumes a chat, and the native
// window (desktop/, Tauri) starting its own `chorus serve`. Every step saves a screenshot to docs/proof/phase5/.
//
//   node test/smoke/proof-desktop.ts [--out docs/proof/phase5] [--open]
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { activityCmd, artifactsCmd, threadsCmd } from '../../src/cli/commands.ts';
import { Store } from '../../src/core/store.ts';
import { openReport, writeReport } from './report.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'src/cli/index.ts');
const APP = path.join(ROOT, 'desktop/src-tauri/target/release/bundle/macos/Chorus.app');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const argv = process.argv.slice(2);
const OUT = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(ROOT, 'docs/proof/phase5'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const W = 1440;
const H = 900;

const TITLE = 'Chorus Phase 5 e2e proof: the desktop app with Claude Code + Codex';
const INTRO = 'The desktop page over `chorus serve`, driven in Chrome with real clicks and key presses, with the real CLIs in the server\'s PTYs. Then the native window (Tauri) starting its own server. Each screenshot is what the user sees at that step.';

const log = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const results: { ok: boolean; name: string; detail?: string }[] = [];
const shots: { file: string; caption: string }[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ ok, name, detail });
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail.slice(0, 300)})`}`);
  return ok;
}

/* ---------- the project, a shared database in a temporary home, skills ---------- */

const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-desk-')));
spawnSync('git', ['init', '-q'], { cwd: project });
// Claude Code starts in "auto mode" (a classifier approves for you): pin this folder to manual so there is something to approve
fs.mkdirSync(path.join(project, '.claude'));
fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }));
const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-desk-home-'));
const fakeUserHome = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-desk-uh-'));
for (const [dir, name, desc] of [['.claude/skills', 'release-notes', 'Draft release notes from the commit log'], ['.agents/skills', 'pdf-tools', 'Fill, merge and split PDF files']] as const) {
  fs.mkdirSync(path.join(fakeUserHome, dir, name), { recursive: true });
  fs.writeFileSync(path.join(fakeUserHome, dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`);
}
fs.mkdirSync(path.join(project, '.chorus', 'skills', 'cake-pricing'), { recursive: true });
fs.writeFileSync(path.join(project, '.chorus', 'skills', 'cake-pricing', 'SKILL.md'), '---\nname: cake-pricing\ndescription: Price a cake from size, layers and toppings\n---\nUse the table in pricing.md.\n');
const otherProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-desk-api-')));
{
  const seed = new Store(project, { home: sharedHome });
  seed.createThread({ id: 't_seed', title: 'Rate limiter', agent: 'codex', cwd: otherProject, project: otherProject, native_session_id: 'seed-session', state: 'waiting' });
  seed.recordSession('t_seed', { agent: 'codex', turns: [{ seq: 1, role: 'user', text: 'Add a per-key rate limit to the public API' }, { seq: 2, role: 'assistant', text: 'Limiter in place; 40 tests pass.' }], toolCalls: [{ id: 'w1', turnSeq: 1, tool: 'Write', target: path.join(otherProject, 'src/limit.ts'), status: 'ok' }], usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 } });
  seed.close();
}
const store = () => new Store(project, { home: sharedHome });
const TASK =
  'Create calc.js in the current directory that exports a function add(a, b). ' +
  `Run it once with your shell tool as: node -e "console.log(require('./calc.js').add(2, 3))" . ` +
  'Then write a short markdown note about what you did, as notes.md, where Chorus keeps files for the user. Reply with one line: done.';

const env = { ...process.env, CHORUS_MODEL_CLAUDE: 'haiku', CHORUS_NO_OPEN: '1', CHORUS_HOME: sharedHome, CHORUS_SKILLS_HOME: fakeUserHome } as Record<string, string>;
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];

/* ---------- chorus serve ---------- */

let serve: ChildProcess | undefined;
async function startServe(): Promise<string> {
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

/* ---------- Chrome over the DevTools protocol ---------- */

const freePort = () => new Promise<number>(r => { const s = net.createServer().listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
const cdpPort = await freePort();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-desk-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
// the server, its agents and Chrome go away however the proof ends (a failed step throws)
process.on('exit', () => {
  serve?.kill('SIGTERM');
  chrome.kill();
});
let pageWs = '';
for (let i = 0; i < 60 && !pageWs; i++) {
  await sleep(250);
  try {
    const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    pageWs = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
  } catch {
    /* not up yet */
  }
}
const ws = new WebSocket(pageWs, { perMessageDeflate: false });
await new Promise(r => ws.once('open', r));
let seq = 0;
const waiters = new Map<number, (m: any) => void>();
ws.on('message', d => {
  const m = JSON.parse(String(d));
  if (m.id && waiters.has(m.id)) {
    waiters.get(m.id)!(m);
    waiters.delete(m.id);
  }
});
function cdp(method: string, params: object = {}): Promise<any> {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => waiters.set(id, m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))));
}
async function js<T = any>(expr: string): Promise<T> {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${expr.slice(0, 80)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value as T;
}
await cdp('Page.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
const scheme = (value: 'light' | 'dark') => cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
await scheme('light');

let n = 0;
async function shot(slug: string, caption: string) {
  await sleep(350); // let the last frame paint
  const file = `${String(++n).padStart(2, '0')}-${slug}.png`;
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(data, 'base64'));
  shots.push({ file, caption });
  log(`  📷 ${file}`);
}
async function until(pred: () => Promise<boolean> | boolean, ms: number, tick = 400) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await pred()) return true;
    } catch {
      /* the page may be reloading */
    }
    await sleep(tick);
  }
  return false;
}
/** a real mouse click in the middle of the first element that matches (and whose text matches) */
async function click(sel: string, text?: string | RegExp): Promise<boolean> {
  const re = text instanceof RegExp ? text.source : text ? text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  const at = await js<{ x: number; y: number } | null>(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent !== null && ${re ? `new RegExp(${JSON.stringify(re)}).test(e.textContent)` : 'true'});
    const e = els[0]; if (!e) return null;
    e.scrollIntoView({ block: 'nearest' });
    const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })()`);
  if (!at) return false;
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await sleep(300);
  return true;
}
const KEYS: Record<string, [number, string]> = { Enter: [13, '\r'], ArrowUp: [38, ''], ArrowDown: [40, ''], Escape: [27, ''] };
async function key(k: keyof typeof KEYS) {
  const [vk, text] = KEYS[k];
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(150);
}
/** types like a person: text, a pause, then Enter apart (TUIs read text + Enter in one chunk as a paste) */
async function typeLine(text: string, enter = true) {
  await cdp('Input.insertText', { text });
  await sleep(600);
  if (enter) await key('Enter');
}
const term = () => js<string>(`(() => { if (!window.chorus) return ''; const b = chorus.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out.join('\\n'); })()`);
const screen = () => js<string>(`(() => { if (!window.chorus) return ''; const b = chorus.term.buffer.active; const out = []; for (let i = b.viewportY; i < b.viewportY + chorus.term.rows; i++) out.push(b.getLine(i)?.translateToString(true) ?? ''); return out.join('\\n'); })()`);
const state = () => js<any>('chorus.S.state');
const view = () => js<any>('chorus.S.view');
const has = (sel: string, re: RegExp) => js<boolean>(`[...document.querySelectorAll(${JSON.stringify(sel)})].some(e => new RegExp(${JSON.stringify(re.source)}).test(e.textContent))`);
const focusTerm = () => click('#term-slot .xterm-screen');
/** answers the folder-trust dialogs of Claude and Codex the way a person does once per folder */
async function trustIfAsked() {
  const s = await screen();
  if (/Yes, I trust this folder/i.test(s) && /Enter to confirm/i.test(s)) {
    const sel = async () => (await screen()).split('\n').find(l => /❯/.test(l))?.trim() ?? '';
    await focusTerm();
    for (let i = 0; i < 8 && !/^❯\s*\d?\.?\s*Yes/.test(await sel()); i++) {
      await key('ArrowUp');
      await sleep(1200);
    }
    await key('Enter');
    return true;
  }
  if (/Trust and continue|Do you trust the contents/i.test(s)) {
    await focusTerm();
    await key('Enter');
    return true;
  }
  return false;
}

/* ---------- 1. New chat ---------- */

let url = await startServe();
log(`project: ${project}\nshared database: ${sharedHome}\nscreenshots: ${OUT}\n`);
await cdp('Page.navigate', { url });
log('1. the window opens on New chat');
check('the page loads from chorus serve and the token leaves the address bar', await until(async () => (await js<string>('location.search')) === '' && !!(await js('window.chorus && chorus.S.state')), 15000));
check('New chat shows the three agents with their versions, model, effort, folder and the skip switch', await until(async () => (await js<number>('document.querySelectorAll(".agent").length')) === 3 && (await has('.agent', /Claude Code\s*2\.\d+\.\d+/)) && (await has('.agent', /Codex\s*0\.\d+/)), 30000) && (await js<string>('document.querySelector("#nc-folder").value')).endsWith(path.basename(project)) && (await has('.toggle', /Skip permission prompts/)));
check('the sidebar lists the chat recorded in another project (one shared database)', await has('.proj', new RegExp(path.basename(otherProject))) && (await has('.chat-row', /Rate limiter/)));
await shot('new-chat', 'The window opens on New chat: agent (with version and login), model, effort, project folder, an optional first message, and whether it may skip permission prompts. The sidebar already lists a chat from another project (one shared database)');

log('2. Claude with a first message');
await click('.agent', 'Claude Code');
await js(`(() => { const s = document.querySelector('#nc-model'); s.value = 'haiku'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await sleep(200);
await click('#nc-prompt');
await cdp('Input.insertText', { text: TASK });
check('the model list is Claude\'s and haiku is chosen', (await js<string>('chorus.S.form.model')) === 'haiku' && (await js<string[]>('[...document.querySelectorAll("#nc-model option")].map(o => o.value)')).includes('sonnet'));
await shot('new-chat-filled', 'Claude Code + haiku in this folder, with the task as the first message. The first message is passed to the agent when it starts; you can also type it in the agent\'s own screen');
await click('[data-act="nc-start"]');
check('Start opens the chat with the agent\'s own screen', await until(async () => (await view()).name === 'chat' && /claude/i.test(await term()), 60000), await term());
const claudeId = (await view()).id as string;
const trusted = await until(async () => (await trustIfAsked()) || /esc to interrupt|Do you want|calc\.js/i.test(await screen()), 60000);
check('Claude starts working on the first message (folder trust answered with the keyboard)', trusted && (await until(async () => /calc|esc to interrupt|Do you want/i.test(await term()), 90000)), await screen());
check('the chat is named after the first message in the sidebar and the top bar', await until(async () => (await has('.chat-row', /Create calc\.js/)) && (await has('#top .crumbs', /Create calc\.js/)), 30000));
await shot('claude-working', 'Chat 1: Claude Code (haiku) works in its own screen, in the window. The chat took its name from the first message; the header shows agent, state, model and folder');

/* ---------- 3. a second chat: Codex, skip permissions ---------- */

log('3. a second chat (Codex, effort low, skip permissions)');
await click('[data-act="new"]');
await until(async () => (await js<number>('document.querySelectorAll(".agent").length')) === 3, 10000);
await click('.agent', 'Codex');
await sleep(200);
const efforts = await js<string[]>('[...document.querySelectorAll("#nc-effort option")].map(o => o.value)');
check('the effort list follows the agent (Codex lists its own levels)', efforts.includes('low') && efforts.includes('high'), efforts.join(','));
await js(`(() => { const s = document.querySelector('#nc-effort'); s.value = 'low'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
await click('.toggle input');
check('ticking skip shows what it means and the Codex flag', await until(() => has('.toggle', /--dangerously-bypass-approvals-and-sandbox/), 3000) && (await has('.toggle', /Nothing reaches the approvals inbox/)));
await shot('new-chat-skip', '+ New chat: Codex with effort low and "Skip permission prompts" ticked; the form says what that means and which flag is used (per chat, never global)');
await click('[data-act="nc-start"]');
await until(async () => (await view()).id !== claudeId && /codex|OpenAI/i.test(await term()), 60000);
const codexId = (await view()).id as string;
// Codex draws its YOLO banner first and its folder-trust dialog after it: wait for the empty composer, answering the dialog on the way
check('Codex opens in chat 2 with its own YOLO banner and an empty composer', await until(async () => { await trustIfAsked(); const s = await screen(); return /YOLO/.test(await term()) && /Ask Codex to do anything/.test(s) && !/Trust this folder/i.test(s); }, 60000, 1000), await screen());
await sleep(4000); // Codex draws its banner before it reads the keyboard
await focusTerm();
await typeLine('Reply with only the text codex-ready-42');
const codexAnswered = () => until(async () => /codex-ready-42\s*$/m.test((await term()).replace(/Reply with only the text codex-ready-42/g, '')), 30000);
let codexOk = await codexAnswered();
for (let i = 0; i < 3 && !codexOk; i++) {
  // the Enter came while Codex was still busy starting: the text waits in its composer, so press Enter again, like a person
  if (/› Reply with only the text codex-ready-42/.test(await screen())) await key('Enter');
  codexOk = await codexAnswered();
}
check('typing in the window reaches Codex and it answers in its own screen', codexOk, await screen());
check('the header shows the amber skip tag and effort low', await has('.chat-head', /skip/) && (await has('.chat-head', /low/)));
await shot('codex-skip', 'Chat 2: Codex with skip permissions answers in its own screen; the header shows the amber skip tag and effort low. Claude keeps working in the background');

/* ---------- 4. Claude asks while Codex is in front: the inbox ---------- */

log('4. Claude asks for approval in the background; answered from the inbox');
const asked = await until(async () => (await state()).approvals.some((a: any) => a.id === claudeId), 180000);
check('the agent\'s own permission prompt is detected on the background chat', asked, JSON.stringify((await state()).approvals));
check('the top bar counts it, the sidebar marks it, and a toast offers the answer without covering Codex', await until(async () => (await has('#top', /\d+ waiting/)) && (await js<boolean>(`!!document.querySelector('.chat-row .dot.approval')`)) && (await has('.toast.ask', /asks/)), 8000), `top: ${await has('#top', /\d+ waiting/)} dot: ${await js<boolean>(`!!document.querySelector('.chat-row .dot.approval')`)} toast: ${await has('.toast.ask', /asks/)}`);
await shot('background-asks', 'Codex is in front; Claude (background) asks: the top bar says "! 1 waiting", the sidebar dot turns red, and a toast offers Approve / Deny / Open. Nothing covers the chat in front');
await click('#top .btn.waiting');
check('the badge opens the approvals inbox with the request and its risk tag', await until(() => has('.item', /Create calc\.js/), 5000) && (await js<boolean>(`!!document.querySelector('.item .badge.plain, .item .badge.warn, .item .badge.bad')`)));
await shot('approvals-inbox', 'The approvals inbox: every chat waiting on you, the request as the agent wrote it, a risk tag, and Approve / Deny / Open chat. Approve types the agent\'s own answer key');
let approvals = 0;
let t0 = Date.now();
while (Date.now() - t0 < 300000) {
  if (await click('.item [data-act="approve"]')) {
    approvals++;
    await sleep(2500);
    continue;
  }
  const done = fs.existsSync(path.join(project, 'calc.js')) && store().listArtifacts(claudeId).some(a => a.path === 'notes.md') && !(await state()).approvals.length;
  if (done) break;
  await sleep(1200);
}
check('requests were approved from the inbox', approvals > 0, String(approvals));
check('Decided today keeps the answers', await until(() => has('.section-title + .card', /approved/), 5000));
await shot('after-approvals', `Approved ${approvals} request(s) from the inbox without opening the chat; the list is empty and "Decided today" keeps the answers`);
check('Claude created calc.js', fs.existsSync(path.join(project, 'calc.js')));
check('the store logged the approvals', store().approvalsLog().filter(a => a.decision === 'approved').length >= approvals);

/* ---------- 5. artifacts, activity, record ---------- */

log('5. Claude chat: artifacts, activity, record');
await click('.chat-row', /Create calc\.js/);
await until(async () => (await view()).id === claudeId, 5000);
await until(async () => (await state()).chats.find((c: any) => c.id === claudeId)?.state === 'idle', 120000);
check('the Claude chat settles as "waiting for you" and the store has its turns, the node call and usage', await until(async () => (await has('.chat-head', /waiting for you/)), 10000) && (() => { const s = store(); return s.getTurns(claudeId).length >= 2 && s.getToolCalls(claudeId).some(c => /node -e/.test(c.target) && c.status === 'ok') && (s.getUsage(claudeId)?.outputTokens ?? 0) > 0; })());
await js(`localStorage.removeItem('chorus.drawer')`);
await click('[data-act="drawer"][data-arg="artifacts"]');
check('Artifacts lists notes.md with its version and the files the tools wrote', await until(() => has('.drawer .art', /notes\.md/), 8000) && (await has('.drawer', /calc\.js/)));
await shot('artifacts', 'The Artifacts drawer next to the agent\'s screen: notes.md (v1) with Open, Show in folder, Copy path, and the files Claude\'s tools wrote');
const preview = await js<{ url: string }>(`fetch('/api/chats/${claudeId}/preview', { method: 'POST', headers: { 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ path: 'notes.md' }) }).then(r => r.json())`);
const page = await (await fetch(preview.url)).text().catch(() => '');
check('Open serves the artifact on a local page that reloads while the agent edits it', /calc/i.test(page) && /EventSource/.test(page), page.slice(0, 200));
await click('[data-act="drawer"][data-arg="activity"]');
check('Activity shows the tool calls with status and duration', await until(() => has('.drawer .act-row', /node -e/), 8000));
await shot('activity', 'The Activity drawer: the chat\'s timeline of tool calls, approvals and files, with filters by kind');
await click('[data-act="drawer"][data-arg="record"]');
check('Record shows what get_handoff_context returns for this chat', await until(() => has('.drawer pre.record', /calc\.js/), 8000));
await shot('record', 'The Record drawer: exactly what the next agent reads through get_handoff_context');
await click('[data-act="drawer"][data-arg="record"]');

/* ---------- 6. handoff Claude → Codex ---------- */

log('6. hand off the Claude chat to Codex');
await click('[data-act="handoff"]', 'Hand off');
check('Hand off opens the form for the chat, another agent chosen first', await until(() => has('.handoff-src', /Create calc\.js/), 8000) && (await js<string>('chorus.S.form.agent')) === 'codex');
await shot('handoff-form', 'Hand off: the same form, for the chat that continues "Create calc.js…"; the other agent comes first and the folder is the source\'s');
await click('[data-act="nc-start"]');
await until(async () => { const v = await view(); return v.name === 'chat' && v.id !== claudeId && v.id !== codexId; }, 30000);
const childId = (await view()).id as string;
check('the new chat is listed under the chat it continues (↳) and is its child in the store', await until(() => has('.chat-row.child', /→ codex/), 10000) && store().getThread(childId)?.parent_thread_id === claudeId);
const loaded = await until(async () => {
  await trustIfAsked();
  if ((await state()).approvals.some((a: any) => a.id === childId)) await click('.banner.ask [data-act="approve"]');
  return store().mcpCalls(childId).some(m => m.tool === 'get_handoff_context');
}, 180000, 1500);
check('Codex called get_handoff_context (Chorus saw the MCP call)', loaded, JSON.stringify(store().mcpCalls(childId)));
const answered = await until(async () => {
  if ((await state()).approvals.some((a: any) => a.id === childId)) await click('.banner.ask [data-act="approve"]');
  return store().getTurns(childId).some(x => x.role === 'assistant' && /calc/i.test(x.text));
}, 180000, 1500);
const reply = store().getTurns(childId).filter(x => x.role === 'assistant').map(x => x.text).join('\n');
check('its summary names calc.js', answered && /calc\.js/.test(reply), reply.slice(0, 300));
await shot('handoff-summary', 'The continuing Codex chat loaded the record through the Chorus MCP server and sums up the work; it waits for your OK');

/* ---------- 7. Memory, Skills, Doctor ---------- */

log('7. Memory, Skills, Doctor');
await click('.nav button', 'Memory');
check('Memory lists the chats of every project, continued ones under their source', await until(() => has('.mem .item', /Rate limiter/), 8000) && (await has('.mem .item', /Create calc/)) && (await has('.mem .item', /↳/)));
await click('#mem-q');
await cdp('Input.insertText', { text: 'limiter' });
check('search keeps only the matching chat', await until(async () => (await js<number>('document.querySelectorAll(".mem .rows .item").length')) === 1 && (await has('.mem .rows', /Rate limiter/)), 5000));
check('selecting it shows what it asked and the files it touched', await has('.kv', /Add a per-key rate limit/) && (await has('.kv', /src\/limit\.ts/)));
await shot('memory-search', 'Memory: every chat in every project (one shared database). Search finds the chat from another project; its details say what it asked, its last answer and its files');
await js(`(() => { const q = document.querySelector('#mem-q'); q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); })()`);
await until(() => has('.mem .rows', /Create calc/), 5000);
await click('.mem .rows .item', /Create calc/);
await click('[data-act="mem-record"]');
check('"What an agent reads" shows the handoff record', await until(() => has('pre.record', /calc\.js/), 5000));
await shot('memory-record', 'Memory: the Claude chat and what an agent reads when it continues it; Open chat, Continue with another agent and Delete are one click away');

await click('.nav button', 'Skills');
check('Skills shows the library with on/off and the skills the agents already keep', await until(() => has('.item', /cake-pricing/), 5000) && (await has('.item', /release-notes/)) && (await has('.item', /pdf-tools/)));
await shot('skills', 'Skills: one library for the three agents, with on/off; skills found in the agents\' own folders are offered for import');
await click('.item .switch');
check('turning a skill off unlinks it from the agents\' folders', await until(() => !fs.existsSync(path.join(project, '.claude', 'skills', 'cake-pricing')) && js<boolean>('!document.querySelector(".item .switch").checked'), 5000));
await click('.item .switch');
await until(() => js<boolean>('document.querySelector(".item .switch").checked'), 5000);
await click('[data-act="sk-import"][data-arg$="/release-notes"]');
check('Import copies a skill into the library', await until(() => fs.existsSync(path.join(project, '.chorus', 'skills', 'release-notes', 'SKILL.md')), 5000));

await click('.side-foot button', 'Doctor');
check('Doctor lists the agents, versions, logins and the store', await until(() => has('pre.record', /claude/), 15000) && (await has('pre.record', /store/)));
await shot('doctor', 'Doctor: the agents Chorus starts, their versions and logins, and where the data lives');

await click('.chat-row', /Create calc\.js/);
await until(async () => (await view()).id === claudeId, 5000);
await scheme('dark');
await shot('dark', 'The same window in dark mode (it follows the system)');
await scheme('light');

/* ---------- 8. restart: the window reconnects, a chat resumes ---------- */

log('8. restart chorus serve: chats come back and resume');
const claudeSession = store().getThread(claudeId)!.native_session_id;
serve!.kill('SIGTERM');
check('the window says it lost the server', await until(() => js<boolean>('!document.querySelector("#conn").hidden'), 10000));
await shot('disconnected', 'chorus serve stopped (the app closing, a crash): the window says so and keeps trying');
await sleep(1500);
url = await startServe();
await cdp('Page.navigate', { url: `${url}#/chat/${claudeId}` });
check('after a restart the chats are listed again and the Claude chat resumes its own session when opened', await until(async () => { const c = (await state())?.chats.find((x: any) => x.id === claudeId); return !!c && c.live; }, 40000) && store().getThread(claudeId)?.native_session_id === claudeSession);
check('the resumed Claude screen is in the window', await until(async () => /claude|calc|>/i.test(await screen()), 40000), await screen());
await until(async () => /done|calc/i.test(await term()), 20000);
await shot('resumed', 'After a restart of chorus serve: the sidebar lists every chat again, and opening the Claude chat resumes its own session (claude --resume) in the window');
serve!.kill('SIGTERM');
await sleep(2000);

/* ---------- 9. the native window (Tauri) ---------- */

log('9. the native app starts its own chorus serve');
if (process.platform !== 'darwin' || !fs.existsSync(APP)) {
  check('the native app is built (cd desktop && npm install && npm run build)', false, APP);
} else {
  const logFile = path.join(sharedHome, 'desktop.log');
  const appBin = path.join(APP, 'Contents/MacOS/chorus-desktop');
  const app = spawn(appBin, [], { env: { ...env, CHORUS_PROJECT: project, CHORUS_SERVE_CMD: `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)}` }, stdio: 'ignore' });
  const started = await until(() => fs.existsSync(logFile) && /chorus serve: http:\/\/127\.0\.0\.1:\d+\/\?token=\w+/.test(fs.readFileSync(logFile, 'utf8')), 30000);
  check('Chorus.app starts chorus serve through the login shell and loads its page', started);
  if (started) {
    const appUrl = fs.readFileSync(logFile, 'utf8').match(/chorus serve: (\S+)/)![1];
    const token = new URL(appUrl).searchParams.get('token')!;
    const st = (await (await fetch(new URL('/api/state', appUrl), { headers: { authorization: `Bearer ${token}` } })).json()) as any;
    const resumable = store().listThreads().filter(t => t.native_session_id).map(t => t.id); // a chat without an agent session cannot be resumed, so it is not listed
check('the app\'s server has the same chats (the shared database)', resumable.length >= 4 && resumable.every(id => st.chats.some((c: any) => c.id === id)), JSON.stringify(st.chats?.map((c: any) => c.title)));
    // bring the window to the front and photograph it (macOS screencapture of that one window)
    await sleep(4000);
    spawnSync('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${app.pid}) to true`]);
    await sleep(1500);
    const winId = spawnSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('CoreGraphics'); const l = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0))); const w = l.find(x => x.kCGWindowOwnerPID === ${app.pid} && x.kCGWindowLayer === 0 && x.kCGWindowName === 'Chorus'); w ? String(w.kCGWindowNumber) : ''`], { encoding: 'utf8' }).stdout.trim();
    const file = `${String(++n).padStart(2, '0')}-native-window.png`;
    const shotOk = !!winId && spawnSync('screencapture', ['-x', '-o', '-l', winId, path.join(OUT, file)]).status === 0 && fs.existsSync(path.join(OUT, file));
    if (shotOk) {
      shots.push({ file, caption: 'The native window (desktop/, Tauri, 4.9 MB): it started its own chorus serve and shows the same chats. Closing it stops the server and the agents' });
      log(`  📷 ${file}`);
    }
    check('the native window can be photographed (window found on screen)', shotOk, `window id "${winId}"`);
    const servePid = spawnSync('pgrep', ['-f', 'serve --port 0 --exit-with-stdin'], { encoding: 'utf8' }).stdout.trim();
    app.kill('SIGKILL'); // even a hard kill of the app takes its server down (it holds the server's stdin)
    check('closing the app stops its chorus serve', await until(() => spawnSync('pgrep', ['-f', 'serve --port 0 --exit-with-stdin']).status !== 0, 8000), servePid);
  }
}

/* ---------- report ---------- */

ws.close();
chrome.kill();
const s = store();
const cmds: [string, string][] = [
  ['chorus threads', threadsCmd(s)],
  ['chorus activity', activityCmd(s)],
  ['chorus artifacts', artifactsCmd(s)],
];
const scrub = (t: string) => t.replaceAll(project, '$PROJECT').replaceAll(otherProject, '$OTHER').replaceAll(sharedHome, '$CHORUS_HOME').replaceAll(fakeUserHome, '$USER_HOME').replaceAll(os.homedir(), '~');
const md = `# Phase 5 e2e proof: the desktop app\n\nThe desktop page over \`chorus serve\`, driven in Chrome with real clicks and key presses, with the real Claude Code and Codex (\`npm run proof:desktop\`). Then the native window (Tauri) starting its own server.\n\n## Result\n\n| | check |\n|---|---|\n${results.map(r => `| ${r.ok ? '✅' : '❌'} | ${r.name} |`).join('\n')}\n\n## Screenshots\n\n${shots.map(x => `### ${x.file.replace(/\.png$/, '')}\n${x.caption}\n\n![${x.caption}](${x.file})\n`).join('\n')}\n## Commands after the run\n\n${cmds.map(([c, o]) => `\`\`\`\n$ ${c}\n${o}\n\`\`\``).join('\n\n')}\n`;
const reportFile = writeReport(OUT, TITLE, INTRO, results, shots, cmds.map(([c, o]) => [c, scrub(o)] as [string, string]));
fs.writeFileSync(path.join(OUT, 'README.md'), scrub(md));
fs.rmSync(path.join(OUT, 'serve.log'), { force: true });
s.close();
const failed = results.filter(r => !r.ok).length;
log(`\n${failed ? 'FAILED' : 'OK'}: ${results.length - failed}/${results.length} checks.\nReport with screenshots: ${reportFile}`);
if (argv.includes('--open')) openReport(reportFile);
process.exit(failed ? 1 : 0);
