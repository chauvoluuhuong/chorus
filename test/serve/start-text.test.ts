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
    mcpTools: () => [],
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
  const launcher = (agent: 'claude' | 'codex' | 'agy', o: Parameters<typeof buildInteractive>[1]) => {
    const l = buildInteractive(agent, { ...o, ...chatLaunch.extras(o, agent) });
    texts.set(o.threadId, l.args[l.args.indexOf('--append-system-prompt') + 1]);
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
  return { srv, store, project, texts, api, chat, mcp, done };
}

test('a plain chat is told every action of the bundle; without the bundle, none', async () => {
  const s = stand();
  const r = await rig(s.mod);
  try {
    const id = await r.chat();
    assert.match(r.texts.get(id)!, new RegExp(`This chat is Chorus thread ${id}\\.\\n\\nChorus actions: Create plan, Review changes\\. When one of them fits`));
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
