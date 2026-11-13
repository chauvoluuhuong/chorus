// chorus serve (Phase 5): the local API and the agent-screen WebSocket, with a fake TUI as the agent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { Controller, SKIPPED } from '../../src/app/controller.ts';
import { VirtualScreen } from '../../src/app/screen.ts';
import { buildHandoff } from '../../src/core/handoff.ts';
import { buildInteractive } from '../../src/core/launch.ts';
import { Store } from '../../src/core/store.ts';
import type { AgentId } from '../../src/core/types.ts';
import type { AgentCheck, FastReport } from '@chauvoluuhuong/chorus-core/doctor';
import { SignIns } from '../../src/serve/signin.ts';
import { boxLoginCommand, ChorusServer, headlessApp, hostNames, type ServeOpts } from '../../src/serve/server.ts';
import { NotificationInbox } from '../../src/serve/notifications.ts';
import { UpdateCheck } from '../../src/serve/updates.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-tui.mjs');
const PROMPT = path.join(ROOT, 'fixtures/codex/0.163.0/approval-ask-nohook-enter/prompt-screen.txt');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The doctor's short check as the server sees it: every agent ready unless a test says otherwise. */
const agentCheck = (agent: AgentId, state: AgentCheck['state'], login: AgentCheck['login'] = state === 'needs-login' ? 'no' : 'yes'): AgentCheck => ({ agent, name: agent, state, login, version: '1.0.0', page: '', loginCommand: [agent, 'login'], ms: 1 });
const fastReport = (agents: AgentCheck[] = (['claude', 'codex', 'agy'] as AgentId[]).map(a => agentCheck(a, 'ready'))): FastReport => ({ node: { version: '22', ok: true }, platform: 'test', agents, ms: 1 });

async function rig(seed?: (store: Store, project: string) => void, notifications?: NotificationInbox, updates?: UpdateCheck, doctor: Pick<ServeOpts, 'check' | 'runCommand' | 'pickFolder' | 'sessionExists' | 'host' | 'container' | 'signIns'> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-home-'));
  process.env.CODEX_HOME = home;
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-serve-')));
  const store = new Store(project);
  seed?.(store, project);
  const launches: { agent: AgentId; prompt?: string; resumeId?: string; skipPermissions?: boolean }[] = [];
  // the model and folder each chat was launched with
  const launchedWith: { agent: AgentId; model?: string; cwd: string }[] = [];
  let srvRef: ChorusServer | undefined;
  const c = new Controller({
    project,
    store,
    stillMs: 300,
    // only a test that says whether sessions exist checks for lost ones (decision 18)
    sessionGone: doctor.sessionExists ? row => srvRef?.sessionGone(row) : undefined,
    app: headlessApp(),
    tailPollMs: 100,
    opener: async () => ({ ok: true }),
    launcher: (agent, o) => {
      launches.push({ agent, prompt: o.prompt, resumeId: o.resumeId, skipPermissions: o.skipPermissions });
      launchedWith.push({ agent, model: o.model, cwd: o.cwd });
      return { bin: process.execPath, args: [FAKE, agent], cwd: o.cwd };
    },
  });
  c.restore();
  const notificationLinks: string[] = [];
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), notifications, updates, check: async () => fastReport(), ...doctor, onUpdateOpen: url => { notificationLinks.push(url); }, onNotificationLink: url => { notificationLinks.push(url); } });
  srvRef = srv;
  const url = await srv.start(0);
  const api = async (method: string, p: string, body?: object, headers: Record<string, string> = {}) => {
    const res = await fetch(url + p, { method, headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };
  const done = async () => {
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await sleep(300); // the agents' exits arrive before the store closes
    store.close();
  };
  return { srv, c, store, project, url, api, launches, launchedWith, notificationLinks, done };
}

/** A desktop window: a socket and the terminal it would draw (replayed screen + live bytes). */
async function viewer(url: string, token: string, origin?: string, query = '') {
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws' + query, { headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) } });
  const msgs: any[] = [];
  const term = new VirtualScreen(100, 30);
  ws.on('message', d => {
    const m = JSON.parse(String(d));
    msgs.push(m);
    if (m.t === 'screen') {
      term.term.reset();
      term.write(m.data);
    } else if (m.t === 'out') term.write(m.data);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  const until = async (pred: () => boolean, what: string, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return;
      await sleep(50);
    }
    assert.fail(`timed out: ${what}\n${term.text().filter(l => l.trim()).join('\n')}`);
  };
  const send = (m: object) => ws.send(JSON.stringify(m));
  const state = () => [...msgs].reverse().find(m => m.t === 'state')?.state;
  return { ws, msgs, term, until, send, state, text: () => term.text().join('\n') };
}

test('serve: 127.0.0.1 only, a token on every request, our Host only, writes need X-Chorus, sockets only from our page', async () => {
  const r = await rig();
  try {
    assert.match(r.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(r.url + '/api/state')).status, 401, 'no token');
    assert.equal((await r.api('GET', '/api/state', undefined, { authorization: 'Bearer ' + 'b'.repeat(48) })).status, 401, 'wrong token');
    assert.equal((await r.api('GET', '/api/state')).status, 200);
    // DNS rebinding: a page on evil.example resolving to 127.0.0.1 sends its own Host
    const port = new URL(r.url).port;
    const rebind = await new Promise<number>(resolve => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/state', headers: { host: `evil.example:${port}`, authorization: `Bearer ${r.srv.token}` } }, res => resolve(res.statusCode ?? 0));
      req.end();
    });
    assert.equal(rebind, 403, 'foreign Host header');
    assert.equal((await r.api('POST', '/api/chats', { agent: 'claude' }, { 'x-chorus': '' })).status, 403, 'a write without X-Chorus');
    // the first visit brings the page and the token as a cookie (no redirect: see server.ts)
    const first = await fetch(r.srv.openUrl, { redirect: 'manual' });
    assert.equal(first.status, 200);
    assert.match(await first.text(), /<title>Chorus<\/title>/);
    const cookie = first.headers.get('set-cookie') ?? '';
    assert.match(cookie, new RegExp(`chorus_token_${new URL(r.url).port}=a{48}; HttpOnly; SameSite=Strict`));
    // a stale cookie of an earlier server on this host does not hide the right token in the address
    const stale = await fetch(r.srv.openUrl, { headers: { cookie: `chorus_token_${new URL(r.url).port}=${'b'.repeat(48)}` } });
    assert.equal(stale.status, 200, 'a new token in the address wins over a stale cookie');
    const page = await fetch(r.url + '/', { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Chorus<\/title>/);
    const xterm = await fetch(r.url + '/vendor/xterm.js', { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(xterm.status, 200, 'xterm.js is served from node_modules');
    assert.equal((await fetch(r.url + '/../package.json', { headers: { cookie: cookie.split(';')[0] } })).status, 404);
    await assert.rejects(viewer(r.url, r.srv.token, 'https://evil.example'), /HTTP|socket hang up|closed|ECONNRESET/);
    const ok = await viewer(r.url, r.srv.token, r.url);
    ok.ws.close();
  } finally {
    await r.done();
  }
});

test('serve: a new chat streams its agent screen; typing, resize and the replayed screen work like a terminal', async () => {
  const r = await rig();
  try {
    const v = await viewer(r.url, r.srv.token);
    const made = await r.api('POST', '/api/chats', { agent: 'codex', folder: r.project, prompt: 'hello there', skip: true });
    assert.equal(made.status, 200);
    const id = made.json.id as string;
    assert.deepEqual(r.launches[0], { agent: 'codex', prompt: 'hello there', resumeId: undefined, skipPermissions: true });
    v.send({ t: 'attach', id, cols: 90, rows: 25 });
    await v.until(() => /READY codex/.test(v.text()), 'the agent screen arrives');
    await v.until(() => /SIZE 90x25/.test(v.text()), 'the agent takes the window size');
    assert.equal(v.state().chats[0].id, id);
    assert.equal(v.state().chats[0].agent, 'codex');
    assert.equal(v.state().chats[0].skip, true);
    v.send({ t: 'in', id, data: 'abc' });
    v.send({ t: 'in', id, data: '\r' });
    await v.until(() => /got: "abc"/.test(v.text()), 'typing reaches the agent');
    v.send({ t: 'resize', id, cols: 80, rows: 20 });
    await v.until(() => /SIZE 80x20/.test(v.text()), 'resize');
    // a second window opened later gets the same screen, modes included (the agent asked for bracketed paste)
    const w = await viewer(r.url, r.srv.token);
    w.send({ t: 'attach', id, cols: 80, rows: 20 });
    await w.until(() => /got: "abc"/.test(w.text()) && /red bold/.test(w.text()), 'replayed screen');
    assert.equal(w.term.modes().bracketedPaste, true, 'bracketed paste mode replayed');
    v.send({ t: 'in', id, data: 'mouse\r' });
    await v.until(() => v.term.modes().mouse, 'live mode change reaches the window');
    const x = await viewer(r.url, r.srv.token);
    x.send({ t: 'attach', id, cols: 80, rows: 20 });
    await x.until(() => x.msgs.some(m => m.t === 'screen'), 'screen');
    assert.match(x.msgs.find(m => m.t === 'screen').data, /\x1b\[\?1000h/);
    assert.match(x.msgs.find(m => m.t === 'screen').data, /\x1b\[\?1006h/, 'SGR mouse encoding added to the replay');
    for (const c of [v, w, x]) c.ws.close();
  } finally {
    await r.done();
  }
});

test('serve: approvals, handoff, delete (asked through a dialog), activity, memory and the record of a chat', async () => {
  const r = await rig();
  try {
    const v = await viewer(r.url, r.srv.token);
    const a = (await r.api('POST', '/api/chats', { agent: 'codex', folder: r.project })).json.id as string;
    const b = (await r.api('POST', '/api/chats', { agent: 'claude', folder: r.project })).json.id as string;
    v.send({ t: 'attach', id: b, cols: 100, rows: 30 });
    await v.until(() => /READY claude/.test(v.text()), 'claude in front');
    // the chat behind asks for approval: the state lists it, the API answers it without switching
    r.c.app.entry(a)!.host!.write(`show ${PROMPT}\r`);
    await v.until(() => v.state()?.approvals.length === 1, 'pending approval in the state');
    const p = v.state().approvals[0];
    assert.equal(p.id, a);
    assert.ok(p.what && p.risk);
    assert.equal(v.state().chats.find((c: any) => c.id === a).state, 'approval');
    assert.equal((await r.api('GET', '/api/approvals')).json.pending.length, 1);
    assert.equal((await r.api('POST', `/api/chats/${a}/approve`)).json.ok, true);
    await v.until(() => v.state()?.approvals.length === 0, 'answered');
    assert.equal(r.store.approvalsLog()[0].decision, 'approved');
    assert.equal((await r.api('GET', '/api/approvals')).json.decided[0].decision, 'approved');
    assert.ok(v.msgs.some(m => m.t === 'flash' && /^approved/.test(m.text)), 'the flash reaches the window');
    const act = (await r.api('GET', `/api/chats/${a}/activity`)).json;
    assert.ok(act.rows.some((x: any) => x.kind === 'approval' && x.status === 'approved'));
    // a request_approval card: listed with its options, answered with a note, typed into the agent
    const req = r.store.createRequest({ threadId: a, question: 'Use Postgres?', options: ['Postgres', 'SQLite'] });
    await v.until(() => v.state()?.approvals.some((x: any) => x.kind === 'ask' && x.request === req.id), 'the card in the state');
    assert.deepEqual(v.state().approvals.find((x: any) => x.request === req.id).options, ['Postgres', 'SQLite']);
    assert.equal((await r.api('POST', `/api/chats/${a}/answer`, { request: req.id, option: 'SQLite', note: 'for now' })).json.ok, true);
    await v.until(() => !v.state()?.approvals.some((x: any) => x.kind === 'ask'), 'answered'); // the fake agent keeps its old prompt on screen
    assert.equal(r.store.getRequest(req.id)!.answer, 'SQLite');
    assert.equal((await r.api('POST', `/api/chats/${a}/answer`, { request: req.id, option: 'Postgres' })).json.ok, false, 'once');
    // handoff: a child chat with the fixed first message
    const h = await r.api('POST', `/api/chats/${a}/handoff`, { to: 'agy' });
    const child = h.json.id as string;
    assert.match(r.launches.at(-1)!.prompt ?? '', /get_handoff_context/);
    await v.until(() => v.state()?.chats.find((c: any) => c.id === child)?.parentId === a, 'the child is listed under its parent');
    const detail = (await r.api('GET', `/api/chats/${child}`)).json;
    assert.equal(detail.parent.id, a);
    assert.equal(detail.contextLoaded, false);
    assert.match((await r.api('GET', `/api/chats/${a}`)).json.record, /codex/);
    assert.equal((await r.api('GET', '/api/memory')).json.items.length, 3);
    // delete asks first: the question is a dialog in the state, answered by the window
    await r.api('DELETE', `/api/chats/${b}`);
    await v.until(() => v.state()?.dialogs.length === 1, 'a dialog');
    const d = v.state().dialogs[0];
    assert.equal(d.title, 'Delete this chat?');
    assert.deepEqual(d.options.map((o: any) => o.key), ['y', 'w']);
    await r.api('POST', `/api/dialogs/${d.id}`, { value: 'y' });
    await v.until(() => !v.state()?.chats.some((c: any) => c.id === b) && v.state().dialogs.length === 0, 'deleted');
    assert.equal(r.store.getThread(b), undefined);
    v.ws.close();
  } finally {
    await r.done();
  }
});

test('serve: a chat from an earlier run is parked and resumes when the window opens it; skills and new-chat info', async () => {
  const r = await rig((store, project) => {
    store.createThread({ id: 't_old', title: 'Old chat', agent: 'claude', cwd: project, native_session_id: 'sess-1', state: 'waiting' });
    fs.mkdirSync(path.join(project, '.chorus', 'skills', 'cake-pricing'), { recursive: true });
    fs.writeFileSync(path.join(project, '.chorus', 'skills', 'cake-pricing', 'SKILL.md'), '---\nname: cake-pricing\ndescription: Price a cake\n---\nbody\n');
  });
  try {
    const v = await viewer(r.url, r.srv.token);
    await v.until(() => v.state()?.chats.length === 1, 'state');
    assert.equal(v.state().chats[0].state, 'parked');
    v.send({ t: 'attach', id: 't_old', cols: 100, rows: 30 });
    await v.until(() => /READY claude/.test(v.text()), 'resumed');
    assert.equal(r.launches[0].resumeId, 'sess-1');
    const info = (await r.api('GET', '/api/newchat')).json;
    assert.deepEqual(info.agents.map((a: any) => a.id), ['claude', 'codex', 'agy']);
    assert.ok(info.agents[0].models.includes('default'));
    assert.equal(info.folder, r.project);
    assert.match(info.computer, /\.chorus\/computer$/, 'the "This computer" folder is offered');
    const from = (await r.api('GET', '/api/newchat?from=t_old')).json;
    assert.equal(from.from.title, 'Old chat');
    const sk = (await r.api('GET', '/api/skills')).json;
    assert.equal(sk.items[0].name, 'cake-pricing');
    assert.equal(sk.items[0].on, true);
    const off = (await r.api('POST', '/api/skills/cake-pricing/toggle')).json;
    assert.equal(off.items[0].on, false);
    // import a skill an agent already keeps in its own folder
    const uh = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-uh-'));
    fs.mkdirSync(path.join(uh, '.claude', 'skills', 'release-notes'), { recursive: true });
    fs.writeFileSync(path.join(uh, '.claude', 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\ndescription: Draft release notes\n---\nbody\n');
    process.env.CHORUS_SKILLS_HOME = uh;
    const found = (await r.api('GET', '/api/skills')).json.found.find((f: any) => f.name === 'release-notes');
    const imported = await r.api('POST', '/api/skills/import', { dir: found.dir });
    delete process.env.CHORUS_SKILLS_HOME;
    assert.equal(imported.status, 200);
    assert.ok(imported.json.items.some((i: any) => i.name === 'release-notes'), 'imported into the library');
    assert.ok(fs.existsSync(path.join(r.project, '.chorus', 'skills', 'release-notes', 'SKILL.md')));
    const folders = (await r.api('GET', `/api/folders?dir=${encodeURIComponent(path.dirname(r.project))}`)).json;
    assert.ok(folders.folders.includes(path.basename(r.project)));
    assert.ok((await r.api('GET', '/api/doctor')).json.lines.some((l: string) => /^claude/.test(l)));
    assert.match((await r.api('GET', '/api/doctor')).json.chorus.app, /^chorus \d+\.\d+\.\d+/);
    v.ws.close();
  } finally {
    await r.done();
  }
});

test('serve: a dropped file goes into the agent input like a terminal sends it, copied when asked, recorded with the chat', async () => {
  const r = await rig();
  try {
    const v = await viewer(r.url, r.srv.token);
    const id = (await r.api('POST', '/api/chats', { agent: 'claude', folder: r.project })).json.id as string;
    v.send({ t: 'attach', id, cols: 100, rows: 30 });
    await v.until(() => /READY claude/.test(v.text()), 'agent');
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-downloads-')));
    const spec = path.join(outside, 'my spec.txt');
    fs.writeFileSync(spec, 'the spec');
    const pastes = () => v.term.logicalLines().filter(l => l.startsWith('PASTE '));

    // the native window: full paths; nothing is sent (no Enter), the path waits in the input as a bracketed paste
    v.send({ t: 'drop', id, paths: [spec] });
    await v.until(() => pastes().length === 1, 'the path reaches the agent');
    assert.equal(pastes()[0], `PASTE ${JSON.stringify(spec.replace(' ', '\\ ') + ' ')}`);
    await v.until(() => v.msgs.some(m => m.t === 'dropped'), 'the window hears back');
    assert.ok(!/got: /.test(v.text()), 'no Enter was sent');

    // copy into the chat: the file lands in its attachments folder, a second one of the same name gets " (2)"
    v.send({ t: 'drop', id, paths: [spec], copy: true });
    v.send({ t: 'drop', id, paths: [spec], copy: true });
    await v.until(() => pastes().length === 3, 'two more pastes');
    const dir = r.store.attachmentsDir(id);
    assert.equal(dir, path.join(r.project, '.chorus', 'threads', id, 'attachments'));
    assert.deepEqual(fs.readdirSync(dir).sort(), ['my spec (2).txt', 'my spec.txt']);
    assert.match(pastes()[1], /attachments\/my\\\\ spec\.txt /);

    // a browser: the bytes, the name in the address; the same auth as every write
    const up = (headers: Record<string, string>) => fetch(`${r.url}/api/chats/${id}/attachments?name=${encodeURIComponent('shot.png')}`, { method: 'POST', headers, body: Buffer.from([137, 80, 78, 71]) });
    assert.equal((await up({ 'x-chorus': '1' })).status, 401, 'no token');
    assert.equal((await up({ authorization: `Bearer ${r.srv.token}` })).status, 403, 'no X-Chorus');
    const ok = await up({ authorization: `Bearer ${r.srv.token}`, 'x-chorus': '1' });
    assert.equal(ok.status, 200);
    const saved = ((await ok.json()) as { paths: string[] }).paths[0];
    assert.equal(saved, path.join(dir, 'shot.png'));
    assert.deepEqual([...fs.readFileSync(saved)], [137, 80, 78, 71]);
    await v.until(() => pastes().length === 4, 'the uploaded copy reaches the agent');

    // a relative path is ignored; a missing file is a message to the window
    v.send({ t: 'drop', id, paths: ['relative.txt', path.join(outside, 'gone.txt')] });
    await v.until(() => v.msgs.some(m => m.t === 'flash' && /gone\.txt does not exist/.test(m.text)), 'missing file');

    // recorded with the chat: the handoff (and so Memory's record) lists them, Activity shows each drop
    const given = r.store.attachments(id);
    assert.deepEqual(given.map(a => [path.basename(a.path), a.copied]), [['my spec.txt', false], ['my spec.txt', true], ['my spec (2).txt', true], ['shot.png', true]]);
    const text = buildHandoff(r.store, r.store.getThread(id)!).text;
    assert.match(text, /## Files the user gave\n- .*my spec\.txt\n- .*attachments\/my spec\.txt \(a copy of .*my spec\.txt\)/);
    assert.match(text, /attachments\/shot\.png/);
    assert.equal(r.c.activityRows(id).rows.filter(x => x.verb === 'drop').length, 4);
    v.ws.close();
  } finally {
    await r.done();
  }
});


test('serve: notification UI uses the launch cache; opening counts once and external links stay constrained', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-serve-news-'));
  const calls: string[] = [];
  const item = { id: 'news-one', title: 'Workspace tip', html: '<h1>A tip</h1><a href="https://example.org/tip">More</a>', revision: 1, publishedAt: new Date().toISOString() };
  const request = (async (url: string | URL | Request) => { calls.push(String(url)); return Response.json(String(url).endsWith('/startup') ? { notifications: [item], checkedAt: new Date().toISOString() } : { ok: true }); }) as typeof fetch;
  const inbox = new NotificationInbox({ directory, version: 'test', request });
  const r = await rig(undefined, inbox);
  try {
    await inbox.startup();
    assert.equal(calls.length, 1);
    for (let i = 0; i < 5; i++) {
      const cached = await r.api('GET', '/api/notifications');
      assert.equal(cached.json.unread, 1); assert.equal(cached.json.items[0].title, item.title);
      assert.equal(JSON.stringify(cached.json).includes('installationKey'), false);
      await r.api('GET', '/api/state');
    }
    assert.equal(calls.length, 1, 'UI redraws and local reads do not fetch the cloud feed');
    const opened = await r.api('POST', '/api/notifications/news-one/open', {});
    assert.equal(opened.json.item.html, item.html); assert.equal(opened.json.inbox.unread, 0);
    await inbox.opened(item.id); assert.equal(calls.length, 2);
    await r.api('POST', '/api/notifications/news-one/open', {}); await inbox.opened(item.id);
    assert.equal(calls.length, 2, 'reopening does not inflate open events');
    assert.equal((await r.api('POST', '/api/notifications/link', { id: item.id, url: 'https://example.org/tip' })).json.ok, true);
    assert.deepEqual(r.notificationLinks, ['https://example.org/tip']);
    assert.ok((await r.api('POST', '/api/notifications/link', { id: item.id, url: 'https://evil.example/' })).json.error);
    assert.equal((await r.api('POST', '/api/notifications/missing/open', {})).status, 404);
    assert.equal(calls.length, 2);
  } finally { await r.done(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('serve: the doctor screen opens at once on a first launch, and not again once a check was shown', async () => {
  const r = await rig();
  const before = process.env.CHORUS_DOCTOR_HOME;
  process.env.CHORUS_DOCTOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-doctor-'));
  try {
    assert.deepEqual((await r.api('GET', '/api/doctor/first')).json, { first: true });
    assert.equal((await r.api('POST', '/api/doctor/seen')).json.ok, true);
    assert.deepEqual((await r.api('GET', '/api/doctor/first')).json, { first: false });
  } finally {
    if (before === undefined) delete process.env.CHORUS_DOCTOR_HOME;
    else process.env.CHORUS_DOCTOR_HOME = before;
    await r.done();
  }
});

test('serve: one agent status for every screen; a login in the Doctor shows on the home screen before its job ends', async () => {
  let claude: AgentCheck['state'] = 'needs-login';
  let checks = 0;
  const commands: string[] = [];
  const r = await rig(undefined, undefined, undefined, {
    check: async () => (checks++, fastReport([agentCheck('claude', claude), agentCheck('codex', 'ready'), agentCheck('agy', 'missing', 'unknown')])),
    runCommand: async command => (commands.push(command), (claude = 'ready'), 0),
  });
  const v = await viewer(r.url, r.srv.token);
  try {
    // the check at start reaches the window with the state: the sidebar and New chat read it from there
    await v.until(() => v.state()?.doctor?.agents, 'the check at start');
    assert.equal(v.state().doctor.agents.find((a: AgentCheck) => a.agent === 'claude').state, 'needs-login');
    assert.equal(v.state().agents, undefined, 'no second, separate agent probe in the state');
    // the Doctor page shows the same check; it does not run another one
    assert.equal((await r.api('GET', '/api/doctor')).json.fast.agents[0].state, 'needs-login');
    assert.equal(checks, 1);
    // Log in from the Doctor: by the time the job is done, every window already has the new status
    const job = (await r.api('POST', '/api/doctor/run', { agent: 'claude', action: 'login' })).json;
    assert.deepEqual(commands, ['claude auth login']);
    let done: any;
    for (let i = 0; i < 50 && !done?.done; i++) (done = (await r.api('GET', `/api/doctor/${job.id}`)).json), await sleep(50);
    assert.equal(done.ok, true);
    await v.until(() => v.state().doctor.agents.find((a: AgentCheck) => a.agent === 'claude').state === 'ready', 'Ready on every screen');
    // a login outside Chorus is seen at Check again (POST doctor/check), and pushed the same way
    claude = 'needs-login';
    assert.equal((await r.api('POST', '/api/doctor/check')).json.fast.agents[0].state, 'needs-login');
    await v.until(() => v.state().doctor.agents[0].state === 'needs-login' && !v.state().doctor.checking, 'Check again pushed');
    v.ws.close();
  } finally {
    await r.done();
  }
});

test('serve: the window coming back checks again quietly, at most once every 10 s; the Report uses the same check', async () => {
  let claude: AgentCheck['state'] = 'needs-login';
  let checks = 0;
  const r = await rig(undefined, undefined, undefined, {
    check: async () => (checks++, await sleep(100), fastReport([agentCheck('claude', claude), agentCheck('codex', 'ready'), agentCheck('agy', 'missing', 'unknown')])),
  });
  const v = await viewer(r.url, r.srv.token);
  const before = process.env.CHORUS_DOCTOR_HOME;
  process.env.CHORUS_DOCTOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-doctor-'));
  try {
    await v.until(() => v.state()?.doctor?.agents && !v.state().doctor.checking, 'the check at start');
    // right after the check at start a focus does nothing
    assert.equal((await r.api('POST', '/api/doctor/refresh')).json.ran, false);
    assert.equal(checks, 1);
    // the user logs in in a terminal and comes back later: one quiet check, the status stays (no "Checking…") until it is done
    claude = 'ready';
    const at = v.state().doctor.at;
    (r.srv as any).agentCheck.at = new Date(Date.now() - 11_000).toISOString();
    const seen: boolean[] = [];
    const watch = setInterval(() => seen.push(!!v.state().doctor.checking), 10);
    assert.equal((await r.api('POST', '/api/doctor/refresh')).json.ran, true);
    assert.equal((await r.api('POST', '/api/doctor/refresh')).json.ran, false, 'a second window, or focus and visibility together');
    await v.until(() => v.state().doctor.agents[0].state === 'ready', 'the login shows without Check again');
    clearInterval(watch);
    assert.equal(checks, 2);
    assert.ok(!seen.includes(true), 'statuses never went to Checking…');
    assert.notEqual(v.state().doctor.at, at);
    // the page's 30 s loop: it runs only while an agent waits for the user (agy is not installed here)
    (r.srv as any).agentCheck.at = new Date(Date.now() - 11_000).toISOString();
    assert.equal((await r.api('POST', '/api/doctor/refresh', { waiting: true })).json.ran, true);
    await v.until(() => checks === 3 && !(r.srv as any).checking, 'the loop check');
    (r.srv as any).agentCheck.report.agents.forEach((a: AgentCheck) => (a.state = 'ready'));
    (r.srv as any).agentCheck.at = new Date(Date.now() - 11_000).toISOString();
    assert.equal((await r.api('POST', '/api/doctor/refresh', { waiting: true })).json.ran, false, 'all Ready: the loop stops');
    assert.equal(checks, 3);
    // Check again is still there and still shows Checking…
    claude = 'needs-login';
    const again = r.api('POST', '/api/doctor/check');
    await v.until(() => v.state().doctor.checking, 'Check again shows Checking…');
    assert.equal((await again).json.fast.agents[0].state, 'needs-login');
    // the Report runs the one check, which every screen gets too
    claude = 'ready';
    await r.api('POST', '/api/doctor/issue', {});
    assert.equal(checks, 5);
    await v.until(() => v.state().doctor.agents[0].state === 'ready', 'the Report check reached the screens');
    v.ws.close();
  } finally {
    if (before === undefined) delete process.env.CHORUS_DOCTOR_HOME;
    else process.env.CHORUS_DOCTOR_HOME = before;
    await r.done();
  }
});

test('serve: Report issue works before any test run, with the issue types to pick from', async () => {
  const r = await rig();
  const before = process.env.CHORUS_DOCTOR_HOME;
  process.env.CHORUS_DOCTOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-doctor-'));
  try {
    const rep = (await r.api('POST', '/api/doctor/issue', { client: { window: 'browser' }, errors: ['boom'] })).json;
    assert.deepEqual(rep.kinds.map((k: { id: string }) => k.id), ['bug', 'cli', 'feature', 'question', 'other']);
    assert.ok(rep.details.includes('window browser') && rep.details.includes('page: boom'));
    // an unknown type is refused before anything is sent
    assert.equal((await r.api('POST', '/api/doctor/issue/send', { kind: 'urgent', details: '' })).json.error, 'kind and details');
  } finally {
    if (before === undefined) delete process.env.CHORUS_DOCTOR_HOME;
    else process.env.CHORUS_DOCTOR_HOME = before;
    await r.done();
  }
});

test('New chat in the desktop offers fable for Claude Code (latestModels, after default); the CLI app\'s list is unchanged; a chat with it runs claude --model fable', async () => {
  const r = await rig();
  try {
    const claude = (await r.api('GET', '/api/newchat')).json.agents.find((a: any) => a.id === 'claude');
    assert.deepEqual(claude.models, ['default', 'fable', 'sonnet', 'opus', 'haiku']);
    assert.deepEqual(claude.efforts.fable, claude.efforts.sonnet, 'its efforts are offered too');
    assert.deepEqual(r.c.modelList('claude'), ['default', 'sonnet', 'opus', 'haiku'], 'the CLI app keeps its list');
    const codex = (await r.api('GET', '/api/newchat')).json.agents.find((a: any) => a.id === 'codex');
    assert.deepEqual(codex.models, r.c.modelList('codex'), 'no newer models for Codex');
    const made = await r.api('POST', '/api/chats', { agent: 'claude', folder: r.project, model: 'fable' });
    assert.equal(made.status, 200);
    const l = r.launchedWith.find(x => x.agent === 'claude' && x.model === 'fable');
    assert.ok(l, JSON.stringify(r.launchedWith));
    const cmd = buildInteractive('claude', { cwd: l!.cwd, model: l!.model, project: r.project, threadId: made.json.id } as any);
    const at = cmd.args.indexOf('--model');
    assert.equal(cmd.args[at + 1], 'fable', cmd.args.join(' '));
    assert.equal(r.store.getThread(made.json.id)!.model, 'fable');
  } finally {
    await r.done();
  }
});

test('serve: release notice uses launch state; download is explicit and skip suppresses it without another check', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-update-http-'));
  let checks = 0;
  const url = 'https://chorus-cli.web.app/dl/Chorus-macOS-1.0.7.zip';
  const updates = new UpdateCheck({ directory, version: '1.0.6', platform: 'darwin', arch: 'arm64', request: (async () => { checks++; return Response.json({ version: '1.0.7', downloads: { 'darwin-arm64': { url, sha256: 'a'.repeat(64) } } }); }) as typeof fetch });
  const r = await rig(undefined, undefined, updates);
  try {
    await updates.startup();
    for (let i = 0; i < 5; i++) assert.equal((await r.api('GET', '/api/state')).json.update.version, '1.0.7');
    assert.equal(checks, 1); assert.deepEqual(r.notificationLinks, []);
    assert.equal((await r.api('POST', '/api/updates/open', { url: 'https://evil.example' })).json.ok, true);
    assert.deepEqual(r.notificationLinks, ['https://chorus-cli.web.app/update'], 'update destination cannot come from the browser');
    assert.equal((await r.api('POST', '/api/updates/skip', {})).json.ok, true);
    assert.equal((await r.api('GET', '/api/state')).json.update, null);
    assert.match((await r.api('POST', '/api/updates/open', {})).json.error, /No update/);
    assert.equal(checks, 1);
  } finally { await r.done(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Browse… asks the system picker: its folder, a cancel, or none here (the page then shows its own dialog)', async () => {
  const asked: string[] = [];
  let answer: { dir?: string; cancelled?: boolean; none?: boolean } = { dir: '/Users/x/new-app' };
  const r = await rig(undefined, undefined, undefined, { pickFolder: async (start, title) => (asked.push(`${start}|${title}`), answer) });
  try {
    assert.deepEqual((await r.api('POST', '/api/folders/pick', { dir: r.project })).json, { dir: '/Users/x/new-app' });
    assert.deepEqual(asked, [`${r.project}|Choose a project folder`]);
    answer = { cancelled: true };
    assert.deepEqual((await r.api('POST', '/api/folders/pick', { dir: '~' })).json, { cancelled: true });
    assert.equal(asked[1].split('|')[0], os.homedir(), '~ is the home folder');
    answer = { none: true };
    assert.deepEqual((await r.api('POST', '/api/folders/pick', {})).json, { none: true });
  } finally {
    await r.done();
  }
});

test('Hand off to any agent with a note: the record, then the note, in the first message', async () => {
  const r = await rig();
  try {
    const a = (await r.api('POST', '/api/chats', { agent: 'claude', folder: r.project })).json.id as string;
    const id = (await r.api('POST', `/api/chats/${a}/handoff`, { to: 'codex', model: 'gpt-6-luna', effort: 'high', note: ' Only look at the tests ' })).json.id as string;
    assert.match(r.launches.at(-1)!.prompt ?? '', /get_handoff_context[\s\S]*\n\nOnly look at the tests$/);
    assert.equal(r.launches.at(-1)!.agent, 'codex');
    assert.equal(r.store.getThread(id)!.parent_thread_id, a);
    assert.equal(r.store.getThread(id)!.model, 'gpt-6-luna');
  } finally {
    await r.done();
  }
});

test('opening another chat leaves the first one working: same process, still running', async () => {
  const r = await rig();
  try {
    const a = (await r.api('POST', '/api/chats', { agent: 'codex', folder: r.project })).json.id as string;
    const host = r.c.app.entry(a)!.host!;
    const b = (await r.api('POST', '/api/chats', { agent: 'claude', folder: r.project })).json.id as string;
    await r.api('POST', `/api/chats/${b}/select`);
    await sleep(300);
    assert.equal(r.c.app.entry(a)!.host, host, 'the same process');
    assert.notEqual(host.state, 'ended');
    assert.notEqual((await r.api('GET', '/api/state')).json.chats.find((c: any) => c.id === a).state, 'parked');
  } finally {
    await r.done();
  }
});

test('a project taken off the sidebar stays off after a restart: the server keeps the choice, not the browser', async () => {
  const r = await rig();
  try {
    assert.deepEqual((await r.api('GET', '/api/state')).json.ui, {}, 'nothing chosen yet');
    assert.deepEqual((await r.api('POST', '/api/ui', { key: 'hidden', value: { '/work/old': ['t_1'] } })).json, { ok: true });
    await r.api('POST', '/api/ui', { key: 'folded', value: ['/work/big'] });
    assert.equal((await r.api('POST', '/api/ui', { key: 'token', value: 'x' })).json.error, 'unknown setting');
    // the window's next launch is a new server on a new port, reading the same data folder
    const saved = JSON.parse(fs.readFileSync(path.join(r.store.root, 'ui.json'), 'utf8'));
    assert.deepEqual(saved, { hidden: { '/work/old': ['t_1'] }, folded: ['/work/big'] });
    assert.deepEqual((await r.api('GET', '/api/state')).json.ui, saved);
  } finally {
    await r.done();
  }
});

test('a chat whose CLI lost its session goes on in the same chat, from its record (decision 18)', async () => {
  const r = await rig(
    (store, project) => {
      store.createThread({ id: 't_old', title: 'Old chat', agent: 'claude', cwd: project, native_session_id: 'gone-1', state: 'waiting' });
      store.recordSession('t_old', { agent: 'claude', turns: [{ seq: 1, role: 'user', text: 'Make the cart faster' }, { seq: 2, role: 'assistant', text: 'Cached the totals.' }], toolCalls: [{ id: 'c1', turnSeq: 2, tool: 'Edit', target: 'cart.ts', status: 'ok' }], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } });
      store.createThread({ id: 't_kept', title: 'Kept chat', agent: 'codex', cwd: project, native_session_id: 'kept-1', state: 'waiting' });
    },
    undefined,
    undefined,
    { sessionExists: row => row.native_session_id === 'kept-1' },
  );
  try {
    const v = await viewer(r.url, r.srv.token);
    await v.until(() => v.state()?.chats.length === 2, 'state');
    const at = () => v.state().chats.map((c: any) => c.id);
    const order = at();
    v.send({ t: 'attach', id: 't_old', cols: 100, rows: 30 });
    await v.until(() => /READY claude/.test(v.text()), 'started');
    const l = r.launches.at(-1)!;
    assert.equal(l.resumeId, undefined, 'not resumed: the CLI has no such session');
    assert.match(l.prompt ?? '', /no longer has the earlier session of this chat[\s\S]*get_handoff_context with thread_id t_old/);
    assert.deepEqual(at(), order, 'the same chat, in the same place');
    assert.equal((await r.api('GET', '/api/chats/t_old')).json.fromRecord, 'Claude Code');
    // the new session's turns go after the old ones: the record keeps both
    r.store.recordSession('t_old', { agent: 'claude', turns: [{ seq: 1, role: 'user', text: 'new session' }], toolCalls: [{ id: 'n1', turnSeq: 1, tool: 'Read', target: 'cart.ts', status: 'ok' }], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } });
    assert.deepEqual(r.store.getTurns('t_old', { limit: 10 }).map(t => [t.seq, t.text]), [[1, 'Make the cart faster'], [2, 'Cached the totals.'], [3, 'new session']]);
    assert.deepEqual(r.store.getToolCalls('t_old').map(c => c.id), ['c1', 'n1']);
    // a chat whose session is still there resumes as always
    v.send({ t: 'attach', id: 't_kept', cols: 100, rows: 30 });
    await v.until(() => r.launches.at(-1)!.resumeId === 'kept-1', 'resumed');
    assert.equal((await r.api('GET', '/api/chats/t_kept')).json.fromRecord, null);
  } finally {
    await r.done();
  }
});

/** A Host header the server answers to with this token: status code only. */
function statusWithHost(port: string, host: string, token?: string, connectTo = '127.0.0.1') {
  return new Promise<number | string>(resolve => {
    const req = http.request({ host: connectTo, port, path: '/api/state', headers: { host, ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res => resolve(res.statusCode ?? 0));
    req.on('error', e => resolve((e as NodeJS.ErrnoException).code ?? 'error'));
    req.setTimeout(2000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.end();
  });
}

const lanAddress = () => Object.values(os.networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address;

test('serve --host: names it accepts (plan A.8)', () => {
  assert.deepEqual(hostNames(), ['127.0.0.1', 'localhost']);
  assert.deepEqual(hostNames('chorus.lan'), ['127.0.0.1', 'localhost', 'chorus.lan']);
  const nics = { lo: [{ address: '127.0.0.1' }], eth0: [{ address: '172.17.0.2' }, { address: 'fe80::1%eth0' }] } as any;
  assert.deepEqual(hostNames('0.0.0.0', nics), ['127.0.0.1', 'localhost', '172.17.0.2', '[fe80::1]']);
  assert.deepEqual(hostNames('::', nics), hostNames('0.0.0.0', nics));
});

test('serve: without --host only this machine connects; serve.json carries the browser address (plan A.1, A.7)', async () => {
  const r = await rig();
  try {
    const port = new URL(r.url).port;
    const saved = JSON.parse(fs.readFileSync(path.join(r.store.root, 'serve.json'), 'utf8'));
    assert.equal(saved.url, r.url);
    assert.equal(saved.openUrl, r.srv.openUrl);
    assert.equal((fs.statSync(path.join(r.store.root, 'serve.json')).mode & 0o777).toString(8), '600');
    const lan = lanAddress();
    if (lan) assert.equal(await statusWithHost(port, `${lan}:${port}`, r.srv.token, lan), 'ECONNREFUSED', 'nothing listens on the network address');
  } finally {
    await r.done();
  }
});

test('serve --host 0.0.0.0: reachable by any address of this machine, still a token on every request, sockets from the same address (plan A.6, A.8)', async () => {
  const r = await rig(undefined, undefined, undefined, { host: '0.0.0.0' });
  try {
    const port = new URL(r.url).port;
    assert.match(r.url, /^http:\/\/127\.0\.0\.1:\d+$/, 'the printed address stays 127.0.0.1 (a published container port)');
    assert.equal(await statusWithHost(port, `localhost:${port}`, r.srv.token), 200);
    assert.equal(await statusWithHost(port, `localhost:${port}`), 401, 'no token');
    assert.equal(await statusWithHost(port, `mac.local:${port}`, r.srv.token), 200, 'any name this machine is reached by (owner, 2026-11-08)');
    assert.equal(await statusWithHost(port, `mac.local:${port}`), 401, 'still the token');
    await assert.rejects(viewer(r.url, r.srv.token, `http://mac.local:${port}`), /HTTP|socket hang up|closed|ECONNRESET/, 'a socket from another address than the one asked');
    const lan = lanAddress();
    if (lan) {
      assert.equal(await statusWithHost(port, `${lan}:${port}`, r.srv.token, lan), 200, 'another computer, by this machine\'s address');
      assert.equal(await statusWithHost(port, `${lan}:${port}`, undefined, lan), 401, 'still no way in without the token');
      const ok = await viewer(`http://${lan}:${port}`, r.srv.token, `http://${lan}:${port}`);
      ok.ws.close();
    }
    await assert.rejects(viewer(r.url, r.srv.token, 'https://evil.example'), /HTTP|socket hang up|closed|ECONNRESET/);
  } finally {
    await r.done();
  }
});

test('serve --host <name>: that name is accepted and printed', async () => {
  const r = await rig(undefined, undefined, undefined, { host: 'localhost' });
  try {
    assert.match(r.url, /^http:\/\/localhost:\d+$/);
    const port = new URL(r.url).port;
    assert.equal(await statusWithHost(port, `localhost:${port}`, r.srv.token), 200);
    assert.equal(await statusWithHost(port, `other.example:${port}`, r.srv.token), 403);
  } finally {
    await r.done();
  }
});

test('serve: while the window is open only it sizes the agents; a browser tab is a viewer (plan A.4)', async () => {
  const r = await rig();
  try {
    const tab = await viewer(r.url, r.srv.token);
    const made = await r.api('POST', '/api/chats', { agent: 'claude', folder: r.project, prompt: 'hi' });
    const id = made.json.id as string;
    tab.send({ t: 'attach', id, cols: 90, rows: 25 });
    await tab.until(() => /SIZE 90x25/.test(tab.text()), 'a tab alone sizes the agent');
    const win = await viewer(r.url, r.srv.token, undefined, '?window=native');
    win.send({ t: 'attach', id, cols: 100, rows: 30 });
    await win.until(() => /SIZE 100x30/.test(win.text()), 'the window sizes it');
    tab.send({ t: 'resize', id, cols: 70, rows: 20 });
    tab.send({ t: 'attach', id, cols: 71, rows: 21 });
    await sleep(600);
    assert.doesNotMatch(win.text(), /SIZE 7[01]x2[01]/, 'the tab does not resize the agent while the window is open');
    win.send({ t: 'resize', id, cols: 80, rows: 24 });
    await win.until(() => /SIZE 80x24/.test(win.text()), 'the window still resizes it');
    win.ws.close();
    await sleep(200);
    tab.send({ t: 'resize', id, cols: 60, rows: 20 });
    await tab.until(() => /SIZE 60x20/.test(tab.text()), 'with the window closed the tab sizes it again');
    tab.ws.close();
  } finally {
    await r.done();
  }
});

test('serve in a container: Log in runs the sign-in here and the page gets its link; the code goes back to the CLI (plan part B)', async () => {
  assert.equal(boxLoginCommand('claude'), 'docker exec -it -u chorus chorus claude auth login');
  assert.equal(boxLoginCommand('codex', 'box2'), 'docker exec -it -u chorus box2 codex login --device-auth');
  const typed: string[] = [];
  let print: (d: string) => void = () => {};
  const signIns = new SignIns({ env: {}, pty: () => ({ pid: 1, onData: cb => void (print = cb), onExit() {}, write: d => void typed.push(d), resize() {}, kill() {} }) });
  const r = await rig(undefined, undefined, undefined, { container: true, signIns });
  try {
    assert.equal(r.srv.state().container, true, 'the page knows');
    const j = await r.api('POST', '/api/doctor/run', { agent: 'claude', action: 'login' });
    assert.equal(j.status, 200);
    assert.match(j.json.signIn, /^[0-9a-f]{12}$/);
    assert.equal(j.json.hostCommand, 'docker exec -it -u chorus chorus claude auth login', 'the fallback the popup shows');
    assert.equal((await r.api('GET', `/api/signin/${j.json.signIn}`)).json.state, 'starting');
    print("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=S\r\nPaste code here if prompted > ");
    const si = (await r.api('GET', `/api/signin/${j.json.signIn}`)).json;
    assert.equal(si.state, 'waiting');
    assert.equal(si.url, 'https://claude.com/cai/oauth/authorize?code=true&state=S');
    assert.deepEqual((await r.api('POST', `/api/signin/${j.json.signIn}/code`, { code: 'XYZ' })).json, { ok: true });
    assert.deepEqual(typed, ['XYZ\r']);
    assert.deepEqual((await r.api('POST', `/api/signin/${j.json.signIn}/close`, {})).json, { ok: true });
    assert.match((await r.api('GET', `/api/signin/${j.json.signIn}`)).json.error, /over/);
  } finally {
    await r.done();
  }
});

test('serve in a container: links go to the page to open; a missing opener does not stop chorus serve (2026-11-08 crash)', async () => {
  // what crashed the box: openUrl with no xdg-open/open on the PATH emitted an unhandled spawn error
  const { openUrl } = await import('../../src/core/doctor.ts');
  const path0 = process.env.PATH;
  process.env.PATH = '/nonexistent';
  try {
    openUrl('https://example.com/');
    await sleep(300);
  } finally {
    process.env.PATH = path0;
  }
  const r = await rig(undefined, undefined, undefined, { container: true });
  try {
    const j = await r.api('POST', '/api/doctor/open', { agent: 'codex' });
    assert.equal(j.status, 200);
    assert.match(j.json.open, /^https:\/\//, 'the page opens it');
    assert.deepEqual(r.notificationLinks, [], 'nothing opened on the server');
  } finally {
    await r.done();
  }
});

test('serve: a chat whose folder is not on this computer is shown, not started, and chorus serve goes on (the box crash, 2026-11-08)', async () => {
  const r = await rig(store => {
    store.createThread({ id: 't_far', title: 'From the Mac', agent: 'codex', cwd: '/private/var/folders/xx/T/chorus-proof-gone', native_session_id: 'far-1', state: 'waiting' });
  });
  try {
    const v = await viewer(r.url, r.srv.token);
    await v.until(() => v.state()?.chats.length === 1, 'state');
    assert.equal((await r.api('POST', '/api/chats/t_far/select')).status, 200);
    v.send({ t: 'attach', id: 't_far', cols: 100, rows: 30 });
    await v.until(() => v.msgs.some(m => m.t === 'flash' && /can't open: its folder \/private\/var\/folders\/xx\/T\/chorus-proof-gone is not on this computer/.test(m.text)), 'it says why');
    await sleep(300);
    assert.deepEqual(r.launches, [], 'nothing started');
    assert.equal((await r.api('GET', '/api/state')).status, 200, 'still serving');
    v.ws.close();
  } finally {
    await r.done();
  }
});

/* ---------- the Planner loop's host side, and Approvals (plan 2026-11-13) ---------- */

test('typing into a chat (the Planner loop): sent, one message at a time; an ended chat is resumed first; gone without its session; not now while a prompt waits', async () => {
  const r = await rig(undefined, undefined, undefined, { sessionExists: row => row.native_session_id !== 'sess-gone' });
  const send = (id: string, text: string) => (r.srv as any).sendToChat(id, text) as Promise<string>;
  try {
    const v = await viewer(r.url, r.srv.token);
    const a = (await r.api('POST', '/api/chats', { agent: 'codex', folder: r.project })).json.id as string;
    v.send({ t: 'attach', id: a, cols: 100, rows: 30 });
    await v.until(() => /READY codex/.test(v.text()), 'codex up');
    assert.deepEqual(await Promise.all([send(a, 'first message'), send(a, 'second message')]), ['sent', 'sent']);
    await v.until(() => /got: "second message"/.test(v.text()), 'both typed');
    assert.ok(v.text().indexOf('got: "first message"') < v.text().indexOf('got: "second message"'), 'in order, each with its own Enter');
    // a chat whose CLI ended is continued with its resume, then typed into once its screen is still
    const b = (await r.api('POST', '/api/chats', { agent: 'claude', folder: r.project })).json.id as string;
    await sleep(800);
    r.store.updateThread(b, { native_session_id: 'sess-b' });
    r.c.app.entry(b)!.host!.kill();
    await sleep(500);
    const before = r.launches.length;
    assert.equal(await send(b, 'answer from the Planner'), 'sent');
    assert.equal(r.launches.length, before + 1);
    assert.equal(r.launches.at(-1)!.resumeId, 'sess-b', 'resumed on its own session');
    for (let i = 0; i < 40 && !/got: "answer from the Planner"/.test(r.c.app.entry(b)!.host!.screen.text().join('\n')); i++) await sleep(50);
    assert.match(r.c.app.entry(b)!.host!.screen.text().join('\n'), /got: "answer from the Planner"/);
    // its CLI no longer has the session: gone, nothing started
    const g = (await r.api('POST', '/api/chats', { agent: 'claude', folder: r.project })).json.id as string;
    await sleep(500);
    r.store.updateThread(g, { native_session_id: 'sess-gone' });
    r.c.app.entry(g)!.host!.kill();
    await sleep(400);
    const n = r.launches.length;
    assert.equal(await send(g, 'hello?'), 'gone');
    assert.equal(r.launches.length, n, 'not resumed into an empty chat');
    // a permission prompt on its screen: not typed now
    r.c.app.entry(a)!.host!.write(`show ${PROMPT}\r`);
    await v.until(() => v.state()?.approvals.some((x: any) => x.id === a && x.kind === 'permission'), 'a prompt');
    assert.equal(await send(a, 'third'), 'ended');
    v.ws.close();
  } finally {
    await r.done();
  }
});

test('question cards: kind, Skip types the skip line (no decision logged), typing to the agent removes the card at once; Approvals delete; deleting a chat tells the module', async () => {
  const r = await rig();
  try {
    const v = await viewer(r.url, r.srv.token);
    const a = (await r.api('POST', '/api/chats', { agent: 'codex', folder: r.project })).json.id as string;
    v.send({ t: 'attach', id: a, cols: 100, rows: 30 });
    await v.until(() => /READY codex/.test(v.text()), 'codex up');
    const q = r.store.createRequest({ threadId: a, question: 'Which table?', options: ['orders', 'carts'], kind: 'question' });
    await v.until(() => v.state()?.approvals.some((x: any) => x.request === q.id), 'the question');
    assert.equal(v.state().approvals.find((x: any) => x.request === q.id).askKind, 'question');
    const logged = r.store.approvalsLog().length;
    assert.equal((await r.api('POST', `/api/chats/${a}/answer`, { request: q.id, option: SKIPPED })).json.ok, true);
    await v.until(() => v.text().includes(`got: "Chorus approval ${q.id}: skipped. Decide yourself and say what you chose."`), 'the skip line typed');
    assert.equal(r.store.approvalsLog().length, logged, 'a skip is not a decision');
    assert.ok(!v.state().approvals.some((x: any) => x.request === q.id), 'gone from Approvals');
    // the user types to the agent instead of answering: the card and its Approvals row go at once
    const ap = r.store.createRequest({ threadId: a, question: 'Drop the table?' });
    await v.until(() => v.state()?.approvals.some((x: any) => x.request === ap.id && x.askKind === 'approval'), 'an approval');
    v.send({ t: 'in', id: a, data: 'no, keep it\r' });
    await v.until(() => r.store.getRequest(ap.id)!.status === 'cancelled' && !v.state().approvals.some((x: any) => x.request === ap.id), 'typed instead of answered', 1000);
    // delete from Approvals: a question is cancelled; a command prompt is hidden there and keeps its line in the chat
    const d = r.store.createRequest({ threadId: a, question: 'Ship it?', kind: 'question' });
    await v.until(() => v.state()?.approvals.some((x: any) => x.request === d.id), 'another question');
    assert.equal((await r.api('POST', `/api/chats/${a}/dismiss`, { request: d.id })).json.ok, true);
    assert.equal(r.store.getRequest(d.id)!.status, 'cancelled');
    assert.ok(!(await r.api('GET', '/api/approvals')).json.pending.some((x: any) => x.request === d.id));
    r.c.app.entry(a)!.host!.write(`show ${PROMPT}\r`);
    await v.until(() => v.state()?.approvals.some((x: any) => x.id === a && x.kind === 'permission'), 'a prompt');
    await r.api('POST', `/api/chats/${a}/dismiss`, {});
    await v.until(() => v.state().approvals.find((x: any) => x.id === a && x.kind === 'permission')?.hidden === true, 'hidden');
    assert.equal((await r.api('GET', '/api/approvals')).json.pending.length, 0, 'not in Approvals');
    assert.equal(r.store.approvalsLog().length, logged, 'nothing answered');
    // a deleted chat: the optional module is told, so its waiting items go too
    const events: any[] = [];
    (r.srv as any).pro.chatEvent = (ev: any) => events.push(ev);
    await r.api('DELETE', `/api/chats/${a}`);
    await v.until(() => v.state()?.dialogs.length === 1, 'asked');
    await r.api('POST', `/api/dialogs/${v.state().dialogs[0].id}`, { value: 'y' });
    await v.until(() => events.some(e => e.type === 'deleted' && e.thread === a), 'told');
    assert.equal(v.state().approvals.length, 0);
    v.ws.close();
  } finally {
    await r.done();
  }
});
