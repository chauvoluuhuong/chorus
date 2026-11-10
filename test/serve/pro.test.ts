// The optional module's seam with a stand-in module: what the page and `chorus mcp` see locked and unlocked.
import { versions } from '../../src/core/doctor.ts';
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
import { sourceDir, syncSkills } from '../../src/core/skills.ts';
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

test('the loader is told the app\'s version, so a preview gets the preview paid build', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pro-p-'));
  const store = new Store(project, { home: fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pro-')) });
  let seen: ProCtx | undefined;
  const proLoader: ProLoader = { dev: false, load: async c => ((seen = c), LOCKED), activate: async () => LOCKED };
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (_a, o) => ({ bin: process.execPath, args: [], cwd: o.cwd }) });
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }), proLoader });
  await srv.start(0);
  await new Promise(x => setTimeout(x, 20));
  try {
    assert.equal(seen?.appVersion, versions().chorus);
    assert.match(seen?.appVersion ?? '', /^\d+\.\d+\.\d+/);
  } finally {
    srv.close(); c.stop(); store.close();
  }
});

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

test('syncSkills `only` links just those skills', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-skills-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-skills-p-'));
  const src = sourceDir(project);
  for (const s of ['one', 'two', 'three']) {
    fs.mkdirSync(path.join(src, s), { recursive: true });
    fs.writeFileSync(path.join(src, s, 'SKILL.md'), `---\nname: ${s}\ndescription: d\n---\nbody\n`);
  }
  syncSkills(project, { agents: ['claude'], only: ['one', 'three'], into: home });
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude/skills')).sort(), ['one', 'three']);
});

test('a chat the module resumes while it starts gets its tools', async () => {
  const { ProHost } = await import('../../src/serve/pro.ts');
  let seen: string[] = [];
  let host!: InstanceType<typeof ProHost>;
  let starting = true;
  // like the real module: its start resumes chats, and a resumed chat asks for the tools before `use` has them
  const mod: ProModule = { ...stand, mcpTools: c => { if (starting) { starting = false; seen = host.toolNames(); } return stand.mcpTools(c); } };
  host = new ProHost({} as ProCtx, () => {}, { dev: true, load: async () => mod, activate: async () => mod });
  await host.start();
  assert.deepEqual(seen, ['stand_in']);
});

test('Try Pro: the sign-up page opens in the browser, comes back once with a code, and the app hears it (plan stage 6)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pro-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pro-p-'));
  const store = new Store(project, { home });
  const codes: string[] = [];
  const trial = { ...stand, entitled: { plan: 'trial', locked: [], ends: '2026-11-18T00:00:00.000Z' } };
  const proLoader: ProLoader = {
    dev: false, load: async () => LOCKED, activate: async () => LOCKED,
    signIn: async (_c, code) => (codes.push(code), code === 'good-code' ? trial : { locked: 'unknown-key', message: 'This sign-in has expired.' }),
    links: () => ({ tryUrl: 'https://chorus-cli.web.app/try', plansUrl: '' }),
  };
  const opened: string[] = [];
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (_a, o) => ({ bin: process.execPath, args: [], cwd: o.cwd }) });
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }), proLoader, openLink: u => opened.push(u) });
  const url = await srv.start(0);
  try {
    const t = await (await fetch(`${url}/api/pro/try`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1' } })).json();
    assert.equal(opened.length, 1);
    const sent = new URL(opened[0]);
    assert.equal(sent.origin + sent.pathname, 'https://chorus-cli.web.app/try');
    assert.equal(sent.searchParams.get('port'), new URL(url).port, 'the page knows where to come back');
    const state = sent.searchParams.get('state')!;
    assert.equal(t.url, opened[0]);
    // no token on the way back (another browser): a wrong state is refused, the right one works once
    assert.equal((await fetch(`${url}/api/pro/signed-in?code=good-code&state=made-up-state-123456`)).status, 403);
    const back = await fetch(`${url}/api/pro/signed-in?code=good-code&state=${state}`);
    assert.equal(back.status, 200);
    assert.match(await back.text(), /You're signed in/);
    assert.deepEqual(codes, ['good-code']);
    assert.equal((await fetch(`${url}/api/pro/signed-in?code=good-code&state=${state}`)).status, 403, 'once');
    const st = await (await fetch(`${url}/api/pro/status`, { headers: { authorization: `Bearer ${srv.token}` } })).json();
    assert.deepEqual([st.unlocked, st.plan, st.ends], [true, 'trial', '2026-11-18T00:00:00.000Z']);
  } finally {
    srv.close();
    c.stop();
    store.close();
  }
});

test('Upgrade on an account that already paid takes the paid licence at once, so the app stops offering Upgrade (2026-11-10)', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pro-p-'));
  const store = new Store(project, { home: fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pro-')) });
  const trial = { ...stand, entitled: { plan: 'trial', locked: [], ends: '2026-11-18T00:00:00.000Z' } };
  const pro = { ...stand, entitled: { plan: 'pro', locked: [] } };
  let rechecked = 0;
  // the app started on the trial licence it had saved; the server already has the payment
  const proLoader: ProLoader = { dev: false, load: async () => trial, activate: async () => LOCKED, upgrade: async () => ({ url: 'https://pay.example/pay/checkout?a=ann', pro: true }), recheck: async () => (rechecked++, pro) };
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (_a, o) => ({ bin: process.execPath, args: [], cwd: o.cwd }) });
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }), proLoader, openLink: () => {} });
  const url = await srv.start(0);
  const call = async (method: string, route: string) => (await fetch(`${url}/api/pro/${route}`, { method, headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1' } })).json();
  try {
    assert.equal((await call('GET', 'status')).plan, 'trial');
    assert.equal((await call('POST', 'upgrade')).pro, true);
    assert.equal(rechecked, 1, 'the server was asked for the paid licence');
    assert.equal((await call('GET', 'status')).plan, 'pro');
  } finally {
    srv.close();
    c.stop();
    store.close();
  }
});

test('Upgrade: the payment page opens in the browser; the way back and Check again ask the server, which alone makes it Pro (plan stage 8)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pro-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pro-p-'));
  const store = new Store(project, { home });
  const trial = { ...stand, entitled: { plan: 'trial', locked: [], ends: '2026-11-18T00:00:00.000Z' } };
  const pro = { ...stand, entitled: { plan: 'pro', locked: [] } };
  const server = { paid: false, down: false, ports: [] as (number | undefined)[] };
  const proLoader: ProLoader = {
    dev: false, load: async () => trial, activate: async () => LOCKED,
    upgrade: async (_c, port) => (server.ports.push(port), { url: 'https://pay.example/pay/checkout?a=ann' }),
    recheck: async () => (server.down ? { locked: 'unreachable', message: 'offline' } : server.paid ? pro : trial),
  };
  const opened: string[] = [];
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (_a, o) => ({ bin: process.execPath, args: [], cwd: o.cwd }) });
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }), proLoader, openLink: u => opened.push(u) });
  const url = await srv.start(0);
  const post = async (route: string) => (await fetch(`${url}/api/pro/${route}`, { method: 'POST', headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1' } })).json();
  try {
    assert.equal((await post('upgrade')).url, 'https://pay.example/pay/checkout?a=ann');
    assert.deepEqual(opened, ['https://pay.example/pay/checkout?a=ann']);
    assert.deepEqual(server.ports, [Number(new URL(url).port)], 'the payment page can link back to this app');
    // not paid yet: Check again keeps the trial
    assert.equal((await post('recheck')).plan, 'trial');
    // offline: what runs keeps running
    server.down = true;
    const off = await post('recheck');
    assert.deepEqual([off.unlocked, off.plan, off.message], [true, 'trial', 'offline']);
    server.down = false;
    // paid: the browser comes back with no token; the page asks the server and says what it answered
    server.paid = true;
    const back = await fetch(`${url}/api/pro/paid`);
    assert.match(await back.text(), /You have Chorus Pro/);
    const st = await (await fetch(`${url}/api/pro/status`, { headers: { authorization: `Bearer ${srv.token}` } })).json();
    assert.equal(st.plan, 'pro');
  } finally {
    srv.close();
    c.stop();
    store.close();
  }
});

test('plan box: the status names the signed-in email, and Buy Pro signs in on the way to payment (plan 2026-11-09)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pro-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-pro-p-'));
  const store = new Store(project, { home });
  const trial = { ...stand, entitled: { plan: 'trial', locked: [], ends: '2026-11-18T00:00:00.000Z' } };
  const proLoader: ProLoader = { dev: false, load: async () => trial, activate: async () => LOCKED, account: () => ({ email: 'ann@example.com' }), links: () => ({ tryUrl: 'https://chorus-cli.web.app/try', plansUrl: '' }) };
  const opened: string[] = [];
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (_a, o) => ({ bin: process.execPath, args: [], cwd: o.cwd }) });
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }), proLoader, openLink: u => opened.push(u) });
  const url = await srv.start(0);
  const h = { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' };
  try {
    const st = await (await fetch(`${url}/api/pro/status`, { headers: h })).json();
    assert.deepEqual([st.plan, st.email], ['trial', 'ann@example.com']);
    await fetch(`${url}/api/pro/try`, { method: 'POST', headers: h, body: JSON.stringify({ then: 'upgrade' }) });
    await fetch(`${url}/api/pro/try`, { method: 'POST', headers: h });
    assert.deepEqual(opened.map(u => new URL(u).searchParams.get('then')), ['upgrade', null]);
  } finally {
    srv.close();
    c.stop();
    store.close();
  }
});

/* ---------- stage 7: requests through the private link go to the module ---------- */

const remoteStand: ProModule = {
  ...stand,
  remote: (_c, req) => {
    const ok = String(req.headers.cookie ?? '').includes('chorus_device=ok');
    if (req.url.startsWith('/mcp')) return { answer: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ got: req.body?.toString() }) } };
    return ok ? { pass: true, origins: ['https://mac.tail.ts.net'], device: 'd1' } : { answer: { status: 401, headers: { 'content-type': 'text/plain' }, body: 'pair first' } };
  },
  appTools: () => [{ name: 'chorus_projects', description: 'app', inputSchema: { type: 'object', properties: {} }, handler: () => 'p1' }],
};

test('a request through a proxy never uses the token: only the module lets a device in, and from its own origin', async () => {
  const r = await rig(remoteStand);
  await new Promise(x => setTimeout(x, 20));
  const url = r.srv.url;
  const via = (p: string, h: Record<string, string> = {}, method = 'GET', body?: string) => fetch(url + p, { method, headers: { 'x-forwarded-for': '100.64.0.2', host: 'mac.tail.ts.net', ...h }, body });
  // the window's token is no key here
  const t = await via('/api/state', { authorization: `Bearer ${r.srv.token}` });
  assert.equal(t.status, 401);
  assert.equal(await t.text(), 'pair first');
  assert.equal((await via('/api/state', { cookie: 'chorus_device=ok' })).status, 200);
  assert.equal((await via('/api/approvals', { cookie: 'chorus_device=ok', 'x-chorus': '1', origin: 'https://evil.example' }, 'POST', '{}')).status, 403);
  assert.equal((await via('/api/pro/remote', { cookie: 'chorus_device=ok', 'x-chorus': '1', origin: 'https://mac.tail.ts.net', 'content-type': 'application/json' }, 'POST', '{"do":"allow"}')).status, 403, 'devices are allowed on the Mac only');
  const m = await via('/mcp', { 'content-type': 'application/json' }, 'POST', '{"jsonrpc":"2.0"}');
  assert.deepEqual(await m.json(), { got: '{"jsonrpc":"2.0"}' });
  // the window on this Mac is as before
  assert.equal((await r.api('GET', '/api/state')).status, 200);
  // an AI app with no chat gets the app's tools
  const tools = await (await fetch(`${url}/api/pro/mcp/tools?app=1`, { headers: { authorization: `Bearer ${JSON.parse(fs.readFileSync(path.join(r.home, 'serve.json'), 'utf8')).mcpToken}` } })).json();
  assert.deepEqual(tools.tools.map((x: any) => x.name), ['chorus_projects']);
  r.close();
});

test('with no module, nothing answers through a proxy', async () => {
  const r = await rig();
  await new Promise(x => setTimeout(x, 20));
  const res = await fetch(r.srv.url + '/', { headers: { 'x-forwarded-for': '100.64.0.2', cookie: 'chorus_device=ok' } });
  assert.equal(res.status, 404);
  r.close();
});
