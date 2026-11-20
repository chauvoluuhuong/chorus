#!/usr/bin/env node
// Replay proof of Vietnamese typing on the desktop page (fix/vietnamese-input): the DOM events recorded in Chorus.app with real
// keystrokes (test/fixtures/ime/: Apple Telex and VNI, an OpenKey-style tool with 0 and 30 ms gaps) are played again in Chrome
// headless over the DevTools protocol, into the chat terminal of a fake TUI agent (no real CLI, no model calls):
//   - a word rewrite (Apple's insertReplacementText) → the word selected in xterm's helper textarea + Input.insertText,
//   - a commit without a key → Input.insertText, keys (Backspace bursts, letters, several letters in one key) → Input.dispatchKeyEvent,
//   - a real composition (IBus-style preedit) → Input.imeSetComposition, then Input.insertText to commit it,
// with the recorded timing. The bytes the agent's PTY got must decode (a DEL takes off one character) to the sentence, exactly once.
// People's typing (test/fixtures/ime/human-*.json, Simple Telex, Telex and VNI): keys overlap, so an input method's text for a letter
// can come while Space is still down. Each fixture is played in its recorded event order; only the input event Chrome makes for a key
// we typed over the protocol is not inserted again, every other one is (the page decides what to send).
// Then a composition + Enter in New chat's message, a card's "Your own answer" and a dialog's input must send nothing before the commit.
// Linux (test/fixtures/ime/linux-*.json, IBus + ibus-bamboo in WebKitGTK): commits come with no compositionstart, which Chrome cannot
// make over the protocol, so those events (beforeinput/input insertFromComposition, compositionend, the Enter IBus forwards) are
// dispatched on the field itself with the recorded text, keys go over the protocol as above.
//   node test/smoke/proof-ime.ts [--out <dir>] [--only <fixture-substring>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import { openChrome, sleep } from './chrome.ts';
import { writeReport, type Check } from './report.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-tui.mjs');
const FIX = path.join(ROOT, 'test/fixtures/ime');
const TARGET = 'Tiếng Việt có dấu: người, được, khoẻ, Đà Nẵng';
const argv = process.argv.slice(2);
const branch = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().replace(/\//g, '-') || 'fix-vietnamese-input';
const OUT = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(ROOT, '.chorus/proof', branch, 'proof-ime'));
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const results: Check[] = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (${detail.slice(0, 300)})`}`);
  return ok;
}

/* ---------- chorus serve on a temp home, chats run the fake TUI ---------- */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-proof-ime-home-'));
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-proof-ime-')));
process.env.CHORUS_HOME = home;
process.env.CODEX_HOME = home;
process.env.CHORUS_SKILLS_HOME = home;
const store = new Store(project, { home });
const c = new Controller({ project, store, stillMs: 300, app: headlessApp(), tailPollMs: 100, opener: async () => ({ ok: true }), launcher: (agent, l) => ({ bin: process.execPath, args: [FAKE, agent], cwd: l.cwd }) });
c.restore();
const ready = (agent: string) => ({ agent, name: agent, state: 'ready', login: 'yes', version: '1.0.0', page: '', loginCommand: [agent, 'login'], ms: 1 });
const srv = new ChorusServer({ controller: c, token: 'e'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 'test', agents: ['claude', 'codex', 'agy'].map(ready), ms: 1 }) as any });
const url = await srv.start(0);
const api = async (method: string, p: string, body?: object) => (await (await fetch(url + p, { method, headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json()) as any;

const ch = await openChrome({ out: OUT, width: 1280, height: 800, log: s => console.log(s) });
const { cdp, js, until, click, shot } = ch;
const cleanup = async () => {
  ch.close();
  srv.close();
  c.stop();
  for (const e of c.app.entries) e.host?.kill();
  await sleep(300);
  store.close();
};

/** What the agent's PTY got, per chat: every write the server makes to it. A chat in the back may be parked and resumed with a new
 *  PTY, so `arm` wraps the chat's current one just before a replay. */
const got = new Map<string, string[]>();
const wrapped = new WeakSet<object>();
async function chat(agent: string): Promise<string> {
  const id = (await api('POST', '/api/chats', { agent, folder: project, title: `IME ${agent}` })).id as string;
  got.set(id, []);
  return id;
}
async function arm(id: string): Promise<string[]> {
  await until(() => !!c.app.entry(id)?.host, 10000, 100);
  const host = c.app.entry(id)!.host!;
  const rec = got.get(id)!;
  if (!wrapped.has(host)) {
    wrapped.add(host);
    const write = host.write.bind(host);
    host.write = ((d: string) => {
      got.get(id)!.push(d);
      return write(d);
    }) as typeof host.write;
  }
  rec.length = 0;
  return rec;
}

/** The CLI's input line from the bytes: terminal replies and paste marks dropped, a DEL (or Ctrl+H) takes off one character. */
const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function decode(bytes: string) {
  const s = bytes.replace(/\x1b\[20[01]~/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b./g, '').replace(/\r/g, '');
  const line: string[] = [];
  for (const { segment } of seg.segment(s)) {
    if (segment === '\x7f' || segment === '\b') line.pop();
    else line.push(segment);
  }
  return line.join('');
}

/* ---------- the page ---------- */

await cdp('Page.navigate', { url: srv.openUrl });
await until(() => js<boolean>('!!(window.chorus && chorus.S.state)'), 15000);
for (let i = 0; i < 3; i++) if (await ch.has('button', /Skip, start using Chorus/)) await ch.click('button', 'Skip, start using Chorus');
const isMac = await js<boolean>('/Mac/.test(navigator.platform)');
const MOD = isMac ? 4 : 2; // Meta on a Mac, Ctrl elsewhere

type Ev = { type: string; t: number; key?: string; code?: string; keyCode?: number; shift?: boolean; repeat?: boolean; data?: string | null; inputType?: string; valueTail?: string };
const NAMED: Record<string, number> = { Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, Meta: 91, CapsLock: 20 };

async function keyEvent(type: 'keyDown' | 'rawKeyDown' | 'keyUp', e: Ev, text?: string) {
  const key = e.key ?? '';
  const vk = e.keyCode ?? NAMED[key] ?? 0;
  await cdp('Input.dispatchKeyEvent', { type, key, code: e.code ?? '', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: e.shift ? 8 : 0, autoRepeat: !!e.repeat, ...(text ? { text, unmodifiedText: text } : {}) });
}

/** Plays one recorded event list into the focused terminal, in its recorded order and with its timing (gaps over 300 ms are cut
 *  to 300; Apple's input methods stamp a letter's keydown a few ms before the input event that comes first, so time never goes back).
 *  Keys overlap as recorded (a keydown before the last keyup, Backspace held with auto-repeat). */
async function replay(events: Ev[]) {
  let last = events[0]?.t ?? 0;
  let tail = ''; // xterm's helper textarea as recorded, before the event
  // the text Chrome itself types for the last keydown we dispatched with text: its recorded input event is that text's and is not
  // inserted again. Only that one: an input method's text for another letter may come while this key is still down (a person
  // presses the next letter before letting go of Space), and that input event is replayed (fix/ime-human-typing)
  let keyText: string | null = null;
  for (const e of events) {
    const gap = Math.min(300, Math.max(0, e.t - last));
    last = Math.max(last, e.t);
    if (gap) await sleep(gap);
    const key = e.key ?? '';
    if (e.type === 'keydown') {
      if (e.keyCode === 229 || key in NAMED || key === '' || /^(Arrow|F\d|Page|Home|End|Delete)/.test(key)) {
        await keyEvent('rawKeyDown', e, key === 'Enter' ? '\r' : undefined);
      } else if (Array.from(key).length > 1) {
        // several letters in one key (an OpenKey-style tool): Chrome drops a keydown whose key is not one character, WebKit fires
        // it. So that keydown and its keypress are DOM events on the helper textarea, and the text is typed over the protocol
        await js(`(() => { const t = document.querySelector('#term-slot .xterm-helper-textarea'); for (const type of ['keydown', 'keypress']) t.dispatchEvent(new KeyboardEvent(type, { key: ${JSON.stringify(key)}, code: ${JSON.stringify(e.code ?? '')}, bubbles: true, cancelable: true })); })()`);
        await cdp('Input.insertText', { text: key });
        keyText = key;
      } else {
        await keyEvent('keyDown', e, key); // one letter: Chrome fires keydown, keypress and input
        keyText = key;
      }
    } else if (e.type === 'keyup') {
      await keyEvent('keyUp', e);
    } else if (e.type === 'input' && keyText !== null && e.inputType === 'insertText' && e.data === keyText) {
      keyText = null; // Chrome already typed it with the key
    } else if (e.type === 'input' && e.data && (e.inputType === 'insertText' || e.inputType === 'insertReplacementText')) {
      // the input method rewrote the word: select what it replaced, then insert the new text over it
      const after = e.valueTail ?? '';
      const replaced = e.inputType === 'insertReplacementText' ? Math.max(0, tail.length - (after.length - e.data.length)) : 0;
      if (replaced) await js(`(() => { const t = document.querySelector('#term-slot .xterm-helper-textarea'); const n = Math.max(0, t.value.length - ${replaced}); t.setSelectionRange(n, t.value.length); })()`);
      await cdp('Input.insertText', { text: e.data });
    }
    if (e.valueTail !== undefined) tail = e.valueTail;
  }
}

/** A real composition per word (Linux IBus with ibus-bamboo, a macOS method with marked text): preedit grows, then commits. */
async function compose(word: string) {
  const letters = Array.from(word.normalize('NFC'));
  for (let i = 1; i <= letters.length; i++) {
    const pre = letters.slice(0, i).join('');
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: '', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await cdp('Input.imeSetComposition', { text: pre, selectionStart: pre.length, selectionEnd: pre.length });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Process', code: '', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await sleep(25);
  }
  await cdp('Input.insertText', { text: word });
  await sleep(25);
}

/** Headless Chrome may stop making frames after a burst of protocol input; the page attaches a chat in requestAnimationFrame, so a
 *  tiny screenshot asks for a frame while the proof waits. */
const frame = () => cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 } });

/** Opens a chat as a person does (its row in the sidebar) and waits until its screen is attached and drawn. */
async function openChat(id: string, agent: string) {
  if ((await js<string | null>('chorus.S.attached')) !== id) await click(`.chat-row[data-arg="${id}"]`);
  const ok = await until(async () => (await frame(), (await js<string | null>('chorus.S.attached')) === id && new RegExp(`READY ${agent}`).test(await termText())), 15000);
  if (!ok) {
    await shot(`open-failed-${agent}`, `the ${agent} chat did not open`);
    throw new Error(`the ${agent} chat did not open: attached ${await js<string>('chorus.S.attached')}, screen ${JSON.stringify((await termText()).trim().slice(0, 300))}`);
  }
}

/** Focus on the chat terminal, as a click does (a click also starts a fresh word for the input method). */
async function focusTerm() {
  await click('#term-slot .xterm-screen');
  const ok = await until(() => js<boolean>(`document.activeElement === document.querySelector('#term-slot .xterm-helper-textarea')`), 3000, 100);
  if (!ok) console.log(`  (terminal focus: ${await js<string>('document.activeElement?.outerHTML.slice(0, 120) ?? "none"')})`);
  await sleep(200);
}

const report: { fixture: string; agent: string; method: string; arrived: string; ok: boolean; bytes: string }[] = [];
const termText = () => js<string>(`(() => { const b = chorus.term.buffer.active; const out = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i).translateToString(true)); return out.join('\\n'); })()`);

/* ---------- 1. the chat terminal ---------- */

console.log('1. the chat terminal: every recorded chat fixture, replayed');
const chats: Record<string, string> = {};
for (const agent of ['claude', 'codex', 'agy']) chats[agent] = await chat(agent);
// People's typing (fix/ime-human-typing): test/fixtures/ime/human-*.json are scripted human-like runs (keys overlap 60–200 ms, a
// pause, a Backspace fix mid-word, a held Backspace) with Simple Telex, Telex and VNI; a person's own recordings stay out of the
// repo (they hold a name) and are replayed too when they are on this machine. A person's own run must arrive as what was on screen
// just before Enter (their typos included), a scripted one as the sentence.
const PRIVATE = path.join(ROOT, '.chorus/proof/fix-ime-human-typing/private-fixtures');
const human = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^human-.*\.json$/.test(f)).sort().map(f => path.join(dir, f)) : []);
const files = [...fs.readdirSync(FIX).filter(f => /-chat-(claude|codex|agy)\.json$/.test(f)).sort().map(f => path.join(FIX, f)), ...human(FIX), ...human(PRIVATE)].filter(p => path.basename(p).includes(ONLY));
function onScreen(events: Ev[]) {
  const enter = events.findIndex(e => e.type === 'keydown' && e.key === 'Enter');
  const last = events.slice(0, enter < 0 ? events.length : enter).reverse().find(e => e.valueTail !== undefined);
  return (last?.valueTail ?? '').replace(/\u00a0/g, ' ');
}
for (const p of files) {
  const file = (p.startsWith(PRIVATE) ? 'private ' : '') + path.basename(p);
  const f = JSON.parse(fs.readFileSync(p, 'utf8'));
  const want: string = f.by === 'owner' ? onScreen(f.events) : (f.target ?? TARGET);
  const id = chats[f.agent];
  await openChat(id, f.agent);
  await focusTerm();
  const rec = await arm(id);
  await replay(f.events);
  await sleep(500);
  const bytes = rec.join('');
  const arrived = decode(bytes);
  const ok = check(`${file}: ${f.method} into a ${f.agent} chat arrives as ${f.by === 'owner' ? 'what was on screen' : 'the sentence'}, once`, arrived === want, `want ${JSON.stringify(want)} got ${JSON.stringify(arrived)}`);
  report.push({ fixture: file, agent: f.agent, method: f.method, arrived, ok, bytes: JSON.stringify(bytes) });
  if (file.startsWith('telex-')) await shot(`chat-${f.agent}-${f.method}`, `${file}: the ${f.agent} chat after the replay (the fake agent echoes a line only on Enter; the check reads the bytes its PTY got)`);
}

/** Linux IBus in WebKitGTK: one commit with no compositionstart, as recorded: the field holds `before`, the word is inserted
 *  (`after` = the field afterwards, WebKit's no-break spaces kept), then compositionend; `enter` adds the Enter IBus forwards. */
const ibusCommit = (sel: string, before: string, after: string, data: string, enter = false) =>
  js(`(() => {
    const t = document.querySelector(${JSON.stringify(sel)});
    t.value = ${JSON.stringify(before)};
    t.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertFromComposition', data: ${JSON.stringify(data)}, isComposing: true, bubbles: true, cancelable: true }));
    t.value = ${JSON.stringify(after)};
    t.dispatchEvent(new InputEvent('input', { inputType: 'insertFromComposition', data: ${JSON.stringify(data)}, isComposing: true, bubbles: true }));
    t.dispatchEvent(new CompositionEvent('compositionend', { data: ${JSON.stringify(data)}, bubbles: true }));
    ${enter ? "t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));" : ''}
    return 1;
  })()`);

const linuxFiles = fs.readdirSync(FIX).filter(f => /^linux-.*-chat\.json$/.test(f) && f.includes(ONLY)).sort();
if (linuxFiles.length) console.log('1b. Linux IBus (ibus-bamboo in WebKitGTK): commits with no compositionstart, replayed');
for (const file of linuxFiles) {
  const f = JSON.parse(fs.readFileSync(path.join(FIX, file), 'utf8'));
  for (const agent of ['claude', 'codex', 'agy']) {
    const id = chats[agent];
    await openChat(id, agent);
    await focusTerm();
    await js(`(document.querySelector('#term-slot .xterm-helper-textarea').value = '', 1)`);
    const rec = await arm(id);
    const TA = '#term-slot .xterm-helper-textarea';
    let tail = '';
    for (const e of f.events as Ev[]) {
      if (e.type === 'keydown' && (e.keyCode === 229 || e.key === 'Enter')) await keyEvent('rawKeyDown', e, e.key === 'Enter' ? '\r' : undefined);
      else if (e.type === 'keydown' && e.key === ' ') await keyEvent('keyDown', e, ' ');
      else if (e.type === 'keyup') await keyEvent('keyUp', e);
      else if (e.type === 'input' && e.inputType === 'insertFromComposition') await ibusCommit(TA, tail, e.valueTail ?? '', e.data ?? '');
      if (e.valueTail !== undefined && e.type !== 'compositionend') tail = e.valueTail;
    }
    await sleep(500);
    const bytes = rec.join('');
    const arrived = decode(bytes);
    const ok = check(`${file}: ${f.method} into a ${agent} chat arrives as the sentence, once, with no DEL or no-break space`, arrived === TARGET && !/[\x7f\u00a0]/.test(bytes), `got ${JSON.stringify(arrived)} bytes ${JSON.stringify(bytes)}`);
    report.push({ fixture: file, agent, method: f.method, arrived, ok, bytes: JSON.stringify(bytes) });
    if (agent === 'claude') await shot(`chat-linux-${f.method}`, `${file}: the claude chat after the replay`);
  }
}

if (!ONLY) {
  console.log('2. a real composition (IBus-style preedit) into the chat terminal');
  for (const agent of ['claude', 'codex', 'agy']) {
    const id = chats[agent];
    await openChat(id, agent);
    await focusTerm();
    const rec = await arm(id);
    const words = TARGET.split(' ');
    for (let i = 0; i < words.length; i++) {
      await compose(words[i]);
      if (i < words.length - 1) await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' });
    }
    await sleep(500);
    const arrived = decode(rec.join(''));
    check(`composition (imeSetComposition + commit) into a ${agent} chat arrives as the sentence, once`, arrived === TARGET, `got ${JSON.stringify(arrived)}`);
    report.push({ fixture: '(composition)', agent, method: 'composition', arrived, ok: arrived === TARGET, bytes: JSON.stringify(rec.join('')) });
  }

  /* ---------- 3. Chorus's own boxes: Enter while a word is composed sends nothing ---------- */

  console.log('3. Enter while a word is composed, in Chorus\'s own boxes');
  /** A composition, Enter (with `mods`) while it is open, then the commit. */
  async function composeEnter(word: string, mods = 0) {
    const letters = Array.from(word);
    for (let i = 1; i <= letters.length; i++) {
      const pre = letters.slice(0, i).join('');
      await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code: '', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
      await cdp('Input.imeSetComposition', { text: pre, selectionStart: pre.length, selectionEnd: pre.length });
      await sleep(20);
    }
    // Enter while the word is open: the browser marks it isComposing (the input method takes it to finish the word)
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: mods });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: mods });
    await sleep(400);
  }
  const enter = async (mods = 0) => {
    await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: mods });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: mods });
  };

  // New chat's message: Cmd/Ctrl+Enter starts the chat
  await js(`window.chorus.go({ name: 'new' }), 1`);
  await until(() => js<boolean>('!!document.querySelector("#nc-prompt")'), 10000);
  await click('#nc-prompt');
  const before = store.listThreads().length;
  await composeEnter('Việt', MOD);
  const ncHeld = (await js<any>('chorus.S.view')).name === 'new' && store.listThreads().length === before;
  await shot('nc-prompt-composing', 'New chat: "Việt" being composed, Cmd+Enter pressed during it: nothing started, the word is still being built');
  await cdp('Input.insertText', { text: 'Việt' });
  await sleep(300);
  check('#nc-prompt: Cmd/Ctrl+Enter while "Việt" is composed starts nothing; the word is committed whole', ncHeld && (await js<string>('document.querySelector("#nc-prompt").value')) === 'Việt', `view ${(await js<any>('chorus.S.view')).name}, chats ${store.listThreads().length - before}, value ${await js<string>('document.querySelector("#nc-prompt")?.value')}`);
  await enter(MOD);
  check('#nc-prompt: after the commit, Cmd/Ctrl+Enter starts the chat with "Việt"', await until(() => store.listThreads().length === before + 1, 10000), `${store.listThreads().length - before} new chats`);

  // a card's "Your own answer": Enter sends it
  const cardChat = chats.claude;
  await openChat(cardChat, 'claude');
  const req = store.createRequest({ threadId: cardChat, question: 'Tên của dự án là gì?', options: ['Chorus', 'Khác'], kind: 'question' });
  await until(() => js<boolean>('!!document.querySelector(".ask-dock [data-act=other]")'), 15000);
  await click('.ask-dock [data-act="other"]');
  await click('.ask-dock .other-input');
  await composeEnter('Nẵng');
  const cardHeld = !store.getRequest(req.id)?.answer;
  await shot('card-own-answer-composing', 'A card\'s "Your own answer": "Nẵng" being composed and Enter pressed during it: nothing sent');
  await cdp('Input.insertText', { text: 'Nẵng' });
  await sleep(300);
  check('.other-input: Enter while "Nẵng" is composed sends nothing; the word is committed whole', cardHeld && (await js<string>('document.querySelector(".ask-dock .other-input")?.value ?? ""')) === 'Nẵng', JSON.stringify(store.getRequest(req.id)));
  await enter();
  check('.other-input: after the commit, Enter sends "Other: Nẵng"', await until(() => store.getRequest(req.id)?.answer === 'Other: Nẵng', 10000), JSON.stringify(store.getRequest(req.id)));

  // Linux IBus: Enter while Bamboo shows the word commits it, then IBus forwards the Enter (keyCode 13, isComposing false): held
  const req2 = store.createRequest({ threadId: cardChat, question: 'Tên thư mục?', options: ['Chorus', 'Khác'], kind: 'question' });
  await until(() => js<boolean>(`!!document.querySelector('.ask-dock [data-act=other]')`), 15000);
  await click('.ask-dock [data-act="other"]');
  await click('.ask-dock .other-input');
  await ibusCommit('.ask-dock .other-input', '', 'Tiếng', 'Tiếng', true);
  await sleep(400);
  const linuxHeld = !store.getRequest(req2.id)?.answer;
  await shot('card-own-answer-linux-enter', 'A card\'s "Your own answer", Linux IBus: Enter while "Tiếng" is shown commits it; the Enter IBus forwards sends nothing');
  check('.other-input (Linux IBus): the Enter forwarded with the commit sends nothing; the word is whole', linuxHeld && (await js<string>('document.querySelector(".ask-dock .other-input")?.value ?? ""')) === 'Tiếng', JSON.stringify(store.getRequest(req2.id)));
  await sleep(100);
  await enter();
  check('.other-input (Linux IBus): the next Enter sends "Other: Tiếng"', await until(() => store.getRequest(req2.id)?.answer === 'Other: Tiếng', 10000), JSON.stringify(store.getRequest(req2.id)));

  // a dialog's input (the server asks, e.g. a new name): Enter is OK
  const asked = (c.app as any).prompt('Đổi tên', ['Tên mới cho cuộc trò chuyện'], '') as Promise<string | undefined>;
  let answer: string | undefined | null = null;
  void asked.then(v => (answer = v ?? ''));
  await until(() => js<boolean>('!!document.querySelector("#dialogs .dlg-input")'), 10000);
  await click('#dialogs .dlg-input');
  await composeEnter('khoẻ');
  const dlgHeld = answer === null && (await js<boolean>('!!document.querySelector("#dialogs .dlg-input")'));
  await shot('dialog-input-composing', 'A dialog\'s input: "khoẻ" being composed and Enter pressed during it: the dialog stays open');
  await cdp('Input.insertText', { text: 'khoẻ' });
  await sleep(300);
  check('.dlg-input: Enter while "khoẻ" is composed does not press OK; the word is committed whole', dlgHeld && (await js<string>('document.querySelector("#dialogs .dlg-input")?.value ?? ""')) === 'khoẻ', `answer ${JSON.stringify(answer)}`);
  await enter();
  check('.dlg-input: after the commit, Enter answers "khoẻ"', await until(() => answer === 'khoẻ', 10000), `answer ${JSON.stringify(answer)}`);

  // the same dialog with Linux IBus: the Enter forwarded with the commit does not press OK
  const asked2 = (c.app as any).prompt('Đổi tên', ['Tên mới cho cuộc trò chuyện'], '') as Promise<string | undefined>;
  let answer2: string | undefined | null = null;
  void asked2.then(v => (answer2 = v ?? ''));
  await until(() => js<boolean>('!!document.querySelector("#dialogs .dlg-input")'), 10000);
  await click('#dialogs .dlg-input');
  await ibusCommit('#dialogs .dlg-input', '', 'Nẵng', 'Nẵng', true);
  await sleep(400);
  check('.dlg-input (Linux IBus): the Enter forwarded with the commit does not press OK', answer2 === null && (await js<boolean>('!!document.querySelector("#dialogs .dlg-input")')), `answer ${JSON.stringify(answer2)}`);
  await sleep(100);
  await enter();
  check('.dlg-input (Linux IBus): the next Enter answers "Nẵng"', await until(() => answer2 === 'Nẵng', 10000), `answer ${JSON.stringify(answer2)}`);
}

await cleanup();

/* ---------- the report ---------- */

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ target: TARGET, results, chats: report }, null, 2));
writeReport(OUT, 'Vietnamese typing: replay proof (npm run proof:ime)', `The recorded keystrokes of test/fixtures/ime/ replayed over the DevTools protocol into chats of a fake agent, and compositions into Chorus's boxes. Target: ${TARGET}`, results, ch.shots, [['npm run proof:ime', 'this proof']]);
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed · report: ${path.join(OUT, 'report.html')}`);
process.exit(failed ? 1 : 0);
