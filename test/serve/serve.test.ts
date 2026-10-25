// chorus serve (Phase 5): the local API and the agent-screen WebSocket, with a fake TUI as the agent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import WebSocket from 'ws';
import { Controller } from '../../src/app/controller.ts';
import { VirtualScreen } from '../../src/app/screen.ts';
import { buildHandoff } from '../../src/core/handoff.ts';
import { Store } from '../../src/core/store.ts';
import type { AgentId } from '../../src/core/types.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import { NotificationInbox } from '../../src/serve/notifications.ts';
import { UpdateCheck } from '../../src/serve/updates.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-tui.mjs');
const PROMPT = path.join(ROOT, 'fixtures/codex/0.163.0/approval-ask-nohook-enter/prompt-screen.txt');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function rig(seed?: (store: Store, project: string) => void, notifications?: NotificationInbox, updates?: UpdateCheck) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-home-'));
  process.env.CODEX_HOME = home;
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-serve-')));
  const store = new Store(project);
  seed?.(store, project);
  const launches: { agent: AgentId; prompt?: string; resumeId?: string; skipPermissions?: boolean }[] = [];
  const c = new Controller({
    project,
    store,
    app: headlessApp(),
    tailPollMs: 100,
    opener: async () => ({ ok: true }),
    launcher: (agent, o) => {
      launches.push({ agent, prompt: o.prompt, resumeId: o.resumeId, skipPermissions: o.skipPermissions });
      return { bin: process.execPath, args: [FAKE, agent], cwd: o.cwd };
    },
  });
  c.restore();
  const notificationLinks: string[] = [];
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), notifications, updates, onUpdateOpen: url => { notificationLinks.push(url); }, onNotificationLink: url => { notificationLinks.push(url); } });
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
  return { srv, c, store, project, url, api, launches, notificationLinks, done };
}

/** A desktop window: a socket and the terminal it would draw (replayed screen + live bytes). */
async function viewer(url: string, token: string, origin?: string) {
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws', { headers: { authorization: `Bearer ${token}`, ...(origin ? { origin } : {}) } });
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
