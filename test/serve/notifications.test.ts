import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NotificationInbox } from '../../src/serve/notifications.ts';
const item = { id: 'notice-one', title: 'A workspace tip', html: '<article><h1>Hello</h1><p>Keep your context.</p><a href="https://example.org/help?q=one&amp;lang=en">Read more</a></article>', revision: 1, publishedAt: '2026-10-25T00:00:00.000Z' };
const feed = () => ({ notifications: [item], checkedAt: new Date().toISOString() });
function setup(t: any, reply?: (url: string, body: any) => object | Promise<object>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-inbox-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls: { url: string; body: any }[] = [];
  const request = (async (url: string | URL | Request, opts: RequestInit) => { const body = JSON.parse(String(opts.body)); calls.push({ url: String(url), body }); return Response.json(await (reply?.(String(url), body) ?? (String(url).endsWith('/startup') ? feed() : { ok: true }))); }) as typeof fetch;
  const create = () => new NotificationInbox({ directory, version: 'test-version', platform: 'darwin', request, endpoint: 'https://notifications.invalid' });
  return { directory, calls, create };
}
test('only one remote check per launch; snapshot, read-all, and repeated startup calls never check again', async t => {
  const r = setup(t), inbox = r.create();
  await Promise.all([inbox.startup(), inbox.startup(), inbox.startup()]);
  assert.equal(r.calls.length, 1); assert.equal(inbox.summary().unread, 1);
  for (let i = 0; i < 20; i++) { inbox.snapshot(); inbox.summary(); inbox.content(item.id); }
  inbox.markAllRead(); await inbox.startup();
  assert.equal(r.calls.length, 1); assert.equal(inbox.summary().unread, 0);
  assert.equal(JSON.stringify(inbox.snapshot()).includes('installationKey'), false);
  inbox.close();
});
test('explicit open is delivered once; mark-all-read is not counted as opening content', async t => {
  const r = setup(t), inbox = r.create(); await inbox.startup(); inbox.markAllRead();
  assert.equal(r.calls.length, 1); await inbox.opened(item.id);
  assert.equal(r.calls.length, 2); assert.match(r.calls[1].url, /\/events$/);
  assert.deepEqual(r.calls[1].body.events, [{ id: item.id, type: 'opened' }]);
  await inbox.opened(item.id); assert.equal(r.calls.length, 2); inbox.close();
});
test('installation identity and read state survive another launch; acknowledged receipts are not resent forever', async t => {
  const r = setup(t); let inbox = r.create(); await inbox.startup(); await inbox.opened(item.id); inbox.close();
  inbox = r.create(); await inbox.startup();
  assert.equal(r.calls[0].body.installationId, r.calls[2].body.installationId);
  assert.equal(r.calls[0].body.installationKey, r.calls[2].body.installationKey);
  assert.deepEqual(r.calls[2].body.events, []); assert.equal(inbox.summary().unread, 0);
  assert.equal(fs.statSync(path.join(r.directory, 'inbox.json')).mode & 0o777, 0o600); inbox.close();
});
test('a failed launch uses the cache and never retries until a new launch', async t => {
  let offline = false;
  const r = setup(t, () => { if (offline) throw new Error('offline'); return feed(); });
  let inbox = r.create(); await inbox.startup(); inbox.close(); offline = true;
  inbox = r.create(); await inbox.startup(); await inbox.startup();
  assert.equal(inbox.snapshot().items[0].title, item.title); assert.equal(inbox.summary().offline, true);
  const count = r.calls.length; inbox.snapshot(); inbox.markAllRead(); await inbox.startup();
  assert.equal(r.calls.length, count); inbox.close();
});
test('offline open stays queued and is acknowledged on the next startup, without retrying in the old process', async t => {
  let failEvents = true;
  const r = setup(t, url => { if (url.endsWith('/events') && failEvents) throw new Error('offline'); return url.endsWith('/startup') ? feed() : { ok: true }; });
  let inbox = r.create(); await inbox.startup(); await inbox.opened(item.id);
  assert.equal(inbox.summary().unread, 0); assert.equal(r.calls.length, 2); inbox.snapshot(); assert.equal(r.calls.length, 2); inbox.close();
  failEvents = false; inbox = r.create(); await inbox.startup();
  assert.deepEqual(r.calls[2].body.events, [{ id: item.id, type: 'opened' }]); inbox.close();
});
test('a malformed feed never overwrites a previously valid cache', async t => {
  let malformed = false;
  const r = setup(t, () => malformed ? { notifications: [{ ...item, id: undefined }], checkedAt: new Date().toISOString() } : feed());
  let inbox = r.create(); await inbox.startup(); inbox.close(); malformed = true;
  inbox = r.create(); await inbox.startup(); assert.equal(inbox.content(item.id)?.html, item.html); assert.equal(inbox.summary().offline, true); inbox.close();
});
test('only cached HTTPS links can open externally; credentials never enter the public snapshot', async t => {
  const r = setup(t), inbox = r.create(); await inbox.startup();
  assert.equal(inbox.allowsLink(item.id, 'https://example.org/help?q=one&lang=en'), true);
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'https://evil.example/', 'https://person:secret@example.org/help?q=one&lang=en']) assert.equal(inbox.allowsLink(item.id, bad), false);
  assert.equal(inbox.allowsLink(undefined, 'https://chorus-cli.web.app/privacy'), true);
  const key = JSON.parse(fs.readFileSync(path.join(r.directory, 'inbox.json'), 'utf8')).installationKey;
  assert.equal(JSON.stringify(inbox.snapshot()).includes(key), false); inbox.close();
});
test('a corrupt cache is preserved, rather than silently registering a second installation', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-bad-inbox-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'inbox.json'); fs.writeFileSync(file, '{broken');
  assert.throws(() => new NotificationInbox({ directory, version: '1' }), /preserving/); assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('opening two messages at once sends each opened event once', async t => {
  const second = { ...item, id: 'notice-two', title: 'Another tip' };
  let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const r = setup(t, async url => { if (url.endsWith('/events')) await gate; return url.endsWith('/startup') ? { notifications: [item, second], checkedAt: new Date().toISOString() } : { ok: true }; });
  const inbox = r.create(); await inbox.startup(); inbox.markAllRead();
  const both = Promise.all([inbox.opened(item.id), inbox.opened(second.id)]); setTimeout(release, 20); await both;
  const sent = r.calls.filter(c => c.url.endsWith('/events')).flatMap(c => c.body.events.filter((e: any) => e.type === 'opened').map((e: any) => e.id));
  assert.deepEqual(sent.sort(), [item.id, second.id].sort()); inbox.close();
});

test('usage counts once per process, combines same-day launches, and reports offline launches on the next startup', async t => {
  let offline = false, now = new Date('2026-10-26T10:00:00Z');
  const r = setup(t, () => { if (offline) throw new Error('offline'); return feed(); });
  const create = () => new NotificationInbox({ directory: r.directory, version: '1', request: (async (url, options) => {
    const body = JSON.parse(String(options?.body)); r.calls.push({ url: String(url), body }); if (offline) throw new Error('offline'); return Response.json(feed());
  }) as typeof fetch, now: () => now });
  let inbox = create(); await Promise.all([inbox.startup(), inbox.startup()]);
  assert.deepEqual(r.calls[0].body.usage, { launches: 1, activeDays: 1, firstDay: '2026-10-26', recentDays: ['2026-10-26'] });
  await inbox.opened(item.id); assert.equal(r.calls[1].body.usage, undefined, 'open requests never report extra launches'); inbox.close();
  offline = true; inbox = create(); await inbox.startup(); await inbox.startup(); inbox.close();
  now = new Date('2026-10-27T10:00:00Z'); inbox = create(); await inbox.startup(); inbox.close();
  offline = false; inbox = create(); await inbox.startup();
  assert.deepEqual(r.calls.at(-1)?.body.usage, { launches: 4, activeDays: 2, firstDay: '2026-10-26', recentDays: ['2026-10-26', '2026-10-27'] });
  assert.equal(JSON.stringify(inbox.snapshot()).includes('usage'), false); inbox.close();
});

test('usage upgrades an existing cache without replacing identity and bounds recent history to 90 UTC days', async t => {
  const r = setup(t); let now = new Date('2026-01-01T10:00:00Z');
  const file = path.join(r.directory, 'inbox.json'); const before = r.create(); before.close();
  const identity = JSON.parse(fs.readFileSync(file, 'utf8')).installationId;
  const request = (async (_url, options) => { const body = JSON.parse(String(options?.body)); r.calls.push({ url: '', body }); return Response.json(feed()); }) as typeof fetch;
  for (let day = 0; day < 100; day++) { now = new Date(Date.UTC(2026, 0, 1 + day)); const inbox = new NotificationInbox({ directory: r.directory, version: '1', request, now: () => now }); await inbox.startup(); inbox.close(); }
  const sent = r.calls.at(-1)?.body;
  assert.equal(sent.installationId, identity); assert.equal(sent.usage.launches, 100); assert.equal(sent.usage.activeDays, 100); assert.equal(sent.usage.recentDays.length, 90); assert.equal(sent.usage.firstDay, '2026-01-01');
});
test('the versions the matrix tested after this build are handed to the doctor; a malformed list is ignored', async t => {
  const got: unknown[] = [];
  for (const tested of [{ claude: [], codex: ['0.164.0'], agy: ['1.4.8'] }, { codex: ['../x'] }, undefined]) {
    const r = setup(t, url => (url.endsWith('/startup') ? { ...feed(), ...(tested ? { tested } : {}) } : { ok: true }));
    const inbox = new NotificationInbox({ directory: r.directory, version: 'v', platform: 'darwin', request: (async (u: any, o: any) => Response.json({ ...feed(), ...(tested ? { tested } : {}) })) as typeof fetch, endpoint: 'https://notifications.invalid', onTested: x => got.push(x) });
    await inbox.startup(); inbox.close();
  }
  assert.deepEqual(got, [{ claude: [], codex: ['0.164.0'], agy: ['1.4.8'] }]);
});
