// Typing a message into a chat (Enter in its terminal) closes that chat's open cards: its request_approval cards are cancelled and
// the module hears { type: 'typed' } to close its own (the "Start <action>?" suggestion, the goal question). Shift+Enter writes the
// CLI's new-line bytes (NEWLINE_KEYS) and is not sending. Also ProCtx.threadKind: main chat, sub thread or a step's Worker.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { NEWLINE_KEYS } from '@chauvoluuhuong/chorus-core';
import type { ProCtx, ProModule } from '@chauvoluuhuong/chorus-core/pro-loader';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import type { ProLoader } from '../../src/serve/pro.ts';

async function rig() {
  const events: { type: string; thread?: string }[] = [];
  let ctx: ProCtx | undefined;
  const mod: ProModule = {
    version: 'stand-in',
    routes: c => ((ctx = c), {}),
    mcpTools: () => [],
    ui: () => ({ js: '', css: '' }),
    onChatEvent: (_c, ev) => void events.push(ev as { type: string; thread?: string }),
    dispose() {},
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-typed-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-typed-p-'));
  const store = new Store(project, { home });
  const proLoader: ProLoader = { dev: true, load: async () => mod, activate: async () => mod };
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (_a, o) => ({ bin: process.execPath, args: [], cwd: o.cwd }) });
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }), proLoader });
  await srv.start(0);
  for (let i = 0; i < 100 && !ctx; i++) await new Promise(x => setTimeout(x, 10));
  assert.ok(ctx, 'the module loaded');
  const typed = (id: string, data: string) => (srv as unknown as { typedTo(id: string, data: string): void }).typedTo(id, data);
  return { store, project, events, ctx: () => ctx!, typed, close: () => (srv.close(), c.stop(), store.close()) };
}

test('Enter cancels the open question card and tells the module "typed"; Shift+Enter does neither', async () => {
  const r = await rig();
  try {
    for (const agent of ['claude', 'codex', 'agy'] as const) {
      const t = r.store.createThread({ title: agent, agent, cwd: r.project });
      r.store.createRequest({ threadId: t.id, question: 'Which colour?', kind: 'question' });
      const typedFor = () => r.events.filter(e => e.type === 'typed' && e.thread === t.id).length;

      r.typed(t.id, NEWLINE_KEYS[agent]);
      r.typed(t.id, `first line${NEWLINE_KEYS[agent]}`);
      r.typed(t.id, 'abc');
      assert.equal(r.store.pendingRequests(t.id).length, 1, `${agent}: Shift+Enter and plain keys leave the card`);
      assert.equal(typedFor(), 0, `${agent}: no typed event for Shift+Enter`);

      r.typed(t.id, '\r');
      assert.equal(r.store.pendingRequests(t.id).length, 0, `${agent}: Enter cancels the card`);
      assert.equal(typedFor(), 1, `${agent}: typed event on Enter`);

      // no Chorus question card open: the module still hears it (its own suggest or goal card may be open)
      r.typed(t.id, `two${NEWLINE_KEYS[agent]}lines\r`);
      assert.equal(typedFor(), 2, `${agent}: typed event with no pending request`);
    }
  } finally {
    r.close();
  }
});

test('ProCtx.threadKind: a main chat, a sub thread, a step Worker, an unknown id', async () => {
  const r = await rig();
  try {
    const main = r.store.createThread({ title: 'Main', agent: 'claude', cwd: r.project });
    const sub = r.store.createThread({ title: 'Sub', agent: 'claude', cwd: r.project, parent_thread_id: main.id });
    r.store.setSub(sub.id, { sub_status: 'working', sub_brief: 'x' });
    const step = r.store.createThread({ title: 'Step', agent: 'codex', cwd: r.project, parent_thread_id: main.id });
    r.store.setSub(step.id, { sub_status: 'task' as never });
    const kind = r.ctx().threadKind!;
    assert.equal(kind(main.id), 'main');
    assert.equal(kind(sub.id), 'sub');
    assert.equal(kind(step.id), 'task');
    assert.equal(kind('t_nope'), undefined);
  } finally {
    r.close();
  }
});
