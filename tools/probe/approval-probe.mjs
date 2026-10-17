#!/usr/bin/env node
// Approval research (docs/phase4.md §4): can a hook decide a tool call in the INTERACTIVE TUI?
//
//   node tools/probe/approval-probe.mjs <claude|codex|agy> <allow|deny|ask> [--out fixtures] [--wait 60]
//
// Starts the real TUI with a PreToolUse (or permission) hook that logs its stdin and answers with the given
// decision after a 3 s delay (a person reading a card), then asks the agent to create a file with the shell.
// Records: hook payloads, the answer format used, whether the file was created, the final screen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const [cli, decision] = process.argv.slice(2);
const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : d);
const outRoot = path.resolve(opt('out', 'fixtures'));
const waitSec = Number(opt('wait', 70));
const version = spawnSync(cli, ['--version'], { encoding: 'utf8' }).stdout.trim().replace(/^codex-cli /, '').replace(/ \(.*/, '');
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `chorus-appr-${cli}-`)));
spawnSync('git', ['init', '-q'], { cwd: ws });
const answerOverride = opt('answer', '');
const keysAfterPrompt = opt('keys', ''); // keystrokes (JSON string) typed once the agent's own prompt appears
let keysSent = false;
const dest = path.join(outRoot, cli, version, `approval-${decision}${opt('tag', '') ? '-' + opt('tag', '') : ''}`);
fs.mkdirSync(dest, { recursive: true });
const log = path.join(ws, 'hook-log.jsonl');
const outside = args.includes('--outside'); // a path the sandbox must ask about (outside the workspace)
const target = outside ? path.join(os.homedir(), '.chorus-approval-probe', 'approval-probe-file.txt') : path.join(ws, 'approval-probe-file.txt');
if (outside) fs.rmSync(path.dirname(target), { recursive: true, force: true });

// hook script: log stdin, wait 3 s, answer
const hook = path.join(ws, 'hook.mjs');
const answers = {
  claude: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: `chorus probe: ${decision}` } },
  agy: { decision, reason: `chorus probe: ${decision}` },
  codex: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: `chorus probe: ${decision}` } },
};
fs.writeFileSync(hook, `
import fs from 'node:fs';
let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',async()=>{
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({t:Date.now(), stdin: s.slice(0,3000)})+'\\n');
  await new Promise(r=>setTimeout(r,3000));
  const out = ${JSON.stringify(answerOverride || JSON.stringify(answers[cli]))};
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({t:Date.now(), answered: out})+'\\n');
  process.stdout.write(out);
});`);
const hookCmd = `${process.execPath} ${hook}`;

const env = { ...process.env, TERM: 'xterm-256color' };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];
const PROMPT = `Use your shell tool to run exactly: mkdir -p ${path.dirname(target)} && touch ${target} . Then reply with only: finished`;
let argv;
if (cli === 'claude') {
  const settings = { hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: hookCmd, timeout: 60 }] }] } };
  argv = ['--settings', JSON.stringify(settings), '--model', 'haiku', PROMPT];
} else if (cli === 'agy') {
  fs.mkdirSync(path.join(ws, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.agents', 'hooks.json'), JSON.stringify({ chorus: { PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: hookCmd, timeout: 60 }] }] } }, null, 2));
  argv = ['-i', PROMPT];
} else {
  const hooks = { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: hookCmd, timeout: 60 }] }] };
  const toml = o => (Array.isArray(o) ? `[${o.map(toml).join(',')}]` : typeof o === 'object' ? `{${Object.entries(o).map(([k, v]) => `${k}=${toml(v)}`).join(',')}}` : JSON.stringify(o));
  const hookArgs = args.includes('--nohook') ? [] : ['-c', `hooks=${toml(hooks)}`, '--dangerously-bypass-hook-trust'];
  argv = [...hookArgs, '-s', outside ? 'workspace-write' : 'read-only', '-a', 'on-request', PROMPT];
}

const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
const p = pty.spawn(cli, argv, { name: 'xterm-256color', cols: 120, rows: 40, cwd: ws, env });
p.onData(d => term.write(d));
p.onExit(e => (exited = e.exitCode));
let exited = null;
const screen = () => { const b = term.buffer.active; const l = []; for (let y = 0; y < 40; y++) l.push(b.getLine(y).translateToString(true)); return l.filter(x => x.trim()).join('\n'); };
const redact = s => s.split(os.homedir()).join('~').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, '<email>');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let answered = 0;
const t0 = Date.now();
let sawPrompt = '';
while (Date.now() - t0 < waitSec * 1000) {
  await sleep(1500);
  const s = screen();
  if (answered < 2 && /trust (this|the contents)|Trust and continue|Yes, I trust/i.test(s) && !/approval-probe|finished/.test(s)) {
    if (cli === 'claude') { p.write('\x1b[A'); await sleep(300); }
    p.write('\r'); answered++; continue;
  }
  if (keysAfterPrompt && !keysSent && /Run this command\?|Do you want to proceed|Would you like to run/i.test(s) && (fs.existsSync(log) || args.includes('--nohook'))) {
    await sleep(1000);
    fs.writeFileSync(path.join(dest, 'prompt-screen.txt'), redact(screen()));
    for (const k of JSON.parse(keysAfterPrompt)) { p.write(k); await sleep(400); }
    keysSent = true; await sleep(5000); sawPrompt = screen(); break;
  }
  const log2 = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  if (/answered/.test(log2) && Date.now() - t0 > 12000) {
    // after the hook answered, give the agent time to react; record any prompt it shows
    await sleep(6000);
    sawPrompt = screen();
    break;
  }
}
const finalScreen = redact(sawPrompt || screen());
try { p.write('\x03'); await sleep(500); p.write('\x03'); await sleep(800); p.kill(); } catch {}
if (outside) { var created = fs.existsSync(target); fs.rmSync(path.dirname(target), { recursive: true, force: true }); }
const result = {
  cli, version, decision,
  hookCalled: fs.existsSync(log),
  fileCreated: outside ? created : fs.existsSync(target),
  answeredStartupPrompts: answered,
  promptSeenAndKeysSent: keysSent,
  hookLog: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [],
};
fs.writeFileSync(path.join(dest, 'result.json'), redact(JSON.stringify(result, null, 2)));
fs.writeFileSync(path.join(dest, 'screen.txt'), finalScreen.slice(-6000));
console.log(JSON.stringify({ cli, decision, hookCalled: result.hookCalled, fileCreated: result.fileCreated }), '\n--- screen (tail) ---\n' + finalScreen.split('\n').slice(-14).join('\n'));
