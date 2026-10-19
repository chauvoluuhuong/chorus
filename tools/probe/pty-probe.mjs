#!/usr/bin/env node
// Interactive (PTY) probe: starts the real TUI of a CLI with a first prompt in a throwaway
// workspace, answers startup prompts, waits for the reply, then records what machine-readable
// data appeared on disk while the TUI was still running (transcript, hooks).
//
//   node tools/probe/pty-probe.mjs <claude|codex|agy> [--out fixtures] [--wait 60] [--keys "\r"]
//
// Output: <out>/<cli>/<version>/pty/{screen.txt,events.json,transcript.jsonl,hook-events.jsonl}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pty = require('node-pty');

const args = process.argv.slice(2);
const cli = args[0];
const opt = (n, d) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : d);
const outRoot = path.resolve(opt('out', 'fixtures'));
const waitSec = Number(opt('wait', 75));
const PROMPT = 'Use your shell tool to run: echo pty-probe-$((6*7)) then reply with only the output.';
const EXPECT = 'pty-probe-42';

const version = spawnSync(cli, ['--version'], { encoding: 'utf8' }).stdout.trim().replace(/^codex-cli /, '').replace(/ \(.*/, '');
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `chorus-pty-${cli}-`)));
spawnSync('git', ['init', '-q'], { cwd: ws });
const dest = path.join(outRoot, cli, version, 'pty');
fs.mkdirSync(dest, { recursive: true });
const hookFile = path.join(ws, 'hook-events.jsonl');

const env = { ...process.env, TERM: 'xterm-256color' };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];

let argv;
if (cli === 'claude') {
  const hook = { hooks: {} };
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd']) {
    hook.hooks[ev] = [{ matcher: ev === 'PreToolUse' || ev === 'PostToolUse' ? '.*' : undefined, hooks: [{ type: 'command', command: `cat >> ${hookFile}; echo >> ${hookFile}` }] }];
  }
  argv = ['--settings', JSON.stringify(hook), '--permission-mode', 'acceptEdits', '--model', 'haiku', PROMPT];
} else if (cli === 'codex') {
  argv = ['-s', 'workspace-write', '-c', 'approval_policy="never"', PROMPT];
} else {
  argv = ['--dangerously-skip-permissions', '-i', PROMPT];
}

const term = pty.spawn(cli, argv, { name: 'xterm-256color', cols: 120, rows: 40, cwd: ws, env });
let screen = '';
const events = [];
const t0 = Date.now();
term.onData(d => {
  screen += d;
  events.push({ t: Date.now() - t0, bytes: d.length });
});
const strip = s => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|[\x00-\x08\x0b-\x1f]/g, '');

// answer startup prompts (trust folder, etc.) by pressing Enter when the screen asks
let answered = 0;
const poke = setInterval(() => {
  const tail = strip(screen).slice(-600);
  if (answered < 3 && /trust|Do you want|Yes, continue|Press enter|Allow/i.test(tail) && !tail.includes(EXPECT)) {
    // Claude's folder-trust dialog may start on "No, exit": move up to "Yes" first (clamped at the top)
    if (cli === 'claude' && /trust/i.test(tail)) term.write('\x1b[A');
    setTimeout(() => term.write('\r'), 300);
    answered++;
  }
}, 2500);

function findTranscript() {
  const home = os.homedir();
  const roots = { claude: path.join(home, '.claude/projects'), codex: path.join(home, '.codex/sessions'), agy: path.join(home, '.gemini/antigravity-cli/brain') };
  const out = [];
  const walk = d => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.jsonl$/.test(e.name) && fs.statSync(p).mtimeMs > t0 - 1000) out.push(p);
    }
  };
  // only this workspace's own transcripts (other Claude sessions on the machine write here too)
  walk(cli === 'claude' ? path.join(roots.claude, ws.replace(/[^a-zA-Z0-9]/g, '-')) : roots[cli]);
  return out.filter(p => (cli === 'agy' ? /logs\/transcript\.jsonl$/.test(p) : true));
}

const deadline = Date.now() + waitSec * 1000;
let found = null;
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 1500));
  const files = findTranscript();
  const f = files.find(p => fs.readFileSync(p, 'utf8').includes(EXPECT) && /assistant|PLANNER_RESPONSE|AgentMessage|agent_message/.test(fs.readFileSync(p, 'utf8')));
  if (f) {
    found = { file: f, ms: Date.now() - t0 };
    break;
  }
}
clearInterval(poke);
const aliveAtCapture = true;
const transcriptWhileRunning = found ? fs.readFileSync(found.file, 'utf8') : '';
// exit: Ctrl-C twice, then kill
term.write('\x03');
await new Promise(r => setTimeout(r, 800));
term.write('\x03');
await new Promise(r => setTimeout(r, 1500));
try { term.kill(); } catch {}

const KEYS = /("(?:organizationUuid|organization_uuid|accountUuid|account_uuid|userId|user_id|email|userEmail|account_id|accountId|creator_user_id|creator_account_id)"\s*:\s*)"[^"]*"/g;
const redact = s => s.replace(KEYS, '$1"<redacted>"').split(os.homedir()).join('~').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
fs.writeFileSync(path.join(dest, 'screen.txt'), redact(strip(screen)).slice(-8000));
fs.writeFileSync(path.join(dest, 'events.json'), JSON.stringify({ version, ws: redact(ws), answeredStartupPrompts: answered, transcript: found && { file: redact(found.file), msUntilVisible: found.ms }, bytes: screen.length, aliveAtCapture }, null, 2));
if (found) fs.writeFileSync(path.join(dest, 'transcript.jsonl'), redact(transcriptWhileRunning));
if (fs.existsSync(hookFile)) fs.writeFileSync(path.join(dest, 'hook-events.jsonl'), redact(fs.readFileSync(hookFile, 'utf8')));
console.log(JSON.stringify({ cli, version, answeredStartupPrompts: answered, transcript: found && { file: redact(found.file), msUntilVisible: found.ms }, hookEvents: fs.existsSync(hookFile) }, null, 1));
console.log('--- last screen ---\n' + redact(strip(screen)).slice(-700));
process.exit(found ? 0 : 1);
