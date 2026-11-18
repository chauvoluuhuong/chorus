// A Chorus serve with fake CLIs for the project tools' tests (task #11 step 8): chats that really run, the tools called through
// `chorus mcp` (createServer) and the serve route, and stand-ins for the CLI's live folder add.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { LoadResult, ProModule } from '@chauvoluuhuong/chorus-core/pro-loader';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import { createServer } from '../../src/mcp/server.ts';
import type { ProLoader } from '../../src/serve/pro.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';

export const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const FAKE = path.resolve(import.meta.dirname, '../../tools/fake-agent/fake-tui.mjs');

export const fakePro = (o: Partial<ProModule> = {}): ProModule => ({ version: 'stand-in', routes: () => ({}), mcpTools: () => [], ui: () => ({ js: '', css: '' }), onChatEvent() {}, dispose() {}, ...o }) as ProModule;

export async function rig(o: { pro?: ProModule; layout?: (parent: string, project: string) => void } = {}) {
  const home = tmp('chorus-pt-h-');
  process.env.CHORUS_SKILLS_HOME ??= home;
  const parent = tmp('chorus-pt-p-');
  const project = path.join(parent, 'shop');
  fs.mkdirSync(project);
  o.layout?.(parent, project);
  const store = new Store(project, { home });
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (agent, l) => ({ bin: process.execPath, args: [FAKE, agent], cwd: l.cwd }) });
  const proLoader: ProLoader = { dev: true, load: async () => (o.pro ?? { locked: 'no-licence', message: 'none' }) as LoadResult, activate: async () => ({ locked: 'no-licence', message: 'none' }) };
  const agents = [{ agent: 'claude', state: 'ready' }, { agent: 'codex', state: 'ready' }];
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), proLoader, check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents, ms: 1 }) as any, sessionExists: () => true });
  const url = await srv.start(0);
  const events: any[] = [];
  const bc = (srv as any).broadcast.bind(srv);
  (srv as any).broadcast = (m: any) => (events.push(m), bc(m));
  // the CLI's live add of a folder: a stand-in that always works; the runtime sees every chat idle and nobody typing
  const live: [string, string][] = [];
  const d = (srv.projects as any).d;
  d.liveAdd = async (id: string, _agent: string, dir: string) => (live.push([id, dir]), true);
  d.idle = () => true;
  d.typing = () => false;
  const restarts: string[] = [];
  d.restart = (id: string) => void restarts.push(id);
  const api = async (method: string, p: string, body?: object) => {
    const res = await fetch(url + p, { method, headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : undefined };
  };
  /** a running chat in the project; `launched`: what Chorus started it with (the launcher's report, as ChatLaunch gives it) */
  const newChat = async (agent = 'claude', folder = project) => {
    const id = (await api('POST', '/api/chats', { agent, folder })).json.id as string;
    srv.projects.launched(id, folder, srv.projectSettings.addDirs(folder), srv.projectSettings.env(folder));
    return id;
  };
  const clients: Client[] = [];
  const mcp = async (threadId: string) => {
    const server = createServer(project, threadId, home, { role: async () => undefined });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    clients.push(client);
    return async (name: string, args: object = {}) => {
      const r = (await client.callTool({ name, arguments: args as Record<string, unknown> })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0]?.text ?? '', isError: !!r.isError };
    };
  };
  const until = async (fn: () => boolean, what: string, ms = 5000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error(`timed out: ${what}`);
      await new Promise(r => setTimeout(r, 25));
    }
  };
  const done = async () => {
    for (const cl of clients) await cl.close().catch(() => {});
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await new Promise(r => setTimeout(r, 200));
    store.close();
  };
  return { home, parent, project, store, c, srv, api, newChat, mcp, until, done, events, live, restarts };
}
