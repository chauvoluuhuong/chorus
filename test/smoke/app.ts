#!/usr/bin/env node
// L3 for P4.1: the real app hosting the real agent TUIs. The app runs in an outer PTY; what the user sees is
// rebuilt in a virtual terminal and asserted on.
//
//   node test/smoke/app.ts [--agents claude,codex,agy]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { VirtualScreen } from '../../src/app/screen.ts';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const CLI = path.resolve(import.meta.dirname, '../../src/cli/index.ts');
const argv = process.argv.slice(2);
const agents = (argv.includes('--agents') ? argv[argv.indexOf('--agents') + 1] : 'claude,codex,agy').split(',');
const COMMAND: Record<string, string> = { claude: 'claude --model haiku --permission-mode acceptEdits', codex: 'codex', agy: 'agy --dangerously-skip-permissions' };
const TRUST: Record<string, { re: RegExp; keys: string[] }> = {
  // keys are sent one by one: TUIs read an arrow and Enter arriving in one chunk as a different key
  claude: { re: /trust this folder|Yes, I trust/i, keys: ['\x1b[A', '\r'] },
  codex: { re: /Trust and continue|OpenAI Codex/i, keys: [] }, // trusted folders skip the dialog
  agy: { re: /Yes, I trust this folder/i, keys: ['\r'] },
};
const PROMPT = (a: string) => `Reply with only the text ${a}- followed by the product of 6 and 7.`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let failed = 0;
const dump = () => text().map(l => l.trimEnd()).filter(Boolean).join('\n');
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok && process.env.DEBUG) console.log('--- screen ---\n' + dump() + '\n--------------');
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail.slice(0, 300)})`}`);
  if (!ok) failed++;
};

const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-p41-')));
fs.mkdirSync(path.join(cwd, '.git'));
const COLS = 140;
const ROWS = 40;
const outer = new VirtualScreen(COLS, ROWS);
let rawOut = '';
const env = { ...process.env, TERM: 'xterm-256color' } as Record<string, string>;
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];
const p = pty.spawn(process.execPath, [CLI, 'mux', ...agents.map(a => COMMAND[a])], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd, env });
p.onData((d: string) => {
  rawOut += d;
  outer.write(d);
});
let exited = false;
p.onExit(() => (exited = true));

const text = () => outer.text();
const screenHas = (re: RegExp) => text().some(l => re.test(l));
async function until(re: RegExp, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(250);
    if (screenHas(re)) return true;
  }
  return false;
}
const menu = (key: string) => p.write('\x00' + key);

console.log(`app in ${cwd}`);
// 1. each agent starts inside the app; answer its trust dialog while it is in front
for (const [i, a] of agents.entries()) {
  if (i > 0) { menu(String(i + 1)); await sleep(500); }
  const shown = await until(TRUST[a].re, 45000);
  check(`${a}: starts in its thread and shows its own startup screen`, shown, text().filter(l => l.trim()).join(' | '));
  if (shown) for (const k of TRUST[a].keys) { p.write(k); await sleep(400); }
  await sleep(1500);
}
const sidebar = text().slice(0, ROWS - 1).map(l => l.slice(0, 26)).join('\n');
check('sidebar lists every thread', agents.every((a, i) => new RegExp(`${i + 1} ${COMMAND[a].split(' ')[0]}`).test(sidebar)), sidebar);
check('status line is the last row', /ctrl\+space: menu/.test(text()[ROWS - 1]), text()[ROWS - 1]);

// 2. a prompt typed into each thread reaches only that agent and its answer shows in that thread
for (const [i, a] of agents.entries()) {
  menu(String(i + 1)); await sleep(500);
  await until(/\S/, 1000);
  p.write(PROMPT(a));
  await sleep(500); // agents treat text+Enter arriving at once as a paste; a person types them apart
  p.write('\r');
}
for (const [i, a] of agents.entries()) {
  menu(String(i + 1));
  const ok = await until(new RegExp(`${a}-42`), 90000);
  check(`${a}: its answer is shown in its thread`, ok, text().filter(l => l.trim()).slice(-8).join(' | '));
  const others = agents.filter(x => x !== a).some(x => new RegExp(`${x}-42`).test(text().slice(0, ROWS - 1).map(l => l.slice(27)).join('\n')));
  check(`${a}: other agents' answers are not on this screen`, !others);
}

// 3. switching back keeps the state, resize reaches the agent
menu('1'); await sleep(800);
check('thread 1 still shows its earlier answer after switching around', screenHas(new RegExp(`${agents[0]}-42`)));
p.resize(120, 32); outer.resize(120, 32);
await sleep(2500);
check('after resize the status line is on the new last row', /ctrl\+space: menu/.test(text()[31]), text()[31]);
check('after resize the frame has no leftovers below the status line', text().slice(32).every(l => !l.trim()));

// 4. leave: menu + q twice, terminal restored
menu('q'); await sleep(500);
check('quit asks for confirmation while agents run', screenHas(/still running/));
menu('q'); await sleep(2500);
check('app exits and restores the terminal', exited && /\x1b\[\?1049l$/.test(rawOut.slice(-40)), rawOut.slice(-60));
try { p.kill(); } catch {}
console.log(failed ? '\nFAILED' : '\nOK');
process.exit(failed ? 1 : 0);
