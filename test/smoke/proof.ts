#!/usr/bin/env node
// Phase 4 proof (docs/phase4.md §6): the real chorus app, real Claude Code and real Codex, driven through a PTY.
// Two threads, switch, an approval answered from a card while another thread is in front, handoff Claude → Codex,
// artifacts listed. Every step saves a PNG of what the user would see to docs/proof/phase4/.
//
//   node test/smoke/proof.ts [--out docs/proof/phase4]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { VirtualScreen } from '../../src/app/screen.ts';
import { saveScreenshot } from '../../src/app/snapshot.ts';
import { activityCmd, artifactsCmd, doctorCmd, threadsCmd, traceCmd } from '../../src/cli/commands.ts';
import { Store } from '../../src/core/store.ts';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'src/cli/index.ts');
const argv = process.argv.slice(2);
const OUT = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(ROOT, 'docs/proof/phase4'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const COLS = 150;
const ROWS = 44;
const outer = new VirtualScreen(COLS, ROWS);
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-proof-')));
spawnSync('git', ['init', '-q'], { cwd: project });

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
  fs.writeFileSync(path.join(OUT, file.replace('.png', '.txt')), outer.text().map(l => l.trimEnd()).join('\n').replace(/\n+$/, '') + '\n');
  shots.push({ file, caption });
  log(`  📷 ${file}${ok ? '' : ' (png failed)'}`);
}

const TASK =
  'Create calc.js in the current directory that exports a function add(a, b). ' +
  `Run it once with your shell tool as: node -e "console.log(require('./calc.js').add(2, 3))" . ` +
  'Then write a short markdown note about what you did into notes.md in the artifacts folder. Reply with one line: done.';

const env = { ...process.env, TERM: 'xterm-256color', CHORUS_MODEL_CLAUDE: 'haiku' } as Record<string, string>;
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];
const app = pty.spawn(process.execPath, [CLI, 'new', 'fix add()', '--agent', 'claude', '--task', TASK], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: project, env });
let exited = false;
app.onData((d: string) => outer.write(d));
app.onExit(() => (exited = true));

const text = () => outer.text();
const has = (re: RegExp) => text().some(l => re.test(l));
const area = () => text().map(l => l.slice(27)).join('\n'); // the thread area, without the sidebar
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
const row = (i: number) => text()[2 + i] ?? ''; // sidebar row of thread i (0-based)
const store = () => new Store(project);

log(`project: ${project}\nscreenshots: ${OUT}\n`);

/* 1. Claude starts with a task */
log('1. a Claude thread starts with a task');
check('Claude opens inside the app', await until(/Claude Code|trust this folder|Yes, I trust/i, 60000), text().join('|'));
shot('claude-starts', 'Chorus app: thread 1 is Claude Code, started with a task');
if (has(/trust this folder|Yes, I trust/i)) {
  app.write('\x1b[A');
  await sleep(400);
  app.write('\r');
}
check('sidebar shows the thread and the status line the menu key', /▶1 fix add\(\)/.test(row(0)) && /ctrl\+space: menu/.test(text()[ROWS - 1]), `${row(0)} | ${text()[ROWS - 1]}`);

/* 2. Claude asks for approval while it is in front */
log('2. Claude asks for approval in front');
await until(() => has(/Do you want to (proceed|create|make)/), 120000);
const asked = await until(() => /!/.test(row(0).slice(20)), 10000);
check('the agent\'s own permission prompt is detected (sidebar shows !)', asked, `${row(0)} | ${area().slice(-400)}`);
shot('claude-asks-in-front', 'Claude is in front and asks permission; the sidebar already shows ! for thread 1');

/* 3. open a second thread (Codex) so Claude is in the background */
log('3. a second thread (Codex) from the menu; Claude moves to the background');
menu('n');
check('new-thread dialog lists the agents', await until(/new thread with…/, 5000));
await sleep(400);
shot('new-thread-dialog', 'ctrl+space n: choose which agent to open in a new thread');
app.write('2'); // codex
check('Codex opens in thread 2', await until(/Trust and continue|Ask Codex to do anything/i, 40000), text().join('|'));
if (has(/Trust and continue/i)) {
  app.write('\r'); // "1. Trust and continue"
  await until(/Ask Codex to do anything/i, 20000);
}
check('thread 2 is in front and Claude (thread 1) is still pending', /▶2/.test(row(1)) && /!/.test(row(0).slice(20)), `${row(0)} | ${row(1)}`);
const card = await until(/asks for approval/, 15000);
check('an approval card for the background thread appears over Codex', card, area().slice(-500));
shot('card-for-background-thread', 'Codex is in front; Claude (background) is waiting, and Chorus shows its request as a card');

/* 4. approve from the card until Claude is done */
log('4. approve from the card without switching');
let approvals = 0;
let cardShot = false;
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  if (has(/asks for approval/)) {
    if (!cardShot) { shot('card-detail', 'the card names the thread, the command or file, and the key to answer'); cardShot = true; }
    menu('y');
    approvals++;
    await sleep(2500);
    continue;
  }
  const s = store().listThreads()[0];
  const done = fs.existsSync(path.join(project, 'calc.js')) && store().listArtifacts(s?.id).some(a => a.path === 'notes.md') && /○/.test(row(0).slice(20));
  if (done) break;
  await sleep(1200);
}
check('at least one request was approved from a card', approvals > 0, String(approvals));
check('Claude created calc.js', fs.existsSync(path.join(project, 'calc.js')));
shot('after-approvals', `approved ${approvals} request(s) from the card; thread 2 stayed in front`);
const t1 = store().listThreads().find(t => t.agent === 'claude')!;
check('Claude thread finished: waiting dot, store state', /○/.test(row(0).slice(20)) && store().getThread(t1.id)!.state === 'waiting', `${row(0)} ${store().getThread(t1.id)?.state}`);
check('live tailing recorded the turns, the node call and the usage', (() => { const s = store(); return s.getTurns(t1.id).length >= 2 && s.getToolCalls(t1.id).some(c => /node -e/.test(c.target) && c.status === 'ok') && (s.getUsage(t1.id)?.outputTokens ?? 0) > 0; })());
check('the artifact notes.md was registered', store().listArtifacts(t1.id).some(a => a.path === 'notes.md'), artifactsCmd(store()));

/* 5. Codex thread is independent */
log('5. the Codex thread works on its own');
app.write('Reply with only the text codex-ready-');
await sleep(500);
app.write('42'); // TUIs read text and Enter arriving in one chunk as a paste: type them apart
await sleep(500);
app.write('\r');
check('Codex answers in its own thread', await until(/codex-ready-42/, 90000), area().slice(-300));
shot('codex-own-thread', 'thread 2 (Codex) answers independently while thread 1 is parked in the background');

/* 6. handoff Claude → Codex */
log('6. hand off the Claude thread to Codex');
menu('1');
await sleep(800);
menu('h');
check('handoff dialog names the thread', await until(/hand off "fix add\(\)" to…/, 5000));
await sleep(400);
shot('handoff-dialog', 'ctrl+space h on thread 1: choose the agent that continues the work');
app.write('2');
check('the handoff thread appears as thread 3', await until(() => /▶3/.test(row(2)), 20000), row(2));
const child = (() => { const s = store(); return s.listThreads().find(t => t.parent_thread_id === t1.id); })();
check('the new thread is a child of the Claude thread in the store', !!child && child!.agent === 'codex', JSON.stringify(child));
const loaded = await untilTrusting(() => !!child && store().mcpCalls(child.id).some(m => m.tool === 'get_handoff_context'), 150000);
check('Codex called get_handoff_context (Chorus saw the MCP call)', loaded, JSON.stringify(child && store().mcpCalls(child.id)));
const answered = await untilTrusting(() => !!child && store().getTurns(child.id).some(x => x.role === 'assistant' && /calc/i.test(x.text)), 150000);
shot('handoff-summary', 'the continuing Codex thread loaded the context through the Chorus MCP server and summarises the work');
const reply = child ? store().getTurns(child.id).filter(x => x.role === 'assistant').map(x => x.text).join('\n') : '';
check('its summary names calc.js', answered && /calc\.js/.test(reply), reply.slice(0, 300));
check('the handoff thread settles as waiting', await until(() => /○/.test(row(2).slice(20)), 60000), row(2));

/* 7. views */
log('7. views');
menu('m');
check('memory view shows what the next agent reads', await until(/memory · /, 5000) && /calc\.js/.test(text().join('\n')), text().join('|').slice(0, 300));
shot('memory-view', 'ctrl+space m: the digest a handoff carries (first request, files touched, commands, tests, last message)');
app.write('\x1b');
await sleep(500);
menu('t');
check('tool call view lists the commands', await until(/tool calls · /, 5000) && /✓/.test(text().join('\n')));
shot('tool-calls-view', 'ctrl+space t: every tool call of the thread with status and result');
app.write('\x1b');
await sleep(500);
menu('f');
check('files view lists the artifact', await until(/files and artifacts/, 5000) && /notes\.md/.test(text().join('\n')), text().join('|').slice(0, 300));
shot('files-view', 'ctrl+space f: artifacts per thread and files written by tools');
app.write('\x1b');
await sleep(500);
menu('?');
await until(/Chorus keeps your agents side by side/, 5000);
shot('help-view', 'ctrl+space ?: the keys');
app.write('\x1b');
await sleep(500);
menu('1');
await sleep(1000);
shot('overview', 'final state: three threads (Claude, Codex, and the Codex handoff thread), all waiting');

/* 8. leave */
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
  ['chorus trace <claude thread>', traceCmd(s, t1.id).replaceAll(os.homedir(), '~')],
  ['chorus doctor', doctorCmd(project).replaceAll(os.homedir(), '~')],
];
let md = `# Phase 4 e2e proof\n\nReal \`chorus\` app, real Claude Code and Codex, driven through a PTY (\`npm run proof\`).\nEach screenshot is the terminal as the user sees it at that step.\n\n## Result\n\n| | check |\n|---|---|\n${results.map(r => `| ${r.ok ? '✅' : '❌'} | ${r.name} |`).join('\n')}\n\n## Screenshots\n\n${shots.map(x => `### ${x.file.replace(/\.png$/, '')}\n${x.caption}\n\n![${x.caption}](${x.file})\n`).join('\n')}\n## Commands after the run\n\n${cmds.map(([c, o]) => `\`\`\`\n$ ${c}\n${o}\n\`\`\``).join('\n\n')}\n`;
fs.writeFileSync(path.join(OUT, 'README.md'), md.replaceAll(project, '$PROJECT').replaceAll(os.homedir(), '~'));
s.close();
const failed = results.filter(r => !r.ok).length;
log(`\n${failed ? 'FAILED' : 'OK'}: ${results.length - failed}/${results.length} checks. Report: ${path.join(OUT, 'README.md')}`);
try { app.kill(); } catch {}
process.exit(failed ? 1 : 0);
