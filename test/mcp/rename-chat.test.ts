// rename_chat (task #11 step 8): a chat names itself; the store row and the app's entry change at once, every window gets a
// 'renamed' event (the toast with Undo), and Undo is POST chats/:id/title by "you". The first-message rule never renames it back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rig } from './project-rig.ts';

test('rename_chat renames only the calling chat; the event carries from/to; Undo restores it', async () => {
  const r = await rig();
  try {
    const me = await r.newChat('claude');
    const other = await r.newChat('codex');
    const before = r.store.getThread(me)!.title;
    const otherTitle = r.store.getThread(other)!.title;
    const call = await r.mcp(me);
    const out = await call('rename_chat', { title: '  Plan:   Projects\tpage ' });
    assert.ok(!out.isError, out.text);
    assert.equal(out.text, 'This chat is now named "Plan: Projects page".');
    assert.equal(r.store.getThread(me)!.title, 'Plan: Projects page');
    assert.equal(r.c.app.entry(me)!.title, 'Plan: Projects page', 'the app entry too');
    assert.equal(r.store.getThread(other)!.title, otherTitle, 'never another chat');
    assert.deepEqual(r.events.filter(e => e.t === 'renamed'), [{ t: 'renamed', id: me, from: before, to: 'Plan: Projects page', by: 'model' }]);

    // the first-message rule only names auto-named chats: it leaves this one alone
    (r.c as any).nameFromFirstMessage(me, { turns: [{ role: 'user', text: 'You are Planner. Read the instructions carefully' }] });
    assert.equal(r.store.getThread(me)!.title, 'Plan: Projects page');
    (r.c as any).nameFromFirstMessage(other, { turns: [{ role: 'user', text: 'You are Planner. Read the instructions carefully' }] });
    assert.equal(r.store.getThread(other)!.title, 'You are Planner. Read the i…', 'an auto name still is (the rule is unchanged)');

    // Undo from the toast
    const undo = (await r.api('POST', `/api/chats/${me}/title`, { title: before, by: 'you' })).json;
    assert.deepEqual(undo, { ok: true, from: 'Plan: Projects page', to: before });
    assert.equal(r.store.getThread(me)!.title, before);
    assert.equal(r.c.app.entry(me)!.title, before);
    assert.deepEqual(r.events.filter(e => e.t === 'renamed').at(-1), { t: 'renamed', id: me, from: 'Plan: Projects page', to: before, by: 'you' });
  } finally {
    await r.done();
  }
});

test('empty, too long and multi-line titles are refused with a clear error; nothing changes', async () => {
  const r = await rig();
  try {
    const me = await r.newChat('codex');
    const before = r.store.getThread(me)!.title;
    const call = await r.mcp(me);
    const refused = async (title: string, re?: RegExp) => {
      const out = await call('rename_chat', { title });
      assert.equal(out.isError, true, title);
      if (re) assert.match(out.text, re);
    };
    await refused('', undefined);
    await refused('   ', /The title is empty/);
    await refused('x'.repeat(61), undefined);
    await refused('Plan\nProjects', /one line/);
    assert.match((await r.api('POST', `/api/chats/${me}/title`, { title: 'y'.repeat(61), by: 'you' })).json.error, /too long: 61 characters, at most 60/);
    assert.match((await r.api('POST', `/api/chats/${me}/title`, { title: 'a\r\nb' })).json.error, /one line/);
    assert.match((await r.api('POST', `/api/chats/${me}/title`, {})).json.error, /must be text/);
    assert.equal(r.store.getThread(me)!.title, before);
    assert.deepEqual(r.events.filter(e => e.t === 'renamed'), []);
    // exactly 60 is fine
    assert.ok(!(await call('rename_chat', { title: 'z'.repeat(60) })).isError);
  } finally {
    await r.done();
  }
});
