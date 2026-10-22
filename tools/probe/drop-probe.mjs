#!/usr/bin/env node
// Drop probe: what each real TUI does when a file path arrives the way a terminal sends a dropped file (backslash-escaped,
// as a bracketed paste when the program asked for it). Two files outside the workspace, both with a space in the name:
//   image: a solid red PNG    → "what colour is it?"  (did the model see the image?)
//   pdf:   one page with a word → "what is the word?"  (did the agent read it, and did it ask first?)
// The screen is drawn with @xterm/headless, which also answers the program's terminal queries, as Chorus does.
//
//   node tools/probe/drop-probe.mjs <claude|codex|agy> [--out fixtures] [--wait 90] [--start-bottom]
//
// --start-bottom puts the cursor on the last row before the program starts (the agy input-at-the-bottom idea) and records
// whether the program cleared or homed the screen anyway.
// Output: <out>/<cli>/<version>/drop/{image-pasted,image-reply,pdf-pasted,pdf-reply}.txt + summary.json
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pdf, png } from './sample-files.mjs';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const args = process.argv.slice(2);
const cli = args[0];
const opt = (n, d) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : d);
const outRoot = path.resolve(opt('out', 'fixtures'));
const waitSec = Number(opt('wait', 90));
const startBottom = args.includes('--start-bottom');
const COLS = 120, ROWS = 40;

const version = spawnSync(cli, ['--version'], { encoding: 'utf8' }).stdout.trim().replace(/^codex-cli /, '').replace(/ \(.*/, '');
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `chorus-drop-${cli}-`)));
spawnSync('git', ['init', '-q'], { cwd: ws });
// the dropped files live outside the workspace, like a file from ~/Downloads
const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-drop-files-')));
const dest = path.join(outRoot, cli, version, args.includes('--startup-only') ? `startup${startBottom ? '-bottom' : '-top'}` : args.includes('--default-permissions') ? 'drop-default-permissions' : 'drop');
fs.mkdirSync(dest, { recursive: true });

// ---------- the two files ----------
const SECRET = 'PINEAPPLE';
const imgPath = path.join(elsewhere, 'drop shot.png');
const pdfPath = path.join(elsewhere, 'drop spec.pdf');
fs.writeFileSync(imgPath, png(64, 64, [220, 20, 20]));
fs.writeFileSync(pdfPath, pdf(`The secret word is ${SECRET}.`));

// ---------- the agent in a PTY, drawn by a headless terminal ----------
const env = { ...process.env, TERM: 'xterm-256color' };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];
// --default-permissions: Claude in its default mode, not the user's own default (which may be auto), to see whether a file
// outside the folder makes it ask
const argv = cli === 'claude' ? ['--model', 'haiku', ...(args.includes('--default-permissions') ? ['--permission-mode', 'default'] : [])] : cli === 'codex' ? ['-c', 'model_reasoning_effort="low"'] : [];

const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 0 });
if (startBottom) term.write(`\x1b[${ROWS};1H`);
const p = pty.spawn(cli, argv, { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: ws, env });
let raw = '';
const t0 = Date.now();
p.onData(d => { raw += d; term.write(d); });
term.onData(d => p.write(d)); // cursor position reports, device attributes …
const sleep = ms => new Promise(r => setTimeout(r, ms));
const flush = () => new Promise(r => term.write('', r));
const screen = async () => {
  await flush();
  const b = term.buffer.active;
  return Array.from({ length: ROWS }, (_, y) => b.getLine(y)?.translateToString(true) ?? '').join('\n');
};
const lastRow = async () => (await screen()).split('\n').reduce((n, l, i) => (l.trim() ? i : n), -1);
const redact = s => s.split(os.homedir()).join('~').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
const save = async (name, text) => fs.writeFileSync(path.join(dest, name), redact(text ?? (await screen())));

// startup: answer folder-trust style prompts with Enter, then wait for the screen to settle
let answered = 0;
for (let i = 0, quiet = 0, before = ''; i < 40 && quiet < 3; i++) {
  await sleep(1000);
  const s = await screen();
  if (answered < 3 && /trust|Do you trust|Yes, continue|Press enter to continue/i.test(s)) {
    if (cli === 'claude' && /trust/i.test(s)) p.write('\x1b[A');
    await sleep(300); p.write('\r'); answered++; quiet = 0; before = ''; continue;
  }
  quiet = s === before ? quiet + 1 : 0;
  before = s;
}
const startup = { clearedScreen: /\x1b\[2J/.test(raw), homedCursor: /\x1b\[H|\x1b\[1;1H/.test(raw), altScreen: /\x1b\[\?1049h/.test(raw), lastNonEmptyRow: await lastRow() };
await save('startup.txt');
// --startup-only: only the first screen (no model call), e.g. to compare with and without --start-bottom
if (args.includes('--startup-only')) {
  p.write('\x03'); await sleep(800); p.write('\x03'); await sleep(1000);
  try { p.kill(); } catch {}
  fs.writeFileSync(path.join(dest, 'summary.json'), redact(JSON.stringify({ cli, version, argv, startBottom, startup }, null, 2)) + '\n');
  console.log(redact(JSON.stringify({ startBottom, startup }, null, 2)));
  process.exit(0);
}

// the paste a terminal sends for a dropped file: backslash before spaces and shell specials, then one trailing space
const escapeLikeTerminal = f => f.replace(/([ \\'"()&;$`!*?[\]{}|<>#~])/g, '\\$1');
async function drop(file) {
  const text = escapeLikeTerminal(file) + ' ';
  const bracketed = !!term.modes.bracketedPasteMode;
  p.write(bracketed ? `\x1b[200~${text}\x1b[201~` : text);
  await sleep(2500);
  return bracketed;
}
async function ask(question, expect, name) {
  p.write(question);
  await sleep(500);
  p.write('\r');
  const deadline = Date.now() + waitSec * 1000;
  let asked = 0, s = '';
  const polls = []; // every different screen while waiting, to see what happened in between
  while (Date.now() < deadline) {
    await sleep(2000);
    s = await screen();
    const tail = s.split('\n').slice(-18).join('\n');
    // a permission prompt: record it, then allow once (read-only questions in a throwaway folder)
    if (asked < 3 && /Do you want to proceed|Would you like to run|Allow (once|this)|approve|\(y\/n\)|Yes, allow/i.test(tail)) {
      await save(`${name}-permission-${asked + 1}.txt`, s);
      asked++;
      p.write('\r');
      continue;
    }
    if (new RegExp(`\\b${expect}\\b`, 'i').test(s.split(question.slice(0, 20)).pop() ?? '')) break;
    if (s !== polls.at(-1)) polls.push(s);
  }
  await save(`${name}-polls.txt`, polls.join('\n\n======== next poll ========\n\n'));
  await save(`${name}-reply.txt`, s);
  return { answered: new RegExp(`\\b${expect}\\b`, 'i').test(s.split(question.slice(0, 20)).pop() ?? ''), permissionPrompts: asked };
}

const result = { cli, version, argv, startBottom, startup, answeredStartupPrompts: answered };
result.image = { bracketedPaste: await drop(imgPath) };
await save('image-pasted.txt');
const pastedImg = await screen();
result.image.shownAs = /\[Image #?\d*\]|\[image/i.test(pastedImg) ? 'image attachment' : pastedImg.includes('drop shot.png') || pastedImg.includes('drop\\ shot.png') ? 'path text' : 'not visible';
Object.assign(result.image, await ask('What colour is that image? Reply with one word.', 'red', 'image'));

result.pdf = { bracketedPaste: await drop(pdfPath) };
await save('pdf-pasted.txt');
const pastedPdf = await screen();
result.pdf.shownAs = /\[(PDF|File|Document)[^\]]*\]/i.test(pastedPdf) ? 'attachment' : pastedPdf.includes('drop spec.pdf') || pastedPdf.includes('drop\\ spec.pdf') ? 'path text' : 'not visible';
Object.assign(result.pdf, await ask('What is the secret word in that PDF? Reply with the word only.', SECRET, 'pdf'));
result.ms = Date.now() - t0;

p.write('\x03'); await sleep(800); p.write('\x03'); await sleep(1500);
try { p.kill(); } catch {}
fs.writeFileSync(path.join(dest, 'summary.json'), redact(JSON.stringify(result, null, 2)) + '\n');
console.log(redact(JSON.stringify(result, null, 2)));
process.exit(0);
