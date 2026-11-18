#!/usr/bin/env node
// Proof of the mail watchdog's type-in on the desktop page (task #14, mockup mail-courier.html v3, scenes 1–3): chorus serve on a temp
// home, a chat whose CLI is a fake input box drawn like Claude Code's (tools/fake-agent/fake-input.mjs) with a two-line draft in it,
// its look stuck at "working", and a message from another chat. The watchdog (clock shortened by CHORUS_COURIER_MS) retries, then
// types: the page dims the whole window with the card, the line is sent, the draft comes back. Screens at desktop, phone and dark.
//   node test/smoke/proof-mail-courier.ts [--out .chorus/proof/feature-mail-courier]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import { openChrome, sleep } from './chrome.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_INPUT = path.join(ROOT, 'tools/fake-agent/fake-input.mjs');
const argv = process.argv.slice(2);
const branch = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().replace(/\//g, '-');
const OUT = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join(ROOT, '.chorus/proof', branch));
fs.mkdirSync(OUT, { recursive: true });
const results: [boolean, string][] = [];
const check = (ok: boolean, what: string) => (results.push([ok, what]), console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`));

async function run(o: { width: number; height: number; dark?: boolean; shots: [string, string][] }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-proof-mc-home-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-proof-mc-')));
  process.env.CODEX_HOME = home;
  process.env.CHORUS_COURIER_MS = '4000';
  const store = new Store(project, { home });
  const c = new Controller({ project, store, stillMs: 300, app: headlessApp(), tailPollMs: 100, opener: async () => ({ ok: true }), launcher: (_a, l) => ({ bin: process.execPath, args: [FAKE_INPUT], cwd: l.cwd }) });
  c.restore();
  const srv = new ChorusServer({ controller: c, token: 'f'.repeat(48), channelWaitMs: 300, check: async () => ({ node: { version: '22', ok: true }, platform: 'test', agents: [{ agent: 'claude', state: 'ready' }], ms: 1 }) as any });
  const url = await srv.start(0);
  delete process.env.CHORUS_COURIER_MS;
  const api = async (p: string, body: object) => (await (await fetch(url + p, { method: 'POST', headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as any;
  const sender = (await api('/api/chats', { agent: 'claude', folder: project, title: 'Step 2 · type-in helpers' })).id as string;
  const planner = (await api('/api/chats', { agent: 'claude', folder: project, title: 'Planner' })).id as string;
  // a chat's title comes from its first message: the names of the mockup's scenes
  store.updateThread(sender, { title: 'Step 2 · type-in helpers' });
  store.updateThread(planner, { title: 'Planner' });
  const ch = await openChrome({ out: OUT, width: o.width, height: o.height });
  try {
    if (o.dark) await ch.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await ch.cdp('Page.navigate', { url: srv.openUrl });
    await ch.until(() => ch.js<boolean>('!!window.chorus'), 15000);
    for (let i = 0; i < 3; i++) if (await ch.has('button', /Skip, start using Chorus/)) await ch.click('button', 'Skip, start using Chorus');
    await ch.js(`window.chorus.go({ name: 'chat', id: ${JSON.stringify(planner)} }), 1`);
    await sleep(1500);
    // the user's two-line draft, typed into the chat's terminal as a person does (Option+Enter between the lines)
    const host = c.app.entry(planner)!.host!;
    host.write('also check the phone layout\x1b\rand dark mode before you merge');
    await sleep(500);
    store.updateThread(planner, { state: 'working' }); // the look stuck at working: the mailbox holds the mail
    (srv as any).mail.send({ from: { who: 'chat', thread: sender, role: 'Worker' }, to: { thread: planner }, kind: 'report', subject: 'step 2 ended its turn', body: 'Step 2 "Core: type-in helpers" ended its turn.', refs: {} });
    // the watchdog: 4 s, the retry (no channel stream: it fails), then the type-in; the overlay is up while it types
    const up = await ch.until(() => ch.js<boolean>('!!document.querySelector("#mail-typing:not(.out)")'), 20_000, 50);
    check(up, `${o.shots[0][0]}: the window dims while the line is typed`);
    if (up) await ch.shot(o.shots[0][0], o.shots[0][1]);
    const gone = await ch.until(() => ch.js<boolean>('!document.querySelector("#mail-typing")'), 12_000);
    check(gone, `${o.shots[0][0]}: the overlay goes once the draft is back`);
    await sleep(400);
    const screen = host.screen.text().join('\n');
    // a narrow terminal wraps the sent line: read it as one
    check(/SENT Chorus: you have 1 unread message \(m_[a-z0-9]+\); read it with read_mail\./.test(screen.replace(/\n/g, '')), 'the line was sent');
    check(/❯ also check the phone layout\n\s+and dark mode before you merge/.test(screen) && !/SENT also check/.test(screen), 'the draft is back in the input, never sent');
    if (o.shots[1]) await ch.shot(o.shots[1][0], o.shots[1][1]);
  } finally {
    ch.close();
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await sleep(300);
    store.close();
  }
}

await run({ width: 1280, height: 800, shots: [['typing', 'Scene 1: the whole window dims, one card in the centre, while the line is typed'], ['after', 'Scene 2: the line is sent, the draft is back in the input, nothing of Chorus is left on screen']] });
await run({ width: 390, height: 780, shots: [['phone', 'Scene 3 (left): the same card over the whole phone screen']] });
await run({ width: 1280, height: 800, dark: true, shots: [['typing-dark', 'Scene 1 in dark mode']] });
// the screenshots are named <n>-<name>.png by the driver: keep a copy under the plain name the plan asks for
for (const f of fs.readdirSync(OUT)) {
  const m = f.match(/^\d+-(typing|after|phone|typing-dark)\.png$/);
  if (m) fs.copyFileSync(path.join(OUT, f), path.join(OUT, `${m[1]}.png`));
}
const failed = results.filter(r => !r[0]).length;
console.log(`\n${results.length - failed}/${results.length} passed · screens in ${OUT}`);
process.exit(failed ? 1 : 0);
