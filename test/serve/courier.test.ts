// The mail watchdog's type-in in chorus serve (task #14), on a fake CLI input box drawn like Claude Code's (tools/fake-agent/
// fake-input.mjs): the draft is cleared, the line typed and sent, the draft put back; keys the user presses meanwhile go after it and
// count as typed; nothing is typed while a dialog is on screen; the terminal lock serialises with a live working folder; an attachment
// draft is not ready; and a chat whose look stays "working" gets its mail typed after the (shortened) watchdog clock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fallbackLine, inputState } from '@chauvoluuhuong/chorus-core';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import { screenRows, typeLine } from '../../src/serve/mail.ts';
import type { ProLoader } from '../../src/serve/pro.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import { TermLocks } from '../../src/serve/termlock.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE_INPUT = path.join(ROOT, 'tools/fake-agent/fake-input.mjs');
const LOCKED: ProLoader = { dev: true, load: async () => ({ locked: 'no-licence', message: 'No licence on this computer.' }), activate: async () => ({ locked: 'no-licence', message: 'x' }) };
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(pred: () => boolean, what: string, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(50);
  }
  assert.fail(`timed out: ${what}`);
}

async function rig(o: { dialog?: boolean; courierMs?: string } = {}) {
  const home = tmp('chorus-courier-h-');
  const project = tmp('chorus-courier-p-');
  process.env.CODEX_HOME = home;
  if (o.courierMs) process.env.CHORUS_COURIER_MS = o.courierMs;
  const store = new Store(project, { home });
  const env = o.dialog ? { FAKE_DIALOG: '1' } : undefined;
  const c = new Controller({ project, store, stillMs: 300, app: headlessApp(), tailPollMs: 100, opener: async () => ({ ok: true }), launcher: (_agent, l) => ({ bin: process.execPath, args: [FAKE_INPUT], cwd: l.cwd, env }) });
  c.restore();
  const srv = new ChorusServer({ controller: c, token: 'd'.repeat(48), proLoader: LOCKED, sessionExists: () => true, channelWaitMs: 200, check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }) as any });
  const url = await srv.start(0);
  delete process.env.CHORUS_COURIER_MS;
  const r = await fetch(`${url}/api/chats`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'claude', folder: project }) });
  const id = ((await r.json()) as { id: string }).id;
  const host = () => c.app.entry(id)!.host!;
  const screen = () => host().screen.text().join('\n');
  await until(() => /❯|Do you want to proceed/.test(screen()), 'the fake input box');
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws?token=${srv.token}`);
  await new Promise(res => ws.addEventListener('open', res, { once: true }));
  const got: any[] = [];
  ws.addEventListener('message', e => got.push(JSON.parse(String(e.data))));
  ws.send(JSON.stringify({ t: 'attach', id, cols: 120, rows: 40 }));
  const keys = (data: string) => ws.send(JSON.stringify({ t: 'in', id, data }));
  const state = () => inputState('claude', screenRows(host().screen), host().screen.cols);
  const done = async () => {
    ws.close();
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await sleep(300);
    store.close();
  };
  return { srv, api: srv as any, c, store, id, host, screen, keys, state, got, done };
}

test('type-in: the draft is cleared, the line typed and sent, the draft put back; keys pressed meanwhile go after it, as typed', async () => {
  const r = await rig();
  try {
    r.keys('first line');
    r.keys('\x1b\r');
    r.keys('second line');
    await until(() => r.state().draft === 'first line\nsecond line', 'the user draft');
    const line = fallbackLine([{ id: 'm_abc123' }]);
    const p = r.api.typeIn(r.id, line);
    await sleep(150);
    r.keys('!'); // the user goes on typing while the watchdog types
    assert.equal(await p, 'typed');
    await until(() => r.state().draft === 'first line\nsecond line!', 'the draft back, then the held key');
    assert.match(r.screen(), /SENT Chorus: you have 1 unread message \(m_abc123\); read it with read_mail\./);
    assert.doesNotMatch(r.screen(), /SENT first line/, 'the draft was never sent');
    // the held key went through the user path; the watchdog's keys did not
    const typed = r.api.typed.get(r.id);
    assert.ok(typed.line.endsWith('!'));
    assert.ok(!typed.line.includes('Chorus: you have'));
    const marks = r.got.filter(m => m.t === 'mail-typing' && m.thread === r.id).map(m => m.phase);
    assert.deepEqual(marks, ['start', 'end']);
    assert.equal(r.got.find(m => m.t === 'mail-typing' && m.phase === 'end').ok, true);
  } finally {
    await r.done();
  }
});

test('type-in: an empty input gets the line, and stays empty', async () => {
  const r = await rig();
  try {
    assert.equal(await r.api.typeIn(r.id, fallbackLine([{ id: 'm_e1' }, { id: 'm_e2' }])), 'typed');
    await until(() => /SENT Chorus: you have 2 unread messages \(m_e1, m_e2\)/.test(r.screen()), 'sent');
    assert.equal(r.state().draft, '');
  } finally {
    await r.done();
  }
});

test('type-in: nothing is typed while a dialog is on screen', async () => {
  const r = await rig({ dialog: true });
  try {
    const shown = () => r.screen().replace(/\s+$/, '');
    const before = shown();
    assert.equal(await r.api.typeIn(r.id, fallbackLine([{ id: 'm_d1' }])), 'not-ready');
    await sleep(300);
    assert.equal(shown(), before, 'no key reached the dialog');
    assert.doesNotMatch(r.screen(), /SENT/);
    assert.equal(r.got.filter(m => m.t === 'mail-typing').length, 0, 'no overlay for a type-in that did not start');
  } finally {
    await r.done();
  }
});

test('type-in: a draft holding an attachment is not ready', async () => {
  const r = await rig();
  try {
    r.keys('look at [Image #1]');
    await until(() => r.state().draft === 'look at [Image #1]', 'the draft');
    assert.equal(await r.api.typeIn(r.id, fallbackLine([{ id: 'm_i1' }])), 'not-ready');
    assert.equal(r.state().draft, 'look at [Image #1]', 'left as it was');
    assert.doesNotMatch(r.screen(), /SENT/);
  } finally {
    await r.done();
  }
});

test('the terminal lock serialises the type-in with a live working folder\'s /add-dir', async () => {
  const r = await rig();
  try {
    const order: string[] = [];
    const add = r.api.locks.run(r.id, async () => {
      order.push('add-dir start');
      r.host().write('/add-dir /tmp/x');
      await sleep(400);
      r.host().write('\r');
      order.push('add-dir end');
    });
    const typed = r.api.typeIn(r.id, fallbackLine([{ id: 'm_l1' }])).then((x: string) => (order.push('typed'), x));
    await Promise.all([add, typed]);
    assert.deepEqual(order, ['add-dir start', 'add-dir end', 'typed']);
    await until(() => /SENT \/add-dir \/tmp\/x[\s\S]*SENT Chorus: you have 1 unread message \(m_l1\)/.test(r.screen()), 'both sent, one after the other');
  } finally {
    await r.done();
  }
});

test('a write from elsewhere waits while the watchdog holds the terminal, and goes after it', async () => {
  const locks = new TermLocks();
  const writes: string[] = [];
  const host = { write: (d: string) => writes.push(d) };
  const raw = locks.guard('t', host);
  locks.hold('t');
  host.write('other');
  raw('mine');
  assert.deepEqual(writes, ['mine']);
  locks.release('t', host);
  assert.deepEqual(writes, ['mine', 'other']);
  host.write('after');
  assert.deepEqual(writes, ['mine', 'other', 'after']);
});

test('typeLine on a screen with no input box returns not-ready and writes nothing', async () => {
  const writes: string[] = [];
  const r = await typeLine(
    { agent: 'codex', running: () => true, cols: () => 120, rows: () => [{ text: '  Would you like to run the following command?' }, { text: '› 1. Yes, proceed (y)' }, { text: '  Press enter to confirm or esc to cancel' }], write: d => writes.push(d) },
    'x',
    { sleep: async () => {}, start() {}, end() {}, hold() {}, release() {} },
  );
  assert.equal(r, 'not-ready');
  assert.deepEqual(writes, []);
});

test('a chat whose look stays "working" gets its mail typed after the watchdog clock', async () => {
  const r = await rig({ courierMs: '1500' });
  try {
    r.store.updateThread(r.id, { state: 'working' });
    const id = r.api.mail.send({ from: { who: 'chorus' }, to: { thread: r.id }, kind: 'note', subject: 'hello', body: 'hi', refs: {} });
    // working: held; after 1.5 s the retry (no channel stream: transportUp is still true for 20 s, the push fails after 200 ms), then the type-in
    await until(() => new RegExp(`SENT Chorus: you have 1 unread message \\(${id}\\)`).test(r.screen()), 'the line typed', 15_000);
    await until(() => r.api.mail.get(id)?.route === 'typed', 'recorded as typed');
    const m = r.api.mail.get(id);
    assert.ok(m.typed_at);
    assert.equal(m.delivered_at, undefined, 'not confirmed: the fake CLI writes no transcript');
    assert.ok(m.attempts.some((a: any) => a.route === 'retry') && m.attempts.some((a: any) => a.route === 'typed' && a.result === 'typed'));
  } finally {
    await r.done();
  }
});
