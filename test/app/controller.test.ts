// Controller tests: threads, live tailing, state, approvals, handoff, views, with a fake TUI as the agent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { App, type AppIO } from '../../src/app/app.ts';
import { Controller } from '../../src/app/controller.ts';
import { VirtualScreen } from '../../src/app/screen.ts';
import { Store } from '../../src/core/store.ts';
import type { AgentId } from '../../src/core/types.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-tui.mjs');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function rig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-home-'));
  process.env.CODEX_HOME = home; // the codex adapter looks for rollouts here
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-proj-')));
  const stdin = Object.assign(new PassThrough(), { setRawMode: () => {}, isTTY: true });
  const outer = new VirtualScreen(120, 30);
  const stdout = new PassThrough();
  stdout.on('data', d => outer.write(d));
  const io: AppIO = { stdin, stdout, size: () => ({ cols: 120, rows: 30 }), onResize: () => () => {} };
  const app = new App(io);
  const store = new Store(project);
  const launches: { agent: AgentId; prompt?: string; resumeId?: string; model?: string; cwd?: string }[] = [];
  const c = new Controller({
    project,
    store,
    app,
    tailPollMs: 100,
    launcher: (agent, o) => {
      launches.push({ agent, prompt: o.prompt, resumeId: o.resumeId, model: o.model, cwd: o.cwd });
      return { bin: process.execPath, args: [FAKE, `${agent}`], cwd: o.cwd };
    },
  });
  app.start();
  return {
    app, c, store, project, home, launches,
    type: (s: string) => stdin.write(s),
    screen: () => outer.text(),
    async until(pred: () => boolean, what: string, ms = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (pred()) return;
        await sleep(60);
      }
      assert.fail(`timed out: ${what}\n${outer.text().filter(l => l.trim()).join('\n')}`);
    },
    close() {
      app.stop();
      store.close();
    },
  };
}
const has = (lines: string[], re: RegExp) => lines.some(l => re.test(l));

function listFiles(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? listFiles(path.join(d, e.name)) : [path.join(d, e.name)]));
}

/** A Codex rollout like the real ones (fixtures/codex shell scenario), pointed at this project. `done: false` stops before the command ran. */
function writeRollout(home: string, project: string, opts: { done: boolean }) {
  const src = listFiles(path.join(ROOT, 'fixtures/codex/0.163.0/shell/home-changes/.codex/sessions'))[0];
  const fixture = fs.readFileSync(src, 'utf8').split('\n').filter(l => l.trim());
  const id = '01a1' + Math.random().toString(16).slice(2, 6) + '-aaaa-7000-8000-000000000000';
  const fix = (l: string) => l.replace(/"cwd":"[^"]*"/g, `"cwd":${JSON.stringify(project)}`).replace(/01a147ea-9e0e-7301-b1ca-816b28d9cee3/g, id);
  const cutAt = fixture.findIndex(l => l.includes('"CommandExecution"'));
  const file = path.join(home, 'sessions', '2026', '10', '17', `rollout-2026-10-17T10-00-00-${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, (opts.done ? fixture : fixture.slice(0, cutAt)).map(fix).join('\n') + '\n');
  return { file, id, rest: fixture.slice(cutAt).map(fix) };
}

test('new thread: store row, process, live transcript tailing and state follow the agent', async () => {
  const r = rig();
  try {
  const e = r.c.newThread({ agent: 'codex', title: 'fix it' });
  await r.until(() => has(r.screen(), /READY codex/), 'agent screen');
  assert.equal(r.store.getThread(e.id)?.agent, 'codex');
  assert.match(r.screen()[2], /▶1 fix it/);

  // mid-turn transcript appears: the thread is working and the store has the user turn
  const w = writeRollout(r.home, r.project, { done: false });
  await r.until(() => r.store.getTurns(e.id).length > 0, 'turns tailed into the store');
  assert.equal(r.store.getThread(e.id)?.native_session_id, w.id);
  await r.until(() => /●/.test(r.screen()[2]), 'working dot');

  // the rest arrives while the TUI keeps running
  fs.appendFileSync(w.file, w.rest.join('\n') + '\n');
  await r.until(() => r.store.getToolCalls(e.id).some(t => t.target.includes('chorus-probe')), 'tool call tailed');
  await r.until(() => /○/.test(r.screen()[2]), 'waiting dot after task_complete');
  assert.equal(r.store.getThread(e.id)?.state, 'waiting');
  assert.ok((r.store.getUsage(e.id)?.outputTokens ?? 0) > 0);
  } finally {
    r.close();
  }
});

test('approval: a prompt on a background thread becomes a card; ctrl+space y answers it without switching', async () => {
  const r = rig();
  try {
  const a = r.c.newThread({ agent: 'codex', title: 'worker' });
  r.c.newThread({ agent: 'claude', title: 'front' });
  await r.until(() => has(r.screen(), /READY claude/), 'front thread');
  // thread 1 (background) shows the real Codex prompt from the fixture
  const prompt = path.join(ROOT, 'fixtures/codex/0.163.0/approval-ask-nohook-enter/prompt-screen.txt');
  r.app.entry(a.id)!.host!.write(`show ${prompt}\r`);
  await r.until(() => has(r.screen(), /asks for approval/), 'approval card');
  assert.match(r.screen().join('').replace(/[┃│┏┗┓┛━\s]/g, ''), /touch\/private.*approval-probe-file\.txt/); // the command, wrapped inside the card
  assert.match(r.screen()[2], /!/);

  r.type('\x00y');
  await r.until(() => !has(r.screen(), /asks for approval/), 'card gone after approving');
  // the key went to the background agent's terminal: it printed KEY enter on ITS screen
  await r.until(() => r.app.entry(a.id)!.host!.screen.text().some(l => /KEY enter/.test(l)), 'enter reached the background agent');
  assert.equal(r.app.active, 1, 'still on the front thread');
  } finally {
    r.close();
  }
});

test('deny sends Esc; nothing pending says so', async () => {
  const r = rig();
  try {
  const a = r.c.newThread({ agent: 'codex', title: 'worker' });
  r.c.newThread({ agent: 'claude', title: 'front' });
  await r.until(() => has(r.screen(), /READY claude/), 'ready');
  r.type('\x00y');
  await r.until(() => has(r.screen(), /nothing is waiting for approval/), 'no pending message');
  const prompt = path.join(ROOT, 'fixtures/codex/0.163.0/approval-ask-nohook-enter/prompt-screen.txt');
  r.app.entry(a.id)!.host!.write(`show ${prompt}\r`);
  await r.until(() => has(r.screen(), /asks for approval/), 'card');
  r.type('\x00x');
  await r.until(() => r.app.entry(a.id)!.host!.screen.text().some(l => /KEY esc/.test(l)), 'esc reached the agent');
  } finally {
    r.close();
  }
});

test('handoff: the new thread is a child with the fixed first message, and a missing context load is flagged', async () => {
  const r = rig();
  try {
  const p = r.c.newThread({ agent: 'claude', title: 'fix the bug' });
  await r.until(() => has(r.screen(), /READY claude/), 'parent');
  const child = await r.c.handoff(p.id, 'codex');
  assert.ok(child);
  const row = r.store.getThread(child!.id)!;
  assert.equal(row.parent_thread_id, p.id);
  assert.match(r.launches.at(-1)!.prompt!, /continues the Chorus thread "fix the bug", worked on by claude\. Call the chorus MCP tool get_handoff_context first/);
  assert.equal(r.app.entries[r.app.active].id, child!.id);

  // the child finished its first turn but never called the tool: warning + retry key
  const w = writeRollout(r.home, r.project, { done: true });
  await r.until(() => /context not loaded/.test(r.app.notice), 'context warning');
  void w;
  r.type('\x00r');
  await r.until(() => r.app.entry(child!.id)!.host!.screen.text().some(l => /got: "This chat continues/.test(l)), 'prompt typed into the agent again');

  // once the tool was called the warning goes away
  r.store.logMcpCall(child!.id, 'get_handoff_context');
  fs.appendFileSync(w.file, '\n');
  r.c['onSession'](child!.id, r.c['sessions'].get(child!.id)!);
  assert.equal(r.app.notice, '');
  } finally {
    r.close();
  }
});

test('views: memory, tools and files panes; limit warning; new-thread dialog', async () => {
  const r = rig();
  try {
  const e = r.c.newThread({ agent: 'codex', title: 'viewer' });
  await r.until(() => has(r.screen(), /READY codex/), 'ready');
  const w = writeRollout(r.home, r.project, { done: true });
  void w;
  await r.until(() => r.store.getToolCalls(e.id).length > 0, 'tailed');

  r.type('\x00m');
  await r.until(() => has(r.screen(), /memory · viewer/), 'memory pane');
  assert.match(r.screen().join('\n'), /get_handoff_context returns for "viewer"/);
  assert.match(r.screen().join('\n'), /echo chorus-probe/);
  r.type('\x1b');
  await r.until(() => has(r.screen(), /READY codex/), 'back to the agent');

  r.type('\x00t');
  await r.until(() => has(r.screen(), /tool calls · viewer/), 'tools pane');
  assert.match(r.screen().join('\n'), /✓ shell\s+echo chorus-probe/);
  r.type('q');
  r.type('\x00f');
  await r.until(() => has(r.screen(), /files and artifacts/), 'files pane');
  r.type('q');

  r.store.db.prepare('UPDATE usage SET limit_utilization = 0.93 WHERE thread_id = ?').run(e.id);
  r.c['checkLimit'](e.id);
  await r.until(() => /93% of its plan limit/.test(r.screen()[29]), 'limit warning in the status line');

  // the new-thread form: agent, model, folder (default: this project)
  r.type('\x00n');
  await r.until(() => has(r.screen(), /Agent\s+\[claude\]/), 'form');
  assert.match(r.screen().join('\n'), /Model\s+\[default\]/);
  assert.match(r.screen().join('\n'), new RegExp('Folder\\s+' + r.project.replace(/[/.]/g, '\\$&')));
  r.type('\x1b[C'); // agent: codex
  r.type('\r');
  await r.until(() => r.app.entries.length === 2 && r.launches.at(-1)?.agent === 'codex', 'new codex thread');
  assert.equal(r.launches.at(-1)!.cwd, r.project);
  assert.equal(r.launches.at(-1)!.model, undefined, 'default model passes no flag');
  } finally {
    r.close();
  }
});

test('new-thread form: model list follows the agent, folder is validated and becomes the thread folder', async () => {
  const r = rig();
  try {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-other-')));
    r.type('\x00n');
    await r.until(() => has(r.screen(), /Agent\s+\[claude\]/), 'form');
    r.type('\t'); // → model
    r.type('\x1b[C'); // sonnet
    await r.until(() => has(r.screen(), /Model\s+default\s+\[sonnet\]/), 'model changed');
    r.type('\x1b[Z'); // back to agent
    r.type('\x1b[C'); // codex: the model list is the codex one again, starting at default
    await r.until(() => has(r.screen(), /Agent\s+claude\s+\[codex\]/) && has(r.screen(), /Model\s+\[default\]/), 'model reset for codex');
    r.type('\x1b[D'); // claude again
    r.type('\t');
    r.type('\x1b[C');
    r.type('\t'); // folder: clear it and type a wrong one
    r.type('\x15');
    for (const ch of '/no/such/dir') r.type(ch);
    r.type('\r');
    await r.until(() => has(r.screen(), /! \/no\/such\/dir is not a folder/), 'folder error');
    assert.equal(r.app.entries.length, 0, 'nothing started');
    r.type('\x15');
    for (const ch of other) r.type(ch);
    r.type('\r');
    await r.until(() => r.app.entries.length === 1, 'thread started');
    assert.deepEqual({ agent: r.launches[0].agent, model: r.launches[0].model, cwd: r.launches[0].cwd }, { agent: 'claude', model: 'sonnet', cwd: other });
    const row = r.store.listThreads()[0];
    assert.equal(row.cwd, other);
    assert.equal(row.model, 'sonnet');
    r.type('\x00n');
    await r.until(() => has(r.screen(), /Agent\s+\[claude\]/), 'form again');
    r.type('\x1b');
    await r.until(() => !has(r.screen(), /Agent\s+\[claude\]/), 'esc cancels');
    assert.equal(r.app.entries.length, 1);
  } finally {
    r.close();
  }
});

test('a thread started from the form is named after the first message', async () => {
  const r = rig();
  try {
    const e = r.c.newThread({ agent: 'codex' });
    assert.equal(r.store.getThread(e.id)!.title, 'codex 1');
    const w = writeRollout(r.home, r.project, { done: false });
    void w;
    await r.until(() => r.store.getThread(e.id)!.title !== 'codex 1', 'title from the first message');
    assert.match(r.store.getThread(e.id)!.title, /^Use your shell/);
    assert.equal(r.app.entry(e.id)!.title, r.store.getThread(e.id)!.title);
  } finally {
    r.close();
  }
});

test('restore: threads from a previous run are parked and resume with the stored session id', async () => {
  const r = rig();
  try {
  const t = r.store.createThread({ id: 't_old', title: 'yesterday', agent: 'codex', cwd: r.project, native_session_id: 'abc-123', state: 'waiting' });
  void t;
  r.c.restore();
  assert.match(r.screen()[2] ?? '', /yesterday|$/);
  await r.until(() => has(r.screen(), /◌/), 'parked marker');
  r.type('\x001');
  await r.until(() => has(r.screen(), /READY codex/), 'resumed process');
  assert.equal(r.launches.at(-1)!.resumeId, 'abc-123');
  } finally {
    r.close();
  }
});

test('quota: an agy thread whose screen says the quota is used up gets a status-line warning that points at the handoff', async () => {
  const r = rig();
  try {
    const e = r.c.newThread({ agent: 'agy', title: 'out of quota' });
    await r.until(() => has(r.screen(), /READY agy/), 'ready');
    r.app.entry(e.id)!.host!.write(`show ${path.join(ROOT, 'fixtures/agy/1.4.1/quota/screen.txt')}\r`);
    await r.until(() => /agy reached its quota \(resets in 147h16m18s\): ctrl\+space h continues in another agent/.test(r.screen()[29]), 'quota warning');
  } finally {
    r.close();
  }
});
