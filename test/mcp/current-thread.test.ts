// current_thread (approved 2026-11-17): a chat's own context, live. The request_approval guards: a sub thread asks its main thread,
// and a chat writing a task's plan never asks the user to approve it. And `chorus mcp` finds its chat from the CLI process that
// started it (probe D, chorus-core 56b00d9), so two agy chats in one folder each reach their own thread.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, PLAN_REFUSAL, SUB_REFUSAL, WORKER_REFUSAL, type ThreadRole } from '../../src/mcp/server.ts';
import { ancestorPids, resolveThread } from '../../src/mcp/identity.ts';
import type { RoleInfo } from '../../src/mcp/pro.ts';
import { Store } from '../../src/core/store.ts';

function rig() {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-ct-')));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-ct-home-'));
  const store = new Store(project, { home });
  const roles = new Map<string, RoleInfo>();
  const connect = async (thread: string | undefined) => {
    const server = createServer(project, thread, home, { role: async (_h, t) => roles.get(t) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content[0].text, error: !!r.isError };
    };
    return { client, call };
  };
  return { project, home, store, roles, connect };
}

const planning = (state: string, actionId = 'createPlan'): ThreadRole => ({
  teammate: { id: 'planner', name: 'Planner', kind: 'planner' },
  instructions: 'Plan it.',
  actions: ['Create plan'],
  action: { id: actionId, label: 'Create plan', text: 'Create plan of task #3 "Export".' },
  task: { number: 3, title: 'Export', state, doneWhen: 'W' },
  step: null,
  goals: [],
});

test('current_thread: the chat, its parent and what it asked, its sub threads, role, artifacts, open requests and questions, live', async () => {
  const r = rig();
  const main = r.store.createThread({ title: 'Pricing page', agent: 'claude', cwd: r.project, project: r.project, model: 'opus', effort: 'high', skip_permissions: 1 });
  const sub = r.store.createThread({ title: 'Price list', agent: 'codex', cwd: r.project, project: r.project, parent_thread_id: main.id });
  r.store.setSub(sub.id, { sub_status: 'working', sub_brief: 'Make the price list.\nUse euros.', sub_started: new Date().toISOString(), sub_turns: 1 });
  r.store.updateThread(main.id, { cli_version: '2.1.400' });
  const doc = path.join(r.project, 'notes.md');
  fs.writeFileSync(doc, '# notes');
  r.store.reportArtifact(main.id, doc, 'Notes');
  r.store.createRequest({ threadId: main.id, question: 'Ship it?' });
  const ask = r.store.createAsk({ threadId: sub.id, parentId: main.id, kind: 'question', question: 'EUR or USD?', options: ['EUR', 'USD'] });
  r.roles.set(main.id, { role: planning('doing', 'planner'), readOnly: false });

  const m = await r.connect(main.id);
  let j = JSON.parse((await m.call('current_thread')).text);
  assert.deepEqual(
    { ...j.thread, created: undefined },
    { id: main.id, title: 'Pricing page', agent: 'claude', model: 'opus', effort: 'high', cli_version: '2.1.400', permissions: 'skip', state: main.state, project: r.project, cwd: r.project, created: undefined },
  );
  assert.equal(j.parent, null);
  assert.deepEqual(j.sub_threads.map((s: any) => [s.id, s.title, s.agent, s.status, s.turns]), [[sub.id, 'Price list', 'codex', 'working', 1]]);
  assert.equal(j.role.task.number, 3);
  assert.equal(j.role.action.id, 'planner');
  assert.deepEqual(j.artifacts, { count: 1, latest: { target: doc, title: 'Notes', ts: j.artifacts.latest.ts } });
  assert.deepEqual(j.open_requests.map((x: any) => [x.kind, x.question]), [['approval', 'Ship it?']]);
  assert.deepEqual(j.open_questions.map((x: any) => [x.id, x.from, x.question, x.options]), [[ask.id, sub.id, 'EUR or USD?', ['EUR', 'USD']]]);

  // live: a later change shows on the next call
  r.store.answerAsks(sub.id);
  r.roles.set(main.id, { role: planning('to_check', 'planner'), readOnly: true });
  j = JSON.parse((await m.call('current_thread')).text);
  assert.deepEqual(j.open_questions, []);
  assert.equal(j.role.task.state, 'to_check');
  assert.equal(j.thread.permissions, 'read-only');
  await m.client.close();

  // the sub thread: its parent and what it asked, its own open asks, no role without the bundle
  r.store.createAsk({ threadId: sub.id, parentId: main.id, kind: 'approval', question: 'Delete the old list?' });
  const s = await r.connect(sub.id);
  j = JSON.parse((await s.call('current_thread')).text);
  assert.deepEqual(j.parent, { id: main.id, title: 'Pricing page', agent: 'claude', asked: 'Make the price list.\nUse euros.' });
  assert.equal(j.role, null);
  assert.equal(j.thread.permissions, 'prompts');
  assert.deepEqual(j.open_questions.map((x: any) => [x.kind, x.question, x.to]), [['approval', 'Delete the old list?', main.id]]);
  await s.client.close();

  // no thread: an error
  const none = await r.connect(undefined);
  assert.equal((await none.call('current_thread')).error, true);
  await none.client.close();
  r.store.close();
});

test('request_approval: a sub thread is refused and pointed to its main thread; a step Worker is pointed to its Planner', async () => {
  const r = rig();
  const main = r.store.createThread({ title: 'Main', agent: 'claude', cwd: r.project });
  const sub = r.store.createThread({ title: 'Sub', agent: 'claude', cwd: r.project, parent_thread_id: main.id });
  r.store.setSub(sub.id, { sub_status: 'working', sub_brief: 'x' });
  const s = await r.connect(sub.id);
  const out = await s.call('request_approval', { question: 'Which colour?', kind: 'question' });
  assert.deepEqual(out, { text: SUB_REFUSAL, error: true });
  assert.equal(r.store.pendingRequests(sub.id).length, 0, 'nothing for Approvals');
  await s.client.close();
  const step = r.store.createThread({ title: 'Step', agent: 'claude', cwd: r.project, parent_thread_id: main.id });
  r.store.setSub(step.id, { sub_status: 'task' as any });
  const w = await r.connect(step.id);
  assert.deepEqual(await w.call('request_approval', { question: 'Run the migration?' }), { text: WORKER_REFUSAL, error: true });
  assert.equal(r.store.pendingRequests(step.id).length, 0, 'nothing for Approvals from a Worker');
  await w.client.close();
  r.store.close();
});

test('request_approval: refused for plan approval while the plan is being written; allowed for design questions, once ready, and without the bundle', async () => {
  const r = rig();
  const t = r.store.createThread({ title: 'Planner', agent: 'claude', cwd: r.project });
  const c = await r.connect(t.id);
  r.roles.set(t.id, { role: planning('planning') });
  // an approval (the default kind) while planning
  assert.deepEqual(await c.call('request_approval', { question: 'Does this look right?' }), { text: PLAN_REFUSAL, error: true });
  // a question that asks to approve the plan
  assert.deepEqual(await c.call('request_approval', { question: 'Do you approve the plan?', kind: 'question' }), { text: PLAN_REFUSAL, error: true });
  assert.equal(r.store.pendingRequests(t.id).length, 0);
  // a design question it needs to write the plan
  assert.equal((await c.call('request_approval', { question: 'Postgres or SQLite?', kind: 'question', options: ['Postgres', 'SQLite'] })).error, false);
  // once the plan is approved ('ready'), an approval is fine again
  r.roles.set(t.id, { role: planning('ready') });
  assert.equal((await c.call('request_approval', { question: 'Delete the old export files?' })).error, false);
  // another action than Create plan
  r.roles.set(t.id, { role: planning('planning', 'reviewChanges') });
  assert.equal((await c.call('request_approval', { question: 'Approve the plan?' })).error, false);
  // no bundle: no role, no guard
  r.roles.delete(t.id);
  assert.equal((await c.call('request_approval', { question: 'Approve the plan?' })).error, false);
  await c.client.close();
  r.store.close();
});

test('chat identity: the nearest ancestor that is a live chat\'s CLI, else --thread; two chats in one folder each resolve to their own', () => {
  const r = rig();
  const a = r.store.createThread({ title: 'agy 1', agent: 'agy', cwd: r.project, state: 'working' });
  const b = r.store.createThread({ title: 'agy 2', agent: 'agy', cwd: r.project, state: 'working' });
  r.store.setCliPid(a.id, 5001);
  r.store.setCliPid(b.id, 5002);
  // both servers were started from the shared .agents/mcp_config.json, written last by chat b: --thread says b for both
  assert.equal(resolveThread(r.store, b.id, [7001, 5001, 400, 1]), a.id, 'the server under chat a is a\'s');
  assert.equal(resolveThread(r.store, b.id, [7002, 5002, 400, 1]), b.id);
  assert.equal(resolveThread(r.store, 't_given', [9, 8, 1]), 't_given', 'no match: --thread');
  assert.equal(resolveThread(r.store, undefined, [9]), undefined, 'an AI app with no chat');
  // an ended chat's pid is cleared, and a chat that ended is never matched
  r.store.setCliPid(a.id, null);
  assert.equal(resolveThread(r.store, 't_given', [5001]), 't_given');
  r.store.setCliPid(a.id, 5001);
  r.store.updateThread(a.id, { state: 'ended' });
  assert.equal(resolveThread(r.store, 't_given', [5001]), 't_given');
  r.store.close();
});

test('ancestorPids walks the process table upward, nearest first, and stops at a loop or init', () => {
  const ps = ' 1 0\n 400 1\n 5001 400\n 7001 5001\n 8000 7001\n';
  assert.deepEqual(ancestorPids(8000, () => ps), [7001, 5001, 400]);
  assert.deepEqual(ancestorPids(3, () => '3 4\n4 3\n'), [4, 3]);
  assert.deepEqual(ancestorPids(1, () => ''), []);
  // the real table: this process's parent is among them
  assert.equal(ancestorPids(process.pid)[0], process.ppid);
});
