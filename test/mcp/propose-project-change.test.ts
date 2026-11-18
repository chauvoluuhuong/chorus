// propose_project_change (task #11 step 8): checked first (an invalid change makes no card), then ONE card for the user from any
// chat, main, sub thread or Worker alike; folder-only proposals offer Approve / Decline only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { rig } from './project-rig.ts';

test('one card for a note, two folders and two variables; the proposal is stored on it with every why', async () => {
  const r = await rig();
  try {
    const me = await r.newChat('claude');
    const call = await r.mcp(me);
    const lib = path.join(r.parent, 'lib');
    fs.mkdirSync(lib);
    const out = await call('propose_project_change', {
      reason: 'Set the project up for the payment work.',
      changes: [
        { kind: 'set_note', note: 'The shop; lib is its shared code.', why: 'so later chats know the layout' },
        { kind: 'add_folder', path: lib, why: 'shared code it imports' },
        { kind: 'create_folder', path: path.join(r.parent, 'shop-data'), why: 'test fixtures' },
        { kind: 'set_variable', name: 'POLAR_TOKEN', why: 'the payment tests' },
        { kind: 'set_variable', name: 'POLAR_MODE', why: 'sandbox or live', suggested_value: 'sandbox' },
      ],
    });
    assert.ok(!out.isError, out.text);
    const pending = r.store.pendingRequests(me);
    assert.equal(pending.length, 1, 'ONE card');
    const card = pending[0];
    assert.match(out.text, new RegExp(`^Shown to the user as card ${card.id} with the options: Approve and restart this chat / Approve / Decline\\. End your turn now`));
    assert.deepEqual(card.options, ['Approve and restart this chat', 'Approve', 'Decline']);
    assert.equal(card.question, 'Set up "shop": 5 changes?');
    assert.equal(card.other, 0);
    assert.match(card.details!, /^Set the project up for the payment work\./);
    assert.match(card.details!, /Set the variable `POLAR_TOKEN` \(you type the value\): "the payment tests"/);
    const p = JSON.parse(card.proposal!);
    assert.equal(p.project, r.project);
    assert.deepEqual(p.changes.map((c: any) => [c.kind, c.why]), [['set_note', 'so later chats know the layout'], ['add_folder', 'shared code it imports'], ['create_folder', 'test fixtures'], ['set_variable', 'the payment tests'], ['set_variable', 'sandbox or live']]);
    assert.equal(p.changes[4].suggested_value, 'sandbox');
    assert.ok(!fs.existsSync(path.join(r.parent, 'shop-data')), 'nothing is made before the user approves');
    assert.equal(r.srv.projectSettings.get(r.project).version, 0, 'nothing changes before the user approves');
    // the page's Approvals list carries the proposal for the card
    await r.until(() => (r.srv as any).approvalsNow().some((a: any) => a.request === card.id), 'the card is listed');
    const item = (r.srv as any).approvalsNow().find((a: any) => a.request === card.id);
    assert.equal(item.proposal.changes.length, 5);
  } finally {
    await r.done();
  }
});

test('folder-only proposals offer Approve / Decline only', async () => {
  const r = await rig();
  try {
    const me = await r.newChat('codex');
    const call = await r.mcp(me);
    const out = await call('propose_project_change', { changes: [{ kind: 'create_folder', path: path.join(r.parent, 'notes'), why: 'notes' }, { kind: 'set_note', note: 'x', why: 'y' }] });
    assert.ok(!out.isError, out.text);
    assert.deepEqual(r.store.pendingRequests(me)[0].options, ['Approve', 'Decline']);
  } finally {
    await r.done();
  }
});

test('works from a sub thread and from a Worker: the card is the user\'s', async () => {
  const r = await rig();
  try {
    const main = await r.newChat('claude');
    const sub = await r.newChat('claude');
    const worker = await r.newChat('codex');
    r.store.updateThread(sub, { parent_thread_id: main, sub_status: 'working' } as any);
    r.store.updateThread(worker, { parent_thread_id: main, sub_status: 'task' } as any);
    for (const id of [sub, worker]) {
      const out = await (await r.mcp(id))('propose_project_change', { changes: [{ kind: 'set_variable', name: 'API_KEY', why: 'the tests' }] });
      assert.ok(!out.isError, out.text);
      assert.match(out.text, /^Shown to the user as card r_/);
      assert.equal(r.store.pendingRequests(id).length, 1);
    }
    // request_approval still refuses them: only this tool asks the user from a sub thread or a Worker
    const refused = await (await r.mcp(sub))('request_approval', { question: 'ok?' });
    assert.equal(refused.isError, true);
  } finally {
    await r.done();
  }
});

test('invalid changes are refused at once, all errors together, and no card is made', async () => {
  const r = await rig();
  try {
    const me = await r.newChat('claude');
    const call = await r.mcp(me);
    const bad = async (changes: object[], re: RegExp) => {
      const out = await call('propose_project_change', { changes });
      assert.equal(out.isError, true, JSON.stringify(changes));
      assert.match(out.text, re);
    };
    // a change without why: the MCP schema, and serve's own check of a blank one
    const noWhy = await call('propose_project_change', { changes: [{ kind: 'add_folder', path: r.parent }] });
    assert.equal(noWhy.isError, true);
    await bad([{ kind: 'add_folder', path: r.parent, why: '   ' }], /every change needs its own why/);
    await bad([{ kind: 'create_folder', path: path.join(r.parent, 'no', 'such'), why: 'x' }], /the parent folder .*no does not exist/);
    await bad([{ kind: 'add_folder', path: path.join(r.parent, 'missing'), why: 'x' }], /does not exist: to make a new folder use create_folder/);
    await bad([{ kind: 'add_folder', path: 'relative/dir', why: 'x' }], /absolute path/);
    await bad([{ kind: 'add_folder', path: r.project, why: 'x' }], /the project folder itself/);
    await bad([{ kind: 'set_variable', name: 'PATH', why: 'x' }], /PATH is reserved/);
    await bad([{ kind: 'set_variable', name: '1BAD', why: 'x' }], /not a variable name/);
    await bad([{ kind: 'remove_variable', name: 'NOPE', why: 'x' }], /NOPE is not a variable of this project/);
    await bad([{ kind: 'remove_folder', path: r.parent, why: 'x' }], /is not a working folder/);
    await bad([{ kind: 'set_note', why: 'x' }], /set_note needs the note/);
    const both = await call('propose_project_change', { changes: [{ kind: 'set_variable', name: 'OK_NAME', why: 'fine' }, { kind: 'set_variable', name: 'PATH', why: 'x' }, { kind: 'set_variable', name: 'OK_NAME', why: 'again' }] });
    assert.equal(both.isError, true);
    assert.match(both.text, /change 2 \(set_variable\): PATH is reserved/);
    assert.match(both.text, /change 3 \(set_variable\): OK_NAME is named twice/);
    assert.deepEqual(r.store.pendingRequests(me), [], 'no card for an invalid proposal');
  } finally {
    await r.done();
  }
});
