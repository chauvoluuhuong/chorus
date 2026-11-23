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
import { adapters } from '@chauvoluuhuong/chorus-core';
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
// enough skills with two-line descriptions to make the "/" list scroll, and one name in two sources (it shows once)
for (const n of ['app-demo-overview-zoom', 'app-hub', 'app-market-research', 'build-app-workflow', 'landing-page-builder', 'make-video']) {
  fs.mkdirSync(path.join(userHome, '.claude/skills', n), { recursive: true });
  fs.writeFileSync(path.join(userHome, '.claude/skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: ${n}: a long description that runs over two lines in the list, the way real skills describe when to use them, what they cover and what they leave to other skills, with examples of the phrases that should start them\n---\nbody\n`);
}
fs.mkdirSync(path.join(shop, '.chorus/skills/release-notes'), { recursive: true });
fs.writeFileSync(path.join(shop, '.chorus/skills/release-notes/SKILL.md'), '---\nname: release-notes\ndescription: Draft release notes from the commit log\n---\nbody\n');
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
  seedChatView(s);
  s.close();
}

/**
 * The Chat view's chat (plan 2026-11-22 chat-view, mockup scenes 1–6): a real Claude Code transcript shape with every kind of call (a
 * failed command, a read, a search, an edit, Chorus's read_mail, a command that passed), a reply with a table and a mermaid diagram,
 * sub threads (one reported, one working, one asking), a chat it started, reported artifacts and mail it read. Parsed with the real
 * adapter, so the rows, their kinds and words, and each call's detail come from where they come from in the app.
 */
function seedChatView(s: Store) {
  const at = (sec: number) => new Date(Date.UTC(2026, 10, 22, 7, 2, 0) + sec * 1000).toISOString();
  let n = 0;
  const L: object[] = [];
  const user = (text: string, sec: number) => L.push({ type: 'user', uuid: `u${++n}`, sessionId: 't_cv-session', cwd: shop, message: { role: 'user', content: text }, timestamp: at(sec) });
  const say = (text: string, sec: number, stop = 'tool_use') => L.push({ type: 'assistant', uuid: `a${++n}`, message: { id: `m${n}`, role: 'assistant', model: 'claude-haiku', stop_reason: stop, content: [{ type: 'text', text }] }, timestamp: at(sec) });
  const call = (id: string, name: string, input: object, out: string, sec: number, error = false) => {
    L.push({ type: 'assistant', uuid: `a${++n}`, message: { id: `m${n}`, role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] }, timestamp: at(sec) });
    L.push({ type: 'user', uuid: `r${n}`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: out, is_error: error }] }, timestamp: at(sec + 1) });
  };
  const appLines = Array.from({ length: 120 }, (_, i) => `${String(610 + i).padStart(6)}→${['function renderChrome() {', "  const tree = document.querySelector('.tree');", '  const top = tree?.scrollTop ?? 0;', '  side.innerHTML = drawSide();'][i] ?? `  // line ${610 + i}`}`).join('\n');
  user('the serve tests fail on dev, find out why and fix it', 0);
  say("I'll run the serve tests first.", 2);
  call('toolu_run1', 'Bash', { command: 'npm run test:serve' }, 'Exit code 1\n✗ sidebar-scroll.test.ts (2 failed)\n  keeps the scroll after a state push\n    expected 480, got 0\n✓ serve.test.ts (41)\n' + Array.from({ length: 38 }, (_, i) => `  ✓ case ${i + 1}`).join('\n'), 3, true);
  call('toolu_read', 'Read', { file_path: 'src/desktop/app.js', offset: 610, limit: 120 }, appLines, 52);
  call('toolu_grep', 'Grep', { pattern: 'scrollTop', path: 'src/desktop' }, "app.js:612:    const top = tree?.scrollTop ?? 0;\napp.js:618:    tree.scrollTop = top;\napp.js:1440:   el.scrollTop = el.scrollHeight;\nfollow.js:22:  return el.scrollTop + el.clientHeight;", 61);
  call('toolu_edit', 'Edit', { file_path: 'src/desktop/app.js', old_string: '  tree.scrollTop = top;\n  fillSlots();\n  done();', new_string: "  fillSlots();\n  // after the module's slots: they change the list's height\n  const now = document.querySelector('.tree');\n  if (now) now.scrollTop = top;\n" + Array.from({ length: 8 }, (_, i) => `  step${i}();`).join('\n') }, 'The file src/desktop/app.js has been updated.', 85);
  call('toolu_mail', 'mcp__chorus__read_mail', {}, 'From Chorus · note\n"Ship the projects page" changed src/desktop/app.js\n10 minutes ago.', 110);
  say("Found it. `renderChrome()` redraws the sidebar before the module's slots are filled, so the list loses its scroll position.\n\nI moved the restore to after the slots. Running the tests again.", 115);
  call('toolu_sub', 'mcp__chorus__start_subthread', { title: 'Check docs/features/projects.md against the code', agent: 'codex' }, 'Started sub thread t_cvsub1', 118);
  call('toolu_run2', 'Bash', { command: 'npm run test:serve' }, '✓ sidebar-scroll.test.ts (2)\n✓ serve.test.ts (41)\n\n43 passed', 122);
  say('**Fixed.** All 43 serve tests pass.\n\n- Cause: the sidebar\'s scroll was restored before the module filled its slots.\n- Change: `src/desktop/app.js`, 12 lines.\n\nNothing is committed.', 175, 'end_turn');
  L.push({ type: 'system', subtype: 'turn_duration', timestamp: at(176) });
  user('explain how the two views get their data, with a diagram', 300);
  say('#### Two views, one session\n\nThe CLI runs once. Each view reads a different thing:\n\n| View | Reads |\n|---|---|\n| Terminal | the terminal\'s bytes |\n| Chat | the captured turns |\n\n```mermaid\ngraph LR\n  CLI[CLI in a PTY] --> T[transcript] --> U[turns]\n  CLI --> R[Terminal view]\n  U --> C[Chat view]\n```\n\n```\nchorus serve --port 4780\n```\n\nRun that to try it.', 305);
  call('toolu_art', 'mcp__chorus__show_artifact', { path: 'site/hero.html' }, 'Shown.', 330);
  say('Version 2 of the hero is up, and the copy options are in the second file.', 340, 'end_turn');
  L.push({ type: 'system', subtype: 'turn_duration', timestamp: at(341) });
  // what the transcript stores as user lines but the user never typed (mockup chat-view-desktop.html scene 2): quiet lines
  user('<task-notification>\n<task-id>b1upepmp8</task-id>\n<tool-use-id>toolu_bg1</tool-use-id>\n<output-file>/private/tmp/claude-501/tasks/b1upepmp8.output</output-file>\n<status>completed</status>\n<summary>Background command "Watch the serve tests for changes" completed (exit code 0)</summary>\n</task-notification>', 400);
  say('That alert was the test watcher finishing, which I had already reported.', 402, 'end_turn');
  user('Chorus approval r_e42f164d: Yes, ship the preview', 420);
  say('Shipping the preview now.', 422, 'end_turn');
  user('This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\n' + Array.from({ length: 60 }, (_, i) => `${i + 1}. The serve tests failed on dev because the sidebar lost its scroll position.`).join('\n'), 500);
  user('Chorus: the Planner says: the preview is out; check that it installs.\nThe tag is v9.9.9-preview.1.', 520);
  say('The preview installs: I checked it in an empty folder.', 524, 'end_turn');
  const file = path.join(home, 't_cv.jsonl');
  fs.writeFileSync(file, L.map(x => JSON.stringify(x)).join('\n') + '\n');
  s.createThread({ id: 't_cv', title: 'Fix the failing serve tests', agent: 'claude', cwd: shop, project: shop, native_session_id: 't_cv-session', state: 'waiting' });
  s.recordSession('t_cv', adapters.claude.parseTranscript(fs.readFileSync(file, 'utf8')), { transcriptPath: file });
  // its sub threads: one reported, one working, one with a question (they started together, after the first reply)
  const sub = (id: string, title: string, agent: 'claude' | 'codex' | 'agy', status: string, sec: number) => {
    s.createThread({ id, title, agent, cwd: shop, project: shop, parent_thread_id: 't_cv', native_session_id: `${id}-session`, state: 'waiting' });
    s.setSub(id, { sub_status: status as never, sub_brief: title, sub_started: at(sec) });
  };
  sub('t_cvsub1', 'Check docs/features/projects.md against the code', 'codex', 'stopped', 118);
  sub('t_cvsub2', 'Run the size proofs', 'claude', 'working', 118.5);
  s.db.prepare("INSERT INTO mail (id,from_thread,from_json,to_thread,kind,subject,body,refs,state,created_at,read_at) VALUES ('m_cv1',NULL,'{\"who\":\"chorus\"}','t_cv','report',?,?,?,'read',?,?)").run('Sub thread "Check the docs" ended a turn', 'The doc matches, except "Export" still says zip; the code writes a folder. Two lines to change, listed in my report.', JSON.stringify({ about: 't_cvsub1' }), at(160), at(170));
  s.db.prepare("INSERT INTO asks (id,thread_id,parent_id,kind,question,created) VALUES ('q_cv1','t_cvsub2','t_cv','question',?,?)").run('The tablet proof differs by 1.4 %. Accept, or should I look for the cause?', at(171));
  // a chat it started (start_thread): its own row in Chats, never a report here
  s.createThread({ id: 't_cvnew', title: 'Designer · Empty state for the projects page', agent: 'agy', cwd: shop, project: shop, parent_thread_id: 't_cv', native_session_id: 't_cvnew-session', state: 'waiting' });
  s.db.prepare('UPDATE threads SET created = ? WHERE id = ?').run(at(176.5), 't_cvnew');
  s.recordSession('t_cvnew', { agent: 'agy', turns: [{ seq: 1, role: 'user', text: 'Design an empty state for the projects page: no projects yet, one clear action. Match ui-mockup-v3.', ts: at(200) }, { seq: 2, role: 'assistant', text: "I'll look at the page and the mockup first.", ts: at(205) }], toolCalls: [{ id: 'nv1', turnSeq: 2, tool: 'view_file', kind: 'read', target: 'mockups/ui-mockup-v3.html', status: 'ok', note: '880 lines' }, { id: 'nv2', turnSeq: 2, tool: 'view_file', kind: 'read', target: 'src/desktop/projects-ui.js', status: 'running' }], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } });
  // artifacts it reported (show_artifact): an HTML page and a Markdown file, inside the project
  fs.mkdirSync(path.join(shop, 'site'), { recursive: true });
  fs.writeFileSync(path.join(shop, 'site', 'hero.html'), '<!doctype html><meta charset="utf-8"><style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:28px;color:#1b1b1b}h1{font:600 34px/1.15 Georgia,serif;margin:0 0 8px}a{display:inline-block;background:#0f766e;color:#fff;border-radius:8px;padding:9px 16px;text-decoration:none;margin-top:14px}div{height:150px;margin-top:22px;border-radius:12px;background:linear-gradient(90deg,#e2f3f1,#f7e8e1)}</style><h1>Every agent, one place</h1>Run Claude Code, Codex and Antigravity side by side, from your Mac or your phone.<br><a href="#">Try Chorus</a><div></div>');
  fs.writeFileSync(path.join(shop, 'site', 'hero-copy.md'), '# Hero copy\n\n## Option 1\nEvery agent, one place.\n\n## Option 2\nOne window for all your coding agents.\n\n## Option 3\nYour agents, side by side.\n');
  s.db.prepare('INSERT INTO reported (thread_id,target,title,ts) VALUES (?,?,?,?)').run('t_cv', path.join(shop, 'site', 'hero.html'), 'Landing hero, version 2', at(331));
  s.db.prepare('INSERT INTO reported (thread_id,target,title,ts) VALUES (?,?,?,?)').run('t_cv', path.join(shop, 'site', 'hero-copy.md'), 'Copy options for the hero', at(332));
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
/** The Chat view at this size: a phone opens in it, a tablet and a desktop are switched to it (kept per size, in browser storage). */
const cvOn = async (id = 't_cv') => {
  await js(`localStorage.setItem('chorus.chatView.' + chorus.S.size, 'chat')`);
  await goTo({ name: 'chat', id });
  await until(() => js<boolean>('!!document.querySelector(".cv-stream .cv-u, .cv-stream .cv-a")'), 8000);
  await sleep(700);
};
const cvOff = () => js(`localStorage.removeItem('chorus.chatView.' + chorus.S.size); document.querySelector('.cv-sheet-wrap')?.remove(); document.querySelector('.cv-full')?.remove()`);
const cvScroll = (sel: string) => js(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'center' })`);
const SCREENS: Screen[] = [
  { id: 'home', label: 'Home', sizes: ['phone'], open: () => goTo({ name: 'home' }) },
  { id: 'chats', label: 'Chats', sizes: ['phone'], open: () => goTo({ name: 'chats' }) },
  { id: 'more', label: 'More', sizes: ['phone'], open: () => goTo({ name: 'more' }) },
  { id: 'sidebar', label: 'The sidebar over the page', sizes: ['tablet'], open: async () => { await goTo({ name: 'new' }); await click('[data-act="menu"]'); }, close: () => click('.side-scrim') },
  { id: 'new', label: 'New chat', open: () => goTo({ name: 'new' }) },
  { id: 'new-menu', label: 'New chat, a picker open', open: async () => { await goTo({ name: 'new' }); await until(() => js<boolean>('!!document.querySelector(".nc-pk")'), 8000); await click('.nc-pk'); }, close: () => js('chorus.S.ncMenu = null') },
  { id: 'chat', label: 'A chat that asks', open: async () => { await goTo({ name: 'chat', id: chatId() }); await sleep(800); } },
  { id: 'chat-sheet', label: 'The chat’s ⋯ sheet', sizes: ['phone'], open: async () => { await goTo({ name: 'chat', id: chatId() }); await click('[data-act="chat-menu"]'); }, close: () => js('chorus.S.sheet = null; document.querySelector("#sheet")?.remove()') },
  // a phone: Artifacts is the chat's Files tab
  { id: 'drawer', label: 'Artifacts drawer', open: async () => { await goTo({ name: 'chat', id: chatId() }); if (!(await js<boolean>('chorus.S.drawer === "artifacts"'))) await js(`document.querySelector('[data-act="chat-tab"][data-arg="files"], [data-act="drawer"][data-arg="artifacts"], [data-act="drawer-to"][data-arg="artifacts"]')?.click()`); await sleep(700); }, close: () => js(`chorus.S.drawer = null; chorus.S.chatTab = 'chat'`) },
  // the Chat view (plan 2026-11-22 chat-view, mockup @workspace/mockups/chat-view.html): one screen per scene
  { id: 'cv', label: 'Chat view (scenes 1, 7)', open: () => cvOn(), close: cvOff },
  { id: 'cv-tools', label: 'Chat view · tool calls open (scene 2)', open: async () => { await cvOn(); await js(`document.querySelector('.cv-tools[aria-expanded="false"]')?.click()`); await sleep(300); await cvScroll('.cv-tl'); }, close: cvOff },
  { id: 'cv-call', label: 'Chat view · one call\'s detail, fetched on the tap (scene 2)', open: async () => { await cvOn(); await js(`document.querySelector('.cv-t[data-call="toolu_run1"]') || document.querySelector('.cv-tools[aria-expanded="false"]')?.click()`); await sleep(300); await js(`document.querySelector('.cv-t[data-call="toolu_run1"]')?.click()`); await until(() => js<boolean>('!!document.querySelector(".cv-sheet pre")'), 8000); }, close: cvOff },
  { id: 'cv-cards', label: 'Chat view · sub threads, their report and question (scene 3)', open: async () => { await cvOn(); await cvScroll('.cv-card.sub, .cv-card .mini'); }, close: cvOff },
  { id: 'cv-new', label: 'Chat view · the new chat card, and "Started by" inside it (scene 4)', open: async () => { await cvOn(); await cvScroll('.cv-card.new'); }, close: cvOff },
  { id: 'cv-started', label: 'Chat view · inside the chat it started (scene 4)', sizes: ['phone'], open: () => cvOn('t_cvnew'), close: cvOff },
  { id: 'cv-md', label: 'Chat view · Markdown, mermaid and artifact cards (scene 5)', open: async () => { await cvOn(); await until(() => js<boolean>('!!document.querySelector(".cv-dia.ok svg, .cv-dia.bad")'), 15000); await cvScroll('.cv-dia'); await sleep(600); }, close: cvOff },
  { id: 'cv-full', label: 'Chat view · an artifact full screen (scene 5)', sizes: ['phone'], open: async () => { await cvOn(); await js(`[...document.querySelectorAll('.cv-card.art [data-cv="art"]')][0]?.click()`); await sleep(1200); }, close: cvOff },
  { id: 'cv-notes', label: 'Chat view · quiet lines: a background job (open), a card answer, a shortened conversation, Chorus text', open: async () => { await cvOn(); await js(`document.querySelector('.cv-sys[data-cv="note"][aria-expanded="false"]')?.click()`); await sleep(300); await js(`(() => { const s = document.querySelector('.cv-stream'); s.scrollTop = s.scrollHeight; })()`); await sleep(300); }, close: async () => { await js(`document.querySelector('.cv-sys[data-cv="note"][aria-expanded="true"]')?.click()`); await cvOff(); } },
  { id: 'cv-slash', label: 'Chat view · "/" in the message box (scene 6; desktop: chat-view-desktop.html scene 3)', open: async () => { await cvOn(); await js(`(() => { const b = document.querySelector('.cv-in'); b.focus(); b.value = '/'; b.setSelectionRange(1, 1); b.dispatchEvent(new Event('input', { bubbles: true })); })()`); await until(() => js<boolean>('!!document.querySelector(".cv-box .tpick:not([hidden])")'), 8000); await sleep(300); const rows = await js<{ over: number; twice: string[] }>(`(() => { const b = [...document.querySelectorAll('.cv-box .tpick [data-i]')]; const names = b.map(e => e.querySelector('.mono').textContent); return { over: b.filter(e => e.scrollHeight > e.clientHeight + 1 || [...e.children].some(c => c.getBoundingClientRect().bottom > e.getBoundingClientRect().bottom + 1)).length, twice: names.filter((n, i) => names.indexOf(n) !== i) }; })()`); if (rows.over || rows.twice.length) throw new Error(`"/" list: ${rows.over} rows whose text runs out of the row; shown twice: ${rows.twice.join(', ') || 'none'}`); }, close: async () => { await js(`(() => { const b = document.querySelector('.cv-in'); if (b) { b.value = ''; b.blur(); } })()`); await cvOff(); } },
  { id: 'cv-at', label: 'Chat view · "@" in the message box (scene 6)', open: async () => { await cvOn(); await js(`(() => { const b = document.querySelector('.cv-in'); b.focus(); b.value = 'add a case to @s'; b.setSelectionRange(16, 16); b.dispatchEvent(new Event('input', { bubbles: true })); })()`); await until(() => js<boolean>('!!document.querySelector(".cv-box .tpick:not([hidden])")'), 8000); await sleep(300); }, close: async () => { await js(`(() => { const b = document.querySelector('.cv-in'); if (b) { b.value = ''; b.blur(); } })()`); await cvOff(); } },
  { id: 'cv-raw', label: 'The Terminal view, the agent\'s own screen, from the switch (scene 1)', sizes: ['phone'], open: async () => { await cvOn(); await js(`document.querySelector('[data-act="cv-mode"][data-arg="raw"]')?.click()`); await sleep(1200); }, close: cvOff },
  { id: 'approvals', label: 'Approvals', open: () => goTo({ name: 'approvals' }) },
  { id: 'memory', label: 'Memory', open: async () => { await goTo({ name: 'memory' }); await until(() => js<boolean>('chorus.S.mem.items.length > 0'), 8000); await sleep(300); } },
  { id: 'memory-record', label: 'A record in Memory', sizes: ['phone'], open: async () => { await goTo({ name: 'memory' }); await until(() => js<boolean>('chorus.S.mem.items.length > 0'), 8000); await click('.mem .rows .item'); } },
  { id: 'skills', label: 'Skills', open: async () => { await goTo({ name: 'skills' }); await until(() => js<boolean>('!!chorus.S.skills'), 8000); } },
  { id: 'doctor', label: 'Doctor', open: async () => { await goTo({ name: 'doctor' }); await sleep(600); } },
  { id: 'notifications', label: 'Notifications', open: async () => { await goTo({ name: 'new' }); await js(`document.querySelector('[data-act="news-toggle"]')?.click()`); await sleep(500); }, close: () => js(`document.querySelector('#news').hidden = true`) },
  { id: 'dialog', label: 'A dialog (delete a chat?)', open: async () => { await goTo({ name: 'chat', id: chatId() }); await js(`fetch('/api/chats/${chatId()}', { method: 'DELETE', headers: { 'x-chorus': '1' } })`); await until(() => js<boolean>('!!document.querySelector("[data-dialog]")'), 8000); }, close: async () => { await js(`(() => { const d = document.querySelector('[data-dialog]'); if (!d) return; return fetch('/api/dialogs/' + d.dataset.dialog, { method: 'POST', headers: { 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ value: null }) }).then(() => d.remove()); })()`); await sleep(300); } },
];
// what the release must still look like at 1280 px (Home, Chats and More don't exist there)
const COMPARE = ['new', 'approvals', 'memory', 'skills', 'doctor', 'raw-chat'];
// a chat in Raw on a desktop (the plan's "Raw unchanged"): only the header's new Raw | Chat switch may differ. The newest chat, so
// opening it (which resumes it) cannot change the order of the sidebar for the screens after it
SCREENS.push({ id: 'raw-chat', label: 'A chat in Raw', sizes: [], open: async () => { await js(`localStorage.setItem('chorus.chatView.' + document.documentElement.dataset.size, 'raw')`); await goTo({ name: 'chat', id: 't_cv' }); await sleep(2500); }, close: () => js(`localStorage.removeItem('chorus.chatView.' + document.documentElement.dataset.size)`) });
// Raw on a phone and a tablet too (the owner's rule of 2026-11-22: Raw is not touched; on a phone only the switch icon is new)
const RAW_SIZES: Size[] = ['phone', 'tablet'];
const rawShot = async (size: Size) => {
  await setSize(chrome, size, 'light');
  await sleep(600);
  const s = SCREENS.find(x => x.id === 'raw-chat')!;
  await s.open();
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  await s.close?.();
  return Buffer.from(data, 'base64');
};

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
    for (const size of RAW_SIZES) {
      before.set(`raw-${size}`, await rawShot(size));
      fs.writeFileSync(path.join(OUT, `before-raw-${size}.png`), before.get(`raw-${size}`)!);
    }
    await setSize(chrome, 'desktop', 'light');
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

for (const size of RAW_SIZES) {
  const after = await rawShot(size);
  fs.writeFileSync(path.join(OUT, `after-raw-${size}.png`), after);
  if (!before.has(`raw-${size}`)) continue;
  const d = await pixelDiff(chrome, before.get(`raw-${size}`)!, after);
  shots.push({ file: `before-raw-${size}.png`, caption: `${size} · A chat in Raw · before (${BEFORE})` }, { file: `after-raw-${size}.png`, caption: `${size} · A chat in Raw · after: ${(d * 100).toFixed(2)} % of pixels differ (the switch ${size === 'phone' ? 'icon' : 'control'})` });
  check(`${size} · A chat in Raw looks as in ${BEFORE} apart from the switch (${(d * 100).toFixed(2)} % of pixels differ)`, d < 0.01, `${(d * 100).toFixed(2)} %`);
}
await setSize(chrome, 'desktop', 'light');

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
// the MCP server stays up while the card waits for an answer (its stdin open): closed, it ends before the call is made
const mcp = spawn(process.execPath, [path.join(ROOT, 'src/cli/index.ts'), 'mcp', '--thread', chatId()], { cwd: shop, env, stdio: ['pipe', 'pipe', 'pipe'] });
let mcpOut = '';
mcp.stdout!.on('data', d => (mcpOut += d));
mcp.stderr!.on('data', d => (mcpOut += d));
mcp.stdin!.write(rpc);
process.on('exit', () => mcp.kill('SIGTERM'));
check('the approval card reaches the page', await until(() => js<boolean>('chorus.S.state.approvals.length > 0'), 15000), `mcp: ${mcpOut.slice(-300)}`);

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
mcp.kill('SIGTERM');
await stopServe();
if (beforeDir) spawnSync('git', ['worktree', 'remove', '--force', beforeDir], { cwd: ROOT });
const file = writeReport(OUT, 'Chorus desktop page: phone, tablet and desktop', `Every screen at 390 × 844, 820 × 1180 and 1280 × 800, light and dark, with fake agents. The desktop screens are compared with ${BEFORE || 'nothing'} pixel by pixel.`, results, shots, []);
fs.rmSync(path.join(OUT, 'serve.log'), { force: true });
const failed = results.filter(r => !r.ok).length;
log(`\n${failed ? 'FAILED' : 'OK'}: ${results.length - failed}/${results.length} checks.\nReport: ${file}`);
if (argv.includes('--open')) openReport(file);
process.exit(failed ? 1 : 0);
