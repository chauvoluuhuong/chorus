// The Controller and request_approval cards: shown like a permission prompt, answered by typing into the agent; agy's
// prompts for Chorus's own MCP tools are answered for the user. The agent is the fake TUI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import { headlessApp } from '../../src/serve/server.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-tui.mjs');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function rig() {
  process.env.CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-home-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-req-')));
  const store = new Store(project);
  const c = new Controller({ project, store, app: headlessApp(), tailPollMs: 100, launcher: (agent, o) => ({ bin: process.execPath, args: [FAKE, agent], cwd: o.cwd }) });
  const screen = (id: string) => c.app.entry(id)!.host!.screen.text().join('\n');
  const until = async (pred: () => boolean, what: string, ms = 6000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred()) return;
      await sleep(50);
    }
    assert.fail(`timed out: ${what}`);
  };
  const done = async () => {
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await sleep(300);
    store.close();
  };
  return { c, store, project, screen, until, done };
}

test('request_approval: a card from a running chat is listed with its options; the answer is typed into the agent as its next message', async () => {
  const r = await rig();
  try {
    const a = r.c.newThread({ agent: 'codex' });
    const b = r.c.newThread({ agent: 'claude' }); // in front
    await r.until(() => /READY codex/.test(r.screen(a.id)), 'codex up');
    const req = r.store.createRequest({ threadId: a.id, question: 'Apply the migration plan?', details: 'adds a column', options: ['Apply', 'Not yet'] });
    await r.until(() => r.c.approvalItems().length === 1, 'the card is listed');
    const item = r.c.approvalItems()[0] as any;
    assert.equal(item.kind, 'ask');
    assert.equal(item.id, a.id);
    assert.equal(item.request, req.id);
    assert.deepEqual(item.options, ['Apply', 'Not yet']);
    assert.equal(item.details, 'adds a column');
    assert.equal(r.c.app.entry(a.id)!.state, 'approval', 'the chat shows it waits for you');
    assert.equal(r.c.app.waitingProvider(), 1, 'the top bar counts it');
    assert.equal(r.c.answerRequest(req.id, 'Apply', 'but back up first'), true);
    await r.until(() => r.screen(a.id).includes(`got: "Chorus approval ${req.id}: Apply (but back up first)"`), 'typed into the agent, Enter apart');
    assert.equal(r.store.getRequest(req.id)!.status, 'answered');
    assert.equal(r.store.approvalsLog()[0].decision, 'approved');
    assert.match(r.store.approvalsLog()[0].what, /Apply the migration plan\? → Apply/);
    await r.until(() => r.c.approvalItems().length === 0 && r.c.app.entry(a.id)!.state !== 'approval', 'the card leaves');
    assert.equal(r.c.answerRequest(req.id, 'Not yet'), false, 'answered once');
    // y on a chat that waits on a card (and no prompt on its screen) picks the first option, x the last
    const q = r.store.createRequest({ threadId: b.id, question: 'Ship it?', options: ['Ship', 'Wait'] });
    await r.until(() => r.c.approvalItems().length === 1, 'second card');
    assert.equal(r.c.answer(false, b.id), true);
    await r.until(() => r.screen(b.id).includes(`got: "Chorus approval ${q.id}: Wait"`), 'x picked the last option');
    assert.equal(r.store.approvalsLog()[0].decision, 'approved', '"Wait" is not a refusal word');
    // a card of a chat this app does not run is not shown here (another app hosts it)
    r.store.createThread({ id: 't_other', title: 'elsewhere', agent: 'claude', cwd: r.project });
    r.store.createRequest({ threadId: 't_other', question: 'Not mine?' });
    await sleep(600);
    assert.equal(r.c.approvalItems().length, 0);
  } finally {
    await r.done();
  }
});

test('agy: a prompt for one of Chorus\'s own MCP tools is answered "always allow in this conversation" and never shown', async () => {
  const r = await rig();
  try {
    const a = r.c.newThread({ agent: 'agy' });
    await r.until(() => /READY agy/.test(r.screen(a.id)), 'agy up');
    r.c.app.entry(a.id)!.host!.write(`show ${path.join(ROOT, 'fixtures/agy/1.4.4/approval-mcp-tool/prompt-screen.txt')}\r`);
    await r.until(() => /Allow calling this tool\?/.test(r.screen(a.id)), 'the prompt is on screen');
    await sleep(900); // a few detector rounds
    assert.equal(r.c.approvalItems().length, 0, 'not in the inbox');
    // the fake agent collects keys up to Enter: what Chorus typed is "2" (the option), once
    r.c.app.entry(a.id)!.host!.write('\r');
    await r.until(() => /got: "2"/.test(r.screen(a.id)), 'option 2 was typed');
  } finally {
    await r.done();
  }
});

// Stale asks (plan 2026-11-12): one open card per chat, and a card the user answered by typing leaves. The transcripts are driven
// by hand here (the fake agent writes none): `turn` is what the tailer reports when the chat's turn starts or ends.
const turn = (c: Controller, id: string, status: 'working' | 'waiting') => (c as any).onSession(id, { status, turns: [] });

test('stale asks: a new request cancels the older pending ones of the same chat only, and nothing is logged', () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-req-')));
  const store = new Store(project);
  try {
    for (const id of ['t_a', 't_b']) store.createThread({ id, title: id, agent: 'claude', cwd: project });
    const first = store.createRequest({ threadId: 't_a', question: 'Right of the filters?' });
    const other = store.createRequest({ threadId: 't_b', question: 'Ship it?' });
    const second = store.createRequest({ threadId: 't_a', question: 'Above the table, then?' });
    assert.equal(store.getRequest(first.id)!.status, 'cancelled', 'the older ask of that chat is cancelled');
    assert.deepEqual(store.pendingRequests('t_a').map(r => r.id), [second.id], 'only the newest one is open');
    assert.equal(store.getRequest(other.id)!.status, 'pending', "another chat's ask stays");
    assert.equal(store.approvalsLog().length, 0, 'a cancelled ask is not an approval');
  } finally {
    store.close();
  }
});

test('stale asks: the user answers by typing in the chat (idle → working while the card is open): the card leaves, unlogged', async () => {
  const r = await rig();
  try {
    const a = r.c.newThread({ agent: 'codex' });
    await r.until(() => /READY codex/.test(r.screen(a.id)), 'codex up');
    turn(r.c, a.id, 'working');
    const req = r.store.createRequest({ threadId: a.id, question: 'Put the Export button right of the filters?', options: ['Right', 'Above'] });
    await r.until(() => r.c.approvalItems().length === 1, 'the card is listed');
    turn(r.c, a.id, 'waiting'); // the agent ended its turn after asking
    turn(r.c, a.id, 'working'); // the user answered in the chat itself
    assert.equal(r.store.getRequest(req.id)!.status, 'cancelled', 'answering by typing cancels it');
    await r.until(() => r.c.approvalItems().length === 0 && r.c.app.entry(a.id)!.state !== 'approval', 'the card leaves');
    assert.equal(r.c.app.waitingProvider(), 0, 'the top bar no longer counts it');
    assert.equal(r.store.approvalsLog().length, 0, 'not written to the approvals log');
    assert.doesNotMatch(r.screen(a.id), /Chorus approval/, 'nothing typed into the agent');
  } finally {
    await r.done();
  }
});

test('stale asks: asked, the turn ends and the chat stays idle: the card stays until the next turn starts', async () => {
  const r = await rig();
  try {
    const a = r.c.newThread({ agent: 'codex' });
    await r.until(() => /READY codex/.test(r.screen(a.id)), 'codex up');
    turn(r.c, a.id, 'working');
    const req = r.store.createRequest({ threadId: a.id, question: 'Which export format?', options: ['CSV', 'XLSX'] });
    await r.until(() => r.c.approvalItems().length === 1, 'the card is listed');
    turn(r.c, a.id, 'waiting');
    await sleep(600); // a few detector rounds
    turn(r.c, a.id, 'waiting'); // the same idle chat, reported again
    assert.equal(r.store.getRequest(req.id)!.status, 'pending', 'the card stays while the chat is idle');
    assert.equal(r.c.approvalItems().length, 1);
    assert.equal(r.c.app.entry(a.id)!.state, 'approval');
    turn(r.c, a.id, 'working');
    await r.until(() => r.c.approvalItems().length === 0, 'the next turn removes it');
    assert.equal(r.store.getRequest(req.id)!.status, 'cancelled');
  } finally {
    await r.done();
  }
});

test('stale asks: an ask made in a new turn the tailer has not seen start yet is kept; answering from the card is unchanged', async () => {
  const r = await rig();
  try {
    const a = r.c.newThread({ agent: 'codex' });
    await r.until(() => /READY codex/.test(r.screen(a.id)), 'codex up');
    turn(r.c, a.id, 'waiting');
    await sleep(5);
    // the user typed and the agent asked at once; the transcript shows the turn only now
    const req = r.store.createRequest({ threadId: a.id, question: 'Run the migration?', options: ['Run', 'Wait'] });
    turn(r.c, a.id, 'working');
    assert.equal(r.store.getRequest(req.id)!.status, 'pending', 'an ask of the turn that just started is not stale');
    await r.until(() => r.c.approvalItems().length === 1, 'the card is listed');
    turn(r.c, a.id, 'waiting');
    assert.equal(r.c.answerRequest(req.id, 'Run'), true);
    turn(r.c, a.id, 'working'); // the answer typed into the agent starts its turn
    assert.equal(r.store.getRequest(req.id)!.status, 'answered');
    await r.until(() => r.screen(a.id).includes(`got: "Chorus approval ${req.id}: Run"`), 'typed into the agent');
    assert.equal(r.store.approvalsLog()[0].decision, 'approved');
  } finally {
    await r.done();
  }
});
