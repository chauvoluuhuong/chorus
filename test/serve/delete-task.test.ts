// Deleting the Planner chat of a task (the paid module's GET chat-task) offers to delete the task too; the module deletes a
// deleted task's chats through ProCtx.deleteChat with no dialog. Any other chat, or no module: today's "Delete this chat?".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { LoadResult, ProCtx, ProModule } from '@chauvoluuhuong/chorus-core/pro-loader';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import type { ProLoader } from '../../src/serve/pro.ts';

type Owner = { id: string; number: number; title: string; state: string; chats: number };

/** A stand-in module: `owners` says which chat is the Planner of which task; every call to it is recorded. */
function stand(owners: Record<string, Owner>, chatTask: 'ok' | 'error' = 'ok') {
  const calls: { path: string; query?: unknown; body?: unknown }[] = [];
  const events: unknown[] = [];
  let ctx: ProCtx | undefined;
  const mod: ProModule = {
    version: 'stand-in',
    routes: c => {
      ctx = c;
      return {
        'GET chat-task': req => (calls.push({ path: 'chat-task', query: req.query }), chatTask === 'error' ? { httpStatus: 500, json: { error: 'x' } } : (owners[req.query.thread ?? ''] ?? {})),
        'POST task/remove': req => (calls.push({ path: 'task/remove', body: req.body }), { ok: true }),
      };
    },
    mcpTools: () => [],
    ui: () => ({ js: '', css: '' }),
    onChatEvent: (_c, ev) => void events.push(ev),
    dispose() {},
  };
  return { mod, calls, events, ctx: () => ctx! };
}

async function rig(first: LoadResult) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-del-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-del-p-'));
  const store = new Store(project, { home });
  const proLoader: ProLoader = { dev: true, load: async () => first, activate: async () => first };
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (_a, o) => ({ bin: process.execPath, args: [], cwd: o.cwd }) });
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }), proLoader });
  const url = await srv.start(0);
  for (const [id, title] of [['t_plan', 'Planner chat'], ['t_plain', 'Plain chat'], ['t_work', 'Worker chat']]) store.createThread({ id, title, agent: 'claude', cwd: project, native_session_id: `s-${id}`, state: 'waiting' });
  await new Promise(x => setTimeout(x, 30));
  const api = (method: string, p: string, body?: object) => fetch(url + p, { method, headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise(x => setTimeout(x, 10));
    assert.ok(ok(), what);
  };
  const dialogs = () => srv.state().dialogs;
  const has = (id: string) => !!store.getThread(id);
  /** DELETE the chat, wait for its dialog, answer it (null: Esc) */
  const del = async (id: string, value?: string | null) => {
    await api('DELETE', `/api/chats/${id}`);
    await until(() => dialogs().length === 1, 'a dialog');
    const d = dialogs()[0];
    if (value !== undefined) await api('POST', `/api/dialogs/${d.id}`, { value });
    return d;
  };
  return { srv, store, api, until, dialogs, has, del, close: () => (srv.close(), c.stop(), store.close()) };
}

const OWNER: Record<string, Owner> = { t_plan: { id: 'k1', number: 7, title: 'Ship it', state: 'ready', chats: 1 } };
const settle = () => new Promise(x => setTimeout(x, 80));

test('a plain chat: today\'s dialog, unchanged', async () => {
  const s = stand(OWNER);
  const r = await rig(s.mod);
  try {
    const d = await r.del('t_plain');
    assert.equal(d.title, 'Delete this chat?');
    assert.deepEqual(d.options, [{ key: 'y', label: 'Delete the chat' }, { key: 'w', label: 'Keep it' }]);
    await r.api('POST', `/api/dialogs/${d.id}`, { value: 'y' });
    await r.until(() => !r.has('t_plain'), 'deleted');
    assert.ok(s.events.some((e: any) => e.type === 'deleted' && e.thread === 't_plain'));
    assert.equal(s.calls.filter(c => c.path === 'task/remove').length, 0);
  } finally {
    r.close();
  }
});

test('a Planner chat: two choices naming the task, no "Delete only the chat" (owner, 2026-11-17)', async () => {
  const s = stand(OWNER);
  const r = await rig(s.mod);
  try {
    const d = await r.del('t_plan');
    assert.equal(d.title, 'Delete this chat and its task?');
    assert.deepEqual(d.options, [{ key: 't', label: 'Delete the chat and task #7' }, { key: 'w', label: 'Keep it' }]);
    assert.match(d.lines.join('\n'), /"Planner chat" is the Planner of task #7 "Ship it"/);
    assert.match(d.lines.join('\n'), /Deleting it also deletes the task: its steps, comments and waiting items, and its 1 Worker chat\./);
    await r.api('POST', `/api/dialogs/${d.id}`, { value: 'w' });
  } finally {
    r.close();
  }
});

test('a Planner chat of a plan still being made: "the plan", "Delete the chat and its plan"', async () => {
  const s = stand({ t_plan: { ...OWNER.t_plan, state: 'planning', chats: 0 } });
  const r = await rig(s.mod);
  try {
    const d = await r.del('t_plan', 'w');
    assert.equal(d.title, 'Delete this chat and its plan?');
    assert.equal(d.options![0].label, 'Delete the chat and its plan');
    assert.match(d.lines.join('\n'), /Deleting it also deletes the plan: its steps, comments and waiting items\./);
    assert.match(d.lines.join('\n'), /Planner of the plan "Ship it"/);
  } finally {
    r.close();
  }
});

test('"Delete the chat and task #N": task/remove with planner: true, and the chat is gone', async () => {
  const s = stand(OWNER);
  const r = await rig(s.mod);
  try {
    await r.del('t_plan', 't');
    await r.until(() => !r.has('t_plan'), 'chat deleted');
    await settle();
    assert.deepEqual(s.calls.filter(c => c.path === 'task/remove').map(c => c.body), [{ id: 'k1', planner: true }]);
    assert.equal(r.dialogs().length, 0);
  } finally {
    r.close();
  }
});

test('"Keep it" and Esc delete nothing', async () => {
  const s = stand(OWNER);
  const r = await rig(s.mod);
  try {
    for (const v of ['w', null]) {
      await r.del('t_plan', v);
      await settle();
      assert.ok(r.has('t_plan'), String(v));
      assert.equal(r.dialogs().length, 0);
    }
    assert.equal(s.calls.filter(c => c.path === 'task/remove').length, 0);
  } finally {
    r.close();
  }
});

test('ctx.deleteChat deletes with no dialog and tells the module', async () => {
  const s = stand(OWNER);
  const r = await rig(s.mod);
  try {
    assert.equal(typeof s.ctx().deleteChat, 'function');
    await s.ctx().deleteChat!('t_work');
    assert.equal(r.has('t_work'), false);
    assert.equal(r.dialogs().length, 0);
    assert.ok(s.events.some((e: any) => e.type === 'deleted' && e.thread === 't_work'));
    // a chat already gone: nothing happens
    await s.ctx().deleteChat!('t_work');
    // and a later user delete still asks
    const d = await r.del('t_plain');
    assert.equal(d.options!.length, 2);
  } finally {
    r.close();
  }
});

test('module locked, or chat-task not answered: today\'s dialog', async () => {
  for (const r of [await rig({ locked: 'no-licence', message: 'none' }), await rig(stand(OWNER, 'error').mod)]) {
    try {
      const d = await r.del('t_plan');
      assert.deepEqual(d.options, [{ key: 'y', label: 'Delete the chat' }, { key: 'w', label: 'Keep it' }]);
      await r.api('POST', `/api/dialogs/${d.id}`, { value: 'y' });
      await r.until(() => !r.has('t_plan'), 'deleted');
    } finally {
      r.close();
    }
  }
});
