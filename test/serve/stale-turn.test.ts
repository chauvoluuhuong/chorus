// A chat whose CLI was killed mid-turn by a Chorus restart (task #14): its transcript never got that turn's end, so its row stayed
// "working" for hours after the resumed CLI went idle, and the mailbox held its mail. look() now reports such a resumed chat idle once
// its CLI process has run STALE_TURN_MS with nothing new recorded; a chat that records a new turn is working as before.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import type { ProLoader } from '../../src/serve/pro.ts';
import { ChorusServer, headlessApp, STALE_TURN_MS } from '../../src/serve/server.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-tui.mjs');
const LOCKED: ProLoader = { dev: true, load: async () => ({ locked: 'no-licence', message: 'No licence on this computer.' }), activate: async () => ({ locked: 'no-licence', message: 'x' }) };
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function serve(home: string, project: string, clock: { t: number }) {
  process.env.CODEX_HOME = home;
  const store = new Store(project, { home });
  const c = new Controller({ project, store, stillMs: 300, app: headlessApp(), tailPollMs: 100, opener: async () => ({ ok: true }), launcher: (agent, l) => ({ bin: process.execPath, args: [FAKE, agent], cwd: l.cwd }) });
  c.restore();
  const srv = new ChorusServer({ controller: c, token: 'c'.repeat(48), proLoader: LOCKED, now: () => clock.t, sessionExists: () => true, check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }) as any });
  const url = await srv.start(0);
  const done = async () => {
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await sleep(300);
    store.close();
  };
  return { srv, c, store, url, done, api: (srv as any) };
}

/** One turn in the record, as the tailer writes it. */
const turn = (store: Store, id: string, n: number) =>
  store.recordSession(id, { agent: 'claude', turns: Array.from({ length: n }, (_, i) => ({ seq: i + 1, role: i % 2 ? 'assistant' : 'user', text: `t${i}` })), toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } } as any);

test('a chat resumed after a restart that killed it mid-turn reads idle once its CLI has run with nothing new; the watch sees it idle', async () => {
  const home = tmp('chorus-stale-h-');
  const project = tmp('chorus-stale-p-');
  const clock = { t: 1_000_000 };
  // serve A: a chat in the middle of its turn when Chorus stops
  const a = await serve(home, project, clock);
  const r = await fetch(`${a.url}/api/chats`, { method: 'POST', headers: { authorization: `Bearer ${a.srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'claude', folder: project }) });
  const id = ((await r.json()) as { id: string }).id;
  a.store.updateThread(id, { native_session_id: 'sess-1', state: 'working' });
  turn(a.store, id, 1); // the user's message; the reply never came
  await a.done();
  // serve B: Chorus starts again, the chat is resumed (its CLI waits for input); the row still says working
  const b = await serve(home, project, clock);
  try {
    assert.equal(b.store.getThread(id)?.state, 'working');
    assert.ok(b.api.select(id), 'resumed');
    await sleep(400);
    assert.equal(b.c.app.entry(id)?.host?.state, 'running');
    b.api.mail.send({ from: { who: 'chorus' }, to: { thread: id }, kind: 'note', subject: 's', body: 'b', refs: {} });
    b.api.watch.tick(clock.t);
    assert.equal(b.srv.look(id)?.state, 'working', 'within the grace window');
    assert.equal(b.api.watch.get(`inbox:${id}`)?.seen, 'working');
    clock.t += STALE_TURN_MS;
    assert.equal(b.srv.look(id)?.state, 'waiting', 'idle: its turn ended with the process that ran it');
    b.api.watch.tick(clock.t);
    // the watcher saw the turn end, so the inbox hands the note to the chat's transport (the fake chat has no channel stream to finish it)
    assert.equal(b.store.watchRecord(`inbox:${id}`)?.seen, 'waiting', 'the watch saw it idle');
    // a new turn after the resume: working again, as the row says
    b.store.updateThread(id, { state: 'working' });
    turn(b.store, id, 3);
    assert.equal(b.srv.look(id)?.state, 'working');
  } finally {
    await b.done();
  }
});

test('a new chat with no history is never called idle by this rule', async () => {
  const home = tmp('chorus-stale-h-');
  const project = tmp('chorus-stale-p-');
  const clock = { t: 1_000_000 };
  const a = await serve(home, project, clock);
  try {
    const r = await fetch(`${a.url}/api/chats`, { method: 'POST', headers: { authorization: `Bearer ${a.srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'claude', folder: project }) });
    const id = ((await r.json()) as { id: string }).id;
    a.store.updateThread(id, { state: 'working' });
    a.srv.look(id);
    clock.t += STALE_TURN_MS * 4;
    assert.equal(a.srv.look(id)?.state, 'working', 'its first turn may still be on its way');
  } finally {
    await a.done();
  }
});
