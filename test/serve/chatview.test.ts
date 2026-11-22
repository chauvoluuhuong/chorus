// The Chat view's server side (plan 2026-11-22 chat-view, src/serve/chatview.ts): pages of turns with short tool call rows, only
// what is new pushed to a page that shows the chat, a call's detail fetched once and only on request, `say` and `key` as the user
// typing (skills, the agent's own commands, @paths, watch-only), and a phone in the Chat view getting no terminal bytes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import type { Session } from '@chauvoluuhuong/chorus-core';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import { sourceDir } from '../../src/core/skills.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import { typedText, heldInInput, DETAIL_MAX } from '../../src/serve/chatview.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-tui.mjs');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function rig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-cv-home-'));
  process.env.CODEX_HOME = home;
  process.env.CHORUS_SKILLS_HOME = home;
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-cv-')));
  // a skill this project has: "/demo-skill" in a message becomes the sentence each CLI understands
  fs.mkdirSync(path.join(sourceDir(project), 'demo-skill'), { recursive: true });
  fs.writeFileSync(path.join(sourceDir(project), 'demo-skill', 'SKILL.md'), '---\nname: demo-skill\ndescription: A demo skill for the chat view test\n---\nDo the demo.\n');
  const store = new Store(project);
  const c = new Controller({ project, store, stillMs: 300, app: headlessApp(), tailPollMs: 100, opener: async () => ({ ok: true }), launcher: (agent, o) => ({ bin: process.execPath, args: [FAKE, agent], cwd: o.cwd }) });
  c.restore();
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }), sayCheckMs: 300 });
  const url = await srv.start(0);
  const api = async (method: string, p: string, body?: object, headers: Record<string, string> = {}) => {
    const res = await fetch(url + p, { method, headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, bytes: Buffer.byteLength(text) };
  };
  const viewer = async () => {
    const ws = new WebSocket(url.replace('http', 'ws') + '/ws', { headers: { authorization: `Bearer ${srv.token}` } });
    const msgs: any[] = [];
    let bytes = 0;
    ws.on('message', d => {
      bytes += String(d).length;
      msgs.push(JSON.parse(String(d)));
    });
    await new Promise<void>((res, rej) => (ws.once('open', () => res()), ws.once('error', rej)));
    return { ws, msgs, bytes: () => bytes, send: (m: object) => ws.send(JSON.stringify(m)) };
  };
  const done = async () => {
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await sleep(300);
    store.close();
  };
  return { srv, c, store, project, url, api, viewer, done };
}

/** A session of `n` turns, every assistant turn followed by two calls (a command and a read). */
function session(n: number, extra: Partial<Session> = {}): Session {
  const s: Session = { agent: 'claude', turns: [], toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }, ...extra };
  for (let i = 1; i <= n; i++) {
    s.turns.push({ seq: i, role: i % 2 ? 'user' : 'assistant', text: `turn ${i}`, ts: new Date(Date.UTC(2026, 10, 22, 10, 0, i)).toISOString() });
    if (i % 2 === 0) {
      s.toolCalls.push({ id: `c${i}a`, turnSeq: i, tool: 'Bash', kind: 'command', target: `npm test ${i}`, status: 'ok', result: 'all passed', detail: undefined });
      s.toolCalls.push({ id: `c${i}b`, turnSeq: i, tool: 'Read', kind: 'read', target: `src/f${i}.js`, status: 'ok', note: '12 lines', result: 'const a = 1' });
    }
  }
  return s;
}

test('typedText: new lines as the CLI\'s new-line keys, a space after a final @path; heldInInput reads the input box', () => {
  assert.equal(typedText('codex', 'look at @src/a.js'), 'look at @src/a.js ');
  assert.equal(typedText('agy', 'one\ntwo'), 'one\x1b\rtwo');
  assert.equal(typedText('claude', 'plain text  '), 'plain text');
  assert.equal(typedText('claude', 'mail me@x.com about it'), 'mail me@x.com about it');
  const rows = (draft: string) => [{ text: '' }, { text: `› ${draft}` }, { text: '' }, { text: '  GPT-5.6-Luna medium · ~/p' }];
  assert.equal(heldInInput('codex', rows('/nosuchword reply'), 120, '/nosuchword reply'), true);
  assert.equal(heldInInput('codex', rows('Ask Codex to do anything'), 120, '/nosuchword reply'), false);
});

test('GET turns: the newest page, then earlier pages; short rows only, never a call\'s output', async () => {
  const r = await rig();
  try {
    const t = r.store.createThread({ title: 'paged', agent: 'claude', cwd: r.project });
    const s = session(70);
    s.toolCalls[0].detail = 'SECRET-OUTPUT-OF-A-FAILED-CALL';
    s.toolCalls[0].status = 'failed';
    s.toolCalls[0].note = 'exit 1';
    r.store.recordSession(t.id, s);
    const p1 = (await r.api('GET', `/api/chats/${t.id}/turns`)).json;
    assert.deepEqual(p1.turns.map((x: any) => x.seq), Array.from({ length: 30 }, (_, i) => 41 + i));
    assert.equal(p1.more, true);
    assert.equal(p1.from, 41);
    assert.ok(p1.calls.every((c: any) => c.seq >= 41), 'the calls of this page only');
    for (const c of p1.calls) assert.ok(Object.keys(c).every(k => ['id', 'kind', 'seq', 'status', 'target', 'tool', 'word', 'ms'].includes(k)), Object.keys(c).join());
    assert.equal(p1.calls.find((c: any) => c.id === 'c42b').word, '12 lines');
    const p2 = (await r.api('GET', `/api/chats/${t.id}/turns?before=41`)).json;
    assert.deepEqual([p2.turns[0].seq, p2.turns.at(-1).seq, p2.more], [11, 40, true]);
    const p3 = (await r.api('GET', `/api/chats/${t.id}/turns?before=11`)).json;
    assert.deepEqual([p3.turns[0].seq, p3.turns.at(-1).seq, p3.more], [1, 10, false]);
    const failed = p3.calls.find((c: any) => c.id === 'c2a');
    assert.deepEqual([failed.status, failed.word], ['failed', 'exit 1']);
    assert.ok(!JSON.stringify(p3).includes('SECRET-OUTPUT'), 'the detail is not in the page');
    assert.ok(!JSON.stringify(p1).includes('all passed'), 'nor the one-line result');
  } finally {
    await r.done();
  }
});

test('the push: a page that shows the chat gets only the new turns and the changed rows, from the tailer\'s own update', async () => {
  const r = await rig();
  try {
    const t = r.store.createThread({ title: 'live', agent: 'claude', cwd: r.project });
    const s = session(6);
    r.store.recordSession(t.id, s);
    const v = await r.viewer();
    v.send({ t: 'cv', id: t.id, seq: 6 });
    await sleep(200);
    v.msgs.length = 0;
    // a new reply and a call that is running, then the same call done
    s.turns.push({ seq: 7, role: 'assistant', text: 'running the tests' });
    s.toolCalls.push({ id: 'run7', turnSeq: 7, tool: 'Bash', kind: 'command', target: 'npm test', status: 'running' });
    r.store.recordSession(t.id, s);
    await sleep(100);
    s.toolCalls.at(-1)!.status = 'ok';
    r.store.recordSession(t.id, s);
    r.store.recordSession(t.id, s); // nothing changed: nothing sent
    await sleep(200);
    const cv = v.msgs.filter(m => m.t === 'cv');
    assert.equal(cv.length, 2, 'one message per change, none for no change');
    assert.deepEqual(cv[0].turns.map((x: any) => x.seq), [7]);
    assert.deepEqual(cv[0].calls.map((c: any) => [c.id, c.status]), [['run7', 'running']]);
    assert.deepEqual(cv[1].turns, []);
    assert.deepEqual(cv[1].calls.map((c: any) => [c.id, c.status]), [['run7', 'ok']]);
    // another chat's update is not sent; a page that leaves the view gets nothing more
    const other = r.store.createThread({ title: 'other', agent: 'claude', cwd: r.project });
    r.store.recordSession(other.id, session(2));
    v.send({ t: 'cv' });
    await sleep(100);
    s.turns.push({ seq: 8, role: 'user', text: 'more' });
    r.store.recordSession(t.id, s);
    await sleep(200);
    assert.equal(v.msgs.filter(m => m.t === 'cv').length, 2);
    v.ws.close();
  } finally {
    await r.done();
  }
});

test('GET calls/:id: read from the transcript only when asked, cut at 4 KB, whole with ?full=1', async () => {
  const r = await rig();
  try {
    const t = r.store.createThread({ title: 'detail', agent: 'claude', cwd: r.project });
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join('\n');
    const file = path.join(r.project, 'transcript.jsonl');
    const lines = [
      { type: 'user', message: { role: 'user', content: 'run it' }, timestamp: '2026-11-22T10:00:00Z' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'seq 1 2000' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: big }] } },
    ];
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    const s = session(2);
    s.toolCalls.push({ id: 'toolu_1', turnSeq: 2, tool: 'Bash', kind: 'command', target: 'seq 1 2000', status: 'ok' });
    r.store.recordSession(t.id, s, { transcriptPath: file });
    const page = await r.api('GET', `/api/chats/${t.id}/turns`);
    assert.ok(!page.json.calls.some((c: any) => 'output' in c), 'no detail in the page');
    const d = (await r.api('GET', `/api/chats/${t.id}/calls/toolu_1`)).json;
    assert.equal(d.input, 'seq 1 2000');
    assert.equal(d.cut, true);
    assert.ok(Buffer.byteLength(d.output) <= DETAIL_MAX);
    assert.match(d.output, /^line 1\n/);
    const all = (await r.api('GET', `/api/chats/${t.id}/calls/toolu_1?full=1`)).json;
    assert.equal(all.output, big);
    assert.equal(all.cut, false);
    // a call the transcript does not have: the row's own text; an unknown call: 404
    const row = (await r.api('GET', `/api/chats/${t.id}/calls/c2a`)).json;
    assert.deepEqual([row.input, row.output], ['npm test 2', 'all passed']);
    assert.equal((await r.api('GET', `/api/chats/${t.id}/calls/nope`)).json.error, 'not found');
  } finally {
    await r.done();
  }
});

test('say: a skill, the agent\'s own command and an @path reach the CLI as typed; watch-only is refused; key sends Esc', async () => {
  const r = await rig();
  try {
    const id = (await r.api('POST', '/api/chats', { agent: 'codex', folder: r.project })).json.id as string;
    const screen = () => r.c.app.entry(id)!.host!.screen.text().join('\n');
    for (let i = 0; i < 60 && !/READY codex/.test(screen()); i++) await sleep(50);
    assert.match(screen(), /READY codex/);
    const say = (text: string) => r.api('POST', `/api/chats/${id}/say`, { text });
    assert.equal((await say('/demo-skill then check @src/a.js')).json.result, 'sent');
    assert.equal((await say('/compact')).json.result, 'sent');
    assert.equal((await say('look at @notes.txt')).json.result, 'sent');
    for (let i = 0; i < 60 && !/got: "look at @notes.txt "/.test(screen()); i++) await sleep(50);
    const sc = screen();
    assert.match(sc, /got: "Use the Chorus skill \\"demo-skill\\" \(load it with the chorus get_skill tool\)\. then check @src\/a\.js "/);
    assert.match(sc, /got: "\/compact"/);
    assert.match(sc, /got: "look at @notes\.txt "/, 'a space after the final @path');
    assert.equal((await say('   ')).json.error, 'Type a message first.');
    // the key row: Esc as its byte; anything else refused
    assert.deepEqual((await r.api('POST', `/api/chats/${id}/key`, { key: 'esc' })).json, { ok: true });
    for (let i = 0; i < 40 && !/KEY esc/.test(screen()); i++) await sleep(50);
    assert.match(screen(), /KEY esc/);
    assert.match((await r.api('POST', `/api/chats/${id}/key`, { key: 'ctrl-c' })).json.error, /esc or shift-tab/);
    // a sub thread is watch-only: nothing typed, in either route
    const main = r.store.createThread({ title: 'main', agent: 'claude', cwd: r.project });
    const sub = r.store.createThread({ title: 'sub', agent: 'claude', cwd: r.project, parent_thread_id: main.id });
    r.store.setSub(sub.id, { sub_status: 'working', sub_brief: 'x' });
    assert.match((await r.api('POST', `/api/chats/${sub.id}/say`, { text: 'hi' })).json.error, /watch-only/);
    assert.match((await r.api('POST', `/api/chats/${sub.id}/key`, { key: 'esc' })).json.error, /watch-only/);
  } finally {
    await r.done();
  }
});

test('a phone in the Chat view: no terminal bytes, a parked chat is not resumed, and the page is small', async () => {
  const r = await rig();
  try {
    const t = r.store.createThread({ title: 'parked', agent: 'claude', cwd: r.project });
    r.store.updateThread(t.id, { native_session_id: 'sess-1' });
    r.store.recordSession(t.id, session(40));
    const launches = () => r.c.app.entries.filter(e => e.host).length;
    const before = launches();
    const v = await r.viewer();
    const page = await r.api('GET', `/api/chats/${t.id}/turns`);
    v.send({ t: 'cv', id: t.id, seq: 40 });
    await sleep(400);
    assert.equal(launches(), before, 'opening the Chat view resumes nothing');
    assert.ok(!v.msgs.some(m => m.t === 'screen' || m.t === 'out'), 'no terminal bytes');
    assert.ok(page.bytes < 8000, `one page is ${page.bytes} bytes`);
    // a request through a proxy (the private link) never reaches the routes without the module letting it in
    assert.notEqual((await r.api('GET', `/api/chats/${t.id}/turns`, undefined, { 'x-forwarded-for': '100.64.0.2' })).status, 200);
    v.ws.close();
  } finally {
    await r.done();
  }
});

test('cards: a sub thread with its report and question, a chat it started, a reported artifact, mail it read; "Started by" in the new chat', async () => {
  const r = await rig();
  try {
    const main = r.store.createThread({ title: 'Ship the projects page', agent: 'claude', cwd: r.project });
    r.store.recordSession(main.id, session(4));
    const sub = r.store.createThread({ title: 'Check the docs', agent: 'codex', cwd: r.project, parent_thread_id: main.id });
    r.store.setSub(sub.id, { sub_status: 'stopped', sub_brief: 'check', sub_started: '2026-11-22T10:00:02.500Z' });
    r.store.db.prepare("INSERT INTO mail (id,from_thread,from_json,to_thread,kind,subject,body,refs,state,created_at,read_at) VALUES ('m1',NULL,'{\"who\":\"chorus\"}',?, 'report','Sub thread done',?,?, 'read','2026-11-22T10:00:03.5Z','2026-11-22T10:00:03.6Z')").run(main.id, 'The doc matches, except Export.', JSON.stringify({ about: sub.id }));
    r.store.db.prepare("INSERT INTO asks (id,thread_id,parent_id,kind,question,created) VALUES ('q1',?,?,'question','Accept 1.4 %?','2026-11-22T10:00:03Z')").run(sub.id, main.id);
    const other = r.store.createThread({ title: 'Designer · Empty state', agent: 'agy', cwd: r.project, parent_thread_id: main.id });
    const file = path.join(r.project, 'hero.html');
    fs.writeFileSync(file, '<h1>hi</h1>');
    r.store.db.prepare('INSERT INTO reported (thread_id,target,title,ts) VALUES (?,?,?,?)').run(main.id, file, 'Landing hero', '2026-11-22T10:00:04.5Z');
    const cards = (await r.api('GET', `/api/chats/${main.id}/turns`)).json.cards;
    const by = (type: string) => cards.filter((c: any) => c.type === type);
    assert.deepEqual(by('sub').map((c: any) => [c.title, c.report, c.question, c.seq]), [['Check the docs', 'The doc matches, except Export.', 'Accept 1.4 %?', 2]]);
    assert.deepEqual(by('chat').map((c: any) => [c.title, c.teammate, c.agent]), [['Designer · Empty state', 'Designer', 'agy']]);
    assert.deepEqual(by('artifact').map((c: any) => [c.title, c.kind, c.open, c.seq]), [['Landing hero', 'html', true, 4]]);
    assert.equal(by('mail').length, 1);
    const inNew = (await r.api('GET', `/api/chats/${other.id}/turns`)).json.cards;
    assert.deepEqual(inNew.filter((c: any) => c.type === 'startedBy').map((c: any) => c.title), ['Ship the projects page']);
    // a sub thread has no "Started by" line: its main chat is its own strip
    assert.equal((await r.api('GET', `/api/chats/${sub.id}/turns`)).json.cards.filter((c: any) => c.type === 'startedBy').length, 0);
  } finally {
    await r.done();
  }
});
