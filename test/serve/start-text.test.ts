// What `chorus serve` puts into a chat's start text (approved 2026-11-17): a plain chat gets every action label of the bundle; a
// teammate's chat its role; a sub thread its main thread and the first line of its brief, and no actions. The bundle's role is also
// served to `chorus mcp` (current_thread, the request_approval guard). The CLIs are not run: the launch lines are built and kept.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { LoadResult, ProCtx, ProModule } from '@chauvoluuhuong/chorus-core/pro-loader';
import { Controller } from '../../src/app/controller.ts';
import { buildInteractive } from '../../src/core/launch.ts';
import { Store } from '../../src/core/store.ts';
import type { ThreadRole } from '../../src/mcp/server.ts';
import { ChatLaunch, type ProLoader } from '../../src/serve/pro.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-tui.mjs');

const ROLE: ThreadRole = { teammate: { id: 'planner', name: 'Planner', kind: 'planner' }, instructions: 'Plan things.', actions: ['Create plan'], action: null, task: null, step: null, goals: [] };

function stand() {
  let ctx: ProCtx | undefined;
  const roles = new Map<string, ThreadRole>();
  const mod: ProModule = {
    version: 'stand-in',
    routes: c => ((ctx = c), {}),
    mcpTools: () => [{ name: 'start_action' }] as any,
    ui: () => ({ js: '', css: '' }),
    onChatEvent() {},
    roleOf: (_c, t) => roles.get(t),
    allActionLabels: () => ['Create plan', 'Review changes'],
    chatExtras: (_c, t) => (roles.has(t) ? { role: roles.get(t) } : undefined),
    dispose() {},
  };
  return { mod, roles, ctx: () => ctx! };
}

async function rig(first: LoadResult) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-st-'));
  process.env.CHORUS_SKILLS_HOME ??= home;
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-st-p-')));
  const store = new Store(project, { home });
  const chatLaunch = new ChatLaunch(store);
  const texts = new Map<string, string>();
  const argv = new Map<string, string[]>();
  const extras = new Map<string, ReturnType<ChatLaunch['extras']>>();
  const launcher = (agent: 'claude' | 'codex' | 'agy', o: Parameters<typeof buildInteractive>[1]) => {
    extras.set(o.threadId, chatLaunch.extras(o, agent));
    const l = buildInteractive(agent, { ...o, ...extras.get(o.threadId) });
    texts.set(o.threadId, l.args[l.args.indexOf('--append-system-prompt') + 1]);
    argv.set(o.threadId, l.args);
    return { bin: process.execPath, args: [FAKE, agent], cwd: o.cwd };
  };
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher });
  const agents = [{ agent: 'claude', state: 'ready' }];
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), chatLaunch, check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents, ms: 1 }) as any, proLoader: { dev: true, load: async () => first, activate: async () => first } satisfies ProLoader });
  const url = await srv.start(0);
  const api = async (method: string, p: string, body?: object, token = srv.token) => (await fetch(url + p, { method, headers: { authorization: `Bearer ${token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<any>;
  const chat = async () => (await api('POST', '/api/chats', { agent: 'claude', folder: project })).id as string;
  const mcp = (name: string, args: object, threadId: string) => api('POST', '/api/pro/mcp/call', { name, args, threadId }, srv.mcpToken);
  const done = async () => {
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await new Promise(r => setTimeout(r, 200));
    store.close();
  };
  return { srv, store, project, texts, argv, extras, chatLaunch, api, chat, mcp, done };
}

test('a plain chat is told every action of the bundle; without the bundle, none', async () => {
  const s = stand();
  const r = await rig(s.mod);
  try {
    const id = await r.chat();
    assert.match(r.texts.get(id)!, new RegExp(`This chat is Chorus thread ${id}\\.\\n\\nChorus actions: Create plan, Review changes\\. When one of them fits`));
    // starting an action through Chorus after the user's yes needs no permission prompt
    assert.match(r.argv.get(id)!.join(' '), /mcp__chorus__start_action/);
  } finally {
    await r.done();
  }
  const none = await rig({ locked: 'no-licence', message: 'x' });
  try {
    const id = await none.chat();
    assert.doesNotMatch(none.texts.get(id)!, /actions/);
  } finally {
    await none.done();
  }
});

test('a teammate chat started by the bundle gets its role; the role is served to `chorus mcp` live', async () => {
  const s = stand();
  const r = await rig(s.mod);
  try {
    const id = s.ctx().startChat({ agent: 'claude', title: 'Planner', prompt: 'hi', cwd: r.project, role: ROLE });
    assert.match(r.texts.get(id)!, /Your role: Planner \(teammate "Planner"\)\. Its instructions:\nPlan things\.\n\nYour actions: Create plan\./);
    assert.doesNotMatch(r.texts.get(id)!, /Chorus actions/);
    s.roles.set(id, { ...ROLE, task: { number: 1, title: 'T', state: 'planning', doneWhen: '' } });
    const got = await r.api('GET', `/api/pro/mcp/role?thread=${id}`, undefined, r.srv.mcpToken);
    assert.equal(got.role.task.state, 'planning');
    assert.deepEqual(got.actionLabels, ['Create plan', 'Review changes']);
    assert.equal(got.readOnly, false);
  } finally {
    await r.done();
  }
});

test('a sub thread is told its main thread and what it was started to do, and no actions', async () => {
  const s = stand();
  const r = await rig(s.mod);
  try {
    const main = await r.chat();
    r.store.updateThread(main, { title: 'Pricing page', state: 'waiting' });
    const out = await r.mcp('start_subthread', { title: 'Price list', brief: 'Make the price list.\nUse euros.' }, main);
    const sub = String(out.text).match(/sub thread (t_\w+)/)![1];
    const text = r.texts.get(sub)!;
    assert.match(text, new RegExp(`This chat is a sub thread of Chorus thread ${main} \\("Pricing page"\\), which started it to: Make the price list\\. Your main thread is who you work for`));
    assert.doesNotMatch(text, /actions/);
  } finally {
    await r.done();
  }
});

test('only a main chat keeps its CLI\'s own question tool: a step\'s Worker and a sub thread get noNativeAsk (Codex: request_user_input pinned off)', async () => {
  const s = stand();
  const r = await rig(s.mod);
  const OFF = 'features.default_mode_request_user_input=false';
  try {
    const main = s.ctx().startChat({ agent: 'codex', title: 'Main', prompt: 'hi', cwd: r.project });
    assert.ok(!r.argv.get(main)!.includes(OFF), 'a main chat: unchanged');
    const step: ThreadRole = { ...ROLE, teammate: { id: 'w', name: 'Worker', kind: 'worker' }, actions: [], step: { position: 1, of: 2, title: 'Do it' } };
    const worker = s.ctx().startChat({ agent: 'codex', title: 'Step', prompt: 'hi', cwd: r.project, role: step });
    assert.ok(r.argv.get(worker)!.includes(OFF), 'a step Worker');
    assert.equal(r.extras.get(main)!.noNativeAsk, undefined);
    // a sub thread (here a Claude one: the rig has only Claude signed in; Claude's AskUserQuestion is off in every chat already)
    const plain = await r.chat();
    const out = await r.mcp('start_subthread', { title: 'Sub', brief: 'Look it up.' }, plain);
    const sub = String(out.text).match(/sub thread (t_\w+)/)?.[1];
    assert.ok(sub, JSON.stringify(out));
    assert.equal(r.extras.get(sub)!.noNativeAsk, true, 'a sub thread');
    assert.equal(r.extras.get(plain)!.noNativeAsk, undefined, 'its main chat');
    // resumed: the stored sub_status still says so
    assert.equal(r.store.getThread(worker)!.sub_status, null);
    r.store.setSub(worker, { sub_status: 'task' as never });
    assert.equal(r.chatLaunch.extras({ threadId: worker, project: r.project, cwd: r.project }, 'codex').noNativeAsk, true, 'a resumed Worker');
    assert.equal(r.chatLaunch.extras({ threadId: sub, project: r.project, cwd: r.project }, 'claude').noNativeAsk, true, 'a resumed sub thread');
    // agy: one rules file per folder, so a sub thread's "never ask" is not written there (a main agy chat in that folder would read it)
    buildInteractive('agy', { cwd: r.project, project: r.project, threadId: 't_agy', noNativeAsk: true });
    assert.doesNotMatch(fs.readFileSync(path.join(r.project, '.agents/plugins/chorus/rules/AGENTS.md'), 'utf8'), /ask_question/);
  } finally {
    await r.done();
  }
});
