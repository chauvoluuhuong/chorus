// read_mail (task #10, step 9): a chat's Chorus mail. Without an id the unread messages, which are then read; with an id one message
// in full; with all the read ones too. Free, answered by chorus serve's mailbox through the route the paid tools use.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Mailbox, TurnWatch, type MailMessage } from '@chauvoluuhuong/chorus-core';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import { createServer, readMailText } from '../../src/mcp/server.ts';
import type { ProLoader } from '../../src/serve/pro.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const FAKE = path.resolve(import.meta.dirname, '../../tools/fake-agent/fake-tui.mjs');
const LOCKED: ProLoader = { dev: true, load: async () => ({ locked: 'no-licence', message: 'x' }), activate: async () => ({ locked: 'no-licence', message: 'x' }) };

type Send = Omit<MailMessage, 'id' | 'state' | 'tries' | 'created_at'>;
const report: Send = { from: { who: 'chat', thread: 't_sub', teammate: 'claude-worker-1', role: 'Worker' }, to: { thread: 't_main' }, kind: 'report', subject: 'Step 2 done', body: '**All** tests pass.\n\n- 12 passed', refs: { task: '10', step: '2', about: 't_sub' } };
const question: Send = { from: { who: 'chat', thread: 't_sub' }, to: { thread: 't_main' }, kind: 'question', subject: 'EUR or USD?', body: 'Which currency?', refs: { question: 'q_1' } };
const note: Send = { from: { who: 'chorus' }, to: { thread: 't_main' }, kind: 'reminder', subject: 'Your action is still open', body: 'Call it done when finished.', refs: { action: 's9' } };

function box() {
  let t = Date.parse('2026-11-18T08:00:00Z');
  const store = new Store(tmp('chorus-rm-'), { home: tmp('chorus-rm-h-') });
  const now = () => (t += 1000);
  const watch = new TurnWatch({ look: () => ({ state: 'working' }), store: store.watchStore(), now });
  const mail = new Mailbox({ store: store.mailStore(), watch, transports: {}, agentOf: () => 'claude', now });
  return { store, mail };
}

test('unread, then read: the unread ones are printed and marked read; the next call has none', () => {
  const { store, mail } = box();
  try {
    const a = mail.send(report);
    const b = mail.send(question);
    mail.send({ ...note, to: { thread: 't_other' } });
    const r = readMailText(mail, 't_main', {});
    assert.ok(!r.isError);
    assert.match(r.text, new RegExp(`### ${a} · report\\nFrom: thread t_sub \\(teammate "claude-worker-1", Worker\\)\\nSubject: Step 2 done\\nRefs: task 10, step 2, about t_sub\\n\\n\\*\\*All\\*\\* tests pass\\.\\n\\n- 12 passed`));
    assert.match(r.text, new RegExp(`### ${b} · question\\nFrom: thread t_sub\\nSubject: EUR or USD\\?\\nRefs: question q_1`));
    assert.ok(r.text.indexOf(a) < r.text.indexOf(b), 'oldest first');
    assert.doesNotMatch(r.text, /Your action is still open/, "another chat's mail");
    assert.equal(mail.get(a)!.state, 'read');
    assert.equal(mail.get(b)!.state, 'read');
    assert.equal(readMailText(mail, 't_main', {}).text, 'No unread messages.');
    // all: the read ones too, newest first
    const c = mail.send(note);
    const all = readMailText(mail, 't_main', { all: true }).text;
    assert.ok(all.indexOf(c) < all.indexOf(b) && all.indexOf(b) < all.indexOf(a), all);
    assert.match(all, /From: Chorus\nSubject: Your action is still open\nRefs: action s9/);
    assert.equal(mail.get(c)!.state, 'read', 'all reads the unread too');
  } finally {
    store.close();
  }
});

test('by id: that message in full, read; another chat\'s message or an unknown id is refused', () => {
  const { store, mail } = box();
  try {
    const a = mail.send(report);
    const b = mail.send(question);
    const r = readMailText(mail, 't_main', { id: b });
    assert.match(r.text, new RegExp(`^### ${b} · question`));
    assert.doesNotMatch(r.text, /Step 2 done/);
    assert.equal(mail.get(b)!.state, 'read');
    assert.equal(mail.get(a)!.state, 'queued', 'only that one');
    assert.match(readMailText(mail, 't_main', { id: b }).text, /EUR or USD/, 'a read message can be read again');
    assert.deepEqual(readMailText(mail, 't_other', { id: a }), { text: `No message ${a} for this chat.`, isError: true });
    assert.equal(readMailText(mail, 't_main', { id: 'm_nope' }).isError, true);
  } finally {
    store.close();
  }
});

test('read_mail through `chorus mcp` and chorus serve: the chat gets its unread mail, which is then read', async () => {
  const home = tmp('chorus-rm-sh-');
  process.env.CHORUS_SKILLS_HOME ??= home;
  const project = tmp('chorus-rm-sp-');
  const store = new Store(project, { home });
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (agent, l) => ({ bin: process.execPath, args: [FAKE, agent], cwd: l.cwd }) });
  const agents = [{ agent: 'claude', state: 'ready' }];
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), proLoader: LOCKED, check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents, ms: 1 }) as any, sessionExists: () => true });
  const url = await srv.start(0);
  try {
    const r = await fetch(`${url}/api/chats`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'claude', folder: project }) });
    const id = ((await r.json()) as { id: string }).id;
    const m = srv.mail.send({ ...report, to: { thread: id } });
    const server = createServer(project, id, home, { role: async () => undefined });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    const call = async (args: object) => (await client.callTool({ name: 'read_mail', arguments: args as Record<string, unknown> })) as { content: { text: string }[]; isError?: boolean };
    const first = await call({});
    assert.ok(!first.isError, first.content[0].text);
    assert.match(first.content[0].text, new RegExp(`### ${m} · report`));
    assert.equal(srv.mail.get(m)!.state, 'read');
    assert.equal((await call({})).content[0].text, 'No unread messages.');
    await client.close();
  } finally {
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await new Promise(r => setTimeout(r, 200));
    store.close();
  }
});
