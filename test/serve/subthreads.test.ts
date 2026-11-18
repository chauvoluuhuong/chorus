// Main thread and sub threads (plan 2026-11-14, Stage 2; on the one watcher and the one mailbox since task #10): the four tools over
// the MCP bridge, with the paid module locked or absent; a sub thread's turn end reported to its main chat as mail; nothing reported
// while it waits on an approval; the 3-sub limit and the one-level rule; the watchdog. The chats are the fake agent; a turn's end is
// the thread's state going working → waiting, which the controller writes from the CLI's session (set here by hand, as the fake agent
// keeps no session file). The mail transports are fakes that record what each chat was handed (nothing is typed into a chat), and
// the watcher runs on a fake clock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AgentId } from '../../src/core/types.ts';
import { Controller } from '../../src/app/controller.ts';
import { createServer, MCP_INSTRUCTIONS } from '../../src/mcp/server.ts';
import { Store } from '../../src/core/store.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import type { ProLoader } from '../../src/serve/pro.ts';
import type { MailMessage, Transport } from '@chauvoluuhuong/chorus-core';
import { SUB_NOTE } from '../../src/serve/subthreads.ts';
import { systemText } from '../../src/core/launch.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-tui.mjs');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const LOCKED: ProLoader = { dev: true, load: async () => ({ locked: 'no-licence', message: 'No licence on this computer.' }), activate: async () => ({ locked: 'no-licence', message: 'x' }) };
const ABSENT: ProLoader = { dev: true, load: async () => { throw new Error('no paid module here'); }, activate: async () => ({ locked: 'damaged', message: 'x' }) };

async function rig(o: { loader?: ProLoader; quietMs?: number; usable?: AgentId[] } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-sub-home-'));
  process.env.CODEX_HOME = home;
  process.env.CHORUS_SKILLS_HOME ??= home;
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-sub-')));
  const store = new Store(project, { home });
  const launches: { agent: AgentId; prompt?: string; cwd: string }[] = [];
  const c = new Controller({ project, store, stillMs: 300, app: headlessApp(), tailPollMs: 100, opener: async () => ({ ok: true }), launcher: (agent, l) => (launches.push({ agent, prompt: l.prompt, cwd: l.cwd }), { bin: process.execPath, args: [FAKE, agent], cwd: l.cwd }) });
  c.restore();
  // nothing is typed into a chat: a send through the old path fails the test
  c.sendToChat = () => {
    throw new Error('typed into a chat');
  };
  /** what each chat was handed by its (fake) transport */
  const delivered: { thread: string; m: MailMessage }[] = [];
  const fake = (agent: AgentId): Transport => ({ agent, deliver: async (thread, msgs) => (delivered.push(...msgs.map(m => ({ thread, m }))), 'sent') });
  const clock = { t: Date.now() };
  const agents = (o.usable ?? (['claude', 'codex', 'agy'] as AgentId[])).map(agent => ({ agent, state: 'ready' }));
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), proLoader: o.loader ?? LOCKED, check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents, ms: 1 }) as any, subQuietMs: o.quietMs ?? 60_000, sessionExists: () => true, now: () => clock.t, transports: { claude: fake('claude'), codex: fake('codex'), agy: fake('agy') } });
  const url = await srv.start(0);
  const call = async (name: string, args: object, threadId?: string) => {
    const r = await fetch(`${url}/api/pro/mcp/call`, { method: 'POST', headers: { authorization: `Bearer ${srv.mcpToken}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ name, args, threadId }) });
    const j = (await r.json()) as { text?: string; error?: string };
    return { ok: r.ok, text: j.text ?? j.error ?? '' };
  };
  /** a main chat, idle */
  const chat = async (agent: AgentId = 'claude') => {
    const r = await fetch(`${url}/api/chats`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ agent, folder: project }) });
    const id = ((await r.json()) as { id: string }).id;
    store.updateThread(id, { state: 'waiting' });
    return id;
  };
  /** the mail handed to a chat, oldest first */
  const mailTo = (id: string) => delivered.filter(d => d.thread === id).map(d => d.m.body).join('\n');
  /** what a chat's screen shows (the fake agent echoes each typed line as JSON: its quotes come back plain here) */
  const screen = (id: string) => (c.app.entry(id)?.host?.screen.logicalLines().join('') ?? '').replace(/\\"/g, '"');
  /** a sub thread's turn ends with this reply */
  const endTurn = (id: string, reply: string) => {
    const n = (store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM turns WHERE thread_id = ?').get(id) as { n: number }).n;
    store.db.prepare('INSERT INTO turns (thread_id,seq,role,text,ts) VALUES (?,?,?,?,?)').run(id, n + 1, 'assistant', reply, new Date().toISOString());
    store.updateThread(id, { state: 'waiting' });
  };
  const until = async (pred: () => boolean, what: string, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return;
      await sleep(50);
    }
    assert.fail(`timed out: ${what}`);
  };
  const done = async () => {
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await sleep(300);
    store.close();
  };
  return { srv, c, store, project, home, url, call, chat, screen, endTurn, until, launches, done, delivered, mailTo, clock };
}

const subId = (text: string) => text.match(/sub thread (t_\w+)/)![1];

test('sub threads: the four tools are listed for a chat with the paid module locked or absent, not for a connected AI app; every chat is told', async () => {
  for (const loader of [LOCKED, ABSENT]) {
    const r = await rig({ loader });
    try {
      const get = async (q: string) => (await (await fetch(`${r.url}/api/pro/mcp/tools${q}`, { headers: { authorization: `Bearer ${r.srv.mcpToken}` } })).json()) as { tools: { name: string }[] };
      assert.deepEqual((await get('')).tools.map(t => t.name), ['start_subthread', 'send_to_subthread', 'list_subthreads', 'stop_subthread', 'ask_main_thread']);
      assert.deepEqual((await get('?app=1')).tools, []);
      // a chat's own MCP server registers them through the bridge
      const server = createServer(r.project, 't_x', r.home);
      await server.addProTools();
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a);
      const client = new Client({ name: 't', version: '1' });
      await client.connect(b);
      const names = (await client.listTools()).tools.map(t => t.name);
      for (const n of ['start_subthread', 'send_to_subthread', 'list_subthreads', 'stop_subthread', 'list_threads']) assert.ok(names.includes(n), n);
      assert.equal(client.getInstructions(), MCP_INSTRUCTIONS);
      await client.close();
    } finally {
      await r.done();
    }
  }
});

test('sub threads: started in the caller\'s folder with the brief; its turn end is delivered to the idle main chat; send_to_subthread and stop', async () => {
  const r = await rig();
  try {
    const main = await r.chat('claude');
    const out = await r.call('start_subthread', { title: 'Price list', brief: 'Make the price list for the cake shop.', agent: 'codex' }, main);
    assert.ok(out.ok, out.text);
    const sub = subId(out.text);
    const row = r.store.getThread(sub)!;
    assert.equal(row.parent_thread_id, main);
    assert.equal(row.agent, 'codex');
    assert.equal(row.cwd, r.project);
    assert.equal(row.sub_status, 'working');
    assert.equal(r.launches.at(-1)!.prompt, `Make the price list for the cake shop.\n\n${SUB_NOTE}`);
    // the state the window gets
    await r.until(() => (r.srv.state().chats.find((c: any) => c.id === sub) as any)?.sub?.status === 'working', 'state carries sub');
    assert.equal((r.srv.state().chats.find((c: any) => c.id === main) as any).sub, null);

    // the main chat is in a turn: the report waits
    r.store.updateThread(main, { state: 'working' });
    r.endTurn(sub, 'Done: prices.md has 12 cakes. Should I add VAT?');
    await r.until(() => r.store.getThread(sub)!.sub_status === 'stopped', 'turn end seen');
    await sleep(800);
    const queued = r.srv.mail.list({ to: main });
    assert.deepEqual(queued.map(m => [m.kind, m.state]), [['report', 'queued']], 'queued, not delivered to a busy main chat');
    assert.doesNotMatch(r.mailTo(main), /Chorus: sub thread/);
    r.store.updateThread(main, { state: 'waiting' });
    await r.until(() => r.mailTo(main).includes(`Chorus: sub thread ${sub} "Price list" (codex) ended its turn after 0 min. It said: "Done: prices.md has 12 cakes. Should I add VAT?"`), 'report delivered to the main chat');
    assert.ok(r.store.getThread(sub)!.sub_reported, 'reported');
    assert.equal(r.srv.mail.get(queued[0].id)!.state, 'delivered');
    assert.doesNotMatch(r.screen(main), /Chorus: sub thread/, 'nothing typed');
    assert.equal(r.store.getThread(sub)!.sub_turns, 1);
    const listed = await r.call('list_subthreads', {}, main);
    assert.match(listed.text, new RegExp(`^${sub}\\tPrice list\\tcodex\\tstopped\\t1 turns\\t0 min\\tDone: prices.md`));

    // more work: delivered to the idle sub thread, which counts as working again once its CLI starts the turn
    const more = await r.call('send_to_subthread', { id: sub, message: 'Yes, add VAT at 8%.' }, main);
    assert.ok(more.ok);
    await r.until(() => r.mailTo(sub).includes('Yes, add VAT at 8%.'), 'delivered to the sub thread');
    r.store.updateThread(sub, { state: 'working' });
    await r.until(() => r.store.getThread(sub)!.sub_status === 'working', 'working again');
    // only the caller's own
    const other = await r.chat('agy');
    assert.equal((await r.call('send_to_subthread', { id: sub, message: 'hi' }, other)).ok, false);
    assert.equal((await r.call('stop_subthread', { id: sub }, other)).ok, false);
    const stop = await r.call('stop_subthread', { id: sub }, main);
    assert.ok(stop.ok);
    assert.equal(r.store.getThread(sub)!.sub_status, 'ended');
  } finally {
    await r.done();
  }
});

test('sub threads: nothing is reported while one waits on an approval; one level only; at most 3 working; an unusable agent is refused', async () => {
  const r = await rig({ usable: ['claude', 'codex'] });
  try {
    const main = await r.chat('claude');
    const a = subId((await r.call('start_subthread', { title: 'A', brief: 'Do A.' }, main)).text);
    assert.equal(r.store.getThread(a)!.agent, 'claude', 'the caller\'s agent by default');
    // in the middle of a turn, an approval opens (its CLI's permission prompt, or a card): waiting_user at once; answered: working
    await r.until(() => r.store.getThread(a)!.state === 'working', 'in a turn');
    const mid = r.store.createRequest({ threadId: a, question: 'Run npm install?' });
    await r.until(() => r.store.getThread(a)!.sub_status === 'waiting_user', 'waiting_user while the prompt is open');
    await r.until(() => (r.srv.state().chats.find((c: any) => c.id === a) as any)?.sub?.status === 'waiting_user', 'in the pushed state too');
    r.store.answerRequest(mid.id, 'Approve');
    await r.until(() => r.store.getThread(a)!.sub_status === 'working', 'working again once answered');
    assert.doesNotMatch(r.mailTo(main), /Chorus: sub thread/, 'nothing reported for it');
    // its turn ends on a question card to the user: waiting_user, no report
    r.store.createRequest({ threadId: a, question: 'May I delete old prices?' });
    r.endTurn(a, 'I asked the user.');
    await r.until(() => r.store.getThread(a)!.sub_status === 'waiting_user', 'waiting_user');
    await sleep(800);
    assert.equal(r.store.getThread(a)!.sub_reported, null);
    assert.doesNotMatch(r.mailTo(main), /Chorus: sub thread/);
    // the user answers and the turn is over: now it is reported
    for (const q of r.store.pendingRequests(a)) r.store.answerRequest(q.id, 'Approve');
    await r.until(() => r.mailTo(main).includes(`Chorus: sub thread ${a} "A"`), 'reported after the answer');

    // one level: a sub thread cannot start its own
    const nested = await r.call('start_subthread', { title: 'N', brief: 'x' }, a);
    assert.equal(nested.ok, false);
    assert.match(nested.text, /cannot start sub threads/);
    // an agent that is not usable now
    const agy = await r.call('start_subthread', { title: 'G', brief: 'x', agent: 'agy' }, main);
    assert.equal(agy.ok, false);
    assert.match(agy.text, /agy is not usable now/);
    // 3 working at most (A has stopped, so it does not count)
    for (const t of ['B', 'C', 'D']) assert.ok((await r.call('start_subthread', { title: t, brief: `Do ${t}.` }, main)).ok, t);
    const fourth = await r.call('start_subthread', { title: 'E', brief: 'x' }, main);
    assert.equal(fourth.ok, false);
    assert.match(fourth.text, /already have 3 sub threads working/);
    // a call that is no chat's
    assert.equal((await r.call('list_subthreads', {})).ok, false);
  } finally {
    await r.done();
  }
});

test('sub threads: the watchdog reports one with no activity to the main chat, once; new activity makes it working again', async () => {
  const r = await rig({ quietMs: 1200 });
  try {
    const main = await r.chat('claude');
    const s = subId((await r.call('start_subthread', { title: 'Slow one', brief: 'Think hard.' }, main)).text);
    await sleep(700);
    assert.equal(r.store.getThread(s)!.sub_status, 'working', 'not quiet before its time');
    r.clock.t += 1300;
    await r.until(() => r.store.getThread(s)!.sub_status === 'quiet', 'quiet', 6000);
    await r.until(() => r.mailTo(main).includes(`Chorus: sub thread ${s} "Slow one" (claude) has shown no activity`), 'told to the main chat');
    assert.doesNotMatch(r.mailTo(s), /no activity/, 'not sent to the sub thread');
    const told = () => r.mailTo(main).split('has shown no activity').length - 1;
    r.clock.t += 1500;
    await sleep(1500);
    assert.equal(told(), 1, 'once');
    // a tool call shows up: working again
    r.store.db.prepare('INSERT INTO tool_calls (thread_id,call_id,turn_seq,tool,target,status) VALUES (?,?,?,?,?,?)').run(s, 'c1', 1, 'Bash', 'npm test', 'ok');
    await r.until(() => r.store.getThread(s)!.sub_status === 'working', 'working after activity');
  } finally {
    await r.done();
  }
});

test('a sub thread\'s chat is watch-only: keys are dropped until Unlock; an unlocked one\'s typed lines go to the main chat as a note', async () => {
  const r = await rig();
  const ws = new WebSocket(r.url.replace('http', 'ws') + '/ws', { headers: { authorization: `Bearer ${r.srv.token}` } });
  await new Promise<void>((resolve, reject) => (ws.once('open', () => resolve()), ws.once('error', reject)));
  const type = (id: string, data: string) => ws.send(JSON.stringify({ t: 'in', id, data }));
  const post = async (p: string, body: object) => (await fetch(r.url + p, { method: 'POST', headers: { authorization: `Bearer ${r.srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })).json() as Promise<any>;
  try {
    const main = await r.chat('claude');
    r.store.updateThread(main, { title: 'Cake shop' });
    const sub = subId((await r.call('start_subthread', { title: 'Price list', brief: 'Make the price list.' }, main)).text);
    await r.until(() => /READY/.test(r.screen(sub)) && /READY/.test(r.screen(main)), 'both chats up');
    const st = () => r.srv.state().chats.find((c: any) => c.id === sub) as any;
    assert.deepEqual(st().sub, { parent: main, status: 'working', unlocked: false, title: 'Cake shop' });
    // locked: nothing reaches the sub thread
    type(sub, 'hello\r');
    await sleep(600);
    assert.doesNotMatch(r.screen(sub), /got: "hello"/);
    // any other chat takes keys as always
    type(main, 'plain\r');
    await r.until(() => r.screen(main).includes('got: "plain"'), 'main chat takes keys');
    // only a sub thread can be unlocked
    assert.match((await post(`/api/chats/${main}/unlock`, { on: true })).error, /only a sub thread/);
    assert.equal((await post(`/api/chats/${sub}/unlock`, { on: true })).unlocked, true);
    assert.equal(st().sub.unlocked, true);
    type(sub, 'use eurs');
    type(sub, '\x7fos');
    type(sub, '\r');
    // the keys reach the sub thread as typed (the fake agent echoes Backspace raw); the note has the line as it reads
    await r.until(() => r.screen(sub).includes('got: "use eurs'), 'typed into the unlocked sub thread');
    await r.until(() => r.mailTo(main).includes(`Chorus: the user typed into sub thread ${sub} "Price list": "use euros"`), 'the main chat is told');
    // locked again: dropped again
    assert.equal((await post(`/api/chats/${sub}/unlock`, { on: false })).unlocked, false);
    type(sub, 'again\r');
    await sleep(600);
    assert.doesNotMatch(r.screen(sub), /got: "again"/);
    // Codex hears of sub threads through its developer instructions too
    assert.ok(systemText('codex', { threadId: sub }).includes('goes to a sub thread'));
  } finally {
    ws.close();
    await r.done();
  }
});

test('a file dropped on a locked sub thread\'s chat is refused like its keys; unlocked, it goes through', async () => {
  const r = await rig();
  const ws = new WebSocket(r.url.replace('http', 'ws') + '/ws', { headers: { authorization: `Bearer ${r.srv.token}` } });
  const msgs: any[] = [];
  ws.on('message', d => msgs.push(JSON.parse(String(d))));
  await new Promise<void>((resolve, reject) => (ws.once('open', () => resolve()), ws.once('error', reject)));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-drop-')), 'spec.txt');
  fs.writeFileSync(file, 'the spec');
  try {
    const main = await r.chat('claude');
    const sub = subId((await r.call('start_subthread', { title: 'Price list', brief: 'Make the price list.' }, main)).text);
    await r.until(() => /READY/.test(r.screen(sub)), 'sub thread up');
    ws.send(JSON.stringify({ t: 'drop', id: sub, paths: [file] }));
    await r.until(() => msgs.some(m => m.t === 'flash' && /watch-only/.test(m.text)), 'refused with a flash');
    assert.equal(r.store.attachments(sub).length, 0, 'nothing given to the sub thread');
    // the page's upload route (a browser gives the bytes only) refuses it too
    const up = await fetch(`${r.url}/api/chats/${sub}/attachments?name=spec.txt`, { method: 'POST', headers: { authorization: `Bearer ${r.srv.token}`, 'x-chorus': '1' }, body: 'the spec' });
    assert.equal(up.status, 409);
    await fetch(`${r.url}/api/chats/${sub}/unlock`, { method: 'POST', headers: { authorization: `Bearer ${r.srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ on: true }) });
    ws.send(JSON.stringify({ t: 'drop', id: sub, paths: [file] }));
    await r.until(() => msgs.some(m => m.t === 'dropped' && m.id === sub), 'unlocked: it goes through');
    assert.equal(r.store.attachments(sub).length, 1);
  } finally {
    ws.close();
    await r.done();
  }
});

test('watchOnly (the paid module\'s Worker chat): a sub thread of its Planner, watch-only, never reported, counted or listed here', async () => {
  const r = await rig();
  const ws = new WebSocket(r.url.replace('http', 'ws') + '/ws', { headers: { authorization: `Bearer ${r.srv.token}` } });
  await new Promise<void>((resolve, reject) => (ws.once('open', () => resolve()), ws.once('error', reject)));
  try {
    const planner = await r.chat('claude');
    const workers = [await r.chat('codex'), await r.chat('codex'), await r.chat('agy')];
    for (const w of workers) r.srv.subs.watchOnly(w, planner);
    const w = workers[0];
    const row = r.store.getThread(w)!;
    assert.equal(row.parent_thread_id, planner);
    assert.equal(row.sub_status, 'task');
    // shown under its owner, watch-only, like a sub thread
    await r.until(() => (r.srv.state().chats.find((c: any) => c.id === w) as any)?.sub?.status === 'task', 'state');
    assert.equal((r.srv.state().chats.find((c: any) => c.id === w) as any).sub.parent, planner);
    await r.until(() => /READY/.test(r.screen(w)), 'worker up');
    ws.send(JSON.stringify({ t: 'in', id: w, data: 'hello\r' }));
    await sleep(600);
    assert.doesNotMatch(r.screen(w), /got: "hello"/, 'keys are not sent to it');
    // its turn ending is not reported by Chorus (the paid module reports its Workers itself)
    r.endTurn(w, 'Step done.');
    await sleep(1200);
    assert.equal(r.store.getThread(w)!.sub_status, 'task');
    assert.doesNotMatch(r.mailTo(planner), /Chorus: sub thread/);
    assert.equal(r.srv.watch.has(`sub:${w}`), false, 'not watched here');
    // not counted against the 3-sub limit, not listed, not the Planner's to send to or stop through these tools
    assert.equal((await r.call('list_subthreads', {}, planner)).text, '(no sub threads)');
    assert.equal((await r.call('send_to_subthread', { id: w, message: 'x' }, planner)).ok, false);
    assert.equal((await r.call('stop_subthread', { id: w }, planner)).ok, false);
    for (const t of ['A', 'B', 'C']) assert.ok((await r.call('start_subthread', { title: t, brief: 'x' }, planner)).ok, t);
  } finally {
    ws.close();
    await r.done();
  }
});

test('a "context not loaded" warning about a sub thread is not passed on; about a hand-off it still is', async () => {
  const r = await rig();
  try {
    const main = await r.chat('claude');
    const sub = subId((await r.call('start_subthread', { title: 'Create hello.txt with mango', brief: 'Create hello.txt with mango.' }, main)).text);
    void sub;
    r.c.app.notice = '⚠ context not loaded in "Create hello.txt with mango": ^G r asks it again';
    assert.equal(r.srv.state().notice, '');
    r.c.app.notice = '⚠ context not loaded in "Cake shop → codex": ^G r asks it again';
    assert.equal(r.srv.state().notice, '⚠ context not loaded in "Cake shop → codex": ^G r asks it again');
    r.c.app.notice = '⚠ Claude Code reached its plan limit';
    assert.equal(r.srv.state().notice, '⚠ Claude Code reached its plan limit', 'other warnings stay');
  } finally {
    r.c.app.notice = '';
    await r.done();
  }
});

test('ask_main_thread: a question in the idle main chat\'s mail, never a request or an Approvals item; answered by send_to_subthread; no repeat in the turn report', async () => {
  const r = await rig();
  try {
    const main = await r.chat('claude');
    const sub = subId((await r.call('start_subthread', { title: 'Price list', brief: 'Make the price list.' }, main)).text);
    // not a sub thread: refused
    assert.match((await r.call('ask_main_thread', { kind: 'question', question: 'x?' }, main)).text, /Only a sub thread can ask its main thread/);
    const out = await r.call('ask_main_thread', { kind: 'question', question: 'EUR or USD?', details: 'The shop is in Berlin.', options: ['EUR', 'USD'] }, sub);
    assert.ok(out.ok, out.text);
    const [ask] = r.store.openAsks({ thread: sub });
    assert.equal(ask.parent_id, main);
    assert.match(out.text, new RegExp(`Asked your main thread \\(${ask.id}\\)\\. End your turn now`));
    await r.until(() => r.mailTo(main).includes(`Chorus: sub thread "Price list" (${sub}) asks [${ask.id}] (question): EUR or USD? — The shop is in Berlin. — options: EUR / USD. Answer it with send_to_subthread.`), 'delivered to the main chat');
    await r.until(() => !!r.store.getAsk(ask.id)!.typed, 'marked delivered');
    const qm = r.delivered.find(d => d.m.kind === 'question')!.m;
    assert.deepEqual([qm.from.thread, qm.refs.question, qm.meta], [sub, ask.id, { kind: 'question', details: 'The shop is in Berlin.', options: ['EUR', 'USD'] }]);
    // nothing for the user: no request card, nothing in Approvals
    assert.equal(r.store.pendingRequests().length, 0);
    assert.deepEqual(r.srv.state().approvals, []);
    // its turn ends on the question: no report repeats it
    r.endTurn(sub, 'Asked my main thread: EUR or USD?');
    await r.until(() => r.store.getThread(sub)!.sub_status === 'stopped', 'turn end seen');
    await r.until(() => !!r.store.getThread(sub)!.sub_reported, 'marked reported');
    await sleep(600);
    assert.doesNotMatch(r.mailTo(main), /ended its turn/);
    // the main thread answers: the ask is answered, and the answer is typed into the sub thread
    const a = await r.call('send_to_subthread', { id: sub, message: 'EUR.' }, main);
    assert.match(a.text, /It answers its open question\./);
    assert.ok(r.store.getAsk(ask.id)!.answered);
    assert.deepEqual(r.store.openAsks({ parent: main }), []);
    assert.equal(r.srv.mail.get(qm.id)!.state, 'answered', 'the question mail is answered');
    await r.until(() => r.mailTo(sub).includes('EUR.'), 'answer delivered to the sub thread');
    // a later turn end with no open question is reported as before
    r.store.updateThread(sub, { state: 'working' });
    await r.until(() => r.store.getThread(sub)!.sub_status === 'working', 'working again');
    await sleep(700);
    r.endTurn(sub, 'Done in EUR.');
    await r.until(() => r.mailTo(main).includes(`Chorus: sub thread ${sub} "Price list"`) && r.mailTo(main).includes('Done in EUR.'), 'reported');
  } finally {
    await r.done();
  }
});

test('ask_main_thread: a task step\'s Worker is pointed to its Planner; the chat\'s CLI pid is recorded while it runs', async () => {
  const r = await rig();
  try {
    const main = await r.chat('claude');
    const step = await r.chat('codex');
    r.srv['subs'].watchOnly(step, main);
    assert.match((await r.call('ask_main_thread', { kind: 'question', question: 'x?' }, step)).text, /ask your Planner/);
    assert.equal(r.store.openAsks({ parent: main }).length, 0);
    const pid = r.c.app.entry(main)!.host!.pid;
    assert.equal(r.store.getThread(main)!.cli_pid, pid);
    assert.equal(r.store.threadByCliPid(pid)!.id, main);
    r.c.app.entry(main)!.host!.kill();
    await r.until(() => r.store.getThread(main)!.cli_pid == null, 'cleared when the CLI ends');
  } finally {
    await r.done();
  }
});
