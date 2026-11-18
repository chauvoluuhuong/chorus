// get_project (task #11 step 8): the calling chat's own project, with what it needs to work and to set the project up; never a value.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakePro, rig } from './project-rig.ts';

const VALUE = 'sk-get-project-never-9d2e71';

/** shop depends on ../shop-core (package.json file:), and a sibling shop-assets is named like it */
const layout = (parent: string, project: string) => {
  fs.mkdirSync(path.join(parent, 'shop-core'));
  fs.mkdirSync(path.join(parent, 'shop-assets'));
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'shop', dependencies: { core: 'file:../shop-core' } }));
};

test('get_project: every field, own project only, suggested folders and the setup hint; no value anywhere', async () => {
  const r = await rig({ layout });
  try {
    const me = await r.newChat('claude');
    const other = r.store.createThread({ title: 'elsewhere', agent: 'claude', cwd: r.parent, project: r.parent });
    const call = await r.mcp(me);
    const first = await call('get_project');
    assert.ok(!first.isError, first.text);
    const p = JSON.parse(first.text);
    for (const k of ['name', 'folder', 'note', 'note_by', 'git', 'working_folders', 'variables', 'suggested_folders', 'this_chat', 'chats', 'artifacts', 'last_activity', 'setup_hint', 'how_to_change']) assert.ok(k in p, `has ${k}`);
    assert.equal(p.name, 'shop');
    assert.equal(p.folder, r.project);
    assert.equal(p.git, null);
    assert.ok(!('tasks' in p), 'no tasks without Pro');
    assert.deepEqual(p.suggested_folders.map((s: { path: string }) => s.path), [path.join(r.parent, 'shop-core'), path.join(r.parent, 'shop-assets')]);
    assert.match(p.suggested_folders[0].why, /package\.json depends on file:\.\.\/shop-core/);
    assert.match(p.setup_hint, /no description and 2 likely folders/);
    assert.equal(p.chats.total, 1, 'only this project\'s chats');
    assert.deepEqual(p.chats.list.map((c: { id: string }) => c.id), [me]);
    assert.ok(!first.text.includes(other.id));
    assert.deepEqual(p.this_chat.missing, { folders: [], variables: [] });
    assert.equal(p.this_chat.restart_pending, false);
    assert.equal(p.how_to_change, 'propose_project_change (the user approves on one card)');

    // the user adds a note, a suggested folder and a variable on the page: the folder reaches the running chat live, the variable
    // only when it restarts
    const core = path.join(r.parent, 'shop-core');
    await r.api('POST', '/api/projects/note', { folder: r.project, note: 'The shop and its core library.' });
    await r.api('POST', '/api/projects/folders', { folder: r.project, dir: core, why: 'the core library' });
    await r.api('POST', '/api/projects/variables', { folder: r.project, name: 'SHOP_TOKEN', value: VALUE, why: 'the API' });
    const after = await call('get_project');
    assert.ok(!after.text.includes(VALUE), 'never a value');
    const q = JSON.parse(after.text);
    assert.equal(q.note, 'The shop and its core library.');
    assert.deepEqual(q.working_folders.map((f: any) => [f.path, f.why, f.added_by, f.exists, f.created, f.in_this_chat]), [[core, 'the core library', 'you', true, false, true]]);
    assert.ok(q.working_folders[0].added_at);
    assert.deepEqual(q.variables.map((v: any) => [v.name, v.why, v.added_by, v.in_this_chat]), [['SHOP_TOKEN', 'the API', 'you', false]]);
    assert.deepEqual(Object.keys(q.variables[0]).sort(), ['added_at', 'added_by', 'in_this_chat', 'name', 'why'], 'no value field');
    assert.deepEqual(q.suggested_folders.map((s: { path: string }) => s.path), [path.join(r.parent, 'shop-assets')], 'an added folder is no longer suggested');
    assert.match(q.setup_hint, /1 likely folder not added yet/);
    assert.doesNotMatch(q.setup_hint, /no description/);
    assert.deepEqual(q.this_chat.missing, { folders: [], variables: ['SHOP_TOKEN'] });
    assert.match(q.this_chat.how_to_get_missing, /call reload_project_settings/);

    // reload_project_settings: queued; then the restart (its launch report) gives the chat everything
    const reload = await call('reload_project_settings');
    assert.match(reload.text, /restarts with the project's current folders and variables when this turn ends; the conversation is kept/);
    const pending = JSON.parse((await call('get_project')).text);
    assert.equal(pending.this_chat.restart_pending, true);
    assert.match(pending.this_chat.how_to_get_missing, /nothing to do/);
    r.srv.projects.launched(me, r.project, r.srv.projectSettings.addDirs(r.project), r.srv.projectSettings.env(r.project));
    const restarted = JSON.parse((await call('get_project')).text);
    assert.deepEqual(restarted.this_chat.missing, { folders: [], variables: [] });
    assert.equal(restarted.variables[0].in_this_chat, true);
    assert.equal(restarted.this_chat.restart_pending, false);

    // every suggested folder added and a note: no setup hint
    await r.api('POST', '/api/projects/folders', { folder: r.project, dir: path.join(r.parent, 'shop-assets') });
    assert.ok(!('setup_hint' in JSON.parse((await call('get_project')).text)));
  } finally {
    await r.done();
  }
});

test('get_project: tasks only with Pro (counts and the open ones)', async () => {
  const seen: string[] = [];
  const pro = fakePro({ projectCounts: (_c, p) => (seen.push(p), { tasks: 4, open: 2 }), projectTasks: () => [{ number: 11, title: 'Projects', state: 'running' }, { number: 9, title: 'Search', state: 'planning' }] });
  const r = await rig({ pro });
  try {
    const me = await r.newChat('codex');
    const p = JSON.parse((await (await r.mcp(me))('get_project')).text);
    assert.deepEqual(p.tasks, { total: 4, open: 2, list: [{ number: 11, title: 'Projects', state: 'running' }, { number: 9, title: 'Search', state: 'planning' }] });
    assert.ok(seen.includes(r.project), 'asked for its own project');
    assert.equal(p.this_chat.agent, 'codex');
  } finally {
    await r.done();
  }
});
