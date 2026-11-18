// The user's answer to a propose_project_change card (task #11 step 8): Approve applies every change with its why and who asked,
// makes a created folder, takes an edited note; new folders go live to every running chat (the asking one too), variables only
// mark the others stale; Decline changes nothing. The typed value is written ONLY to project-env.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { rig } from '../mcp/project-rig.ts';

const VALUE = 'pk-typed-on-the-card-5b81c3e0';

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? filesUnder(p) : e.isFile() ? [p] : [];
  });
}

async function proposeAll(r: Awaited<ReturnType<typeof rig>>, me: string) {
  const lib = path.join(r.parent, 'lib');
  fs.mkdirSync(lib);
  const made = path.join(r.parent, 'shop-data');
  const out = await (await r.mcp(me))('propose_project_change', {
    changes: [
      { kind: 'set_note', note: 'The shop.', why: 'for later chats' },
      { kind: 'add_folder', path: lib, why: 'shared code' },
      { kind: 'create_folder', path: made, why: 'fixtures' },
      { kind: 'set_variable', name: 'POLAR_TOKEN', why: 'payment tests' },
    ],
  });
  assert.ok(!out.isError, out.text);
  return { lib, made, card: r.store.pendingRequests(me)[0] };
}

test('Approve and restart: everything applied with its why; folders live to every running chat; only project-env.json has the value', async () => {
  const r = await rig();
  try {
    const me = await r.newChat('claude');
    const other = await r.newChat('codex');
    const { lib, made, card } = await proposeAll(r, me);
    const res = (await r.api('POST', `/api/chats/${me}/answer`, { request: card.id, option: 'Approve and restart this chat', values: { POLAR_TOKEN: VALUE }, note: 'The shop, edited by you.' })).json;
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.ok(!res.text.includes(VALUE));

    // applied
    assert.ok(fs.statSync(made).isDirectory(), 'the created folder is made');
    const rec = r.srv.projectSettings.get(r.project);
    const title = r.store.getThread(me)!.title;
    assert.equal(rec.note, 'The shop, edited by you.');
    assert.equal(rec.note_by, `${title} (claude)`);
    assert.deepEqual(rec.folders.map(f => [f.path, f.why, f.by, f.by_thread, f.approval, !!f.created]), [[lib, 'shared code', `${title} (claude)`, me, card.id, false], [made, 'fixtures', `${title} (claude)`, me, card.id, true]]);
    assert.deepEqual(rec.variables.map(v => [v.name, v.why, v.by_thread, v.approval]), [['POLAR_TOKEN', 'payment tests', me, card.id]]);
    assert.deepEqual(r.srv.projectSettings.env(r.project), { POLAR_TOKEN: VALUE });

    // running chats: both folders live to both chats, the asker included; the asker restarts at its turn end, the other is only stale
    for (const id of [me, other]) for (const d of [lib, made]) assert.ok(r.live.some(([i, x]) => i === id && x === d), `${id} got ${d} live`);
    assert.equal(r.srv.projects.restartPending(me), true);
    assert.equal(r.srv.projects.restartPending(other), false);
    assert.ok(r.srv.projects.staleChats(r.project).includes(other), 'the other chat is marked stale (the page\'s banner)');

    // the answer the chat reads
    const answered = r.store.getRequest(card.id)!;
    assert.equal(answered.status, 'answered');
    assert.equal(answered.note, null);
    assert.match(answered.answer!, /^approved: description set; added folder .*lib \(added to this chat now\); created and added folder .*shop-data \(added to this chat now\); set POLAR_TOKEN \(value hidden\)\. This chat restarts when this turn ends to get them; other running chats get them when they restart\.$/);

    // get_project gives back each why and who asked
    const p = JSON.parse((await (await r.mcp(me))('get_project')).text);
    assert.deepEqual(p.working_folders.map((f: any) => [f.why, f.added_by, f.created]), [['shared code', `${title} (claude)`, false], ['fixtures', `${title} (claude)`, true]]);
    assert.deepEqual(p.variables.map((v: any) => [v.name, v.why, v.added_by]), [['POLAR_TOKEN', 'payment tests', `${title} (claude)`]]);

    // the value: only in project-env.json, nowhere else under the store root (every DB table and WAL, ui.json, projects.json,
    // the request, answer and mail rows), in no event and no MCP reply
    r.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const files = filesUnder(r.home);
    assert.ok(files.some(f => path.basename(f) === 'project-env.json'));
    assert.ok(files.some(f => path.basename(f) === 'projects.json'));
    for (const f of files) {
      const has = fs.readFileSync(f).includes(VALUE);
      assert.equal(has, path.basename(f) === 'project-env.json', `${path.relative(r.home, f)} ${has ? 'has' : 'lacks'} the value`);
    }
    for (const t of (r.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(x => x.name)) {
      const rows = JSON.stringify(r.store.db.prepare(`SELECT * FROM "${t}"`).all());
      assert.ok(!rows.includes(VALUE), `table ${t}`);
    }
    assert.ok(!JSON.stringify(r.events).includes(VALUE), 'no event');
    assert.ok(!JSON.stringify(p).includes(VALUE), 'no MCP reply');
    assert.equal(fs.statSync(path.join(r.home, 'project-env.json')).mode & 0o777, 0o600);
  } finally {
    await r.done();
  }
});

test('Approve without restart: applied; the asker is told how to get the variable', async () => {
  const r = await rig();
  try {
    const me = await r.newChat('claude');
    const out = await (await r.mcp(me))('propose_project_change', { changes: [{ kind: 'set_variable', name: 'API_KEY', why: 'x' }] });
    assert.ok(!out.isError);
    const card = r.store.pendingRequests(me)[0];
    const res = (await r.api('POST', `/api/chats/${me}/answer`, { request: card.id, option: 'Approve', values: { API_KEY: VALUE } })).json;
    assert.equal(res.ok, true);
    assert.match(res.text, /^approved: set API_KEY \(value hidden\)\. This chat and the other running chats get them when they restart: call reload_project_settings/);
    assert.equal(r.srv.projects.restartPending(me), false);
  } finally {
    await r.done();
  }
});

test('a set_variable without a typed value refuses the answer: nothing applied, the card stays', async () => {
  const r = await rig();
  try {
    const me = await r.newChat('claude');
    const { made, card } = await proposeAll(r, me);
    const res = (await r.api('POST', `/api/chats/${me}/answer`, { request: card.id, option: 'Approve', values: { POLAR_TOKEN: '' } })).json;
    assert.equal(res.ok, false);
    assert.match(res.error, /Type a value for POLAR_TOKEN, or decline/);
    assert.equal(r.store.getRequest(card.id)!.status, 'pending');
    assert.ok(!fs.existsSync(made));
    assert.equal(r.srv.projectSettings.get(r.project).version, 0);
  } finally {
    await r.done();
  }
});

test('Decline changes nothing and makes no folder', async () => {
  const r = await rig();
  try {
    const me = await r.newChat('claude');
    const { made, card } = await proposeAll(r, me);
    const res = (await r.api('POST', `/api/chats/${me}/answer`, { request: card.id, option: 'Decline', values: { POLAR_TOKEN: VALUE } })).json;
    assert.equal(res.ok, true);
    const row = r.store.getRequest(card.id)!;
    assert.deepEqual([row.status, row.answer], ['answered', 'declined']);
    assert.ok(!fs.existsSync(made));
    assert.equal(r.srv.projectSettings.get(r.project).version, 0);
    assert.deepEqual(r.srv.projectSettings.env(r.project), {});
    assert.deepEqual(r.live, []);
    assert.ok(!fs.existsSync(path.join(r.home, 'project-env.json')) || !fs.readFileSync(path.join(r.home, 'project-env.json'), 'utf8').includes(VALUE));
  } finally {
    await r.done();
  }
});
