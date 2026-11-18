// list_watches (task #10, step 9; owner 2026-11-18): a chat sees the watch records kept for it (watch.belongs_to) and never another
// chat's: what each expects, on which chat, its status and for how long, its misses, what fires next and its last event. A fake
// clock and seeded watch / watch_event rows; the live state comes from the watcher.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TurnWatch, type WatchState } from '@chauvoluuhuong/chorus-core';
import { Store } from '../../src/core/store.ts';
import { human, listWatchesText } from '../../src/mcp/server.ts';

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const T0 = Date.parse('2026-11-18T10:00:00Z');
const S = 1000;

function rig() {
  const store = new Store(tmp('chorus-lw-'), { home: tmp('chorus-lw-h-') });
  const sub = store.createThread({ agent: 'claude', cwd: '/p', title: 'Price list' });
  const ws = store.watchStore();
  const rec = (s: Partial<WatchState> & Pick<WatchState, 'key' | 'thread' | 'belongsTo' | 'kind'>): WatchState => ({ owner: 'runner', expect: 'x', data: {}, created_at: T0 - 600 * S, ...s });
  const rows = [
    rec({ key: 'action:s1', thread: 't_main', belongsTo: 't_main', kind: 'action', expect: 'Create plan: call action_done when its work is finished', seen: 'waiting', since: T0 - 200 * S, deadline: T0 + 130 * S, waitOverAt: T0 + 130 * S, data: { missed: 1 } }),
    rec({ key: `sub:${sub.id}`, thread: sub.id, belongsTo: 't_main', kind: 'thread', owner: 'subthreads', expect: 'end its turn: reported to the main thread', seen: 'working', since: T0 - 45 * S, activityAt: T0 - 45 * S, created_at: T0 - 3725 * S }),
    rec({ key: 'answer:m_9', thread: 't_main', belongsTo: 't_main', kind: 'mail', owner: 'mailbox', expect: 'answer question m_9', seen: 'waiting', since: T0 - 20 * S, waitsOn: ['card'], created_at: T0 - 300 * S }),
    rec({ key: 'inbox:t_other', thread: 't_other', belongsTo: 't_other', kind: 'mail', owner: 'mailbox', expect: 'deliver the queued mail' }),
    rec({ key: 'action:old', thread: 't_main', belongsTo: 't_main', kind: 'action', seen: 'ended', since: T0 - 3700 * S, created_at: T0 - 4000 * S, ended_at: T0 - 3600 * S }),
    rec({ key: 'action:older', thread: 't_main', belongsTo: 't_main', kind: 'action', created_at: T0 - 30 * 3600 * S, ended_at: T0 - 25 * 3600 * S }),
    rec({ key: 'sub:t_other2', thread: 't_x', belongsTo: 't_other', kind: 'thread', created_at: T0 - 100 * S, ended_at: T0 - 50 * S }),
  ];
  for (const r of rows) ws.save(r);
  ws.event({ key: 'action:s1', thread: 't_main', belongsTo: 't_main', type: 'turnEnd', at: T0 - 250 * S, action: 'reminder sent' });
  ws.event({ key: 'action:s1', thread: 't_main', belongsTo: 't_main', type: 'waiting', at: T0 - 200 * S, detail: { on: ['card'] } });
  ws.event({ key: 'inbox:t_other', thread: 't_other', belongsTo: 't_other', type: 'idle', at: T0 - 10 * S, action: 'delivered' });
  const watch = new TurnWatch({ look: () => ({ state: 'working' }), store: ws, now: () => T0 });
  const list = (thread: string, args: { key?: string; ended?: boolean } = {}) => listWatchesText({ store, watch, thread, now: T0 }, args);
  return { store, sub, watch, list };
}

test('durations are human', () => {
  assert.equal(human(45 * S), '45s');
  assert.equal(human(200 * S), '3m 20s');
  assert.equal(human(180 * S), '3m');
  assert.equal(human(3900 * S), '1h 05m');
});

test('a chat gets exactly the rows that belong to it, never another chat\'s; ended ones only with ended, the last 24 h', () => {
  const r = rig();
  try {
    const keys = (t: string) => [...t.matchAll(/^\| ([^ |]+:[^ |]+) \|/gm)].map(m => m[1]);
    assert.deepEqual(keys(r.list('t_main').text), [`sub:${r.sub.id}`, 'action:s1', 'answer:m_9'], 'open ones, oldest first');
    assert.deepEqual(keys(r.list('t_main', { ended: true }).text), ['action:old', `sub:${r.sub.id}`, 'action:s1', 'answer:m_9']);
    assert.deepEqual(keys(r.list('t_other').text), ['inbox:t_other']);
    assert.doesNotMatch(r.list('t_other', { ended: true }).text + r.list('t_main', { ended: true }).text, /action:older/);
    assert.doesNotMatch(r.list('t_main', { ended: true }).text, /t_other/);
  } finally {
    r.store.close();
  }
});

test('the table: its columns, the watched chat, status, durations, misses, what fires next and the last event', () => {
  const r = rig();
  try {
    const lines = r.list('t_main', { ended: true }).text.split('\n');
    assert.equal(lines[0], '| key | kind | watched chat | expects | status | for | open for | missed | next | last event |');
    const row = (key: string) => lines.find(l => l.startsWith(`| ${key} |`))!.split(' | ').map(c => c.replace(/^\| | \|$/g, ''));
    assert.deepEqual(row('action:s1'), ['action:s1', 'action', 'this chat', 'Create plan: call action_done when its work is finished', 'idle', '3m 20s', '10m', '1', 'Stopped card in 2m 10s', 'waiting 3m 20s ago → —']);
    assert.deepEqual(row(`sub:${r.sub.id}`), [`sub:${r.sub.id}`, 'thread', `${r.sub.id} Price list`, 'end its turn: reported to the main thread', 'working', '45s', '1h 02m', '0', '"may be stuck" in 1m 15s', '—']);
    assert.deepEqual(row('answer:m_9').slice(4, 9), ['waiting on card', '20s', '5m', '0', '—']);
    assert.deepEqual(row('action:old').slice(4, 9), ['ended', '1m 40s', '6m 40s', '0', '—']);
  } finally {
    r.store.close();
  }
});

test('the live state comes from the watcher', () => {
  const r = rig();
  try {
    // the owner registers its watch again and a tick sees the chat working
    r.watch.watch({ key: 'answer:m_9', thread: 't_main', belongsTo: 't_main', kind: 'mail', owner: 'mailbox', expect: 'answer question m_9', on() {} });
    r.watch.tick(T0);
    const line = r.list('t_main').text.split('\n').find(l => l.startsWith('| answer:m_9 |'))!;
    assert.match(line, /\| working \|/);
  } finally {
    r.store.close();
  }
});

test('a key shows its fields and its events, newest first; another chat\'s key is refused', () => {
  const r = rig();
  try {
    const t = r.list('t_main', { key: 'action:s1' }).text;
    assert.match(t, /^- key: action:s1\n- kind: action\n- watched chat: this chat\n/);
    assert.match(t, /- status: idle\n- for: 3m 20s\n- open for: 10m\n- missed: 1\n- next: Stopped card in 2m 10s\n- last event: waiting 3m 20s ago → —/);
    const ev = t.slice(t.indexOf('Last events'));
    assert.match(ev, /2026-11-18T09:56:40.000Z waiting \{"on":\["card"\]\} → —\n- 2026-11-18T09:55:50.000Z turnEnd → reminder sent/);
    assert.match(r.list('t_main', { key: 'action:old' }).text, /- status: ended/, 'an ended record by key');
    assert.deepEqual(r.list('t_main', { key: 'inbox:t_other' }), { text: 'No watch record inbox:t_other for this chat.', isError: true });
  } finally {
    r.store.close();
  }
});

test('nothing: "No watch records for this chat."', () => {
  const r = rig();
  try {
    assert.equal(r.list('t_nobody').text, 'No watch records for this chat.');
    assert.equal(r.list('t_nobody', { ended: true }).text, 'No watch records for this chat.');
  } finally {
    r.store.close();
  }
});
