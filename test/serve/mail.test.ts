// The one watcher and the one mailbox in chorus serve (task #10, step 8): the mail, watch and watch_event tables; a restart keeping
// a watch's data and deadline; ctx.chats() parent; each agent's launch `wake` and env; Claude's development-channels warning answered
// once; mailbox events reaching the paid module; and a delivery that types nothing into the chat (Claude's channel push through the
// chat's `chorus mcp` stream).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { MailMessage, Transport } from '@chauvoluuhuong/chorus-core';
import type { ProCtx, ProModule } from '@chauvoluuhuong/chorus-core/pro-loader';
import { Controller } from '../../src/app/controller.ts';
import { buildInteractive, withEnv } from '../../src/core/launch.ts';
import { Store, WATCH_EVENTS_KEPT } from '../../src/core/store.ts';
import type { AgentId } from '../../src/core/types.ts';
import { listenChannel } from '../../src/mcp/pro.ts';
import { answerChannelWarning, ChannelHub, makeTransports, wakeFor } from '../../src/serve/mail.ts';
import { ChatLaunch, type ProLoader } from '../../src/serve/pro.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-tui.mjs');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const LOCKED: ProLoader = { dev: true, load: async () => ({ locked: 'no-licence', message: 'No licence on this computer.' }), activate: async () => ({ locked: 'no-licence', message: 'x' }) };
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

async function until(pred: () => boolean, what: string, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(50);
  }
  assert.fail(`timed out: ${what}`);
}

/** chorus serve on a store in `home`, with the fake agent's chats; nothing may be typed into a chat */
async function rig(o: { home?: string; loader?: ProLoader; transports?: Partial<Record<AgentId, Transport>>; now?: () => number; channelWaitMs?: number } = {}) {
  const home = o.home ?? tmp('chorus-mail-home-');
  process.env.CODEX_HOME = home;
  process.env.CHORUS_SKILLS_HOME ??= home;
  const project = tmp('chorus-mail-');
  const store = new Store(project, { home });
  const c = new Controller({ project, store, stillMs: 300, app: headlessApp(), tailPollMs: 100, opener: async () => ({ ok: true }), launcher: (agent, l) => ({ bin: process.execPath, args: [FAKE, agent], cwd: l.cwd }) });
  c.restore();
  c.sendToChat = () => {
    throw new Error('typed into a chat');
  };
  const agents = (['claude', 'codex', 'agy'] as AgentId[]).map(agent => ({ agent, state: 'ready' }));
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), proLoader: o.loader ?? LOCKED, check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents, ms: 1 }) as any, sessionExists: () => true, transports: o.transports, now: o.now, channelWaitMs: o.channelWaitMs });
  const url = await srv.start(0);
  const chat = async (agent: AgentId = 'claude') => {
    const r = await fetch(`${url}/api/chats`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ agent, folder: project }) });
    const id = ((await r.json()) as { id: string }).id;
    store.updateThread(id, { state: 'waiting' });
    return id;
  };
  const done = async () => {
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await sleep(300);
    store.close();
  };
  return { srv, c, store, home, project, url, chat, done };
}

test('store: the mail table keeps every field, meta included; get and list by receiver, sender and state', () => {
  const store = new Store(tmp('chorus-mail-st-'), { home: tmp('chorus-mail-st-h-') });
  try {
    const ms = store.mailStore();
    const m: MailMessage = {
      id: 'm_1', from: { who: 'chat', thread: 't_sub', teammate: 'claude-worker-1', role: 'sub thread', session: 's1' }, to: { thread: 't_main' }, kind: 'question',
      subject: 'EUR or USD?', body: '**Which** currency?', refs: { question: 'q_1', about: 't_sub', task: 'k1' }, meta: { kind: 'question', details: 'Berlin', options: ['EUR', 'USD'] },
      state: 'queued', tries: 0, created_at: '2026-11-18T08:00:00.000Z',
    };
    ms.insert(m);
    ms.insert({ ...m, id: 'm_2', from: { who: 'chorus' }, kind: 'note', meta: undefined, created_at: '2026-11-18T08:00:01.000Z' });
    assert.deepEqual(ms.get('m_1'), m);
    assert.equal('meta' in ms.get('m_2')!, false);
    ms.update('m_1', { state: 'delivered', channel: 'claude', tries: 1, delivered_at: '2026-11-18T08:00:02.000Z' });
    ms.update('m_2', { to: { thread: 't_other' }, error: undefined });
    assert.deepEqual(ms.get('m_1'), { ...m, state: 'delivered', channel: 'claude', tries: 1, delivered_at: '2026-11-18T08:00:02.000Z' });
    assert.deepEqual(ms.list({ to: 't_main' }).map(x => x.id), ['m_1']);
    assert.deepEqual(ms.list({ to: 't_other' }).map(x => x.id), ['m_2']);
    assert.deepEqual(ms.list({ from: 't_sub' }).map(x => x.id), ['m_1']);
    assert.deepEqual(ms.list({ state: ['queued'] }).map(x => x.id), ['m_2']);
    assert.deepEqual(ms.list({}).map(x => x.id), ['m_1', 'm_2'], 'oldest first');
    assert.deepEqual(ms.list({ state: [] }), []);
  } finally {
    store.close();
  }
});

test('store: watch and watch_event keep each state with belongs_to; events are listed by key and by owner chat, and pruned', () => {
  const home = tmp('chorus-watch-st-');
  const store = new Store(tmp('chorus-watch-p-'), { home });
  try {
    const ws = store.watchStore();
    const s = { key: 'sub:t_a', thread: 't_a', belongsTo: 't_main', kind: 'thread' as const, owner: 'subthreads', expect: 'report', seen: 'working', since: 5, waitsOn: ['card'], deadline: 90, waitOverAt: 90, activity: '1/1/0', activityAt: 4, quietSent: true, data: { missed: 1 }, created_at: 1 };
    ws.save(s);
    ws.save({ ...s, key: 'gone', ended_at: 9 });
    assert.deepEqual(ws.load(), [s], 'open ones only');
    ws.event({ key: 'sub:t_a', thread: 't_a', belongsTo: 't_main', type: 'turnEnd', at: Date.now(), detail: { ms: 3 } });
    ws.event({ key: 'other', thread: 't_b', belongsTo: 't_main', type: 'note', at: Date.now(), action: 'reminder sent' });
    assert.deepEqual(store.watchEvents({ key: 'sub:t_a' }).map(e => [e.type, e.detail]), [['turnEnd', { ms: 3 }]]);
    assert.deepEqual(store.watchEvents({ belongsTo: 't_main' }).map(e => e.action ?? e.type), ['turnEnd', 'reminder sent']);
    const n = (store.db.prepare('SELECT COUNT(*) AS n FROM watch_event').get() as { n: number }).n;
    ws.event({ key: 'old', thread: 't_c', belongsTo: 't_c', type: 'idle', at: Date.now() - 31 * 86_400_000 });
    store.pruneWatchEvents(Date.now(), 1);
    assert.deepEqual(store.watchEvents({ belongsTo: 't_main' }).map(e => e.action ?? e.type), ['reminder sent'], 'old and over the cap: gone');
    assert.equal(n, 2);
    assert.equal(WATCH_EVENTS_KEPT, 50_000);
  } finally {
    store.close();
  }
});

test('a serve restart keeps a watch\'s data and deadline; the tables exist', async () => {
  const home = tmp('chorus-restart-');
  let t = 1_000_000;
  const a = await rig({ home, now: () => t });
  let main: string;
  try {
    main = await a.chat('codex');
    a.srv.watch.watch({ key: 'test:x', thread: main, belongsTo: main, kind: 'action', owner: 'test', expect: 'call action_done', idleFor: 60_000, on: () => {} });
    a.srv.watch.setData('test:x', { missed: 1 });
    assert.equal(a.srv.watch.get('test:x')!.deadline, t + 60_000);
  } finally {
    await a.done();
  }
  t += 5_000;
  const b = await rig({ home, now: () => t });
  try {
    const w = b.srv.watch.get('test:x')!;
    assert.deepEqual([w.thread, w.data, w.deadline, w.owner], [main!, { missed: 1 }, 1_060_000, 'test']);
    const tables = (b.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name);
    for (const n of ['mail', 'watch', 'watch_event']) assert.ok(tables.includes(n), n);
  } finally {
    await b.done();
  }
});

test('ctx.chats(): each row names the chat it was opened from (parent) and what it is under it (sub)', async () => {
  const r = await rig();
  try {
    const main = await r.chat('claude');
    const sub = await r.chat('codex');
    const step = await r.chat('agy');
    r.store.updateThread(sub, { parent_thread_id: main });
    r.store.setSub(sub, { sub_status: 'working' });
    r.srv.subs.watchOnly(step, main);
    const ctx = (r.srv.pro as unknown as { ctx: ProCtx }).ctx;
    const rows = Object.fromEntries(ctx.chats!().map(c => [c.id, c]));
    assert.equal(rows[main].parent, undefined);
    assert.equal(rows[main].sub, undefined);
    assert.deepEqual([rows[sub].parent, rows[sub].sub], [main, 'sub']);
    assert.deepEqual([rows[step].parent, rows[step].sub], [main, 'task']);
    assert.equal(ctx.watch, r.srv.watch, 'the one watcher');
    assert.equal(ctx.mail, r.srv.mail, 'the one mailbox');
  } finally {
    await r.done();
  }
});

test('launch: each agent gets its transport\'s `wake`; agy\'s token goes in its own environment, per session', () => {
  const store = new Store(tmp('chorus-launch-'), { home: tmp('chorus-launch-h-') });
  try {
    const transports = makeTransports({ session: () => undefined, hub: new ChannelHub() });
    const launch = new ChatLaunch(store);
    launch.wake = (agent, thread) => wakeFor(transports, agent, thread);
    const cwd = tmp('chorus-launch-cwd-');
    const build = (agent: AgentId, threadId: string) => {
      const o = { cwd, project: cwd, threadId, prompt: 'hi' };
      return buildInteractive(agent, { ...o, ...launch.extras(o, agent) });
    };
    const claude = build('claude', 't_c');
    assert.notEqual(claude.bin, '/usr/bin/env');
    const i = claude.args.indexOf('--dangerously-load-development-channels');
    assert.ok(i > 0, 'the channels flag');
    assert.equal(claude.args[i + 1], 'server:chorus');
    const codex = build('codex', 't_x');
    assert.equal(codex.bin, 'codex', 'nothing to add for Codex');
    assert.ok(!codex.args.some(a => /development-channels|ANTIGRAVITY/.test(a)));
    const agy = build('agy', 't_g');
    const agy2 = build('agy', 't_h');
    assert.equal(agy.bin, '/usr/bin/env');
    assert.match(agy.args[0], /^ANTIGRAVITY_SERVER_CSRF_TOKEN=[0-9a-f-]{36}$/);
    assert.equal(agy.args[1], 'agy');
    assert.notEqual(agy.args[0], agy2.args[0], 'a token per session');
    assert.equal('env' in agy, false);
    // a launch with no env is left as it is
    const plain = { bin: 'x', args: ['a'], cwd };
    assert.equal(withEnv(plain), plain);
  } finally {
    store.close();
  }
});

test('Claude\'s development-channels warning is answered once with option 1, and never when it is not on screen', async () => {
  const fake = () => {
    const h = Object.assign(new EventEmitter(), { lines: [] as string[], wrote: [] as string[], write(d: string) { h.wrote.push(d); }, screen: { text: () => h.lines } });
    return h;
  };
  const a = fake();
  answerChannelWarning(a);
  a.lines = ['Welcome to Claude Code'];
  a.emit('update');
  assert.deepEqual(a.wrote, [], 'not on screen: nothing');
  a.lines = ['WARNING: Loading development channels', '❯ 1. I am using this for local development', '  2. Exit'];
  a.emit('update');
  a.emit('update');
  assert.deepEqual(a.wrote, ['\r'], 'once');
  a.lines = ['WARNING: Loading development channels'];
  a.emit('update');
  assert.deepEqual(a.wrote, ['\r'], 'still once in this launch');
  // past its time: a launch that never showed it never gets an answer
  const b = fake();
  answerChannelWarning(b, { ms: 30 });
  await sleep(60);
  b.lines = ['I am using this for local development'];
  b.emit('update');
  assert.deepEqual(b.wrote, []);
});

test('mailbox events reach the paid module as chatEvent {type: mail}', async () => {
  const seen: { type: string; event?: { type: string; message: MailMessage } }[] = [];
  const mod: ProModule = { version: 't', routes: () => ({}), mcpTools: () => [], ui: () => ({ js: '', css: '' }), onChatEvent: (_c, e) => void seen.push(e as never), dispose() {} };
  const loader: ProLoader = { dev: true, load: async () => mod, activate: async () => mod };
  const lost: Transport = { agent: 'codex', deliver: async () => 'gone' };
  const r = await rig({ loader, transports: { codex: lost } });
  try {
    const to = await r.chat('codex');
    await until(() => r.srv.watch.isIdle(to), 'idle');
    const id = r.srv.mail.send({ from: { who: 'chorus' }, to: { thread: to }, kind: 'note', subject: 'hi', body: 'hello', refs: {} });
    await until(() => seen.some(e => e.type === 'mail'), 'a mail event');
    const e = seen.find(x => x.type === 'mail')!.event!;
    assert.deepEqual([e.type, e.message.id, e.message.error], ['failed', id, 'session lost']);
  } finally {
    await r.done();
  }
});

test('delivery types nothing into the chat: a Claude chat gets its mail through its `chorus mcp` channel stream', async () => {
  const r = await rig({ channelWaitMs: 4000 });
  try {
    const main = await r.chat('claude');
    const host = r.c.app.entry(main)!.host!;
    await until(() => host.screen.text().join('\n').includes('READY'), 'chat up');
    const wrote: string[] = [];
    const write = host.write.bind(host);
    host.write = (d: string) => (wrote.push(d), write(d));
    // the chat's `chorus mcp` process: holds the stream and hands each line to Claude Code as a channel notification
    const pushed: { content: string; meta: Record<string, string> }[] = [];
    const stop = listenChannel(r.store.root, main, p => void pushed.push(p), { retryMs: 100 });
    try {
      await until(() => r.srv.channels.connected(main), 'stream open');
      const id = r.srv.mail.send({ from: { who: 'chorus' }, to: { thread: main }, kind: 'note', subject: 'Hello', body: 'A **note** for you.', refs: {} });
      await until(() => pushed.length === 1, 'pushed through the channel');
      assert.match(pushed[0].content, /note from Chorus: Hello\*\* \(mail m_\w+\)\n\nA \*\*note\*\* for you\./);
      assert.deepEqual(pushed[0].meta, { kind: 'note', sender: 'chorus', mail: id });
      assert.equal(r.srv.mail.get(id)!.state, 'delivered');
      assert.equal(r.srv.mail.get(id)!.channel, 'claude');
      assert.deepEqual(wrote, [], 'nothing typed into the chat');
    } finally {
      stop();
    }
    // a Claude chat whose stream never connects: not delivered, still nothing typed
    const other = await r.chat('claude');
    const h2 = r.c.app.entry(other)!.host!;
    const wrote2: string[] = [];
    const w2 = h2.write.bind(h2);
    h2.write = (d: string) => (wrote2.push(d), w2(d));
    const id2 = r.srv.mail.send({ from: { who: 'chorus' }, to: { thread: other }, kind: 'note', subject: 'x', body: 'y', refs: {} });
    await until(() => r.srv.mail.get(id2)!.tries === 1, 'one try', 10_000);
    assert.notEqual(r.srv.mail.get(id2)!.state, 'delivered');
    assert.deepEqual(wrote2, []);
  } finally {
    await r.done();
  }
});

test('deleting a chat drops its mail and ends the watches on it and kept for it', async () => {
  const r = await rig({ transports: { codex: { agent: 'codex', deliver: async () => 'sent' } } });
  try {
    const main = await r.chat('codex');
    const other = await r.chat('codex');
    r.store.updateThread(other, { state: 'working' });
    const id = r.srv.mail.send({ from: { who: 'chat', thread: main }, to: { thread: other }, kind: 'note', subject: 's', body: 'b', refs: {} });
    r.srv.watch.watch({ key: 'test:own', thread: main, belongsTo: other, kind: 'action', owner: 'test', expect: 'x', on: () => {} });
    assert.ok(r.srv.watch.has(`inbox:${other}`));
    await (r.srv as unknown as { deleteChatQuietly(id: string): Promise<void> }).deleteChatQuietly(other);
    assert.equal(r.store.getThread(other), undefined);
    await until(() => r.srv.mail.get(id)!.state === 'dropped', 'dropped');
    assert.equal(r.srv.watch.has(`inbox:${other}`), false);
    assert.equal(r.srv.watch.has('test:own'), false, 'kept for the deleted chat: ended');
    // the sender is told
    assert.ok(r.srv.mail.list({ to: main }).some(m => /Not delivered/.test(m.subject)));
  } finally {
    await r.done();
  }
});

