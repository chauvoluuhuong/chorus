// Main thread and sub threads (plan 2026-11-14, Stage 2): the four tools over the MCP bridge, with the paid module locked or
// absent; a sub thread's turn end reported into its main chat; nothing reported while it waits on an approval; the 3-sub limit and
// the one-level rule; the watchdog. The chats are the fake agent; a turn's end is the thread's state going working → waiting,
// which the controller writes from the CLI's session (set here by hand, as the fake agent keeps no session file).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AgentId } from '../../src/core/types.ts';
import { Controller } from '../../src/app/controller.ts';
import { createServer, SUBTHREADS_NOTE } from '../../src/mcp/server.ts';
import { Store } from '../../src/core/store.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import type { ProLoader } from '../../src/serve/pro.ts';
import { SUB_NOTE } from '../../src/serve/subthreads.ts';

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
  const agents = (o.usable ?? (['claude', 'codex', 'agy'] as AgentId[])).map(agent => ({ agent, state: 'ready' }));
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), proLoader: o.loader ?? LOCKED, check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents, ms: 1 }) as any, subQuietMs: o.quietMs ?? 60_000, subGapMs: 200, sessionExists: () => true });
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
  return { srv, c, store, project, home, url, call, chat, screen, endTurn, until, launches, done };
}

const subId = (text: string) => text.match(/sub thread (t_\w+)/)![1];

test('sub threads: the four tools are listed for a chat with the paid module locked or absent, not for a connected AI app; every chat is told', async () => {
  for (const loader of [LOCKED, ABSENT]) {
    const r = await rig({ loader });
    try {
      const get = async (q: string) => (await (await fetch(`${r.url}/api/pro/mcp/tools${q}`, { headers: { authorization: `Bearer ${r.srv.mcpToken}` } })).json()) as { tools: { name: string }[] };
      assert.deepEqual((await get('')).tools.map(t => t.name), ['start_subthread', 'send_to_subthread', 'list_subthreads', 'stop_subthread']);
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
      assert.ok(client.getInstructions()?.includes(SUBTHREADS_NOTE));
      await client.close();
    } finally {
      await r.done();
    }
  }
});

test('sub threads: started in the caller\'s folder with the brief; its turn end is typed into the idle main chat; send_to_subthread and stop', async () => {
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
    assert.equal(r.store.getThread(sub)!.sub_reported, null, 'not typed into a busy main chat');
    assert.doesNotMatch(r.screen(main), /Chorus: sub thread/);
    r.store.updateThread(main, { state: 'waiting' });
    await r.until(() => !!r.store.getThread(sub)!.sub_reported, 'reported');
    await r.until(() => r.screen(main).includes(`Chorus: sub thread ${sub} "Price list" (codex) ended its turn after 0 min. It said: "Done: prices.md has 12 cakes. Should I add VAT?"`), 'report typed into the main chat');
    assert.equal(r.store.getThread(sub)!.sub_turns, 1);
    const listed = await r.call('list_subthreads', {}, main);
    assert.match(listed.text, new RegExp(`^${sub}\\tPrice list\\tcodex\\tstopped\\t1 turns\\t0 min\\tDone: prices.md`));

    // more work: typed into the idle sub thread, which counts as working again
    const more = await r.call('send_to_subthread', { id: sub, message: 'Yes, add VAT at 8%.' }, main);
    assert.ok(more.ok);
    await r.until(() => r.screen(sub).includes('Yes, add VAT at 8%.'), 'typed into the sub thread');
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
    // its turn ends on a question card to the user: waiting_user, no report
    r.store.createRequest({ threadId: a, question: 'May I delete old prices?' });
    r.endTurn(a, 'I asked the user.');
    await r.until(() => r.store.getThread(a)!.sub_status === 'waiting_user', 'waiting_user');
    await sleep(800);
    assert.equal(r.store.getThread(a)!.sub_reported, null);
    assert.doesNotMatch(r.screen(main), /Chorus: sub thread/);
    // the user answers and the turn is over: now it is reported
    for (const q of r.store.pendingRequests(a)) r.store.answerRequest(q.id, 'Approve');
    await r.until(() => r.screen(main).includes(`Chorus: sub thread ${a} "A"`), 'reported after the answer');

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
    await r.until(() => r.store.getThread(s)!.sub_status === 'quiet', 'quiet', 6000);
    await r.until(() => r.screen(main).includes(`Chorus: sub thread ${s} "Slow one" (claude) has shown no activity`), 'told to the main chat');
    assert.doesNotMatch(r.screen(s), /no activity/, 'not typed into the sub thread');
    const told = () => r.screen(main).split('has shown no activity').length - 1;
    await sleep(1500);
    assert.equal(told(), 1, 'once');
    // a tool call shows up: working again
    r.store.db.prepare('INSERT INTO tool_calls (thread_id,call_id,turn_seq,tool,target,status) VALUES (?,?,?,?,?,?)').run(s, 'c1', 1, 'Bash', 'npm test', 'ok');
    await r.until(() => r.store.getThread(s)!.sub_status === 'working', 'working after activity');
  } finally {
    await r.done();
  }
});
