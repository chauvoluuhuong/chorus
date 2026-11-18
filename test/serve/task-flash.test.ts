// The Task button flashes like Artifacts when the chat's task changes (owner, 2026-11-18): a taskRev that grows lights the
// button; the first number the page learns, the boot window, a hidden window and a chat with no task do not.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a page module, plain JavaScript
import { COUNT_BOOT_MS, COUNT_MS, makeCounts, sideBtn } from '../../src/desktop/counts.js';

function rig() {
  const env = { t: 1_000_000, up: COUNT_BOOT_MS + 1, hid: false };
  const k = makeCounts({ now: () => env.t, uptime: () => env.up, hidden: () => env.hid });
  const revs: Record<string, number | undefined> = {};
  const pro = { taskRev: (id: string) => revs[id] };
  const chats = [{ id: 't_1' }, { id: 't_2' }];
  const task = (id = 't_1') => sideBtn('', 'task', 'Task', '☰', '', k.countFlash(`taskrev:${id}`)) as string;
  const cls = (html: string) => /class="([^"]*)"/.exec(html)![1];
  return { env, k, revs, pro, chats, task, cls };
}

test('a taskRev change makes the Task button flash; the first value does not', () => {
  const r = rig();
  r.revs.t_1 = 4;
  r.k.noteTaskRevs(r.chats, r.pro);
  assert.doesNotMatch(r.cls(r.task()), /flash/, 'the first value is the starting point');
  r.revs.t_1 = 5;
  r.env.t += 10;
  r.k.noteTaskRevs(r.chats, r.pro);
  assert.match(r.cls(r.task()), /flash/);
  assert.match(r.task(), /animation-delay:-0ms/);
  // a redraw inside the second keeps the animation in step
  r.env.t += 300;
  assert.match(r.task(), /animation-delay:-300ms/);
  // and it ends after the second
  r.env.t += COUNT_MS;
  assert.doesNotMatch(r.cls(r.task()), /flash/);
  assert.doesNotMatch(r.cls(r.task('t_2')), /flash/, 'the other chat did not change');
});

test('no flash at startup: the module loading late, the boot window, a hidden window', () => {
  const r = rig();
  // the module is not loaded yet, then its data arrives with a revision already above zero
  r.k.noteTaskRevs(r.chats, undefined);
  r.k.noteTaskRevs(r.chats, r.pro);
  r.revs.t_1 = 9;
  r.k.noteTaskRevs(r.chats, r.pro);
  assert.doesNotMatch(r.cls(r.task()), /flash/, 'the first known revision does not flash');
  // a change inside the boot window
  r.env.up = 10;
  r.revs.t_1 = 10;
  r.k.noteTaskRevs(r.chats, r.pro);
  assert.doesNotMatch(r.cls(r.task()), /flash/);
  // a change while the window is hidden
  r.env.up = COUNT_BOOT_MS + 1;
  r.env.hid = true;
  r.revs.t_1 = 11;
  r.k.noteTaskRevs(r.chats, r.pro);
  r.env.hid = false;
  assert.doesNotMatch(r.cls(r.task()), /flash/);
  // an older module without taskRev, or one that throws, notes nothing
  r.k.noteTaskRevs(r.chats, { sideTabs: () => null });
  r.k.noteTaskRevs(r.chats, { taskRev: () => { throw new Error('no data'); } });
  assert.doesNotMatch(r.cls(r.task()), /flash/);
});
