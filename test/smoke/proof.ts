#!/usr/bin/env node
// Phase 4 proof (docs/phase4.md §6, UI pass 2 = docs/mockups/chorus-cli.html): the real chorus app, real Claude Code and real Codex,
// driven through a PTY with keys and mouse clicks. New chat screen, two chats in a project tree, an approval answered from the
// inbox while another chat is in front, handoff Claude → Codex, shared Memory, Skills, artifacts, window sizes.
// Every step saves a PNG of what the user would see to docs/proof/phase4/.
//
//   node test/smoke/proof.ts [--out docs/proof/phase4]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { VirtualScreen } from '../../src/app/screen.ts';
import { maskText, saveScreenshot } from '../../src/app/snapshot.ts';
import { activityCmd, artifactsCmd, doctorCmd, threadsCmd, traceCmd } from '../../src/cli/commands.ts';
import { Store } from '../../src/core/store.ts';
import { openReport, writeReport } from './report.ts';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'src/cli/index.ts');
const argv = process.argv.slice(2);
const OUT = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(ROOT, 'docs/proof/phase4'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const TITLE = 'Chorus Phase 4 e2e proof (UI pass 2): Claude Code + Codex';
const INTRO = 'The real chorus app driven through a PTY with the real CLIs. Each screenshot is the terminal as you would see it at that step.';
const COLS = 150;
const ROWS = 44;
const SIDE = 29; // full sidebar (28) + its border: the chat area starts here
const outer = new VirtualScreen(COLS, ROWS);
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-proof-')));
spawnSync('git', ['init', '-q'], { cwd: project });
// Claude Code 2.1.302 starts in "auto mode" (a classifier approves for you) and would never ask. Pin this folder to manual
// mode so there is an approval to answer from a card.
fs.mkdirSync(path.join(project, '.claude'));
fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }));

const results: { ok: boolean; name: string; detail?: string }[] = [];
const shots: { file: string; caption: string }[] = [];
const log = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function check(name: string, ok: boolean, detail = '') {
  results.push({ ok, name, detail });
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail.slice(0, 300)})`}`);
}
let n = 0;
function shot(slug: string, caption: string) {
  const file = `${String(++n).padStart(2, '0')}-${slug}.png`;
  const ok = saveScreenshot(outer, path.join(OUT, file), caption);
  fs.writeFileSync(path.join(OUT, file.replace('.png', '.txt')), outer.text().map(l => maskText(l.trimEnd())).join('\n').replace(/\n+$/, '') + '\n');
  shots.push({ file, caption });
  log(`  📷 ${file}${ok ? '' : ' (png failed)'}`);
}

const TASK =
  'Create calc.js in the current directory that exports a function add(a, b). ' +
  `Run it once with your shell tool as: node -e "console.log(require('./calc.js').add(2, 3))" . ` +
  'Then write a short markdown note about what you did, as notes.md, where Chorus keeps files for the user. Reply with one line: done.';

// A shared database in a temporary home, and a stand-in user home for the skills scan: the screenshots never show the real ones.
const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-proof-home-'));
const fakeUserHome = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-proof-uh-'));
for (const [dir, name, desc] of [['.claude/skills', 'release-notes', 'Draft release notes from the commit log'], ['.agents/skills', 'pdf-tools', 'Fill, merge and split PDF files']] as const) {
  fs.mkdirSync(path.join(fakeUserHome, dir, name), { recursive: true });
  fs.writeFileSync(path.join(fakeUserHome, dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\nbody\n`);
}
fs.mkdirSync(path.join(project, '.chorus', 'skills', 'cake-pricing'), { recursive: true });
fs.writeFileSync(path.join(project, '.chorus', 'skills', 'cake-pricing', 'SKILL.md'), '---\nname: cake-pricing\ndescription: Price a cake from size, layers and toppings\n---\nUse the table in pricing.md.\n');
// a chat recorded earlier in ANOTHER project, in the same database: it shows up in the sidebar and in Memory
const otherProject = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-proof-api-')));
{
  const seed = new Store(project, { home: sharedHome });
  seed.createThread({ id: 't_seed', title: 'Rate limiter', agent: 'codex', cwd: otherProject, project: otherProject, native_session_id: 'seed-session', state: 'waiting' });
  seed.recordSession('t_seed', { agent: 'codex', turns: [{ seq: 1, role: 'user', text: 'Add a per-key rate limit to the public API' }, { seq: 2, role: 'assistant', text: 'Limiter in place; 40 tests pass.' }], toolCalls: [{ id: 'w1', turnSeq: 1, tool: 'Write', target: path.join(otherProject, 'src/limit.ts'), status: 'ok' }], usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 } });
  seed.close();
}

const env = { ...process.env, TERM: 'xterm-256color', CHORUS_MODEL_CLAUDE: 'haiku', CHORUS_NO_OPEN: '1', CHORUS_HOME: sharedHome, CHORUS_SKILLS_HOME: fakeUserHome } as Record<string, string>; // NO_OPEN: the preview URL is fetched below, not shown in a browser
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];
const app = pty.spawn(process.execPath, [CLI], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: project, env });
let exited = false;
app.onData((d: string) => outer.write(d));
app.onExit(() => (exited = true));

const text = () => outer.text();
const has = (re: RegExp) => text().some(l => re.test(l));
const area = () => text().map(l => l.slice(SIDE)).join('\n'); // the chat area, without the sidebar
const menu = (k: string) => app.write('\x00' + k);
async function until(pred: RegExp | (() => boolean), ms: number, tick = 300) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (typeof pred === 'function' ? pred() : has(pred)) return true;
    await sleep(tick);
  }
  return false;
}
/** like until(), and answers a Codex folder-trust dialog if one shows up (a person does this once per folder) */
async function untilTrusting(pred: RegExp | (() => boolean), ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (typeof pred === 'function' ? pred() : has(pred)) return true;
    if (has(/Trust and continue/i)) app.write('\r');
    await sleep(1500);
  }
  return false;
}
/** a mouse click (press + release, SGR) on the first place the pattern shows on screen, like a person pointing at it */
async function click(re: RegExp, col = 0, from = 0, x0 = 0, x1 = 1000) {
  const t = text();
  for (let y = from; y < t.length; y++) {
    const m = re.exec(t[y].slice(x0, x1)); // x0 = SIDE searches the chat area only: the sidebar rows are chats, clicking one would open it
    if (m) {
      const x = x0 + m.index + 1 + col;
      app.write(`\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`);
      await sleep(400);
      return true;
    }
  }
  return false;
}
/** click a chat or row of the sidebar (never the top bar, whose path also names the chat) */
const clickSide = (re: RegExp) => click(re, 0, 2, 0, SIDE - 1);
/** the sidebar line (first 28 columns) of the chat whose title matches */
const side = (re: RegExp) => text().slice(1).map(l => l.slice(0, SIDE - 1)).find(l => re.test(l)) ?? '';
const store = () => new Store(project, { home: sharedHome });

log(`project: ${project}\nshared database: ${sharedHome}\nscreenshots: ${OUT}\n`);

/* 1. New chat: the first screen */
log('1. New chat: agent, model, project, skip permissions');
check('chorus opens on New chat with the top bar, the project tree, Skills and Memory', await until(/Agent\s+claude\s+codex\s+agy/, 40000) && /‹ Back|chorus/.test(text()[0]) && /☰ Menu/.test(text()[0]) && has(/\+ New chat/) && has(/✦ Skills/) && has(/◫ Memory/), text().join('|').slice(0, 500));
check('the sidebar already lists the chat recorded in another project (one shared database)', has(/▾ chorus-proof-api/) && has(/Rate limiter/), text().slice(0, 12).join('|'));
check('the screen offers agent, model, effort, project folder and permissions', has(/Model\s+default\s+sonnet\s+opus\s+haiku/) && has(/Effort\s+default\s+low\s+medium\s+high\s+xhigh\s+max/) && text().join('\n').replace(/\s/g, '').includes(project.replace(/\s/g, '')) && has(/\[ \] Skip permission prompts\s+--dangerously-skip-permissions/), text().join('|').slice(0, 500));
shot('new-chat', 'chorus opens on New chat: pick agent, model, project folder and whether it may skip permission prompts. Enter alone starts with the defaults. The sidebar is the map: projects and their chats, Skills and Memory at the bottom');
await click(/haiku/, 0, 0, SIDE); // a click on the model chip, no keyboard
check('clicking haiku selects it (the model list is Claude\'s)', await until(/Model\s+default\s+sonnet\s+opus\s+haiku/, 3000), text().join('|').slice(0, 300));
shot('new-chat-choices', 'Claude + haiku in this folder, chosen with the mouse; the key is inside the chip, so ⏎ starts it');
app.write('\r');

/* 1b. Claude starts; the task is typed into its own screen */
log('1b. Claude opens; the task is typed into its own screen');
check('Claude opens inside the app', await until(/Enter to confirm|\? for shortcuts/i, 60000), text().join('|'));
if (has(/Yes, I trust this folder/i) && has(/Enter to confirm/)) {
  // The dialog is drawn before Claude reads the keyboard, so a key sent too early is lost: press Up until the
  // cursor really is on "Yes, I trust this folder", and only then Enter.
  const sel = () => text().find(l => /❯/.test(l))?.slice(SIDE).trim() ?? '';
  for (let i = 0; i < 10 && !/^❯\s*Yes/.test(sel()); i++) { app.write('\x1b[A'); await sleep(1500); }
  log(`  trust dialog: cursor on "${sel()}"`);
  app.write('\r');
}
await until(/\? for shortcuts|shift\+tab to cycle/i, 30000);
app.write(TASK); // the folder for notes is not mentioned: the agent is told through Chorus's instructions
await sleep(600);
app.write('\r');
shot('claude-starts', 'chat 1 is Claude Code (haiku) under its project; the task was typed into its own screen. The top bar says where you are: the chat title');
check('the top bar shows the path and the sidebar names the chat after the first message', await until(() => /Create calc\.js/.test(side(/Create calc/)) && /‹ Back\s+Create calc/.test(text()[0]), 20000), `${text()[0]} | ${side(/Create calc/)}`);
check('status line has the menu button', /☰ menu/.test(text()[ROWS - 1]), text()[ROWS - 1]);

/* 2. Claude asks for approval while it is in front */
log('2. Claude asks for approval in front');
await until(() => has(/Do you want to (proceed|create|make)/), 120000);
const asked = await until(() => /!/.test(side(/Create calc/).slice(0, 8)) && has(/! 1 waiting/), 10000);
check('the agent\'s own permission prompt is detected (sidebar shows !, the top bar counts it)', asked, `${side(/Create calc/)} | ${text()[0]} | ${area().slice(-400)}`);
shot('claude-asks-in-front', 'Claude is in front and asks permission; the top bar says "! 1 waiting" and the sidebar already shows ! for the chat');

/* 3. second chat (Codex) from New chat, with skip permissions ticked */
log('3. a second chat (Codex, skip permissions) from + New chat; Claude moves to the background');
await click(/\+ New chat/);
check('+ New chat opens the screen over the work in progress', await until(/Agent\s+claude\s+codex\s+agy/, 5000));
await click(/codex/, 0, 3, SIDE);
await sleep(300);
check('the effort list follows the agent (Codex lists the levels of its own models)', await until(/Effort\s+default\s+low\s+medium\s+high/, 3000), text().join('|').slice(0, 400));
await click(/(?<=Effort\s+default\s+)low/, 0, 0, SIDE); // the effort chip, by mouse
await sleep(300);
await click(/Skip permission prompts/, 0, 0, SIDE);
check('ticking skip shows the warning and the Codex flag', await until(/\[x\] Skip permission prompts\s+--dangerously-bypass-approvals-and-sandbox/, 4000) && has(/Nothing reaches the approvals inbox for this chat/), text().join('|').slice(0, 500));
shot('new-chat-skip', '+ New chat: Codex with effort low and "Skip permission prompts" ticked. The screen says what that means and which flag is used (per chat, never global)');
app.write('\r');
check('Codex opens in chat 2 and its own banner says what skip means (permissions: YOLO mode)', await untilTrusting(/Ask Codex to do anything|permissions: YOLO mode/i, 40000) && await until(/permissions: YOLO mode/, 10000), text().join('|'));
check('chat 2 is in front, shows the amber skip marker, and Claude (chat 1) is still pending', /claude.*|codex/.test(text()[ROWS - 1]) && /skip/.test(text()[ROWS - 1]) && /!/.test(side(/Create calc/).slice(0, 8)), `${text()[ROWS - 1]} | ${side(/Create calc/)}`);
const card = await until(/asks for approval/, 15000);
check('an approval card for the background chat appears over Codex, and the top bar badge stays', card && has(/! 1 waiting/), area().slice(-500));
shot('card-for-background-thread', 'Codex (skip) is in front; Claude (background) is waiting: the top bar badge, the sidebar ! and a card with its request');

/* 4. approvals inbox: answer from the list until Claude is done */
log('4. approvals inbox: approve without switching');
await click(/! 1 waiting/);
check('clicking the badge opens the approvals inbox', await until(/Approvals\s+·\s+1 waiting/, 5000) && has(/y Approve\s+x Deny\s+⏎ Open chat/), text().join('|').slice(0, 400));
check('the inbox has the this project / all projects switch and lists the request with its risk tag', has(/this project\s+all projects/) && has(/\[(runs a command|edits a file|writes outside the folder|installs a package)\]/) && has(/▸ Create calc/), text().join('|').slice(0, 500));
shot('approvals-inbox', 'the approvals inbox: every chat waiting on you in one list, with the request and a risk tag. y approves, x denies, ⏎ opens the chat; the agent gets the same key you would have typed');
let approvals = 0;
let t0 = Date.now();
while (Date.now() - t0 < 240000) {
  if (has(/Approvals\s+·\s+[1-9]\d* waiting/)) {
    app.write('y');
    approvals++;
    await sleep(2500);
    continue;
  }
  const s = store().listThreads().find(t => t.agent === 'claude');
  const done = fs.existsSync(path.join(project, 'calc.js')) && store().listArtifacts(s?.id).some(a => a.path === 'notes.md') && !has(/! \d+ waiting/);
  if (done) break;
  if (!has(/Approvals\s+·/) && has(/! \d+ waiting/)) { await click(/! \d+ waiting/); await sleep(800); continue; }
  await sleep(1200);
}
check('at least one request was approved from the inbox', approvals > 0, String(approvals));
check('the inbox keeps the decisions ("Decided")', has(/✓ approved/), text().join('|').slice(0, 500));
shot('after-approvals', `approved ${approvals} request(s) from the inbox; the list is empty and "Decided" keeps what was answered`);
check('the store logged the approvals', store().approvalsLog().filter(a => a.decision === 'approved').length >= approvals, JSON.stringify(store().approvalsLog().slice(0, 3)));
app.write('\x1b'); // back to the chat in front (Codex)
await sleep(600);
check('Claude created calc.js', fs.existsSync(path.join(project, 'calc.js')));
const t1 = store().listThreads().find(t => t.agent === 'claude')!;
check('Claude chat finished: waiting dot, store state', /[○◐]/.test(side(/Create calc/).slice(0, 8)) && store().getThread(t1.id)!.state === 'waiting', `${side(/Create calc/)} ${store().getThread(t1.id)?.state}`);
check('live tailing recorded the turns, the node call and the usage', (() => { const s = store(); return s.getTurns(t1.id).length >= 2 && s.getToolCalls(t1.id).some(c => /node -e/.test(c.target) && c.status === 'ok') && (s.getUsage(t1.id)?.outputTokens ?? 0) > 0; })());
check('the artifact notes.md was registered in the chat project', store().listArtifacts(t1.id).some(a => a.path === 'notes.md') && store().artifactsDir(t1.id).startsWith(project), artifactsCmd(store()));
check('the Codex chat was started with its skip flag and its effort, and remembers both', (() => { const c = store().listThreads().find(t => t.agent === 'codex' && t.id !== 't_seed'); return c?.skip_permissions === 1 && c?.effort === 'low'; })(), JSON.stringify(store().listThreads().find(t => t.agent === 'codex' && t.id !== 't_seed')));

/* 5. Codex chat is independent */
log('5. the Codex chat works on its own');
app.write('Reply with only the text codex-ready-');
await sleep(500);
app.write('42'); // TUIs read text and Enter arriving in one chunk as a paste: type them apart
await sleep(500);
app.write('\r');
check('Codex answers in its own chat', await until(/codex-ready-42/, 90000), area().slice(-300));
shot('codex-own-thread', 'chat 2 (Codex) answers independently while chat 1 is parked in the background');

/* 6. handoff Claude → Codex */
log('6. hand off the Claude chat to Codex');
await clickSide(/Create calc/); // a click in the sidebar opens it
check('a click on a chat in the sidebar opens it', await until(() => /▎/.test(side(/Create calc/)), 5000), side(/Create calc/));
menu('h');
check('handoff dialog names the chat and lists the other agents first with their plan', await until(/Continue "Create calc\.js[^"]*" in a new chat/, 5000) && has(/1\s+codex\s+/) && has(/3\s+claude\s+fresh session/), text().join('|').slice(0, 400));
await sleep(400);
shot('handoff-dialog', 'ctrl+\\ h (or ☰ Menu → Hand off): choose the agent that continues the work');
app.write('1'); // codex is the first of the other agents
check('the handoff chat appears in front, listed under the chat it continues (↳)', await until(() => /↳/.test(side(/↳/)), 20000), side(/↳/));
const child = (() => { const s = store(); return s.listThreads().find(t => t.parent_thread_id === t1.id); })();
check('the new chat is a child of the Claude chat in the store, in the same project', !!child && child!.agent === 'codex' && child!.project === project, JSON.stringify(child));
const loaded = await untilTrusting(() => !!child && store().mcpCalls(child.id).some(m => m.tool === 'get_handoff_context'), 150000);
check('Codex called get_handoff_context (Chorus saw the MCP call)', loaded, JSON.stringify(child && store().mcpCalls(child.id)));
const answered = await untilTrusting(() => !!child && store().getTurns(child.id).some(x => x.role === 'assistant' && /calc/i.test(x.text)), 150000);
shot('handoff-summary', 'the continuing Codex chat loaded the context through the Chorus MCP server and summarises the work');
const reply = child ? store().getTurns(child.id).filter(x => x.role === 'assistant').map(x => x.text).join('\n') : '';
check('its summary names calc.js', answered && /calc\.js/.test(reply), reply.slice(0, 300));
check('the handoff chat settles as waiting', await until(() => /[○◐]/.test(side(/↳/).slice(0, 10)), 60000), side(/↳/));

/* 7. Memory and Skills (shared) */
log('7. Memory and Skills');
await click(/◫ Memory/);
check('Memory lists the chats of every project', await until(/Memory\s+·\s+all projects/, 5000) && has(/Rate limiter/) && has(/Create calc/) && has(/↳/), text().join('|').slice(0, 500));
app.write('/');
await sleep(300);
app.write('limiter');
check('/ searches the memory: only the matching chat is left', await until(() => has(/\/ limiter/) && has(/Rate limiter/) && !has(/Create calc\.js.*claude.*turns/), 3000), text().join('|').slice(0, 500));
shot('memory-search', 'Memory: / searches titles, projects, what a chat asked and its files');
app.write('\x1b');
await sleep(500);
await click(/Rate limiter/, 3, 4, SIDE);
await sleep(500);
check('selecting a chat shows what it asked and which files it touched', has(/asked\s+Add a per-key rate limit/) && has(/files\s+src\/limit\.ts/), text().join('|').slice(0, 600));
shot('memory', 'Memory: one list for all projects and agents (the shared database). Selecting a row shows what it asked, its last message and its files; any agent can read it through the chorus MCP tools');
app.write('\x1b');
await sleep(600);
await click(/✦ Skills/);
check('Skills shows the library with on/off and what the agents already have', await until(/Skills\s+·\s+one library/, 5000) && has(/\[on\]\s+cake-pricing/) && has(/release-notes\s+~\/\.claude\/skills\s+claude\s+import ›/) && has(/pdf-tools\s+~\/\.agents\/skills\s+codex agy\s+import ›/), text().join('|').slice(0, 600));
shot('skills', 'Skills: the library with on/off for all three agents; skills the agents already keep in their own folders are offered for import');
app.write('\r'); // turn cake-pricing off
check('⏎ turns a skill off and unlinks it from the agents\' folders', await until(/\[off\]\s+cake-pricing/, 4000) && !fs.existsSync(path.join(project, '.claude', 'skills', 'cake-pricing')), text().join('|').slice(0, 400));
app.write('\r'); // and on again
await until(/\[on\]\s+cake-pricing/, 4000);
await click(/(?<=release-notes.*)import ›/, 0, 0, SIDE);
check('clicking import copies a skill into the library', await until(/\[on\]\s+release-notes/, 5000) && fs.existsSync(path.join(project, '.chorus', 'skills', 'release-notes', 'SKILL.md')), text().join('|').slice(0, 400));
app.write('\x1b');
await sleep(600);

/* 8. Menu, activity, artifacts */
log('8. menu, activity, artifacts');
await click(/☰ Menu/);
check('☰ Menu opens the ten rows of the menu', await until(/Hand off to another agent/, 4000) && ['New chat', 'Artifacts', 'Approvals', 'Skills', 'Memory', 'Activity', 'Show / hide sidebar', 'Help', 'Quit'].every(r => has(new RegExp(r))), text().join('|').slice(0, 500));
shot('menu', '☰ Menu (or ctrl+\\): hand off, new chat, artifacts, approvals, skills, memory, activity, sidebar, help, quit. ↑↓ and ⏎, a click, or the letter');
app.write('e'); // Activity
check('activity view has the filter bar with counts and lists the tool and MCP calls', await until(/Activity\s+·\s+/, 5000) && /\[all \d+\]\s+tool \d+\s+mcp \d+\s+approval \d+\s+file \d+\s+usage \d+\s+error 0/.test(text().join('\n')) && /mcp\s+chorus\.get_handoff_context\s+ok/.test(text().join('\n')), text().join('|').slice(0, 400));
shot('activity-view', 'Activity on the handoff chat: its timeline shows the chorus.get_handoff_context MCP call that loaded the context');
app.write('f');
check('f filters the timeline by kind', await until(/\[tool \d+\]/, 3000));
app.write('f');
check('the mcp filter keeps the MCP call', await until(/\[mcp \d+\]/, 3000) && /get_handoff_context/.test(text().join('\n')));
app.write('r');
check('r shows the raw trace next to what was parsed', await until(/Raw trace · /, 3000) && /transcript lines:/.test(text().join('\n')), text().join('|').slice(0, 300));
shot('raw-trace', 'r: the raw transcript lines and how Chorus parsed them (for debugging an adapter)');
app.write('\x1b');
await sleep(400);
app.write('\x1b');
await sleep(500);
await clickSide(/Create calc.*claude/); // the artifact belongs to the Claude chat
await sleep(800);
menu('a');
check('artifacts view lists the artifact with its version', await until(/Artifacts · /, 5000) && /notes\.md\s+v1/.test(text().join('\n')), text().join('|').slice(0, 300));
shot('artifacts-view', 'Artifacts: name, version, who wrote it, and the files its tools wrote. ⏎ or a click opens the file with the default app (here through the served link that reloads while the agent edits)');
app.write('\r');
check('⏎ opens the artifact (served with live reload) and shows its address', await until(/Link\s+http:\/\/localhost:\d+\/t_\w+\/notes\.md/, 8000), text().join('|').slice(0, 300));
const previewUrl = text().join('\n').match(/http:\/\/localhost:\d+\/t_\w+\/notes\.md/)?.[0] ?? '';
const page = !previewUrl ? '' : await new Promise<string>(res => http.get(previewUrl, m => { let b = ''; m.on('data', d => (b += d)); m.on('end', () => res(b)); }).on('error', () => res('')));
check('the preview page serves what the agent wrote and reloads when it changes', /Notes: calc\.js/.test(page) && /EventSource/.test(page), page.slice(0, 200));
app.write('\x1b');
await sleep(500);

/* 9. window sizes */
log('9. window sizes');
const resize = async (c: number, r: number) => { app.resize(c, r); outer.resize(c, r); await sleep(1800); };
await resize(100, 30);
check('100 columns: narrow sidebar (names only), the chat keeps the rest', has(/\+ New chat/) && !text().slice(0, 9).some(l => /claude\s*│/.test(l)) && /☰ Menu/.test(text()[0]), text().slice(0, 6).join('|'));
shot('size-narrow', '100 columns: the sidebar shrinks to names (the agent name goes), the agent screen gets the room');
await resize(78, 30);
check('78 columns: icon sidebar', /\+/.test(text()[1]) && !has(/Skills/), text().slice(0, 6).join('|'));
shot('size-icons', '70-89 columns: the sidebar is just icons: state dot and agent letter');
await resize(56, 24);
check('56 columns: sidebar hidden, top bar and status line stay (the buttons shrink to ☰)', !has(/\+ New chat/) && /☰/.test(text()[0]) && /☰/.test(text()[ROWS - 1] ?? text()[23]), text().slice(0, 4).join('|'));
await resize(44, 10);
check('under 50x12 only a notice shows', has(/window too small: 44×10/), text().join('|'));
shot('size-too-small', 'under 50×12: a notice; the chats keep running');
await resize(COLS, ROWS);
check('back to full size: the sidebar and the chat are back', has(/\+ New chat/) && has(/✦ Skills/), text().slice(0, 6).join('|'));
menu('?');
await until(/Chorus keeps your agents side by side/, 5000);
shot('help-view', 'Help: the keys');
app.write('\x1b');
await sleep(500);
shot('overview', 'final state: two projects, three chats (Claude, Codex, and the Codex handoff chat under it), the sidebar tree, Skills and Memory');

/* 10. leave */
menu('q');
await sleep(600);
menu('q');
check('app quits and restores the terminal', await until(() => exited, 15000));

/* commands */
const s = store();
const cmds = [
  ['chorus threads', threadsCmd(s)],
  ['chorus activity', activityCmd(s)],
  ['chorus artifacts', artifactsCmd(s).replaceAll(os.tmpdir(), '$TMPDIR')],
  ['chorus trace <claude chat>', traceCmd(s, t1.id).replaceAll(os.homedir(), '~')],
  ['chorus doctor', doctorCmd(project).replaceAll(os.homedir(), '~')],
];
let md = `# Phase 4 e2e proof (UI pass 2)\n\nReal \`chorus\` app, real Claude Code and Codex, driven through a PTY with keys and mouse clicks (\`npm run proof\`).\nEach screenshot is the terminal as the user sees it at that step.\n\n## Result\n\n| | check |\n|---|---|\n${results.map(r => `| ${r.ok ? '✅' : '❌'} | ${r.name} |`).join('\n')}\n\n## Screenshots\n\n${shots.map(x => `### ${x.file.replace(/\.png$/, '')}\n${x.caption}\n\n![${x.caption}](${x.file})\n`).join('\n')}\n## Commands after the run\n\n${cmds.map(([c, o]) => `\`\`\`\n$ ${c}\n${o}\n\`\`\``).join('\n\n')}\n`;
const scrub = (t: string) => t.replaceAll(project, '$PROJECT').replaceAll(otherProject, '$OTHER').replaceAll(sharedHome, '$CHORUS_HOME').replaceAll(fakeUserHome, '$USER_HOME').replaceAll(os.homedir(), '~');
const reportFile = writeReport(OUT, TITLE, INTRO, results, shots, cmds.map(([c, o]) => [c, scrub(o)] as [string, string]));
fs.writeFileSync(path.join(OUT, 'README.md'), scrub(md));
s.close();
const failed = results.filter(r => !r.ok).length;
log(`\n${failed ? 'FAILED' : 'OK'}: ${results.length - failed}/${results.length} checks.\nReport with screenshots: ${reportFile}`);
if (argv.includes('--open')) openReport(reportFile);
try { app.kill(); } catch {}
process.exit(failed ? 1 : 0);
