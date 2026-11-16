// Proof harness for "Approvals say who is asking" and "counts flash when they grow": chorus serve with fake agents, two
// chats that wait on you (a question and a permission prompt), and one more question each time the file <dir>/more appears.
//   node test/smoke/proof-approvals-count.ts <dir>     prints the page's address; stop it with Ctrl-C
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import type { AgentId } from '../../src/core/types.ts';
import type { FastReport } from '@chauvoluuhuong/chorus-core/doctor';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-tui.mjs');
const PROMPT = path.join(ROOT, 'fixtures/codex/0.163.0/approval-ask-nohook-enter/prompt-screen.txt');
const dir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-proof-'));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const fast = { node: { version: '22', ok: true }, platform: 'test', agents: (['claude', 'codex', 'agy'] as AgentId[]).map(agent => ({ agent, name: agent, state: 'ready', login: 'yes', version: '1.0.0', page: '' })), ms: 1 } as unknown as FastReport;

process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-home-'));
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shop-')));
const store = new Store(project);
const c = new Controller({ project, store, stillMs: 300, app: headlessApp(), tailPollMs: 100, opener: async () => ({ ok: true }), launcher: (agent, o) => ({ bin: process.execPath, args: [FAKE, agent], cwd: o.cwd }) });
c.restore();
const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), check: async () => fast });
const url = await srv.start(0);
const api = async (p: string, body: object) => (await (await fetch(url + p, { method: 'POST', headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as any;

const a = (await api('/api/chats', { agent: 'codex', folder: project, title: 'fix the sign-in page' })).id as string;
const b = (await api('/api/chats', { agent: 'codex', folder: project, title: 'add CSV export' })).id as string;
await sleep(2500);
store.createRequest({ threadId: a, question: 'Which table holds the sessions?', options: ['sessions', 'logins'], kind: 'question' });
c.app.entry(b)!.host!.write(`show ${PROMPT}\r`);
console.log(`PAGE ${url}/?token=${srv.token}`);
for (let n = 1; ; ) {
  await sleep(400);
  if (!fs.existsSync(path.join(dir, 'more'))) continue;
  fs.rmSync(path.join(dir, 'more'));
  store.createRequest({ threadId: a, question: `One more question (${n++})?`, options: ['yes', 'no'], kind: 'approval' });
  console.log('added one');
}
