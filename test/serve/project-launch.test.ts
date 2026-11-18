// A project's folders and variables reach its chats (task #11 step 6): every start and every resume gets them (`--add-dir`, the
// process environment; a value is never in the args), another project's chat gets none; serve remembers what each running chat got
// (chatHas, staleChats); a change reaches running chats live where the CLI has a way, else by a restart at turn end, never mid-turn.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Controller } from '../../src/app/controller.ts';
import { buildInteractive, type Launch } from '../../src/core/launch.ts';
import { ProjectSettings } from '../../src/core/projects.ts';
import { Store } from '../../src/core/store.ts';
import type { AgentId } from '../../src/core/types.ts';
import { ChatLaunch } from '../../src/serve/pro.ts';
import { ProjectRuntime, type LiveWay } from '../../src/serve/project-runtime.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-tui.mjs');
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const VALUE = 'v-very-secret-4f1a9';

async function rig() {
  const home = tmp('chorus-pl-');
  process.env.CHORUS_SKILLS_HOME ??= home;
  const project = tmp('chorus-pl-p-');
  const other = tmp('chorus-pl-o-');
  const extra = tmp('chorus-pl-x-');
  const store = new Store(project, { home });
  const chatLaunch = new ChatLaunch(store);
  const launches: { id: string; launch: Launch; resume: boolean }[] = [];
  const launcher = (agent: AgentId, o: Parameters<typeof buildInteractive>[1]) => {
    const l = buildInteractive(agent, { ...o, ...chatLaunch.extras(o, agent) });
    launches.push({ id: o.threadId, launch: l, resume: !!o.resumeId });
    return { bin: process.execPath, args: [FAKE, agent], cwd: o.cwd, env: l.env, sessionId: l.sessionId };
  };
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher });
  const agents = [{ agent: 'claude', state: 'ready' }, { agent: 'codex', state: 'ready' }];
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), chatLaunch, check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents, ms: 1 }) as any });
  const url = await srv.start(0);
  const api = async (method: string, p: string, body?: object) => (await fetch(url + p, { method, headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<any>;
  const chat = async (folder: string, agent = 'claude') => (await api('POST', '/api/chats', { agent, folder })).id as string;
  const done = async () => {
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await new Promise(r => setTimeout(r, 200));
    store.close();
  };
  return { srv, c, store, project, other, extra, settings: chatLaunch.projects!, launches, chat, done };
}

const until = async (ok: () => boolean, what: string, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
};

const dirsOf = (l: Launch) => l.args.flatMap((a, i) => (a === '--add-dir' ? [l.args[i + 1]] : []));

test('a chat in the project starts with its folders and variables; another project\'s chat gets none; a value is never in the args', async () => {
  const r = await rig();
  try {
    r.settings.addFolder(r.project, r.extra, { why: 'the core', by: 'you' });
    r.settings.setVariable(r.project, 'POLAR_TOKEN', VALUE, { by: 'you' });
    for (const agent of ['claude', 'codex'] as const) {
      const id = await r.chat(r.project, agent);
      const l = r.launches.find(x => x.id === id)!.launch;
      assert.deepEqual(dirsOf(l), [r.extra], `${agent}: --add-dir`);
      assert.equal(l.env?.POLAR_TOKEN, VALUE, `${agent}: in the process environment`);
      assert.ok(!l.args.some(a => a.includes(VALUE)) && !l.bin.includes(VALUE), `${agent}: never in the args`);
      assert.deepEqual(r.srv.projects.chatHas(id), { folders: [r.extra], variables: ['POLAR_TOKEN'], version: 2 });
    }
    const o = await r.chat(r.other);
    const lo = r.launches.find(x => x.id === o)!.launch;
    assert.deepEqual(dirsOf(lo), []);
    assert.equal(lo.env?.POLAR_TOKEN, undefined);
    // the PTY got the environment: the Controller passed Launch.env to the process
    const id = r.launches[0].id;
    const host = r.c.app.entry(id)!.host!;
    assert.ok(host.state === 'running');
  } finally {
    await r.done();
  }
});

test('a resumed chat gets the project\'s new settings; staleChats lists it until then', async () => {
  const r = await rig();
  try {
    const id = await r.chat(r.project);
    assert.deepEqual(r.srv.projects.chatHas(id), { folders: [], variables: [], version: 0 });
    assert.deepEqual(r.srv.projects.staleChats(r.project), []);
    r.settings.addFolder(r.project, r.extra);
    r.settings.setVariable(r.project, 'A_TOKEN', VALUE);
    assert.deepEqual(r.srv.projects.staleChats(r.project), [id], 'missing a folder and a variable');
    assert.deepEqual(r.srv.projects.staleChats(r.other), []);
    // the process ends and the chat is resumed: the resume's command line has the folder, its environment the value
    const host = r.c.app.entry(id)!.host!;
    host.kill();
    await until(() => host.state === 'ended', 'the chat ended');
    (r.srv as any).resumeChat(id);
    await until(() => r.launches.filter(x => x.id === id).length === 2, 'resumed');
    const again = r.launches.filter(x => x.id === id)[1];
    assert.equal(again.resume, true);
    assert.deepEqual(dirsOf(again.launch), [r.extra]);
    assert.equal(again.launch.env?.A_TOKEN, VALUE);
    await until(() => r.c.app.entry(id)?.host?.state === 'running', 'running again');
    assert.deepEqual(r.srv.projects.staleChats(r.project), []);
    assert.deepEqual(r.srv.projects.chatHas(id)?.variables, ['A_TOKEN']);
    // a changed value makes it stale again, though the names are the same
    r.settings.setVariable(r.project, 'A_TOKEN', 'another');
    assert.deepEqual(r.srv.projects.staleChats(r.project), [id]);
    // and a removed folder too
    r.settings.setVariable(r.project, 'A_TOKEN', VALUE);
    r.settings.removeFolder(r.project, r.extra);
    assert.deepEqual(r.srv.projects.staleChats(r.project), [id]);
  } finally {
    await r.done();
  }
});

/** ProjectRuntime with fake chats: who is idle, who is typing, what is sent, which turn ends fire. */
function fakes(ways: Partial<Record<AgentId, LiveWay>>) {
  const root = tmp('chorus-pr-');
  const project = tmp('chorus-pr-p-');
  const dir = tmp('chorus-pr-d-');
  const settings = new ProjectSettings(root);
  const chats = new Map<string, { agent: AgentId; idle: boolean; typing: boolean }>();
  const sent: { id: string; dir: string; way: LiveWay }[] = [];
  const restarted: string[] = [];
  const turnEnds = new Map<string, (() => void)[]>();
  const rt = new ProjectRuntime({
    settings,
    running: () => [...chats.keys()],
    chat: id => (chats.has(id) ? { agent: chats.get(id)!.agent, project, skip: false } : undefined),
    idle: id => !!chats.get(id)?.idle,
    typing: id => !!chats.get(id)?.typing,
    restart: id => void restarted.push(id),
    liveAdd: async (id, _agent, d, way) => {
      sent.push({ id, dir: d, way });
      return true;
    },
    onTurnEnd: (id, fn) => void turnEnds.set(id, [...(turnEnds.get(id) ?? []), fn]),
    way: agent => ways[agent],
  });
  const start = (id: string, agent: AgentId, o: { idle?: boolean; typing?: boolean } = {}) => {
    chats.set(id, { agent, idle: o.idle ?? true, typing: !!o.typing });
    rt.launched(id, project, settings.addDirs(project), settings.env(project));
  };
  /** the chat's turn ends now: it is idle and its waiting callbacks run */
  const endTurn = (id: string) => {
    chats.get(id)!.idle = true;
    const fns = turnEnds.get(id) ?? [];
    turnEnds.delete(id);
    for (const f of fns) f();
  };
  return { rt, settings, project, dir, chats, sent, restarted, turnEnds, start, endTurn };
}

test('applyToRunning: a new folder goes live to an idle chat of a CLI with a live way; one without restarts at its turn end', async () => {
  const f = fakes({ claude: 'slash' });
  f.start('t_live', 'claude');
  f.start('t_none', 'codex', { idle: false });
  f.settings.addFolder(f.project, f.dir);
  const out = await f.rt.applyToRunning(f.project, { kind: 'add_folder', path: f.dir });
  assert.deepEqual(out, { t_live: 'live', t_none: 'restart' });
  assert.deepEqual(f.sent, [{ id: 't_live', dir: f.dir, way: 'slash' }]);
  assert.deepEqual(f.rt.chatHas('t_live')?.folders, [f.dir], 'chatHas follows the live add');
  assert.deepEqual(f.rt.staleChats(f.project), ['t_none']);
  assert.deepEqual(f.restarted, [], 'never mid-turn');
  assert.ok(f.rt.restartPending('t_none'));
  f.endTurn('t_none');
  assert.deepEqual(f.restarted, ['t_none'], 'restarted once its turn ended');
});

test('applyToRunning: nothing is sent while the chat is mid-turn or the user is typing; it goes at the turn end', async () => {
  const f = fakes({ claude: 'slash', agy: 'slash' });
  f.start('t_busy', 'claude', { idle: false });
  f.start('t_typing', 'agy', { typing: true });
  f.settings.addFolder(f.project, f.dir);
  const out = await f.rt.applyToRunning(f.project, { kind: 'add_folder', path: f.dir });
  assert.deepEqual(out, { t_busy: 'later', t_typing: 'later' });
  assert.equal(f.sent.length, 0, 'nothing typed into a working chat or over the user');
  f.endTurn('t_busy');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(f.sent.map(s => s.id), ['t_busy']);
  // still typing at the turn end: it waits again
  f.endTurn('t_typing');
  assert.deepEqual(f.sent.map(s => s.id), ['t_busy']);
  assert.equal(f.turnEnds.get('t_typing')?.length, 1, 'asked again');
  f.chats.get('t_typing')!.typing = false;
  f.endTurn('t_typing');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(f.sent.map(s => s.id), ['t_busy', 't_typing']);
  assert.deepEqual(f.restarted, []);
});

test('applyToRunning: variable changes and removed folders restart at turn end (or only mark stale); a note needs nothing', async () => {
  const f = fakes({ claude: 'slash' });
  f.settings.addFolder(f.project, f.dir);
  f.start('t_a', 'claude', { idle: false });
  f.start('t_b', 'claude');
  assert.deepEqual(await f.rt.applyToRunning(f.project, { kind: 'note' }), {});
  f.settings.setVariable(f.project, 'X', '1');
  assert.deepEqual(await f.rt.applyToRunning(f.project, { kind: 'set_variable', name: 'X' }, { restart: false }), { t_a: 'stale', t_b: 'stale' });
  assert.deepEqual(f.restarted, []);
  assert.deepEqual(await f.rt.applyToRunning(f.project, { kind: 'set_variable', name: 'X' }), { t_a: 'restart', t_b: 'restart' });
  f.endTurn('t_b');
  assert.deepEqual(f.restarted, ['t_b'], 'the idle one at once, the working one waits');
  f.endTurn('t_a');
  assert.deepEqual(f.restarted, ['t_b', 't_a']);
});

test('restartIdle: idle stale chats restart now; one mid-turn restarts when it finishes', () => {
  const f = fakes({});
  f.start('t_idle', 'claude');
  f.start('t_busy', 'codex', { idle: false });
  f.settings.setVariable(f.project, 'X', '1');
  assert.deepEqual(f.rt.restartIdle(f.project), { restarted: ['t_idle'], waiting: ['t_busy'] });
  assert.deepEqual(f.restarted, ['t_idle']);
  f.endTurn('t_busy');
  assert.deepEqual(f.restarted, ['t_idle', 't_busy']);
});
