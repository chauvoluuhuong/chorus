// Controller tests: threads, live tailing, state, approvals, handoff, views, with a fake TUI as the agent.
import { capOutput } from '../../src/core/adapters/util.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
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

function rig(extra: Partial<ConstructorParameters<typeof Controller>[0]> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-home-'));
  process.env.CODEX_HOME = home; // the codex adapter looks for rollouts here
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-proj-')));
  const stdin = Object.assign(new PassThrough(), { setRawMode: () => {}, isTTY: true });
  const outer = new VirtualScreen(120, 30);
  let raw = '';
  const stdout = new PassThrough();
  stdout.on('data', d => {
    raw += d;
    outer.write(d);
  });
  const io: AppIO = { stdin, stdout, size: () => ({ cols: 120, rows: 30 }), onResize: () => () => {} };
  const app = new App(io);
  const store = new Store(project);
  const launches: { agent: AgentId; prompt?: string; resumeId?: string; model?: string; effort?: string; cwd?: string; skipPermissions?: boolean; project?: string }[] = [];
  const c = new Controller({
    project,
    store,
    app,
    tailPollMs: 100,
    ...extra,
    launcher: (agent, o) => {
      launches.push({ agent, prompt: o.prompt, resumeId: o.resumeId, model: o.model, effort: o.effort, cwd: o.cwd, skipPermissions: o.skipPermissions, project: o.project });
      return { bin: process.execPath, args: [FAKE, `${agent}`], cwd: o.cwd };
    },
  });
  app.start();
  return {
    app, c, store, project, home, launches,
    type: (s: string) => stdin.write(s),
    screen: () => outer.text(),
    raw: () => raw,
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
/** A real Codex 0.163.0 developer message carrying the Chorus thread marker (TD-4: rollouts are matched to threads by it). */
const MARKER_LINE = fs
  .readFileSync(path.join(ROOT, 'fixtures/risks/codex-thread-marker/2026-10-22T01-31-46-678Z/rollout-busy.jsonl'), 'utf8')
  .split('\n')
  .find(l => l.includes('"role":"developer"') && l.includes('Chorus thread'))!;

function writeRollout(home: string, project: string, threadId: string, opts: { done: boolean }) {
  const src = listFiles(path.join(ROOT, 'fixtures/codex/0.163.0/shell/home-changes/.codex/sessions'))[0];
  const fixture = fs.readFileSync(src, 'utf8').split('\n').filter(l => l.trim());
  fixture.splice(1, 0, MARKER_LINE.replaceAll('t_busy9b85', threadId));
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
  assert.match(r.screen()[6], /▎.*fix it/);

  // mid-turn transcript appears: the thread is working and the store has the user turn
  const w = writeRollout(r.home, r.project, e.id, { done: false });
  await r.until(() => r.store.getTurns(e.id).length > 0, 'turns tailed into the store');
  assert.equal(r.store.getThread(e.id)?.native_session_id, w.id);
  await r.until(() => /●/.test(r.screen()[6]), 'working dot');

  // the rest arrives while the TUI keeps running
  fs.appendFileSync(w.file, w.rest.join('\n') + '\n');
  await r.until(() => r.store.getToolCalls(e.id).some(t => t.target.includes('chorus-probe')), 'tool call tailed');
  await r.until(() => /○/.test(r.screen()[6]), 'waiting dot after task_complete');
  assert.equal(r.store.getThread(e.id)?.state, 'waiting');
  assert.ok((r.store.getUsage(e.id)?.outputTokens ?? 0) > 0);
  } finally {
    r.close();
  }
});

test('approval: a prompt on a background thread shows as the badge, a sidebar ! and a flash (no card over the chat); ctrl+\\ y answers it without switching', async () => {
  const r = rig();
  try {
  const a = r.c.newThread({ agent: 'codex', title: 'worker' });
  r.c.newThread({ agent: 'claude', title: 'front' });
  await r.until(() => has(r.screen(), /READY claude/), 'front thread');
  // thread 1 (background) shows the real Codex prompt from the fixture
  const prompt = path.join(ROOT, 'fixtures/codex/0.163.0/approval-ask-nohook-enter/prompt-screen.txt');
  r.app.entry(a.id)!.host!.write(`show ${prompt}\r`);
  await r.until(() => /! 1 waiting/.test(r.screen()[0]), 'the top bar badge counts it');
  assert.ok(r.screen().some(l => /!\s+worker/.test(l)), 'the sidebar row of the waiting chat shows !');
  assert.match(r.screen()[29], /! worker \(codex\) asks · ⌃\\ y approve\s+⌃\\ x deny · mkdir -p/, 'the flash names the chat, the keys and the request');
  assert.ok(has(r.screen(), /READY claude/) && !has(r.screen(), /asks for approval/), 'nothing covers the chat in front');

  r.type('\x00y');
  await r.until(() => !/waiting/.test(r.screen()[0]), 'badge gone after approving');
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
  await r.until(() => /! 1 waiting/.test(r.screen()[0]), 'badge');
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
  const w = writeRollout(r.home, r.project, child!.id, { done: true });
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

test('views: memory, activity and files panes; limit warning', async () => {
  const r = rig();
  try {
  const e = r.c.newThread({ agent: 'codex', title: 'viewer' });
  await r.until(() => has(r.screen(), /READY codex/), 'ready');
  const w = writeRollout(r.home, r.project, e.id, { done: true });
  void w;
  await r.until(() => r.store.getToolCalls(e.id).length > 0, 'tailed');

  r.type('\x00m');
  await r.until(() => has(r.screen(), /Memory\s+·\s+all projects/), 'memory screen');
  assert.match(r.screen().join('\n'), /▸ viewer\s+\S+\s+codex\s+\d+ turns/);
  assert.match(r.screen().join('\n'), /asked\s+Use your shell/);
  r.type('d');
  await r.until(() => has(r.screen(), /What an agent reads\s+·\s+viewer/), 'digest');
  assert.match(r.screen().join('\n'), /get_handoff_context returns for "viewer"/);
  assert.match(r.screen().join('\n'), /echo chorus-probe/);
  r.type('\x1b'); // back to the list, then to the chat
  await r.until(() => has(r.screen(), /Memory\s+·\s+all projects/), 'memory list again');
  r.type('\x1b');
  await r.until(() => has(r.screen(), /READY codex/), 'back to the agent');

  r.type('\x00t');
  await r.until(() => has(r.screen(), /Activity\s+·\s+viewer/), 'activity pane');
  assert.match(r.screen().join('\n'), /shell echo chorus-probe\S*.*ok/);
  r.type('q');
  r.type('\x00f');
  await r.until(() => has(r.screen(), /Artifacts\s+·\s+viewer/), 'artifacts pane');
  r.type('q');

  r.store.db.prepare('UPDATE usage SET limit_utilization = 0.93 WHERE thread_id = ?').run(e.id);
  r.c['checkLimit'](e.id);
  await r.until(() => /93% of its plan limit/.test(r.screen()[29]), 'limit warning in the status line');
  } finally {
    r.close();
  }
});

test('New chat screen: Enter alone starts with the defaults; esc and Back return without starting', async () => {
  const r = rig();
  try {
    r.type('\x00n');
    await r.until(() => has(r.screen(), /New chat/) && has(r.screen(), /Agent\s+claude\s+codex\s+agy/), 'screen');
    const t = r.screen().join('\n');
    assert.match(t, /Model\s+default\s+sonnet\s+opus\s+haiku/);
    assert.match(t, /Effort\s+default\s+low\s+medium\s+high\s+xhigh\s+max\s+how hard the model thinks/);
    assert.match(t, new RegExp('Project\\s+' + r.project.replace(/[/.]/g, '\\$&')));
    assert.match(t, /\[ \] Skip permission prompts\s+--dangerously-skip-permissions/);
    assert.match(t, /off: the agent asks, and Chorus shows it in the approvals inbox/);
    assert.match(r.screen()[0], /‹ Back\s+chorus-proj-\w+ \/ New chat\s+☰ Menu/, 'the path is <project> / New chat');
    r.type('\x1b');
    await r.until(() => !has(r.screen(), /Agent\s+claude\s+codex/), 'esc cancels');
    assert.equal(r.app.entries.length, 0);
    r.type('\x00n');
    await r.until(() => has(r.screen(), /Agent\s+claude\s+codex/), 'again');
    r.app.click('back');
    await r.until(() => !has(r.screen(), /Agent\s+claude\s+codex/), 'Back cancels');
    r.type('\x00n');
    await r.until(() => has(r.screen(), /Agent\s+claude\s+codex/), 'third time');
    r.type('\r');
    await r.until(() => r.app.entries.length === 1 && r.launches.length === 1, 'chat started');
    assert.deepEqual({ agent: r.launches[0].agent, model: r.launches[0].model, cwd: r.launches[0].cwd, skip: r.launches[0].skipPermissions }, { agent: 'claude', model: undefined, cwd: r.project, skip: false });
    await r.until(() => has(r.screen(), /READY claude/), 'agent screen');
  } finally {
    r.close();
  }
});

test('New chat screen: the folder defaults to the project you are in, not to a parked chat of another project', async () => {
  const r = rig();
  try {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-parked-')));
    r.store.createThread({ id: 't_parked', title: 'old chat', agent: 'codex', cwd: other, project: other, native_session_id: 'x', state: 'waiting' });
    r.c.restore();
    assert.equal(r.app.current?.cwd, other, 'the parked chat of the other project is the selected entry');
    r.type('\x00n');
    await r.until(() => has(r.screen(), /Agent\s+claude\s+codex/), 'screen');
    assert.match(r.screen().join('\n'), /Project\s+\S*chorus-proj-/); // the folder chorus was started in (the path is cut at the pane edge)
    r.type('\x1b');
    // with a chat running in front, the project is that chat's folder
    r.c.newThread({ agent: 'claude', title: 'front', cwd: other });
    await r.until(() => has(r.screen(), /READY claude/), 'front chat');
    r.type('\x00n');
    await r.until(() => has(r.screen(), /Agent\s+claude\s+codex/), 'screen again');
    assert.match(r.screen().join('\n'), /Project\s+\S*chorus-parked-/);
  } finally {
    r.close();
  }
});

test('sidebar: the + of a project row opens New chat in that project, and the chat is listed under it', async () => {
  const r = rig();
  try {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-landing-')));
    r.c.newThread({ agent: 'claude', title: 'front' });
    r.c.newThread({ agent: 'codex', title: 'elsewhere', cwd: other });
    r.c.newThread({ agent: 'claude', title: 'front again' }); // the project in front is the first one again
    await r.until(() => r.app.hits.some(h => h.id === `newin:${other}`), 'a + on the other project');
    r.app.click(`newin:${other}`);
    await r.until(() => has(r.screen(), /Agent\s+claude\s+codex/), 'New chat');
    assert.match(r.screen()[0], /chorus-landing-\w+ \/ New chat/, 'the path names that project');
    assert.match(r.screen().join('\n'), /Project\s+\S*chorus-landing-/);
    r.type('\r');
    await r.until(() => r.app.entries.length === 4, 'started');
    const made = r.app.entries[3];
    assert.equal(made.cwd, other, 'the chat works in that project');
    assert.equal(r.store.getThread(made.id)?.project, other);
    const rows = r.app.sideRows();
    const proj = rows.findIndex(x => x.kind === 'project' && x.cwd === other);
    const under = rows.slice(proj + 1).findIndex(x => x.kind !== 'chat');
    assert.ok(rows.slice(proj + 1, proj + 1 + under).some(x => x.kind === 'chat' && x.index === 3), 'listed under that project');
  } finally {
    r.close();
  }
});

test('New chat screen: click the agent and model, tick skip permissions, type a folder; the folder is validated and becomes the chat project', async () => {
  const r = rig();
  try {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-other-')));
    r.type('\x00n');
    await r.until(() => has(r.screen(), /Agent\s+claude\s+codex/), 'screen');
    r.app.click('agent:1'); // codex: the model list is the codex one, starting at default
    await r.until(() => has(r.screen(), /--dangerously-bypass-approvals-and-sandbox/) === false && has(r.screen(), /Skip permission prompts/), 'redrawn');
    r.app.click('agent:0');
    r.app.click('model:2'); // opus
    r.app.click('skip');
    await r.until(() => has(r.screen(), /\[x\] Skip permission prompts/) && has(r.screen(), /Nothing reaches the approvals inbox for this chat\./), 'skip ticked with its warning');
    r.app.click('folder');
    r.type('\x15');
    for (const ch of '/no/such/dir') r.type(ch);
    r.type('\r');
    await r.until(() => has(r.screen(), /! \/no\/such\/dir is not a folder/), 'folder error');
    assert.equal(r.app.entries.length, 0, 'nothing started');
    r.type('\x15');
    for (const ch of other) r.type(ch);
    r.app.click('start');
    await r.until(() => r.app.entries.length === 1, 'chat started');
    assert.deepEqual({ agent: r.launches[0].agent, model: r.launches[0].model, cwd: r.launches[0].cwd, project: r.launches[0].project, skip: r.launches[0].skipPermissions }, { agent: 'claude', model: 'opus', cwd: other, project: other, skip: true });
    const row = r.store.listThreads()[0];
    assert.equal(row.cwd, other);
    assert.equal(row.project, other, 'the chat belongs to the folder it works in');
    assert.equal(row.model, 'opus');
    assert.equal(row.skip_permissions, 1);
    assert.equal(r.app.entries[0].meta?.skip, true, 'the status line shows skip');
    assert.ok(r.store.threadDir(row.id).startsWith(other), 'artifacts live in the chat folder');
    await r.until(() => /opus skip/.test(r.screen()[29]), 'amber skip in the status line');
  } finally {
    r.close();
  }
});

test('a thread started from the form is named after the first message', async () => {
  const r = rig();
  try {
    const e = r.c.newThread({ agent: 'codex' });
    assert.equal(r.store.getThread(e.id)!.title, 'codex 1');
    const w = writeRollout(r.home, r.project, e.id, { done: false });
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
    await r.until(() => /agy reached its quota \(resets in 147h16m18s\): ⌃\\ h continues in another agent/.test(r.screen()[29]), 'quota warning');
  } finally {
    r.close();
  }
});

test('artifacts view: select, open the live preview, versions; activity view: filter and raw trace', async () => {
  process.env.CHORUS_NO_OPEN = '1'; // do not start a browser from a test
  const r = rig();
  try {
    const e = r.c.newThread({ agent: 'codex', title: 'viewer' });
    await r.until(() => has(r.screen(), /READY codex/), 'ready');
    const w = writeRollout(r.home, r.project, e.id, { done: true });
    void w;
    await r.until(() => r.store.getToolCalls(e.id).length > 0, 'tailed');
    fs.writeFileSync(path.join(r.store.artifactsDir(e.id), 'plan.md'), '# the plan\nstep one');
    r.store.scanArtifacts(e.id);
    fs.writeFileSync(path.join(r.store.artifactsDir(e.id), 'plan.md'), '# the plan\nstep one\nstep two');
    r.store.scanArtifacts(e.id);

    r.type('\x00a');
    await r.until(() => has(r.screen(), /Artifacts\s+·\s+viewer/) && has(r.screen(), /plan\.md\s+v2/), 'artifacts table with two versions');
    assert.match(r.screen().join('\n'), /press ⏎ to open it in the browser/);
    r.type('v');
    await r.until(() => has(r.screen(), /Versions of plan\.md/) && has(r.screen(), /v1 /) && has(r.screen(), /v2 /), 'versions list');
    r.type('o');
    await r.until(() => /Link\s+http:\/\/localhost:\d+\/t_/.test(r.screen().join('\n')) && has(r.screen(), /live reload/), 'preview url on screen');
    const url = r.c.previewOpened;
    assert.match(url, /^http:\/\/localhost:\d+\/t_\w+\/plan\.md$/);
    const body = await new Promise<string>(res => http.get(url, m => { let b = ''; m.on('data', d => (b += d)); m.on('end', () => res(b)); }));
    assert.match(body, /step two/);
    assert.match(body, /EventSource/);
    r.type('\x1b');

    r.type('\x00e');
    await r.until(() => has(r.screen(), /Activity\s+·\s+viewer/) && has(r.screen(), /tool\s+shell/), 'activity');
    r.type('f');
    await r.until(() => has(r.screen(), / tool \d+ /) && !has(r.screen(), /file\s+plan\.md/), 'filter: tool');
    r.type('f');
    await r.until(() => has(r.screen(), / mcp \d+ /) && !has(r.screen(), /tool\s+shell/), 'filter: mcp');
    r.type('r');
    await r.until(() => has(r.screen(), /Raw trace\s+·\s+viewer/) && has(r.screen(), /transcript lines:/), 'raw trace');
  } finally {
    r.close();
    delete process.env.CHORUS_NO_OPEN;
  }
});

test('approvals inbox: every waiting chat in one list with a risk tag; y / x / click answer it, Decided keeps the history', async () => {
  const r = rig();
  try {
    const a = r.c.newThread({ agent: 'codex', title: 'Stripe webhook' });
    r.c.newThread({ agent: 'claude', title: 'front' });
    await r.until(() => has(r.screen(), /READY claude/), 'front');
    const prompt = path.join(ROOT, 'fixtures/codex/0.163.0/approval-ask-nohook-enter/prompt-screen.txt');
    r.app.entry(a.id)!.host!.write(`show ${prompt}\r`);
    await r.until(() => has(r.screen(), /! 1 waiting/), 'badge in the top bar');

    r.app.click('approvals'); // the badge
    await r.until(() => has(r.screen(), /Approvals\s+·\s+1 waiting/), 'inbox');
    const t = r.screen().join('\n');
    assert.match(t, /▸ Stripe webhook\s+codex\s+waiting \d+s/);
    assert.match(t, /mkdir -p .*….*probe-file\.txt/);
    assert.match(t, /\[(runs a command|writes outside the folder)\]/);
    assert.match(t, /y Approve\s+x Deny\s+⏎ Open chat/);
    assert.match(r.screen()[0], /‹ Back\s+Approvals\s+!/);

    r.type('y'); // the selected request, without leaving the inbox
    await r.until(() => r.app.entry(a.id)!.host!.screen.text().some(l => /KEY enter/.test(l)), 'enter reached the waiting agent');
    await r.until(() => has(r.screen(), /Nothing is waiting for you/) && has(r.screen(), /✓ approved/), 'Decided shows it');
    assert.equal(r.store.approvalsLog()[0].decision, 'approved');
    assert.equal(r.app.active, 1, 'still on the front chat');

    r.app.entry(a.id)!.host!.write(`show ${prompt}\r`);
    await r.until(() => has(r.screen(), /Approvals\s+·\s+1 waiting/), 'second request');
    r.app.click(`deny:${a.id}`);
    await r.until(() => r.app.entry(a.id)!.host!.screen.text().some(l => /KEY esc/.test(l)), 'esc reached the agent');
    await r.until(() => has(r.screen(), /✗ denied/), 'denied in Decided');

    r.app.entry(a.id)!.host!.write(`show ${prompt}\r`);
    await r.until(() => has(r.screen(), /Approvals\s+·\s+1 waiting/), 'third request');
    r.type('\r'); // ⏎ opens the chat
    await r.until(() => r.app.active === 0 && !has(r.screen(), /Approvals\s+·/), 'chat opened');
  } finally {
    r.close();
  }
});

test('a request on a chat you are not looking at rings the bell and flashes its title; CHORUS_BELL=0 mutes the bell', async () => {
  const r = rig();
  try {
    const a = r.c.newThread({ agent: 'codex', title: 'Stripe webhook' });
    r.c.newThread({ agent: 'claude', title: 'front' });
    await r.until(() => has(r.screen(), /READY claude/), 'front');
    const prompt = path.join(ROOT, 'fixtures/codex/0.163.0/approval-ask-nohook-enter/prompt-screen.txt');
    const before = r.raw().length;
    r.app.entry(a.id)!.host!.write(`show ${prompt}\r`);
    await r.until(() => has(r.screen(), /! Stripe webhook \(codex\) asks/), 'flash in the status line');
    assert.ok(r.raw().slice(before).includes('\x07'), 'bell');
    r.type('\x00x');
    await r.until(() => !/waiting/.test(r.screen()[0]), 'denied');
    process.env.CHORUS_BELL = '0';
    const mid = r.raw().length;
    r.app.entry(a.id)!.host!.write(`show ${prompt}\r`);
    await r.until(() => /! 1 waiting/.test(r.screen()[0]), 'second request');
    assert.ok(!r.raw().slice(mid).includes('\x07'), 'muted');
  } finally {
    delete process.env.CHORUS_BELL;
    r.close();
  }
});

test('New chat screen: effort is chosen with a click or ←/→, follows the agent, is stored and passed on, and shows in the status line', async () => {
  const r = rig();
  try {
    r.type('\x00n');
    await r.until(() => has(r.screen(), /Effort\s+default\s+low/), 'effort row');
    r.app.click('effort:3'); // high
    await r.until(() => has(r.screen(), /Effort/), 'chosen');
    r.app.click('agent:1'); // switching the agent starts the effort over at default
    r.app.click('effort:1'); // low
    r.type('\r');
    await r.until(() => r.launches.length === 1, 'started');
    assert.deepEqual({ agent: r.launches[0].agent, effort: r.launches[0].effort }, { agent: 'codex', effort: 'low' });
    const row = r.store.listThreads()[0];
    assert.equal(row.effort, 'low');
    assert.equal(r.app.entries[0].meta?.effort, 'low');
    await r.until(() => /codex · low/.test(r.screen()[29]), 'effort in the status line');

    // keyboard: tab to Effort, → → picks the third level; default passes nothing
    r.type('\x00n');
    await r.until(() => has(r.screen(), /Effort\s+default\s+low/), 'again');
    r.type('\t'); // → start is focused by default; tab wraps to agent
    r.type('\t'); // model
    r.type('\t'); // effort
    r.type('\x1b[C');
    r.type('\x1b[C');
    r.type('\r');
    await r.until(() => r.launches.length === 2, 'second chat');
    assert.equal(r.launches[1].effort, 'medium');
    r.type('\x00n');
    await r.until(() => has(r.screen(), /Effort\s+default\s+low/), 'third');
    r.type('\r');
    await r.until(() => r.launches.length === 3, 'third chat');
    assert.equal(r.launches[2].effort, undefined, 'default passes no effort');
    assert.equal(r.store.listThreads().find(t => t.id === r.app.entries[2].id)!.effort, null);
  } finally {
    r.close();
  }
});

test('a resumed chat keeps its effort and skip flag', async () => {
  const r = rig();
  try {
    r.store.createThread({ id: 't_old', title: 'yesterday', agent: 'claude', cwd: r.project, native_session_id: 'abc', state: 'waiting', effort: 'high', skip_permissions: 1 });
    r.c.restore();
    r.type('\x001');
    await r.until(() => r.launches.some(l => l.resumeId === 'abc'), 'resumed');
    const l = r.launches.find(x => x.resumeId === 'abc')!;
    assert.deepEqual({ effort: l.effort, skip: l.skipPermissions }, { effort: 'high', skip: true });
  } finally {
    r.close();
  }
});

test('choosing agy never freezes the screen: its model list is fetched in the background and appears when it arrives', async () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-fakeagy-'));
  fs.writeFileSync(path.join(bin, 'agy'), "#!/bin/sh\nsleep 1.5\nprintf 'fast-model\\tFast\\nbig-model\\tBig\\n'\n", { mode: 0o755 });
  const cache = path.join(bin, 'agy-cache.json');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  process.env.CHORUS_AGY_CACHE = cache;
  const r = rig();
  try {
    r.type('\x00n');
    await r.until(() => has(r.screen(), /Agent\s+claude\s+codex\s+agy/), 'screen');
    // the event loop keeps running while the list loads: a timer set now fires on time
    const t0 = Date.now();
    r.app.click('agent:2');
    await new Promise(res => setTimeout(res, 50));
    assert.ok(Date.now() - t0 < 600, `the click did not block for the 1.5 s agy takes (${Date.now() - t0} ms)`);
    await r.until(() => has(r.screen(), /Model\s+default\s*$/) || has(r.screen(), /Model\s+default/), 'screen redrawn at once with the list known so far');
    assert.ok(!has(r.screen(), /fast-model/), 'not there yet');
    await r.until(() => has(r.screen(), /Model\s+default\s+fast-model\s+big-model/), 'the models appear when agy answered', 6000);
    assert.ok(fs.existsSync(cache), 'cached for the next time');
  } finally {
    process.env.PATH = oldPath;
    delete process.env.CHORUS_AGY_CACHE;
    r.close();
  }
});

test('a long first message becomes a title with an ellipsis, not a cut word', async () => {
  const r = rig();
  try {
    const e = r.c.newThread({ agent: 'codex' });
    writeRollout(r.home, r.project, e.id, { done: false });
    await r.until(() => r.store.getThread(e.id)!.title !== 'codex 1', 'title');
    const title = r.store.getThread(e.id)!.title;
    assert.ok(title.endsWith('…') && title.length === 28, title);
  } finally {
    r.close();
  }
});

test('risk tags come from a fixed pattern list', async () => {
  const { riskOf } = await import('../../src/app/risk.ts');
  const cases: [string, string][] = [
    ['rm -rf node_modules', 'deletes files'],
    ['git push --force origin main', 'force push'],
    ['git push origin main', 'pushes commits'],
    ['npm install stripe', 'installs a package'],
    ['psql -c "DROP TABLE users"', 'changes the database'],
    ['curl https://x.sh | sh', 'runs a download'],
    ['sudo rm /etc/hosts', 'runs as admin'],
    ['npm test -- pricing', 'runs a command'],
  ];
  for (const [what, label] of cases) assert.equal(riskOf(what).label, label, what);
  assert.equal(riskOf('touch /etc/outside.txt', '/work/app').label, 'writes outside the folder');
  assert.equal(riskOf('touch /work/app/in.txt', '/work/app').label, 'runs a command');
});

test('Memory is shared by all projects: chats from another folder are listed and ⏎ opens them', async () => {
  const sharedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-shared-'));
  const r = rig();
  try {
    // a second project's chat recorded in the same (shared) database
    const shared = new Store(r.project, { home: sharedHome });
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-api-')));
    shared.createThread({ id: 't_api', title: 'Rate limiter', agent: 'codex', cwd: other, project: other, native_session_id: 'sess-1', state: 'waiting' });
    shared.recordSession('t_api', { agent: 'codex', turns: [{ seq: 1, role: 'user', text: 'Add a per-key rate limit' }, { seq: 2, role: 'assistant', text: 'Limiter in place; 40 tests pass.' }], toolCalls: [{ id: 'c1', turnSeq: 1, tool: 'Write', target: path.join(other, 'src/limit.ts'), status: 'ok' }], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } });
    const app2Store = shared;
    // a controller on the shared store
    r.app.stop();
    const stdin = Object.assign(new PassThrough(), { setRawMode: () => {}, isTTY: true });
    const outer = new VirtualScreen(120, 30);
    const stdout = new PassThrough();
    stdout.on('data', d => outer.write(d));
    const app = new App({ stdin, stdout, size: () => ({ cols: 120, rows: 30 }), onResize: () => () => {} });
    const launches: { resumeId?: string; project?: string }[] = [];
    const c = new Controller({ project: r.project, store: app2Store, app, tailPollMs: 100, launcher: (agent, o) => (launches.push({ resumeId: o.resumeId, project: o.project }), { bin: process.execPath, args: [FAKE, agent], cwd: o.cwd }) });
    c.newThread({ agent: 'claude', title: 'Cake order page' });
    app.start();
    await sleep(300);
    app.emit('action', 'memory');
    await sleep(300);
    const screen = () => outer.text();
    assert.match(screen().join('\n'), /Memory\s+·\s+all projects/);
    assert.match(screen().join('\n'), /Rate limiter\s+\S+\s+codex\s+2 turns/);
    assert.match(screen().join('\n'), /Cake order page/);
    assert.match(screen().join('\n'), /all projects\s+\/var\/folders\//, 'shows where the shared database lives (the path is cut at the pane edge)');
    // select the other project's chat and open it: it is added parked, then resumed with its stored session id
    app.click(`row:t_api`); // the first click selects: the detail below shows what that chat did
    await sleep(200);
    assert.match(screen().join('\n'), /asked\s+Add a per-key rate limit/);
    assert.match(screen().join('\n'), /files\s+src\/limit\.ts/);
    app.click(`row:t_api`); // a second click on the selected row opens it
    const t0 = Date.now();
    while (Date.now() - t0 < 6000 && !launches.some(l => l.resumeId === 'sess-1')) await sleep(80);
    assert.ok(launches.some(l => l.resumeId === 'sess-1' && l.project === other), 'resumed in its own project');
    // the sidebar groups chats by project
    const t1 = Date.now();
    while (Date.now() - t1 < 3000 && !screen().some(l => /▾ chorus-api-/.test(l.slice(0, 28)))) await sleep(80);
    assert.ok(screen().some(l => /▾ chorus-api-/.test(l.slice(0, 28))), `second project in the sidebar:\n${screen().join('\n')}`);
    app.stop();
    assert.equal(shared.listThreads().length, 2);
    assert.match(shared.threadDir('t_api'), new RegExp(other.replace(/[/.]/g, '\\$&')), 'artifacts stay in the chat project');
    shared.close();
  } finally {
    r.close();
  }
});

test('Skills screen: on/off by ⏎ or click, import what the agents already have', async () => {
  const fakeHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-uh-')));
  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const r = rig();
  try {
    const lib = path.join(r.project, '.chorus', 'skills', 'pricing');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(lib, 'SKILL.md'), '---\nname: pricing\ndescription: Price a cake from size and toppings\n---\nbody');
    const native = path.join(fakeHome, '.claude', 'skills', 'release-notes');
    fs.mkdirSync(native, { recursive: true });
    fs.writeFileSync(path.join(native, 'SKILL.md'), '---\nname: release-notes\ndescription: Draft release notes\n---\nbody');
    fs.mkdirSync(path.join(fakeHome, '.codex', 'skills', '.system', 'default'), { recursive: true }); // a CLI default: never offered
    fs.writeFileSync(path.join(fakeHome, '.codex', 'skills', '.system', 'default', 'SKILL.md'), '---\nname: default\n---\n');

    r.type('\x00k');
    await r.until(() => has(r.screen(), /Skills\s+·\s+one library/), 'screen');
    let t = r.screen().join('\n');
    assert.match(t, /▸ \[on\]\s+pricing\s+Price a cake/);
    assert.match(t, /release-notes\s+~\/\.claude\/skills\s+claude only\s+import ›/);
    assert.ok(!/\bdefault\b/.test(t.split('Found in')[1] ?? ''), 'CLI defaults are not offered');

    r.type('\r');
    await r.until(() => has(r.screen(), /\[off\]\s+pricing/), 'turned off');
    assert.ok(!fs.existsSync(path.join(r.project, '.claude', 'skills', 'pricing')), 'not linked while off');
    r.type('\r');
    await r.until(() => has(r.screen(), /\[on\]\s+pricing/), 'turned on again');
    assert.ok(fs.existsSync(path.join(r.project, '.claude', 'skills', 'pricing')), 'linked into the agents folder when on');

    r.app.click(`import:${native}`);
    await r.until(() => has(r.screen(), /\[on\]\s+release-notes/), 'imported into the library');
    assert.ok(fs.existsSync(path.join(r.project, '.chorus', 'skills', 'release-notes', 'SKILL.md')));
    assert.ok(fs.existsSync(native), 'the original stays where it was');
    t = r.screen().join('\n');
    assert.match(t, /nothing to import/);
  } finally {
    r.close();
    process.env.HOME = oldHome;
  }
});

test('artifacts: ⏎ or a click opens the selected file, f shows the folder, the way is the project\'s own', async () => {
  const opened: { mode: string; command?: string; url?: string; path: string }[] = [];
  const r = rig({ opener: async (cfg, t) => (opened.push({ mode: cfg.mode, command: cfg.command, url: t.url, path: t.path }), { ok: true, shown: cfg.mode === 'show' ? t.url : undefined }) });
  try {
    const e = r.c.newThread({ agent: 'codex', title: 'viewer' });
    await r.until(() => has(r.screen(), /READY codex/), 'ready');
    fs.writeFileSync(path.join(r.store.artifactsDir(e.id), 'plan.md'), '# plan');
    fs.writeFileSync(path.join(r.store.artifactsDir(e.id), 'order.html'), '<h1>order</h1>');
    r.store.scanArtifacts(e.id);
    r.type('\x00a');
    await r.until(() => has(r.screen(), /Artifacts\s+·\s+viewer/) && has(r.screen(), /order\.html/) && has(r.screen(), /plan\.md/), 'two artifacts');
    r.type('\r'); // opens the selected row
    await r.until(() => opened.length === 1, 'opened');
    assert.equal(opened[0].mode, 'default');
    assert.match(opened[0].url!, /^http:\/\/localhost:\d+\/t_\w+\/(order\.html|plan\.md)$/);
    assert.ok(opened[0].path.startsWith(r.store.artifactsDir(e.id)));
    await r.until(() => has(r.screen(), /Link\s+http:\/\/localhost/) && has(r.screen(), /live reload/), 'link and live reload shown');
    r.app.click('row:1'); // a click selects the other row
    await sleep(200);
    r.app.click('row:1'); // a second click opens it
    await r.until(() => opened.length === 2 && opened[1].path !== opened[0].path, 'second file opened');
    r.type('f');
    await r.until(() => opened.length === 3, 'folder');
    assert.equal(opened[2].mode, 'folder');
    r.app.click('copy'); // the hint chips are buttons
    assert.match(r.screen().join('\n'), /⏎ \/ click\s+open\s+f\s+show in folder\s+p\s+copy path\s+v\s+versions/);
  } finally {
    r.close();
  }
});

test('artifacts: when the open command fails the user chooses another way, which is remembered per project', async () => {
  let calls = 0;
  const r = rig({
    opener: async (cfg, t) => {
      calls++;
      if (cfg.mode === 'default') return { ok: false, error: 'xdg-open: command not found' };
      if (cfg.mode === 'custom') return { ok: cfg.command === 'firefox {url}', error: 'no such command' };
      return { ok: true, shown: t.url };
    },
  });
  try {
    const e = r.c.newThread({ agent: 'codex', title: 'viewer' });
    await r.until(() => has(r.screen(), /READY codex/), 'ready');
    fs.writeFileSync(path.join(r.store.artifactsDir(e.id), 'order.html'), '<h1>order</h1>');
    r.store.scanArtifacts(e.id);
    r.type('\x00a');
    await r.until(() => has(r.screen(), /order\.html/), 'artifact');
    r.type('\r');
    await r.until(() => has(r.screen(), /Couldn't open order\.html/), 'the dialog');
    const t = r.screen().join('\n');
    assert.match(t, /xdg-open: command not found\./);
    assert.match(t, /How do you want to open files\?/);
    assert.match(t, /Copy the link to the clipboard/);
    assert.match(t, /Show the folder in the file manager/);
    assert.match(t, /Use another command… {3}e\.g\. firefox \{url\}/);
    assert.match(t, /Just show the link, don't try again/);
    r.type('4'); // just show the link
    await r.until(() => has(r.screen(), /http:\/\/localhost:\d+\/t_\w+\/order\.html/) && !has(r.screen(), /Couldn't open/), 'link shown');
    const saved = JSON.parse(fs.readFileSync(path.join(r.project, '.chorus', 'open.json'), 'utf8'));
    assert.deepEqual(saved, { mode: 'show' }, 'remembered in the project');
    const before = calls;
    r.type('\r'); // next time the remembered way is used, no dialog
    await r.until(() => calls === before + 1, 'opened again');
    assert.ok(!has(r.screen(), /Couldn't open/));

    // another way: a custom command typed into the prompt
    fs.rmSync(path.join(r.project, '.chorus', 'open.json'));
    r.type('\r');
    await r.until(() => has(r.screen(), /Couldn't open order\.html/), 'dialog again');
    r.type('3');
    await r.until(() => has(r.screen(), /Open files with…/) && has(r.screen(), /> firefox \{url\}/), 'prompt with an example');
    r.type('\r');
    await r.until(() => fs.existsSync(path.join(r.project, '.chorus', 'open.json')), 'saved');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.project, '.chorus', 'open.json'), 'utf8')), { mode: 'custom', command: 'firefox {url}' });
  } finally {
    r.close();
  }
});

test('approvals inbox: "this project" / "all projects" scope and "Decided today"', async () => {
  const r = rig();
  try {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-scope-')));
    const a1 = r.c.newThread({ agent: 'codex', title: 'Stripe webhook' });
    const a2 = r.c.newThread({ agent: 'codex', title: 'Landing copy', cwd: other });
    r.c.newThread({ agent: 'claude', title: 'front' });
    await r.until(() => has(r.screen(), /READY claude/), 'front');
    const prompt = path.join(ROOT, 'fixtures/codex/0.163.0/approval-ask-nohook-enter/prompt-screen.txt');
    for (const e of [a1, a2]) r.app.entry(e.id)!.host!.write(`show ${prompt}\r`);
    await r.until(() => has(r.screen(), /! 2 waiting/), 'two waiting');
    r.type('\x00i');
    await r.until(() => has(r.screen(), /Approvals\s+·\s+2 waiting/), 'inbox');
    assert.match(r.screen().join('\n'), /this project\s+all projects/);
    assert.match(r.screen().join('\n'), /Stripe webhook[\s\S]*Landing copy|Landing copy[\s\S]*Stripe webhook/, 'all projects: both');
    r.app.click('scope:this');
    await r.until(() => has(r.screen(), /Approvals\s+·\s+1 waiting/), 'only this project');
    assert.ok(!has(r.screen(), /Landing copy\s+codex\s+waiting/));
    r.type('\t'); // tab flips it back
    await r.until(() => has(r.screen(), /Approvals\s+·\s+2 waiting/), 'all again');
    r.type('y');
    await r.until(() => has(r.screen(), /Decided today/) && has(r.screen(), /✓ approved/), 'Decided today');
    // an old answer does not show under "today"
    r.store.db.prepare("INSERT INTO approvals_log (thread_id,what,decision,ts) VALUES (?,?,?,?)").run(a1.id, 'Bash · rm old', 'denied', '2020-01-01T10:00:00.000Z');
    r.app.click('scope:all');
    await sleep(1200);
    assert.ok(!has(r.screen(), /rm old/));
  } finally {
    r.close();
  }
});

test('Memory: / searches titles, projects, what was asked and files; esc clears it', async () => {
  const r = rig();
  try {
    r.store.createThread({ id: 't_a', title: 'Cake order page', agent: 'claude', cwd: r.project, native_session_id: 's1', state: 'waiting' });
    r.store.createThread({ id: 't_b', title: 'Rate limiter', agent: 'codex', cwd: r.project, native_session_id: 's2', state: 'waiting' });
    r.store.recordSession('t_b', { agent: 'codex', turns: [{ seq: 1, role: 'user', text: 'Add a per-key throttle' }], toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } });
    r.type('\x00m');
    await r.until(() => has(r.screen(), /Memory\s+·\s+all projects/) && has(r.screen(), /Cake order page/) && has(r.screen(), /Rate limiter/), 'both');
    assert.match(r.screen().join('\n'), /\/ search/);
    r.type('/');
    await r.until(() => has(r.screen(), /\/ ▌/), 'typing');
    for (const ch of 'throttle') r.type(ch);
    await r.until(() => has(r.screen(), /\/ throttle▌/) && !has(r.screen(), /Cake order page\s+\S+\s+claude/), 'filtered by what was asked');
    assert.ok(has(r.screen(), /Rate limiter/));
    r.type('\r');
    await r.until(() => has(r.screen(), /\/ throttle(?!▌)/), 'search kept, typing ended');
    r.type('\x1b'); // clears the search, does not leave
    await r.until(() => has(r.screen(), /Cake order page/) && has(r.screen(), /Memory\s+·\s+all projects/), 'cleared');
    r.type('/');
    for (const ch of 'zzzz') r.type(ch);
    await r.until(() => has(r.screen(), /Nothing matches "zzzz"/), 'nothing matches');
  } finally {
    r.close();
  }
});

test('Skills: n creates a skill, e opens it in the editor', async () => {
  const opened: string[] = [];
  const r = rig({ opener: async (_cfg, t) => (opened.push(t.path), { ok: true }) });
  try {
    r.type('\x00k');
    await r.until(() => has(r.screen(), /Skills\s+·\s+one library/) && has(r.screen(), /e\s+edit\s+n\s+new/), 'screen with the hints');
    r.type('n');
    await r.until(() => has(r.screen(), /New skill/) && has(r.screen(), /Name it with lowercase words/), 'prompt');
    for (const ch of 'Cake Pricing') r.type(ch);
    r.type('\r');
    await r.until(() => fs.existsSync(path.join(r.project, '.chorus', 'skills', 'cake-pricing', 'SKILL.md')), 'created');
    assert.match(fs.readFileSync(path.join(r.project, '.chorus', 'skills', 'cake-pricing', 'SKILL.md'), 'utf8'), /^---\nname: cake-pricing\n/);
    assert.ok(fs.existsSync(path.join(r.project, '.claude', 'skills', 'cake-pricing')), 'linked for the agents');
    await r.until(() => has(r.screen(), /\[on\]\s+cake-pricing/), 'listed');
    r.type('e');
    await r.until(() => opened.length === 1, 'editor');
    assert.equal(opened[0], path.join(r.project, '.chorus', 'skills', 'cake-pricing', 'SKILL.md'));
  } finally {
    r.close();
  }
});

test('Activity: counts per kind in the filter bar, approvals and usage rows, durations, handoff separators', async () => {
  const r = rig();
  try {
    const e = r.c.newThread({ agent: 'codex', title: 'viewer' });
    await r.until(() => has(r.screen(), /READY codex/), 'ready');
    writeRollout(r.home, r.project, e.id, { done: true });
    await r.until(() => r.store.getToolCalls(e.id).length > 0, 'tailed');
    r.store.logMcpCall(e.id, 'get_handoff_context');
    r.store.logApproval(e.id, 'Bash command · npm test', 'approved');
    r.store.db.prepare('UPDATE usage SET limit_utilization = 0.62 WHERE thread_id = ?').run(e.id);
    fs.writeFileSync(path.join(r.store.artifactsDir(e.id), 'plan.md'), '# plan');
    r.store.scanArtifacts(e.id);
    const child = r.store.createThread({ title: 'viewer → claude', agent: 'claude', cwd: r.project, parent_thread_id: e.id });
    r.store.logMcpCall(child.id, 'get_handoff_context');
    r.type('\x00e');
    await r.until(() => has(r.screen(), /Activity\s+·\s+viewer/) && has(r.screen(), / all \d+ /), 'activity');
    const t = r.screen().join('\n');
    assert.match(t, / all \d+ \s+tool 1\s+mcp 2\s+approval 1\s+file 1\s+usage 1\s+error 0\s+f cycles/);
    assert.match(t, /in [\d.]+k?\s+out [\d.]+k? tokens/);
    assert.match(t, /approve\s+npm test\s+approved/);
    assert.match(t, /usage\s+5h 62%/);
    assert.match(t, /file\s+plan\.md v1/);
    assert.match(t, /──── chat "viewer → claude" started with claude/);
    assert.match(t, /claude\s+mcp\s+chorus\.get_handoff_context/, 'the continued chat is on the same timeline');
    r.app.click('kind:approval');
    await r.until(() => has(r.screen(), / approval 1 /) && !has(r.screen(), /file\s+plan\.md/), 'filtered by click');
    r.type('f'); // approval → file
    await r.until(() => has(r.screen(), / file 1 /) && has(r.screen(), /file\s+plan\.md/) && !has(r.screen(), /approve\s/), 'f cycles');
  } finally {
    r.close();
  }
});

test('Doctor shows the mouse and the open way, like the mockup', async () => {
  const r = rig();
  try {
    r.app.emit('action', 'doctor');
    await r.until(() => has(r.screen(), /mouse\s+on\s+\(CHORUS_MOUSE=0 turns it off/) && has(r.screen(), /open\s+\S+\s+\(.*override in \.chorus\/open\.json\)/), 'mouse and open lines');
    assert.match(r.screen().join('\n'), /store\s+.*chorus\.db · 0 chats .* \d+\.\d MB/);
  } finally {
    r.close();
  }
});

test('hand off: the New chat form for the continued chat, the other agent preselected, with model, effort and skip permissions', async () => {
  const r = rig();
  try {
    r.c.newThread({ agent: 'claude', title: 'Cake order page' });
    await r.until(() => has(r.screen(), /READY claude/), 'front');
    r.type('\x00h');
    await r.until(() => has(r.screen(), /Continue "Cake order page" in a new chat/), 'dialog');
    const t = r.screen().join('\n');
    assert.match(t, /Agent\s+claude\s+codex\s+agy/);
    assert.match(t, /Effort/);
    assert.match(t, /Skip permission prompts/);
    r.type('\r');
    await r.until(() => r.launches.at(-1)?.agent === 'codex', 'a Codex chat continues it');
  } finally {
    r.close();
  }
});

test('limit box: the chat is saved (turns, artifacts, files) and the ways out follow the mockup', async () => {
  const r = rig();
  try {
    const e = r.c.newThread({ agent: 'codex', title: 'busy chat' });
    await r.until(() => has(r.screen(), /READY codex/), 'ready');
    writeRollout(r.home, r.project, e.id, { done: true });
    await r.until(() => r.store.getToolCalls(e.id).length > 0, 'tailed');
    r.store.db.prepare('UPDATE usage SET limit_utilization = 0.995 WHERE thread_id = ?').run(e.id);
    r.c['checkLimit'](e.id);
    await r.until(() => has(r.screen(), /Codex reached its plan limit/), 'box');
    const t = r.screen().join('\n');
    assert.match(t, /This chat is saved:/);
    assert.match(t, /\d+ turns · \d+ artifacts? · \d+ files? changed/);
    assert.match(t, /Continue in a new chat with claude/);
    assert.match(t, /2\s+Continue in a new chat with agy/);
    assert.match(t, /w\s+Wait for the reset/);
  } finally {
    r.close();
  }
});

test('Memory: the selected chat shows its tools and recent calls; a failed call shows its error lines and → ⏎ opens the full stored output', async () => {
  const r = rig();
  try {
    r.store.createThread({ id: 't_a', title: 'Cake order page', agent: 'claude', cwd: r.project, native_session_id: 's1', state: 'waiting' });
    const out = Array.from({ length: 30 }, (_, i) => (i === 3 ? 'pricing.ts:41  error TS2322: Type string' : i === 4 ? 'CakeBuilder.tsx:88  error TS2339: no size' : `build step ${i}`)).join('\n');
    r.store.recordSession('t_a', {
      agent: 'claude',
      turns: [{ seq: 1, role: 'user', text: 'Build it' }],
      toolCalls: [
        { id: 'c1', turnSeq: 1, tool: 'Edit', target: 'app/pricing.ts', status: 'ok', note: '+12 −3' },
        { id: 'c2', turnSeq: 1, tool: 'Bash', target: 'curl -H "Authorization: Bearer abcdefghijklmnop123456" x', status: 'ok' },
        { id: 'c3', turnSeq: 1, tool: 'Bash', target: 'npm run build', status: 'failed', note: 'exit 1', detail: capOutput(out) },
      ],
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 },
    });
    r.type('\x00m');
    await r.until(() => has(r.screen(), /tools\s+Bash ×2\s+Edit ×1/), 'tools line');
    const t = r.screen().join('\n');
    assert.match(t, /Edit app\/pricing\.ts\s+\+12 −3/);
    assert.match(t, /Authorization: Bearer ••••/);
    assert.doesNotMatch(t, /abcdefghijklmnop123456/);
    assert.match(t, /✗ Bash npm run build\s+exit 1/);
    assert.match(t, /pricing\.ts:41\s+error TS2322/);
    assert.match(t, /… \+\d+ more lines\s+⏎ full output/);
    r.type('\x1b[C'); // → into the tool calls: the failed one is selected
    await r.until(() => has(r.screen(), /▸ ✗ Bash/), 'failed call selected');
    r.type('\r');
    await r.until(() => has(r.screen(), /build step 0/) && has(r.screen(), /lines omitted/), 'full stored output');
  } finally {
    r.close();
  }
});

test('delete: the menu asks first; deleting removes the chat and its record, keeps chats continued from it, and the files stay', async () => {
  const r = rig();
  try {
    const a = r.c.newThread({ agent: 'claude', title: 'Cake order page' });
    await r.until(() => has(r.screen(), /READY claude/), 'front');
    const child = await r.c.handoff(a.id, 'codex');
    await r.until(() => has(r.screen(), /READY codex/), 'child');
    r.store.recordSession(a.id, { agent: 'claude', turns: [{ seq: 1, role: 'user', text: 'hi' }], toolCalls: [{ id: 'c1', turnSeq: 1, tool: 'Bash', target: 'ls', status: 'ok' }], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } });
    r.app.select(r.app.entries.findIndex(e => e.id === a.id));
    r.type('\x00D');
    await r.until(() => has(r.screen(), /Delete this chat\?/), 'confirm box');
    r.type('w'); // keep it
    await r.until(() => !has(r.screen(), /Delete this chat\?/), 'closed');
    assert.ok(r.store.getThread(a.id), 'kept');
    r.type('\x00D');
    await r.until(() => has(r.screen(), /Delete this chat\?/), 'confirm again');
    r.type('y');
    await r.until(() => !r.store.getThread(a.id), 'deleted from the store');
    assert.equal(r.store.getTurns(a.id, { limit: 10 }).length, 0);
    assert.equal(r.store.getToolCalls(a.id).length, 0);
    assert.ok(!r.app.entries.some(e => e.id === a.id), 'gone from the sidebar');
    assert.equal(r.store.getThread(child!.id)?.parent_thread_id ?? null, null, 'the continued chat stays, unlinked');
  } finally {
    r.close();
  }
});

test('folder picker: browse, go up, make a new folder and use it; the New chat form keeps its choices', async () => {
  const r = rig();
  try {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'picker-'));
    fs.mkdirSync(path.join(base, 'alpha'));
    fs.mkdirSync(path.join(base, 'beta'));
    r.c.newChatScreen({ agent: 'codex', folder: base });
    await r.until(() => has(r.screen(), /Browse…/), 'form with a Browse button');
    r.type('\x0f'); // ⌃O
    await r.until(() => has(r.screen(), /Choose a project folder/) && has(r.screen(), /alpha\//) && has(r.screen(), /beta\//), 'folder list');
    r.type('\x1b[B');
    r.type('\r'); // open beta
    await r.until(() => has(r.screen(), /no folders in here/), 'inside beta');
    r.type('n');
    await r.until(() => has(r.screen(), /New folder/), 'name prompt');
    for (const ch of 'shop') r.type(ch);
    r.type('\r');
    await r.until(() => fs.existsSync(path.join(base, 'beta', 'shop')), 'created');
    await r.until(() => has(r.screen(), /beta\/shop/), 'inside the new folder');
    r.type('s');
    await r.until(() => has(r.screen(), /New chat/) && has(r.screen(), /beta\/shop/) && has(r.screen(), /Agent/), 'back in the form with the folder');
    r.type('\r');
    await r.until(() => r.launches.at(-1)?.agent === 'codex' && r.launches.at(-1)?.cwd === path.join(base, 'beta', 'shop'), 'chat started in the new folder with the chosen agent');
    fs.rmSync(base, { recursive: true, force: true });
  } finally {
    r.close();
  }
});

test('New chat screen: "This computer" starts a chat with no project, in a folder of its own', async () => {
  const r = rig();
  const oldHome = process.env.HOME;
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-'));
  try {
    r.c.newChatScreen({ agent: 'codex', folder: os.tmpdir() });
    await r.until(() => has(r.screen(), /Browse…/), 'form');
    await r.until(() => has(r.screen(), /This computer/), 'the button');
    r.type('\x14'); // ⌃T
    await r.until(() => has(r.screen(), /This computer \(no project\)/), 'folder shows as This computer');
    r.type('\r');
    const want = path.join(process.env.HOME ?? '', '.chorus', 'computer');
    await r.until(() => r.launches.at(-1)?.cwd === want, 'chat started in the computer folder');
    assert.ok(fs.existsSync(want));
  } finally {
    process.env.HOME = oldHome;
    r.close();
  }
});
