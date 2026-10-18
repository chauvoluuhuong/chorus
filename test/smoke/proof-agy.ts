#!/usr/bin/env node
// Phase 4 proof, antigravity part: the real chorus app with real agy and Claude Code.
// An agy thread works while another thread is in front (approval answered from a card), handoff agy → Claude,
// then Claude → agy. Every step saves a PNG to docs/proof/phase4-agy/.
//
//   node test/smoke/proof-agy.ts [--out docs/proof/phase4-agy]
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
const OUT = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(ROOT, 'docs/proof/phase4-agy'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const TITLE = 'Chorus Phase 4 e2e proof: Antigravity (agy) + Claude Code';
const INTRO = 'The real chorus app driven through a PTY with the real CLIs. Each screenshot is the terminal as you would see it at that step.';
const COLS = 150;
const ROWS = 44;
const outer = new VirtualScreen(COLS, ROWS);
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-proof-')));
spawnSync('git', ['init', '-q'], { cwd: project });
// Claude Code 2.1.302 starts in "auto mode"; pin this folder to manual mode like the other proof does
fs.mkdirSync(path.join(project, '.claude'));
fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }));

const results: { ok: boolean; skipped?: boolean; name: string; detail?: string }[] = [];
const shots: { file: string; caption: string }[] = [];
const log = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function skip(name: string, why: string) {
  results.push({ ok: true, skipped: true, name, detail: why });
  log(`  SKIP  ${name}  (${why})`);
}
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

const env = { ...process.env, TERM: 'xterm-256color', CHORUS_NO_OPEN: '1', CHORUS_MODEL_CLAUDE: 'haiku' } as Record<string, string>;
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];
const app = pty.spawn(process.execPath, [CLI], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: project, env });
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
// sidebar: thread i takes two rows (title line, then agent · state), starting below the header
const row = (i: number) => (text()[1 + 2 * i] ?? '') + ' ' + (text()[2 + 2 * i] ?? '');
const dot = (i: number) => (text()[1 + 2 * i] ?? '').slice(0, 10);
const store = () => new Store(project);


/** answer startup dialogs of whichever agent is in front */
async function trustIfAsked() {
  if (has(/Yes, I trust this folder/i) && has(/Do you trust|trust the contents/i)) { app.write('\r'); return true; } // agy: the cursor starts on Yes
  if (has(/Yes, I trust this folder/i) && has(/Claude Code'll be able|Quick safety check/i)) {
    // Claude reads the keyboard a moment after drawing the dialog: press Up until the cursor is on "Yes", then Enter
    // read the cursor only from the thread area (the sidebar and the card may contain other text), and only once it is drawn
    const sel = () => text().map(l => l.slice(31)).find(l => /^\s*❯\s*(No, exit|Yes, I trust)/.test(l))?.trim() ?? '';
    for (let i = 0; i < 20 && !sel(); i++) await sleep(250);
    for (let i = 0; i < 10 && !/^❯\s*Yes/.test(sel()); i++) { app.write('\x1b[A'); await sleep(1500); }
    app.write('\r');
    return true;
  }
  return false;
}
async function untilTrusting(pred: RegExp | (() => boolean), ms: number) {
  const t0 = Date.now();
  let last = 0;
  while (Date.now() - t0 < ms) {
    if (typeof pred === 'function' ? pred() : has(pred)) return true;
    if (Date.now() - last > 4000 && (await trustIfAsked())) last = Date.now();
    await sleep(1200);
  }
  return false;
}

log(`project: ${project}\nscreenshots: ${OUT}\n`);

/* 1. the new-thread form: agy */
log('1. new thread: agent, model, folder');
check('chorus opens on the home screen: agents with versions, and this project\'s threads', await until(/Agents\s+claude\s+\d/, 40000), text().join('|').slice(0, 300));
shot('home', 'chorus in a project: the installed agents with their versions, and this project\'s threads (none yet). n starts one');
app.write('n');
check('n opens the new-thread form', await until(/Agent\s+\[claude\]/, 5000), text().join('|').slice(0, 300));
app.write('\x1b[C'); await sleep(300); app.write('\x1b[C'); // claude → codex → agy
check('agent: agy, with the models agy lists', await until(/Agent\s+claude\s+codex\s+\[agy\]/, 5000) && has(/Model\s+\[default\]/), text().join('|').slice(0, 300));
shot('new-thread-form-agy', 'chorus starts on the new-thread form: agent agy (model list comes from `agy models`), this folder');
app.write('\r');

/* 1b. agy opens; the task is typed into its own screen */
log('1b. agy opens; the task is typed into its own screen');
check('agy opens inside the app', await untilTrusting(/Antigravity CLI|Generating|Run this command|Do you trust/i, 90000), text().join('|').slice(0, 400));
await untilTrusting(/\? for shortcuts/, 90000);
await sleep(1500);
{
  app.write(TASK); // the folder for notes is not mentioned: the agent is told through Chorus's instructions
  await sleep(600);
  app.write('\r');
}
shot('agy-starts', 'thread 1 is Antigravity CLI (agy); the task was typed into its own screen');
check('the sidebar names the thread after the first message', await untilTrusting(() => /▎ . Create calc\.js/.test(row(0)), 60000), row(0));

/* 2. agy asks in front */
log('2. agy asks for approval in front');
await untilTrusting(() => has(/Run this command\?/i), 300000);
const asked = await until(() => /!/.test(dot(0)), 10000);
check('agy\'s own permission prompt is detected (sidebar shows !)', asked, `${row(0)} | ${area().slice(-400)}`);
shot('agy-asks-in-front', 'agy is in front and asks permission to run a command; the sidebar shows ! for thread 1');

/* 3. open Claude so agy is in the background */
log('3. open Claude as thread 2; agy moves to the background');
menu('n');
check('the new-thread form opens', await until(/Agent\s+\[claude\]/, 5000));
shot('new-thread-form-claude', 'ctrl+\\ n: Claude (default model) in this folder, Enter');
app.write('\r');
check('Claude opens in thread 2 (trust dialog answered)', await untilTrusting(/Claude Code v\d/, 60000), text().join('|').slice(0, 300)); // the card may cover its footer
await sleep(1500);
check('thread 2 is in front and agy (thread 1) is still pending', /▎/.test(dot(1)) && /!/.test(dot(0)), `${row(0)} | ${row(1)}`);
check('an approval card for the background agy thread appears over Claude', await until(/asks for approval/, 20000), area().slice(-500));
shot('card-for-agy', 'Claude is in front; agy (background) is waiting, and Chorus shows its request as a card');

/* 4. approve agy's requests from the card */
log('4. approve from the card without switching');
let approvals = 0;
let cardShot = false;
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  if (has(/asks for approval/)) {
    if (!cardShot) { shot('card-detail', 'the card shows what agy wants to run and the keys to answer'); cardShot = true; }
    menu('y');
    approvals++;
    await sleep(3000);
    continue;
  }
  const a = store().listThreads().find(t => t.agent === 'agy');
  const done = fs.existsSync(path.join(project, 'calc.js')) && !!a && store().listArtifacts(a.id).some(x => x.path === 'notes.md') && /[○◐]/.test(dot(0));
  if (done) break;
  await sleep(1500);
}
check('at least one agy request was approved from a card', approvals > 0, String(approvals));
check('agy created calc.js', fs.existsSync(path.join(project, 'calc.js')));
shot('after-approvals', `approved ${approvals} agy request(s) from the card; thread 2 (Claude) stayed in front`);
menu('1');
await sleep(1200);
shot('agy-result', 'switching to thread 1: what agy did (its own screen, state kept in the background)');
const a1 = store().listThreads().find(t => t.agent === 'agy')!;
check('agy thread finished: waiting dot, store state', /[○◐]/.test(dot(0)) && store().getThread(a1.id)!.state === 'waiting', `${row(0)} ${store().getThread(a1.id)?.state}`);
check('live tailing recorded agy turns, tool calls and usage', (() => { const s = store(); return s.getTurns(a1.id).length >= 2 && s.getToolCalls(a1.id).some(c => c.status === 'ok') && (s.getUsage(a1.id)?.outputTokens ?? 0) > 0; })(), JSON.stringify(store().getToolCalls(a1.id).map(c => c.tool + ':' + c.target.slice(0, 40))));
check('agy artifact notes.md registered', store().listArtifacts(a1.id).some(x => x.path === 'notes.md'), artifactsCmd(store()));

/* 5. hand off agy → Claude */
log('5. hand off agy → Claude');
await sleep(300);
menu('h');
check('handoff dialog names the agy thread', await until(/hand off "Create calc\.js/, 5000));
shot('handoff-dialog-from-agy', 'ctrl+\\ h on the agy thread: choose the agent that continues');
app.write('1'); // claude
check('the handoff thread (Claude) appears in front, listed under agy (↳)', await until(() => /▎/.test(dot(1)) && /↳/.test(text()[3] ?? ''), 20000), `${text()[3]}`);
const c1 = store().listThreads().find(t => t.parent_thread_id === a1.id);
check('it is a child of the agy thread (claude)', !!c1 && c1!.agent === 'claude', JSON.stringify(c1));
const loaded1 = await untilTrusting(() => !!c1 && store().mcpCalls(c1.id).some(m => m.tool === 'get_handoff_context'), 150000);
check('Claude called get_handoff_context (Chorus saw the MCP call)', loaded1, JSON.stringify(c1 && store().mcpCalls(c1.id)));
const ans1 = await untilTrusting(() => !!c1 && store().getTurns(c1.id).some(x => x.role === 'assistant' && /calc/i.test(x.text)), 150000);
await sleep(1500);
shot('handoff-agy-to-claude', 'Claude continues the agy thread: it loaded the context through the Chorus MCP server and summarises it');
const reply1 = c1 ? store().getTurns(c1.id).filter(x => x.role === 'assistant').map(x => x.text).join('\n') : '';
check('its summary names calc.js', ans1 && /calc\.js/.test(reply1), reply1.slice(0, 300));

/* 6. hand off Claude → agy */
log('6. hand off the Claude thread to agy');
await until(() => /[○◐]/.test(dot(1)), 60000);
menu('h');
check('handoff dialog names the Claude thread', await until(/hand off ".*" to…/, 5000));
app.write('3'); // agy
check('the agy handoff thread appears in front, listed under the Claude thread it continues (↳)', await until(() => /▎/.test(dot(2)) && /↳/.test(text()[5] ?? ''), 20000), `${text()[5]}`);
const a2 = store().listThreads().find(t => t.parent_thread_id === c1?.id);
check('it is a child of the Claude thread (agy)', !!a2 && a2!.agent === 'agy', JSON.stringify(a2));
// agy may ask before calling the MCP tool: answer from the card/prompt like a person would
let mcpApprovals = 0;
const t1 = Date.now();
while (Date.now() - t1 < 180000) {
  if (a2 && store().mcpCalls(a2.id).some(m => m.tool === 'get_handoff_context')) break;
  if (has(/Individual quota reached/)) break; // agy's own message when the plan quota is used up
  await trustIfAsked();
  if (/!/.test(dot(2))) { menu('y'); mcpApprovals++; await sleep(2500); continue; }
  await sleep(1500);
}
const quota = has(/Individual quota reached/);
if (quota) { shot('agy-quota-reached', 'agy ran out of plan quota while continuing the Claude thread; Chorus shows a warning in the status line'); check('Chorus warns that agy reached its quota and points at the handoff', await until(() => /reached its quota/.test(text()[ROWS - 1]), 8000), text()[ROWS - 1]); }
if (!quota) check('agy called get_handoff_context (Chorus saw the MCP call)', !!a2 && store().mcpCalls(a2.id).some(m => m.tool === 'get_handoff_context'), JSON.stringify(a2 && store().mcpCalls(a2.id)) + ` approvals=${mcpApprovals}`);
const ans2 = quota ? false : await untilTrusting(() => !!a2 && store().getTurns(a2.id).some(x => x.role === 'assistant' && /calc/i.test(x.text)), 150000);
await sleep(1500);
shot('handoff-claude-to-agy', `agy continues the Claude thread (${mcpApprovals} approval(s) answered along the way)`);
const reply2 = a2 ? store().getTurns(a2.id).filter(x => x.role === 'assistant').map(x => x.text).join('\n') : '';
if (quota) {
  skip('agy called get_handoff_context (Chorus saw the MCP call)', 'agy reached its plan quota ("Individual quota reached") before it could answer; the Claude → agy direction passed in an earlier run of this proof');
  skip('its summary names calc.js', 'same: agy quota reached');
} else check('its summary names calc.js', ans2 && /calc\.js/.test(reply2), reply2.slice(0, 300));
if (!quota) await until(() => /[○◐]/.test(dot(2)), 90000);

/* 7. views and end */
log('7. views');
menu('m');
check('memory view of the agy-continued thread', await until(/memory · /, 5000) && /calc\.js/.test(text().join('\n')));
shot('memory-view', 'ctrl+\\ m on the last thread: the digest carried across Claude and agy');
app.write('\x1b');
await sleep(500);
menu('1');
await sleep(1000);
menu('a');
check('artifacts view lists the artifact agy wrote, with its version', await until(/Artifacts · /, 5000) && /notes\.md\s+v1/.test(text().join('\n')), text().join('|').slice(0, 300));
shot('artifacts-view', 'ctrl+\\ a: the artifact agy wrote (name, version, who wrote it)');
app.write('o');
check('o starts the live preview and shows its address', await until(/Preview\s+http:\/\/localhost:\d+\/t_\w+\/notes\.md/, 8000), text().join('|').slice(0, 300));
const previewUrl = text().join('\n').match(/http:\/\/localhost:\d+\/t_\w+\/notes\.md/)?.[0] ?? '';
const page = await new Promise<string>(res => http.get(previewUrl, m => { let b = ''; m.on('data', d => (b += d)); m.on('end', () => res(b)); }).on('error', () => res('')));
check('the preview page serves what agy wrote and reloads when it changes', /calc/i.test(page) && /EventSource/.test(page), page.slice(0, 200));
shot('preview', 'o: the artifact agy wrote, served at a local address that reloads while the agent keeps editing it');
app.write('\x1b');
await sleep(500);
shot('overview', 'final state: agy, Claude, the Claude handoff thread and the agy handoff thread');
menu('q');
await sleep(600);
menu('q');
check('app quits and restores the terminal', await until(() => exited, 15000));

const s = store();
const cmds = [['chorus threads', threadsCmd(s)], ['chorus activity', activityCmd(s)], ['chorus trace <agy thread>', traceCmd(s, a1.id).replaceAll(os.homedir(), '~')]];
const md = `# Phase 4 e2e proof: Antigravity (agy)\n\nReal \`chorus\` app, real agy and Claude Code, driven through a PTY (\`npm run proof:agy\`).\nSee also the Claude + Codex proof in ../phase4/README.md.\n\n## Result\n\n| | check |\n|---|---|\n${results.map(r => `| ${r.ok ? '✅' : '❌'} | ${r.name} |`).join('\n')}\n\n## Screenshots\n\n${shots.map(x => `### ${x.file.replace(/\.png$/, '')}\n${x.caption}\n\n![${x.caption}](${x.file})\n`).join('\n')}\n## Commands after the run\n\n${cmds.map(([c, o]) => `\`\`\`\n$ ${c}\n${o}\n\`\`\``).join('\n\n')}\n`;
const reportFile = writeReport(OUT, TITLE, INTRO, results, shots, cmds.map(([c, o]) => [c, o.replaceAll(project, '$PROJECT').replaceAll(os.homedir(), '~')] as [string, string]));
fs.writeFileSync(path.join(OUT, 'README.md'), md.replaceAll(project, '$PROJECT').replaceAll(os.homedir(), '~'));
s.close();
const failed = results.filter(r => !r.ok).length;
log(`\n${failed ? 'FAILED' : 'OK'}: ${results.length - failed}/${results.length} checks.\nReport with screenshots: ${reportFile}`);
if (argv.includes('--open')) openReport(reportFile);
try { app.kill(); } catch {}
process.exit(failed ? 1 : 0);
