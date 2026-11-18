// A chat's `chorus mcp` finds its serve through its launch env, and a second `chorus serve` on the same home can't break the first
// (task #14): on 2026-11-18 a second serve overwrote serve.json and deleted it when it closed, and every Claude chat lost its channel.
// Also the store's new mail columns (route, typed_at, attempts) and the watch's due clock.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { WatchState } from '@chauvoluuhuong/chorus-core';
import { Controller } from '../../src/app/controller.ts';
import { buildInteractive } from '../../src/core/launch.ts';
import { Store } from '../../src/core/store.ts';
import type { AgentId } from '../../src/core/types.ts';
import { MCP_TOKEN_ENV, SERVE_URL_ENV, serveInfo } from '../../src/mcp/pro.ts';
import { ChatLaunch, type ProLoader } from '../../src/serve/pro.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';

const LOCKED: ProLoader = { dev: true, load: async () => ({ locked: 'no-licence', message: 'No licence on this computer.' }), activate: async () => ({ locked: 'no-licence', message: 'x' }) };
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

async function serve(home: string, chatLaunch?: ChatLaunch) {
  const project = tmp('chorus-env-p-');
  const store = new Store(project, { home });
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (_agent, l) => ({ bin: process.execPath, args: ['-e', ''], cwd: l.cwd }) });
  const srv = new ChorusServer({ controller: c, token: 'b'.repeat(48), proLoader: LOCKED, chatLaunch, check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }) as any });
  const url = await srv.start(0);
  return { srv, url, store, c, close: () => (srv.close(), c.stop(), store.close()) };
}
const fileOf = (home: string) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'serve.json'), 'utf8')) as { url: string; mcpToken: string };
  } catch {
    return undefined;
  }
};

test('the chat launch env carries serve\'s address and token, never on the command line', async () => {
  const home = tmp('chorus-env-h-');
  const launch = new ChatLaunch();
  const a = await serve(home, launch);
  try {
    for (const agent of ['claude', 'codex', 'agy'] as AgentId[]) {
      const cwd = tmp('chorus-env-c-');
      const o = { cwd, project: cwd, threadId: `t-${agent}` };
      const l = buildInteractive(agent, { ...o, ...launch.extras(o, agent) });
      assert.equal(l.env?.[SERVE_URL_ENV], a.url, agent);
      assert.equal(l.env?.[MCP_TOKEN_ENV], a.srv.mcpToken, agent);
      assert.ok(!l.args.join(' ').includes(a.srv.mcpToken), `${agent}: no token in args`);
      // Codex does not hand its env to the MCP server: the names are forwarded (typein-probe F2)
      if (agent === 'codex') assert.ok(l.args.includes(`mcp_servers.chorus.env_vars=["${SERVE_URL_ENV}","${MCP_TOKEN_ENV}"]`));
    }
  } finally {
    a.close();
  }
});

test('serveInfo prefers the launch env, then serve.json', () => {
  const home = tmp('chorus-env-h-');
  fs.writeFileSync(path.join(home, 'serve.json'), JSON.stringify({ url: 'http://127.0.0.1:1', mcpToken: 'file' }));
  assert.deepEqual(serveInfo(home, { [SERVE_URL_ENV]: 'http://127.0.0.1:2', [MCP_TOKEN_ENV]: 'env' }), { url: 'http://127.0.0.1:2', mcpToken: 'env' });
  assert.equal(serveInfo(home, {})?.mcpToken, 'file');
  assert.equal(serveInfo(home, { [SERVE_URL_ENV]: 'http://127.0.0.1:2' })?.mcpToken, 'file', 'half an env is not enough');
  assert.equal(serveInfo(tmp('chorus-env-none-'), {}), undefined);
});

test('a second serve on the same home keeps the first one\'s serve.json, on start and on close', async () => {
  const home = tmp('chorus-env-two-');
  const a = await serve(home);
  const first = fileOf(home);
  assert.equal(first?.url, a.url);
  const b = await serve(home);
  try {
    assert.notEqual(b.url, a.url);
    assert.deepEqual(fileOf(home), first, 'not overwritten on start');
    b.close();
    assert.deepEqual(fileOf(home), first, 'not deleted when the second closes');
    const h = await fetch(`${a.url}/api/pro/mcp/health`, { headers: { authorization: `Bearer ${a.srv.mcpToken}`, 'x-chorus': '1' } });
    assert.equal(((await h.json()) as { home: string }).home, home);
  } finally {
    a.close();
  }
  assert.equal(fileOf(home), undefined, 'the first removes its own file when it closes');
  // a stale file (its serve is gone) is taken over
  fs.writeFileSync(path.join(home, 'serve.json'), JSON.stringify({ url: 'http://127.0.0.1:9', mcpToken: 'x' }));
  const c = await serve(home);
  try {
    assert.equal(fileOf(home)?.url, c.url);
  } finally {
    c.close();
  }
});

test('the migration keeps old mail rows; route, typed_at and attempts round-trip', () => {
  const home = tmp('chorus-env-mig-');
  const old = new DatabaseSync(path.join(home, 'chorus.db'));
  old.exec(`CREATE TABLE mail (
    id TEXT PRIMARY KEY, from_thread TEXT, from_json TEXT NOT NULL, to_thread TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL,
    body TEXT NOT NULL, refs TEXT NOT NULL DEFAULT '{}', meta TEXT, state TEXT NOT NULL, channel TEXT, tries INTEGER NOT NULL DEFAULT 0,
    error TEXT, created_at TEXT NOT NULL, delivered_at TEXT, read_at TEXT, answered_at TEXT)`);
  old.prepare(`INSERT INTO mail (id, from_json, to_thread, kind, subject, body, state, created_at) VALUES ('m_old', '{"who":"chorus"}', 't1', 'note', 's', 'b', 'queued', '2026-11-18T10:35:00.000Z')`).run();
  old.close();
  const store = new Store(tmp('chorus-env-mig-p-'), { home });
  try {
    const mail = store.mailStore();
    const m = mail.get('m_old')!;
    assert.equal(m.state, 'queued');
    assert.equal(m.route, undefined);
    assert.equal(m.typed_at, undefined);
    assert.equal(m.attempts, undefined);
    mail.update('m_old', { route: 'typed', typed_at: '2026-11-18T10:40:00.000Z', attempts: [{ at: '2026-11-18T10:40:00.000Z', route: 'typed', result: 'typed' }] });
    const n = mail.get('m_old')!;
    assert.equal(n.route, 'typed');
    assert.equal(n.typed_at, '2026-11-18T10:40:00.000Z');
    assert.deepEqual(n.attempts, [{ at: '2026-11-18T10:40:00.000Z', route: 'typed', result: 'typed' }]);
    mail.update('m_old', { typed_at: undefined });
    assert.equal(mail.get('m_old')!.typed_at, undefined, 'cleared');
  } finally {
    store.close();
  }
});

test('a watch with a due clock is read back with the same clock', () => {
  const home = tmp('chorus-env-w-');
  const store = new Store(tmp('chorus-env-w-p-'), { home });
  try {
    const ws = store.watchStore();
    const s: WatchState = { key: 'deliver:m_1', thread: 't', belongsTo: 'm', kind: 'mail', owner: 'mailbox', expect: 'x', data: { stage: 'type' }, created_at: 5, dueMs: 180_000, dueFrom: 10, duePaused: 3_000, duePausedAt: 20, dueFired: false };
    ws.save(s);
    const back = ws.load().find(x => x.key === 'deliver:m_1')!;
    assert.deepEqual([back.dueMs, back.dueFrom, back.duePaused, back.duePausedAt, back.dueFired, back.data], [180_000, 10, 3_000, 20, false, { stage: 'type' }]);
  } finally {
    store.close();
  }
});
