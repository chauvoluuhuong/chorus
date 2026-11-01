// The optional module's seam with a stand-in module: what the page and `chorus mcp` see locked and unlocked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LoadResult, ProCtx, ProModule } from '@chauvoluuhuong/chorus-core/pro-loader';
import { Controller } from '../../src/app/controller.ts';
import { createServer } from '../../src/mcp/server.ts';
import { Store } from '../../src/core/store.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import type { ProLoader } from '../../src/serve/pro.ts';

const stand: ProModule = {
  version: 'stand-in',
  routes: () => ({ 'GET ping': () => ({ pong: 1 }) }),
  mcpTools: () => [{ name: 'stand_in', description: 'test', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, handler: (a, f) => `hi ${String(a.name)} ${f.threadId}` }],
  ui: () => ({ js: 'window.choruspro={render(){}}', css: 'a{}' }),
  onChatEvent() {},
  dispose() {},
};
const LOCKED = { locked: 'no-licence', message: 'No licence on this computer.' } as const;

async function rig(first: LoadResult = LOCKED) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pro-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pro-p-'));
  const store = new Store(project, { home });
  let changed: (r: LoadResult) => void = () => {};
  const proLoader: ProLoader = { dev: true, load: async (_c: ProCtx, on) => ((changed = on), first), activate: async (_c, key) => (key === 'good' ? stand : { locked: 'unknown-key', message: 'That key is not valid.' }) };
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (_a, o) => ({ bin: process.execPath, args: [], cwd: o.cwd }) });
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }), proLoader });
  const url = await srv.start(0);
  const api = async (method: string, p: string, body?: object, token = srv.token) => {
    const r = await fetch(url + p, { method, headers: { authorization: `Bearer ${token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, json: text.startsWith('{') ? JSON.parse(text) : undefined };
  };
  const tools = async () => {
    const server = createServer(project, 't_1', home);
    await server.addProTools();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    return client;
  };
  return { srv, api, tools, home, project, change: (r: LoadResult) => changed(r), close: () => (srv.close(), c.stop(), store.close()) };
}

test('locked: status says why, the module\'s addresses answer 402, no tools', async () => {
  const r = await rig();
  await new Promise(x => setTimeout(x, 20));
  const s = await r.api('GET', '/api/pro/status');
  assert.deepEqual(s.json, { unlocked: false, dev: true, reason: 'no-licence', message: 'No licence on this computer.' });
  for (const p of ['/api/pro/ping', '/api/pro/ui.js', '/api/pro/ui.css']) assert.equal((await r.api('GET', p)).status, 402, p);
  const list = await (await r.tools()).listTools();
  assert.equal(list.tools.some(t => t.name === 'stand_in'), false);
  assert.ok(list.tools.some(t => t.name === 'list_threads'), 'the usual tools stay');
  r.close();
});

test('unlocked after Unlock: route, screen and a forwarded tool with its schema', async () => {
  const r = await rig();
  assert.equal((await r.api('POST', '/api/pro/activate', { key: 'bad' })).json.reason, 'unknown-key');
  assert.equal((await r.api('POST', '/api/pro/activate', { key: 'good' })).json.unlocked, true);
  assert.deepEqual((await r.api('GET', '/api/pro/ping')).json, { pong: 1 });
  assert.equal((await r.api('GET', '/api/pro/none')).status, 404);
  assert.match((await r.api('GET', '/api/pro/ui.js')).text, /choruspro/);
  const client = await r.tools();
  const t = (await client.listTools()).tools.find(x => x.name === 'stand_in')!;
  assert.deepEqual((t.inputSchema as { required: string[] }).required, ['name']);
  const out = await client.callTool({ name: 'stand_in', arguments: { name: 'Ann' } });
  assert.deepEqual(out.content, [{ type: 'text', text: 'hi Ann t_1' }]);
  r.close();
});

test('a refresh that locks: routes close at once, and a chat already open gets a clear error', async () => {
  const r = await rig(stand);
  await new Promise(x => setTimeout(x, 20));
  const client = await r.tools();
  r.change({ locked: 'revoked', message: 'This licence was revoked.' });
  assert.equal((await r.api('GET', '/api/pro/ping')).status, 402);
  const out = await client.callTool({ name: 'stand_in', arguments: { name: 'Ann' } });
  assert.equal(out.isError, true);
  r.close();
});

test('serve.json is 0600, its token opens only the tool routes, and it goes when serve stops', async () => {
  const r = await rig(stand);
  const f = path.join(r.home, 'serve.json');
  assert.equal((fs.statSync(f).mode & 0o777).toString(8), '600');
  const { mcpToken } = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal((await r.api('GET', '/api/pro/mcp/tools', undefined, mcpToken)).status, 200);
  assert.equal((await r.api('GET', '/api/state', undefined, mcpToken)).status, 401);
  assert.equal((await r.api('GET', '/api/pro/status', undefined, mcpToken)).status, 401);
  r.close();
  assert.equal(fs.existsSync(f), false);
});

test('serve gone: chat tools are the usual ones', async () => {
  const r = await rig(stand);
  r.close();
  fs.writeFileSync(path.join(r.home, 'serve.json'), JSON.stringify({ url: 'http://127.0.0.1:9', mcpToken: 'x' }));
  const list = await (await r.tools()).listTools();
  assert.equal(list.tools.some(t => t.name === 'stand_in'), false);
});
