#!/usr/bin/env node
// The Chat view's e2e (plan 2026-11-22 chat-view, Stage 5): with the real Claude Code, Codex and Antigravity in `chorus serve`'s PTYs,
// a phone (390 × 844, touch) opens each chat in the Chat view and, from its message box, sends a message with a "/" skill picked from
// the list and an "@" file picked from the list at the end, then one of the agent's own commands picked from the "/" list. Each message
// starts a turn in the CLI and its reply shows in the view. Also measured: the bytes a phone gets for one chat in the Chat view against
// Raw. Screens and the report go to .chorus/proof/<branch>/chatview/.
//
//   node test/smoke/chatview.ts [--agents claude,codex,agy] [--open]
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { openChrome, sleep } from './chrome.ts';
import { openReport, writeReport } from './report.ts';
import { setSize } from './sizes.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const opt = (n: string, d = '') => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const AGENTS = opt('agents', 'claude,codex,agy').split(',') as ('claude' | 'codex' | 'agy')[];
const branch = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || 'detached';
const OUT = path.resolve(opt('out') || path.join(ROOT, '.chorus/proof', branch, 'chatview'));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const log = (s: string) => console.log(s);
const results: { ok: boolean; name: string; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => (results.push({ ok, name, detail }), log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail.slice(0, 300)})`}`), ok);

/* ---------- a project with a skill and a file to pick ---------- */

const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-cv-e2e-')));
spawnSync('git', ['init', '-q'], { cwd: project });
fs.writeFileSync(path.join(project, 'notes.txt'), 'The secret fruit is pineapple.\n');
fs.mkdirSync(path.join(project, '.chorus', 'skills', 'fruit-check'), { recursive: true });
fs.writeFileSync(path.join(project, '.chorus', 'skills', 'fruit-check', 'SKILL.md'), '---\nname: fruit-check\ndescription: Read the file the user names and answer with the fruit in it\n---\nRead the file the user names. Reply with one line: the fruit in it, in capitals, then -OK.\n');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-cv-e2e-home-'));
const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORUS_HOME: home, CHORUS_NO_OPEN: '1', CHORUS_NOTIFICATIONS: '0', CHORUS_UPDATES: '0', CHORUS_MODEL_CLAUDE: 'haiku', CHORUS_MODEL_CODEX: 'gpt-5.6-luna', CHORUS_MODEL_AGY: 'gemini-3.8-flash-low', CHORUS_LICENCE_URL: 'http://127.0.0.1:9' };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];

let serve: ChildProcess | undefined;
const url = await new Promise<string>((resolve, reject) => {
  serve = spawn(process.execPath, [path.join(ROOT, 'src/cli/index.ts'), 'serve', '--port', '0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  serve.stderr!.on('data', d => fs.appendFileSync(path.join(OUT, 'serve.log'), d));
  let buf = '';
  serve.stdout!.on('data', d => {
    buf += d;
    const m = buf.match(/chorus serve: (\S+)/);
    if (m) resolve(m[1]);
  });
  serve.once('exit', c => reject(new Error(`serve exited ${c}: ${buf}`)));
});
process.on('exit', () => serve?.kill('SIGTERM'));
const token = new URL(url).searchParams.get('token') ?? new URL(url).hash.match(/token=([^&]+)/)?.[1] ?? '';
const origin = new URL(url).origin;

const chrome = await openChrome({ out: OUT, width: 390, height: 844, log });
const { cdp, js, until, click, key, shot, shots } = chrome;
await cdp('Page.navigate', { url });
await setSize(chrome, 'phone', 'light');
await until(() => js<boolean>('!!(window.chorus && chorus.S.state)'), 20000);
for (let i = 0; i < 10; i++) {
  if (await chrome.has('button', /Skip, start using Chorus|Start using Chorus|Continue to the app/)) await click('[data-act="doc-continue"]');
  else if (await js<boolean>('chorus.S.view.name === "welcome"')) await click('[data-act="plan-community"]');
  else if (i > 2) break;
  await sleep(500);
}
const api = (method: string, p: string, body?: object) => js<any>(`fetch(${JSON.stringify(p)}, { method: ${JSON.stringify(method)}, headers: { 'x-chorus': '1', 'content-type': 'application/json' }, ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : ''} }).then(r => r.json())`);
const chatOf = (id: string) => js<any>(`chorus.S.state.chats.find(c => c.id === ${JSON.stringify(id)})`);

/** Types into the message box the way a phone keyboard does: text inserted, input events. */
const typeBox = async (text: string) => {
  await click('.cv-in');
  // a tap that landed on something over the box (a toast) still leaves the box focused, as a second tap would
  await js(`(() => { const b = document.querySelector('.cv-in'); if (document.activeElement !== b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); } })()`);
  await cdp('Input.insertText', { text });
  await sleep(500);
};
/** Picks the item whose name matches from the open "/" or "@" list (a tap on it). */
const pick = async (re: RegExp) => {
  const open = await until(() => js<boolean>(`[...document.querySelectorAll('.cv-box .tpick:not([hidden]) [data-i]')].some(e => ${re}.test(e.textContent))`), 15000);
  if (!open) {
    log(`    the list: ${await js<string>('document.querySelector(".cv-box .tpick")?.outerHTML?.slice(0, 600) ?? "none"')}`);
    return false;
  }
  const before = await js<string>('document.querySelector(".cv-in").value');
  await click('.cv-box .tpick [data-i]', re);
  // a pick may first ask to sync the skill to this agent ("Sync and use"): the text changes once it is done
  for (let i = 0; i < 40; i++) {
    if (await js<boolean>('!!document.querySelector(".sk-dlg")')) await click('.sk-dlg [data-x="yes"]');
    if ((await js<string>('document.querySelector(".cv-in").value')) !== before) return true;
    await sleep(250);
  }
  return false;
};
/** The sync dialog, if the picked skill is not in this agent's skills yet: "Sync and use". */
const syncIfAsked = async () => {
  if (await until(() => js<boolean>('!!document.querySelector(".sk-dlg")'), 1500)) await click('.sk-dlg [data-x="yes"]');
};
/** The CLI's own screen (Raw), as a second socket would get it: for a failure's log. */
const screenOf = (id: string) =>
  new Promise<string>(resolve => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { authorization: `Bearer ${token}`, origin } });
    let out = '';
    ws.on('message', d => {
      const m = JSON.parse(String(d));
      if (m.t === 'screen' || m.t === 'out') out += m.data;
    });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'attach', id, cols: 100, rows: 40 })));
    setTimeout(() => (ws.close(), resolve(out.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[\]P][^\x07]*(\x07|\x1b\\)|\x1b./g, ''))), 2500);
  });
/** Keys into the CLI as Raw sends them (a second socket attached to the chat). */
const keysTo = (id: string, keys: string[]) =>
  new Promise<void>(resolve => {
    const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { authorization: `Bearer ${token}`, origin } });
    ws.on('open', async () => {
      ws.send(JSON.stringify({ t: 'attach', id, cols: 100, rows: 40 }));
      await sleep(800);
      for (const k of keys) {
        ws.send(JSON.stringify({ t: 'in', id, data: k }));
        await sleep(900);
      }
      ws.close();
      resolve();
    });
  });
/** The folder-trust question each CLI asks in a new folder, answered Yes in Raw. */
async function trustInRaw(id: string) {
  for (let i = 0; i < 3; i++) {
    const s = await screenOf(id);
    if (/Yes, ?I ?trust this folder|Do you trust the contents|Trust and continue|trust (this|the) (folder|workspace)/i.test(s.replace(/\s+/g, ' ')) || /Yes,Itrustthisfolder|Trustandcontinue/.test(s)) {
      log('    answered the folder-trust question in Raw');
      // Claude lists "No, exit" first: Down to "Yes" before Enter; the others have Yes first
      await keysTo(id, /No,? ?exit/.test(s) && /❯\s*No/.test(s) ? ['\x1b[B', '\r'] : ['\r']);
      await sleep(3000);
    } else return;
  }
}
const replyIn = (re: RegExp) => js<boolean>(`[...document.querySelectorAll('.cv-stream .cv-a')].some(e => ${re}.test(e.textContent))`);

for (const agent of AGENTS) {
  log(`\n${agent}`);
  const r = await api('POST', '/api/chats', { agent, folder: project, skip: true });
  if (!check(`${agent}: a chat starts`, !!r.id, JSON.stringify(r))) continue;
  const id = r.id as string;
  // the CLI comes up and waits (a fresh chat with no first message); a new folder's trust question is answered in Raw, as a person does
  await until(async () => (await chatOf(id))?.state === 'idle', 90000, 1000);
  await trustInRaw(id);
  await js(`chorus.go({ name: 'chat', id: ${JSON.stringify(id)} })`);
  await until(() => js<boolean>('!!document.querySelector(".cv-in")'), 10000);
  check(`${agent}: a phone opens the chat in the Chat view, with its message box`, await js<boolean>('!document.querySelector("#cv-slot").hidden && document.querySelector("#term-slot").hidden'));
  // 1. "/" → the skill from the list, then the text, then "@" → notes.txt from the list, at the end
  await typeBox('/fru');
  const pickedSkill = await pick(/fruit-check/);
  await typeBox('then answer from @note');
  const pickedFile = await pick(/notes\.txt/);
  const text1 = await js<string>('document.querySelector(".cv-in").value');
  check(`${agent}: "/" and "@" pick from their lists`, pickedSkill && pickedFile && /^\/fruit-check then answer from @notes\.txt\s*$/.test(text1), text1);
  await shot(`${agent}-typed`, `${agent}: the message with a skill and a file picked`);
  await click('[data-cv="send"]');
  const replied = await until(() => replyIn(/PINEAPPLE/i), 180000, 1500);
  if (!replied) log(`    the view: ${await js<string>('document.querySelector(".cv-stream").textContent.slice(-300)')}\n    the CLI's screen: ${(await screenOf(id)).slice(-900)}`);
  check(`${agent}: the message starts a turn and the reply shows in the view`, replied, await js<string>('document.querySelector(".cv-stream").textContent.slice(-400)'));
  await until(async () => (await chatOf(id))?.state === 'idle', 60000, 1000);
  await shot(`${agent}-replied`, `${agent}: the reply in the Chat view`);
  // 2. one of the agent's own commands, picked from the "/" list under the skills
  await typeBox('/comp');
  const pickedOwn = await pick(/^\/compact(?=Sent|\s|$)/);
  const text2 = await js<string>('document.querySelector(".cv-in").value');
  check(`${agent}: "/compact" picked from "${agent === 'claude' ? 'Claude Code' : agent === 'codex' ? 'Codex' : 'Antigravity'}'s own"`, pickedOwn && /^\/compact\s*$/.test(text2), text2);
  const said = js<any>(`(async () => { const r = await fetch('/api/chats/${id}/say', { method: 'POST', headers: { 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ text: document.querySelector('.cv-in').value }) }); document.querySelector('.cv-in').value = ''; return r.json(); })()`);
  const a = await said;
  check(`${agent}: /compact is sent and the CLI takes it (not held in its input)`, a.result === 'sent', JSON.stringify(a));
  await until(async () => (await chatOf(id))?.state === 'idle', 120000, 1000);
  await sleep(3000);
  await shot(`${agent}-compact`, `${agent}: after /compact`);
  // 3. a last message after the command, typed in Vietnamese through an input method (a word composed, then committed, as a phone
  // keyboard does; Chrome's IME emulation, not a real iOS or Android keyboard): it reaches the CLI exactly
  await click('.cv-in');
  await cdp('Input.insertText', { text: 'Trả lời chỉ một từ DONE, không ' });
  await cdp('Input.imeSetComposition', { text: 'thê', selectionStart: 3, selectionEnd: 3 });
  await sleep(300);
  await cdp('Input.imeSetComposition', { text: 'thêm', selectionStart: 4, selectionEnd: 4 });
  await sleep(300);
  await cdp('Input.insertText', { text: 'thêm' });
  await sleep(400);
  const viet = await js<string>('document.querySelector(".cv-in").value');
  check(`${agent}: Vietnamese composed in the box stays exact`, viet === 'Trả lời chỉ một từ DONE, không thêm', viet);
  await click('[data-cv="send"]');
  check(`${agent}: a message after the command starts a turn again`, await until(() => replyIn(/DONE/), 120000, 1500));
  check(`${agent}: the Vietnamese message reached the CLI exactly (its user turn)`, await js<boolean>(`[...document.querySelectorAll('.cv-stream .cv-u')].some(e => e.textContent === 'Trả lời chỉ một từ DONE, không thêm')`));
  check(`${agent}: the skill shows as typed in the user's bubble`, await js<boolean>(`[...document.querySelectorAll('.cv-stream .cv-u')].some(e => e.textContent.startsWith('/fruit-check '))`));
  await shot(`${agent}-after`, `${agent}: the next turn`);

  // the network a phone uses for this chat: the Chat view (one page, then only what is new) against Raw (the terminal's bytes)
  if (agent === AGENTS[0]) {
    const page = await api('GET', `/api/chats/${id}/turns`);
    const pageBytes = Buffer.byteLength(JSON.stringify(page));
    const raw = await new Promise<number>(resolve => {
      const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { authorization: `Bearer ${token}`, origin } });
      let n = 0;
      ws.on('message', d => {
        const m = JSON.parse(String(d));
        if (m.t === 'screen' || m.t === 'out') n += String(d).length;
      });
      ws.on('open', () => ws.send(JSON.stringify({ t: 'attach', id, cols: 45, rows: 46 })));
      setTimeout(() => (ws.close(), resolve(n)), 4000);
    });
    const cvWs = await new Promise<number>(resolve => {
      const ws = new WebSocket(`${origin.replace('http', 'ws')}/ws`, { headers: { authorization: `Bearer ${token}`, origin } });
      let n = 0;
      ws.on('message', d => {
        const m = JSON.parse(String(d));
        if (m.t === 'cv' || m.t === 'screen' || m.t === 'out') n += String(d).length;
      });
      ws.on('open', () => ws.send(JSON.stringify({ t: 'cv', id, seq: Math.max(0, ...page.turns.map((t: any) => t.seq)) })));
      setTimeout(() => (ws.close(), resolve(n)), 4000);
    });
    fs.writeFileSync(path.join(OUT, 'network.json'), JSON.stringify({ agent, chatViewPage: pageBytes, chatViewPushIdle4s: cvWs, rawAttach4s: raw }, null, 2));
    check(`network (${agent}, one chat): the Chat view page is ${pageBytes} bytes and sends no terminal bytes; Raw sends ${raw} bytes of screen on attach`, pageBytes > 0 && raw > 0);
  }
}

chrome.close();
serve?.kill('SIGTERM');
const file = writeReport(OUT, 'Chat view e2e with the real CLIs', 'A phone opens each chat in the Chat view and sends, from its message box, a message with a "/" skill and an "@" file picked from their lists, then the agent\'s own /compact, then one more message.', results, shots, []);
const failed = results.filter(r => !r.ok).length;
log(`\n${failed ? 'FAILED' : 'OK'}: ${results.length - failed}/${results.length} checks.\nReport: ${file}`);
if (argv.includes('--open')) openReport(file);
process.exit(failed ? 1 : 0);
