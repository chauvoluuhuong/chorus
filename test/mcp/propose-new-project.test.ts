// propose_new_project (task #11 step 14): a model creates a NEW project from any chat, This computer too. Checked first (no card on an
// error), ONE card for the user, Create makes and registers the folder and applies the note, folders and variables; Decline changes
// nothing. A registered project lists with 0 chats before its first chat. The typed value goes only to project-env.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { rig, tmp } from './project-rig.ts';

const SECRET = 'np-secret-4711';

/** a chat in a stand-in "This computer" (a …/.chorus/computer folder) */
async function computerChat(r: Awaited<ReturnType<typeof rig>>) {
  const dir = path.join(tmp('chorus-np-home-'), '.chorus', 'computer');
  fs.mkdirSync(dir, { recursive: true });
  return { dir, id: await r.newChat('claude', dir) };
}

test('get_project in This computer says it is not a project and points at propose_new_project', async () => {
  const r = await rig();
  try {
    const { id } = await computerChat(r);
    const info = JSON.parse((await (await r.mcp(id))('get_project')).text);
    assert.equal(info.is_project, false);
    assert.equal(info.place, 'This computer');
    assert.equal(info.name, 'This computer');
    assert.equal(info.setup_hint, 'This chat is in This computer, not a project. To set up a project, use propose_new_project.');
    assert.deepEqual(info.suggested_folders, []);
    // a chat in a project: is_project true
    const other = JSON.parse((await (await r.mcp(await r.newChat('codex')))('get_project')).text);
    assert.equal(other.is_project, true);
    assert.equal(other.place, undefined);
    // propose_project_change still works there, and its card says This computer, never "computer"
    const out = await (await r.mcp(id))('propose_project_change', { changes: [{ kind: 'set_note', note: 'odd jobs', why: 'w' }] });
    assert.ok(!out.isError, out.text);
    const card = r.store.pendingRequests(id)[0];
    assert.equal(card.question, 'Set the description of "This computer"?');
    assert.equal(JSON.parse(card.proposal!).name, 'This computer');
  } finally {
    await r.done();
  }
});

test('ONE card from This computer; Create makes the folder, registers it and applies everything; values stay in project-env.json', async () => {
  const r = await rig();
  try {
    const { id, dir: computer } = await computerChat(r);
    const call = await r.mcp(id);
    const app = path.join(r.parent, 'dummy-app');
    const lib = path.join(r.parent, 'dummy-lib');
    fs.mkdirSync(lib);
    const notes = path.join(r.parent, 'dummy-notes');
    const out = await call('propose_new_project', {
      folder: app,
      create: true,
      note: 'A dummy app; dummy-lib is its library, dummy-notes its notes.',
      folders: [{ path: lib, why: 'the library it imports' }, { path: notes, why: 'design notes', create: true }],
      variables: [{ name: 'DUMMY_TOKEN', why: 'the app calls the dummy API' }],
      why: 'The user asked for a dummy-app project.',
    });
    assert.ok(!out.isError, out.text);
    const pending = r.store.pendingRequests(id);
    assert.equal(pending.length, 1, 'ONE card');
    const card = pending[0];
    assert.equal(card.question, 'Create project "dummy-app"?');
    assert.deepEqual(card.options, ['Create', 'Create and open New chat there', 'Decline']);
    assert.equal(card.other, 0);
    assert.match(card.details!, /Chorus creates it/);
    const p = JSON.parse(card.proposal!);
    assert.equal(p.kind, 'new_project');
    assert.equal(p.project, app);
    assert.equal(p.create, true);
    assert.deepEqual(p.changes.map((c: any) => c.kind), ['set_note', 'add_folder', 'create_folder', 'set_variable']);
    assert.ok(!fs.existsSync(app) && !fs.existsSync(notes), 'nothing is made before the user approves');
    // without the typed value the answer is refused and nothing is made
    const none = await r.api('POST', `/api/chats/${id}/answer`, { request: card.id, option: 'Create' });
    assert.equal(none.json.ok, false);
    assert.ok(!fs.existsSync(app));
    const before = JSON.stringify(r.srv.projectSettings.get(computer));
    const res = await r.api('POST', `/api/chats/${id}/answer`, { request: card.id, option: 'Create and open New chat there', values: { DUMMY_TOKEN: SECRET } });
    assert.equal(res.json.ok, true, res.text);
    assert.equal(res.json.open, app, 'the page opens New chat with the folder chosen');
    assert.equal(res.json.text, `approved: created project dummy-app at ${app.replace(os.homedir(), '~')} with 2 folders and 1 variable (values hidden). Chats started there get them.`);
    assert.ok(fs.statSync(app).isDirectory() && fs.statSync(notes).isDirectory());
    const rec = r.srv.projectSettings.get(app);
    assert.equal(rec.registered, true);
    assert.equal(rec.registered_approval, card.id);
    assert.equal(rec.note, 'A dummy app; dummy-lib is its library, dummy-notes its notes.');
    assert.deepEqual(rec.folders.map(f => [f.path, f.why, !!f.created, f.approval]), [[lib, 'the library it imports', false, card.id], [notes, 'design notes', true, card.id]]);
    assert.deepEqual(rec.variables.map(v => [v.name, v.why]), [['DUMMY_TOKEN', 'the app calls the dummy API']]);
    assert.deepEqual(r.srv.projectSettings.env(app), { DUMMY_TOKEN: SECRET });
    assert.equal(JSON.stringify(r.srv.projectSettings.get(computer)), before, 'This computer is unchanged');
    // the chat that asked stays where it is
    assert.equal(r.store.getThread(id)!.cwd, computer);
    // listed with 0 chats; in the state for the sidebar with its two extra folders
    const list = (await r.api('GET', '/api/projects')).json;
    const row = (Array.isArray(list) ? list : list.projects).find((x: any) => x.folder === app);
    assert.equal(row.chats, 0);
    assert.ok(!(Array.isArray(list) ? list : list.projects).some((x: any) => x.folder === computer), 'This computer is not listed');
    const side = (r.srv.state() as any).projects.find((x: any) => x.folder === app);
    assert.deepEqual(side, { folder: app, registered: true, folders: [lib, notes] });
    assert.equal((await r.api('GET', `/api/projects/one?folder=${encodeURIComponent(app)}`)).json.chats.total, 0);
    // leak test: the value is only in project-env.json
    const env = path.join(r.home, 'project-env.json');
    assert.equal(fs.statSync(env).mode & 0o777, 0o600);
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (f !== env && fs.readFileSync(f).includes(SECRET)) hits.push(f);
      }
    };
    walk(r.home);
    walk(r.parent);
    assert.deepEqual(hits, []);
    const said = JSON.stringify([r.events, r.store.getRequest(card.id), (await call('get_project')).text]);
    assert.ok(!said.includes(SECRET), 'no value in events, the answer or an MCP reply');
    // a second card for the same folder is refused: it is a project now
    const again = await call('propose_new_project', { folder: app, note: 'n', why: 'w' });
    assert.equal(again.isError, true);
    assert.match(again.text, /already a project: to change it, call propose_project_change from a chat in that project/);
    // Delete of a registered project with no chats: the registration and settings go, the folders stay
    const del = await r.api('DELETE', `/api/projects?folder=${encodeURIComponent(app)}`);
    assert.equal(del.status, 200, del.text);
    assert.equal(r.srv.projectSettings.get(app).version, 0);
    assert.deepEqual(r.srv.projectSettings.registered(), []);
    assert.ok(fs.existsSync(app) && fs.existsSync(notes) && fs.existsSync(lib));
  } finally {
    await r.done();
  }
});

test('Decline changes nothing and creates no folder', async () => {
  const r = await rig();
  try {
    const me = await r.newChat('claude');
    const app = path.join(r.parent, 'never');
    const out = await (await r.mcp(me))('propose_new_project', { folder: app, create: true, note: 'n', folders: [{ path: path.join(r.parent, 'never-notes'), why: 'w', create: true }], variables: [{ name: 'X_TOKEN', why: 'w' }], why: 'w' });
    assert.ok(!out.isError, out.text);
    const card = r.store.pendingRequests(me)[0];
    const res = await r.api('POST', `/api/chats/${me}/answer`, { request: card.id, option: 'Decline' });
    assert.equal(res.json.text, 'declined');
    assert.ok(!fs.existsSync(app) && !fs.existsSync(path.join(r.parent, 'never-notes')));
    assert.deepEqual(r.srv.projectSettings.list(), []);
  } finally {
    await r.done();
  }
});

test('checked first: every error at once, no card', async () => {
  const r = await rig();
  try {
    const me = await r.newChat('claude');
    const call = await r.mcp(me);
    const refuse = async (args: object, re: RegExp) => {
      const out = await call('propose_new_project', { note: 'n', why: 'w', ...args });
      assert.equal(out.isError, true, JSON.stringify(args));
      assert.match(out.text, re);
      assert.equal(r.store.pendingRequests(me).length, 0, 'no card');
    };
    await refuse({ folder: '/' }, /too wide/);
    await refuse({ folder: os.homedir() }, /too wide/);
    await refuse({ folder: path.join(os.homedir(), '.chorus', 'something') }, /inside Chorus's own folders/);
    await refuse({ folder: path.join(r.home, 'x'), create: true }, /inside Chorus's own folders/);
    await refuse({ folder: 'relative/x' }, /absolute path/);
    await refuse({ folder: r.project }, /already a project/); // it has a chat
    await refuse({ folder: path.join(r.parent, 'nope') }, /does not exist: set create/);
    await refuse({ folder: path.join(r.parent, 'a', 'b'), create: true }, /parent folder .* does not exist/);
    await refuse({ folder: r.parent, create: true }, /already exists/);
    const fresh = path.join(r.parent, 'fresh');
    await refuse({ folder: fresh, create: true, variables: [{ name: 'PATH', why: 'w' }], folders: [{ path: path.join(r.parent, 'gone'), why: 'w' }] }, /folder: .*gone does not exist: set create on it to make it[\s\S]*variable: PATH is reserved/);
    await refuse({ folder: fresh, create: true, why: ' ' }, /why: say/);
    const noNote = await call('propose_new_project', { folder: fresh, create: true, note: ' ', why: 'w' });
    assert.equal(noNote.isError, true);
  } finally {
    await r.done();
  }
});
