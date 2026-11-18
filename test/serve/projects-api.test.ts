// Settings › Projects (task #11 step 7): the list, one project's page, its folders and variables, restart-idle and Export this project
// through the API. A variable's value is written to the values file and never comes back from any route.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { LoadResult, ProCtx, ProModule } from '@chauvoluuhuong/chorus-core/pro-loader';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import type { ProLoader } from '../../src/serve/pro.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';

const VALUE = 'sk-value-never-returned-7f3a9c';
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

async function rig(pro?: ProModule) {
  const home = tmp('chorus-papi-');
  const a = tmp('proj-a-');
  const b = tmp('proj-b-');
  const store = new Store(a, { home });
  const ta1 = store.createThread({ title: 'A one', agent: 'claude', cwd: a, project: a });
  const ta2 = store.createThread({ title: 'A two', agent: 'codex', cwd: a, project: a });
  const tb = store.createThread({ title: 'B one', agent: 'claude', cwd: b, project: b });
  store.db.prepare(`UPDATE threads SET updated = ? WHERE id = ?`).run('2026-11-01T00:00:00Z', ta1.id);
  store.db.prepare(`UPDATE threads SET updated = ? WHERE id = ?`).run('2026-11-02T00:00:00Z', ta2.id);
  store.db.prepare(`UPDATE threads SET updated = ? WHERE id = ?`).run('2026-11-10T00:00:00Z', tb.id);
  store.db.prepare(`INSERT INTO artifacts (thread_id, path, version, ts) VALUES (?, ?, ?, ?)`).run(ta1.id, 'plan.md', '1', '2026-11-01T00:00:00Z');
  store.db.prepare(`INSERT INTO artifacts (thread_id, path, version, ts) VALUES (?, ?, ?, ?)`).run(ta2.id, 'notes.md', '1', '2026-11-01T00:00:00Z');
  store.db.prepare(`INSERT INTO artifacts (thread_id, path, version, ts) VALUES (?, ?, ?, ?)`).run(tb.id, 'b.md', '1', '2026-11-01T00:00:00Z');
  const proLoader: ProLoader = { dev: true, load: async (_c: ProCtx) => (pro ?? { locked: 'no-licence', message: 'none' }) as LoadResult, activate: async () => ({ locked: 'no-licence', message: 'none' }) };
  const c = new Controller({ project: a, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (_x, o) => ({ bin: process.execPath, args: [], cwd: o.cwd }) });
  const out = tmp('chorus-papi-out-');
  const shown: string[] = [];
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }), proLoader, exportDir: out, onReveal: f => shown.push(f) });
  const url = await srv.start(0);
  const api = async (method: string, p: string, body?: object) => {
    const res = await fetch(url + p, { method, headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  };
  const done = () => {
    srv.close();
    c.stop();
    store.close();
  };
  return { home, a, b, store, srv, api, done, out, shown, ids: { ta1: ta1.id, ta2: ta2.id, tb: tb.id } };
}

test('projects API: the list (newest first), one project, folders and variables with their errors; no route ever returns a value', async () => {
  const r = await rig();
  try {
    const list = (await r.api('GET', '/api/projects')).json;
    assert.deepEqual(list, [
      { folder: r.b, name: path.basename(r.b), chats: 1 },
      { folder: r.a, name: path.basename(r.a), chats: 2 },
    ], 'newest activity first; no tasks without Pro');

    const one = (await r.api('GET', `/api/projects/one?folder=${encodeURIComponent(r.a)}`)).json;
    assert.deepEqual(one, { folder: r.a, name: path.basename(r.a), chats: { total: 2, running: 0 }, artifacts: 2, folders: [], variables: [], stale: 0 });
    assert.match((await r.api('GET', '/api/projects/one')).json.error, /folder is needed/);
    assert.match((await r.api('GET', `/api/projects/one?folder=${encodeURIComponent(path.join(r.b, 'nope'))}`)).json.error, /No project/);

    // folders
    const extra = tmp('extra-');
    let got = (await r.api('POST', '/api/projects/folders', { folder: r.a, dir: extra })).json;
    assert.equal(got.folders.length, 1);
    assert.deepEqual([got.folders[0].path, got.folders[0].by], [extra, 'you']);
    assert.ok(got.folders[0].at);
    assert.match((await r.api('POST', '/api/projects/folders', { folder: r.a, dir: 'relative/x' })).json.error, /absolute/);
    assert.match((await r.api('POST', '/api/projects/folders', { folder: r.a, dir: path.join(extra, 'missing') })).json.error, /does not exist/);
    assert.match((await r.api('POST', '/api/projects/folders', { folder: r.a, dir: r.a })).json.error, /project folder itself/);
    assert.match((await r.api('POST', '/api/projects/folders', { folder: r.a, dir: os.homedir() })).json.error, /too wide/);
    assert.match((await r.api('DELETE', '/api/projects/folders', { folder: r.a, dir: r.b })).json.error, /not a working folder/);
    assert.match((await r.api('POST', '/api/projects/folders', { dir: extra })).json.error, /folder is needed/);

    // variables
    got = (await r.api('POST', '/api/projects/variables', { folder: r.a, name: 'API_TOKEN', value: VALUE })).json;
    assert.deepEqual(got.variables.map((v: any) => [v.name, v.by]), [['API_TOKEN', 'you']]);
    assert.match((await r.api('POST', '/api/projects/variables', { folder: r.a, name: '1BAD', value: 'x' })).json.error, /not a variable name/);
    assert.match((await r.api('POST', '/api/projects/variables', { folder: r.a, name: 'PATH', value: 'x' })).json.error, /reserved/);
    assert.match((await r.api('POST', '/api/projects/variables', { folder: r.a, name: 'CHORUS_X', value: 'x' })).json.error, /reserved/);
    assert.match((await r.api('POST', '/api/projects/variables', { folder: r.a, name: 'OK_NAME' })).json.error, /value must be text/);
    assert.match((await r.api('DELETE', '/api/projects/variables', { folder: r.a, name: 'NOPE' })).json.error, /not a variable/);
    // the value is in the 0600 values file, and nowhere in what the routes answer
    const envFile = path.join(r.home, 'project-env.json');
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(envFile, 'utf8'))[r.a].API_TOKEN, VALUE);
    assert.doesNotMatch(fs.readFileSync(path.join(r.home, 'projects.json'), 'utf8'), new RegExp(VALUE));
    for (const [m, p, body] of [['GET', `/api/projects/one?folder=${encodeURIComponent(r.a)}`], ['GET', '/api/projects'], ['GET', '/api/state'], ['POST', '/api/projects/restart-idle', { folder: r.a }]] as const)
      assert.doesNotMatch((await r.api(m, p, body as object | undefined)).text, new RegExp(VALUE), `${m} ${p}`);
    assert.deepEqual((await r.api('POST', '/api/projects/restart-idle', { folder: r.a })).json, { restarted: [], waiting: [] });

    // removing
    got = (await r.api('DELETE', '/api/projects/variables', { folder: r.a, name: 'API_TOKEN' })).json;
    assert.deepEqual(got.variables, []);
    assert.equal(JSON.parse(fs.readFileSync(envFile, 'utf8'))[r.a], undefined);
    got = (await r.api('DELETE', '/api/projects/folders', { folder: r.a, dir: extra })).json;
    assert.deepEqual(got.folders, []);
    assert.ok(fs.existsSync(extra), 'a removed working folder stays on disk');
    // the other project is untouched
    assert.deepEqual((await r.api('GET', `/api/projects/one?folder=${encodeURIComponent(r.b)}`)).json.folders, []);
  } finally {
    r.done();
  }
});

test('projects API: with Pro, task counts come from the module; Export this project carries its pro/ files and Show in Finder reveals it', async () => {
  const pro: ProModule = {
    version: 'stand-in', routes: () => ({}), mcpTools: () => [], ui: () => ({ js: '', css: '' }), onChatEvent() {}, dispose() {},
    projectCounts: (_c, p) => (p.includes('proj-a-') ? { tasks: 3, open: 1 } : { tasks: 0, open: 0 }),
    exportProject: (_c, p) => [{ path: 'pro/tasks.json', data: JSON.stringify({ project: p }) }],
  } as ProModule;
  const r = await rig(pro);
  try {
    const list = (await r.api('GET', '/api/projects')).json;
    assert.deepEqual(list.map((p: any) => p.tasks), [0, 3]);
    const one = (await r.api('GET', `/api/projects/one?folder=${encodeURIComponent(r.a)}`)).json;
    assert.deepEqual(one.tasks, { total: 3, open: 1 });

    const e = (await r.api('POST', '/api/export', { project: r.a })).json;
    assert.equal(e.chats, 2);
    assert.ok(e.file.startsWith(r.out));
    assert.match(path.basename(e.file), new RegExp(`^chorus-${path.basename(r.a)}-\\d{4}-\\d{2}-\\d{2}\\.zip$`));
    const names = execFileSync('unzip', ['-Z1', e.file], { encoding: 'utf8' }).trim().split('\n');
    assert.ok(names.includes('pro/tasks.json'));
    assert.ok(!names.includes('pro/pro.db'));
    assert.ok(names.every(n => !n.includes(r.ids.tb)), 'no chat of the other project');
    assert.deepEqual((await r.api('POST', '/api/export/reveal')).json, { ok: true });
    assert.deepEqual(r.shown, [e.file]);
    assert.match((await r.api('POST', '/api/export', { project: 'relative' })).json.error, /folder is needed/);
    // Export all still works without a project
    const all = (await r.api('POST', '/api/export')).json;
    assert.equal(all.chats, 3);
  } finally {
    r.done();
  }
});
