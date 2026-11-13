// L2 flow: store + capture + handoff + MCP server, with the fake agent standing in for a real CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { captureStream } from '../../src/core/capture.ts';
import { buildHandoff, handoffPrompt } from '../../src/core/handoff.ts';
import { mcpCommand, run } from '../../src/core/launch.ts';
import { ARTIFACT_NOTE } from '../../src/mcp/server.ts';
import { Store } from '../../src/core/store.ts';
import { syncSkills } from '../../src/core/skills.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-agent.ts');
const FIX = (p: string) => fs.readFileSync(path.join(ROOT, 'fixtures', p), 'utf8');

function project() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-flow-'));
}

async function client(proj: string, threadId: string) {
  const m = mcpCommand(proj, threadId);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StdioClientTransport({ command: m.command, args: m.args }));
  return c;
}
const text = (r: any) => r.content.map((x: any) => x.text).join('');

test('capture: a Claude headless run lands in the store and the handoff digest names the command', () => {
  const proj = project();
  const store = new Store(proj);
  const t = store.createThread({ id: 't1', title: 'shell task', agent: 'claude', cwd: proj });
  captureStream(store, t.id, FIX('claude/2.1.301/shell/stdout.jsonl'), 'run echo please');
  assert.equal(store.getTurns('t1').at(-1)?.text, 'chorus-probe-42');
  assert.ok(store.getThread('t1')!.native_session_id);
  const h = buildHandoff(store, store.getThread('t1')!);
  assert.match(h.text, /First request\nrun echo please/);
  assert.match(h.text, /✓ echo chorus-probe-\$\(\(6\*7\)\)/);
  assert.match(h.text, /Last assistant message\nchorus-probe-42/);
  // idempotent
  captureStream(store, t.id, FIX('claude/2.1.301/shell/stdout.jsonl'), 'run echo please');
  assert.equal(store.getToolCalls('t1').length, 1);
  store.close();
});

test('mcp: get_handoff_context returns the parent thread and the call is logged', async () => {
  const proj = project();
  const store = new Store(proj);
  const parent = store.createThread({ id: 'parent', title: 'parent work', agent: 'codex', cwd: proj });
  captureStream(store, parent.id, FIX('codex/0.163.0/shell/stdout.jsonl'), 'echo the probe string');
  store.createThread({ id: 'child', title: 'continue', agent: 'agy', cwd: proj, parent_thread_id: 'parent' });

  const c = await client(proj, 'child');
  // a failed assertion must not leave the server running (the test file would never exit)
  const t = setTimeout(() => void c.close(), 20000);
  t.unref();
  const tools = (await c.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(tools, ['get_handoff_context', 'get_skill', 'get_thread_turns', 'list_artifacts', 'list_skills', 'list_threads', 'request_approval', 'show_artifact']);
  const out = text(await c.callTool({ name: 'get_handoff_context', arguments: {} }));
  assert.match(out, /parent work/);
  assert.match(out, /echo the probe string/);
  assert.match(out, /chorus-probe-42/);
  const turns = text(await c.callTool({ name: 'get_thread_turns', arguments: { thread_id: 'parent', limit: 1 } }));
  assert.match(turns, /assistant: chorus-probe-42/);
  const list = text(await c.callTool({ name: 'list_threads', arguments: {} }));
  assert.match(list, /child\tagy.*\(this thread\)/);
  const bad = (await c.callTool({ name: 'get_thread_turns', arguments: { thread_id: 'nope' } })) as any;
  assert.equal(bad.isError, true);
  await c.close();
  assert.deepEqual(store.mcpCalls('child').map(m => m.tool), ['get_handoff_context', 'get_thread_turns', 'list_threads', 'get_thread_turns']);
  store.close();
});

test('mcp: skills tools serve the shared skills', async () => {
  const proj = project();
  fs.mkdirSync(path.join(proj, '.chorus/skills/kiwi'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.chorus/skills/kiwi/SKILL.md'), '---\nname: kiwi\ndescription: Use for the kiwi greeting.\n---\nAnswer kiwi-42\n');
  const c = await client(proj, 'x');
  assert.match(text(await c.callTool({ name: 'list_skills', arguments: {} })), /kiwi: Use for the kiwi greeting\./);
  assert.match(text(await c.callTool({ name: 'get_skill', arguments: { name: 'kiwi' } })), /Answer kiwi-42/);
  await c.close();
  syncSkills(proj);
});

test('handoff end to end with the fake agent: new thread loads the previous thread through MCP', async () => {
  const proj = project();
  const store = new Store(proj);
  const parent = store.createThread({ id: 'p', title: 'fix the bug', agent: 'claude', cwd: proj });
  captureStream(store, parent.id, FIX('claude/2.1.301/artifact/stdout.jsonl'), 'write the artifact');
  const child = store.createThread({ id: 'c', title: 'fix the bug', agent: 'codex', cwd: proj, parent_thread_id: 'p' });

  const m = mcpCommand(proj, child.id);
  const r = await run(
    { bin: process.execPath, cwd: proj, args: [FAKE, '--mcp-command', m.command, '--mcp-args', JSON.stringify(m.args), '--call', 'get_handoff_context', '--artifact', path.join(store.artifactsDir('c'), 'summary.md'), handoffPrompt(parent)] },
    { timeoutMs: 30_000 },
  );
  assert.equal(r.code, 0, r.stderr);
  const s = captureStream(store, child.id, r.stdout, handoffPrompt(parent));
  assert.ok(s.toolCalls.some(c => c.tool === 'mcp:chorus' && c.target === 'get_handoff_context' && c.status === 'ok'));
  assert.match(s.turns.at(-1)!.text, /fix the bug/);
  assert.ok(store.mcpCalls('c').some(x => x.tool === 'get_handoff_context'), 'Chorus saw the context load');
  assert.deepEqual(store.listArtifacts('c').map(a => a.path), ['summary.md']);
  store.close();
});

test('fake agent can simulate a plan-limit stop', async () => {
  const r = await run({ bin: process.execPath, cwd: os.tmpdir(), args: [FAKE, '--limit', 'hi'] }, { timeoutMs: 30_000 });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /usage limit reached/);
});

test('artifacts by report: the MCP server tells the agent to report what it makes with show_artifact, and names no folder', async () => {
  const proj = project();
  const c = await client(proj, 't_artifacts');
  const text = c.getInstructions() ?? '';
  await c.close();
  assert.match(text, /Chorus thread t_artifacts/);
  assert.ok(text.includes(ARTIFACT_NOTE));
  assert.ok(!text.includes(path.join('.chorus', 'threads')), 'no fixed folder');
  const none = await client(proj, '');
  void none; // a server without a thread id has no folder to name: nothing to assert, it must simply start
  await none.close();
});

test('artifacts by report: Codex gets the note as developer instructions (it does not show MCP server instructions to the model)', async () => {
  const { buildHeadless, buildInteractive, artifactNote } = await import('../../src/core/launch.ts');
  const proj = project();
  for (const l of [buildHeadless('codex', { prompt: 'hi', cwd: proj, project: proj, threadId: 't_9' }), buildInteractive('codex', { cwd: proj, project: proj, threadId: 't_9' })]) {
    const i = l.args.findIndex(a => a.startsWith('developer_instructions='));
    assert.ok(i > 0 && l.args[i - 1] === '-c', l.args.join(' ').slice(0, 200));
    assert.ok(l.args[i].includes('show_artifact'));
  }
  assert.match(artifactNote(proj, 't_9'), /Chorus thread t_9/);
});

test('show_artifact: a file (any folder, a relative path from the chat folder) or an http(s) link is listed; a missing file or another scheme is not', async () => {
  const proj = project();
  const store = new Store(proj);
  store.createThread({ id: 't_rep', title: 'report', agent: 'claude', cwd: proj });
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'docs', 'plan.md'), '# plan');
  const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-elsewhere-')), 'mock.html');
  fs.writeFileSync(elsewhere, '<p>mock</p>');
  const c = await client(proj, 't_rep');
  try {
    const say = async (target: string, title?: string) => { const r: any = await c.callTool({ name: 'show_artifact', arguments: { target, ...(title ? { title } : {}) } }); return { text: r.content[0].text as string, error: !!r.isError }; };
    assert.deepEqual(await say('docs/plan.md', 'The plan'), { text: `Listed in Artifacts: The plan (${path.join(proj, 'docs', 'plan.md')})`, error: false });
    assert.equal((await say(elsewhere)).error, false, 'wherever it is saved');
    assert.equal((await say('https://example.com/preview', 'Preview')).error, false);
    const missing = await say('docs/nope.md');
    assert.equal(missing.error, true);
    assert.match(missing.text, /no file at .*nope\.md\. Save it first/);
    assert.equal((await say('file:///etc/passwd')).error, true, 'only a path or an http(s) link');
    assert.equal((await say('javascript:alert(1)')).error, true);
    assert.deepEqual(store.reportedArtifacts('t_rep').map(r => [r.target, r.title]), [['https://example.com/preview', 'Preview'], [elsewhere, null], [path.join(proj, 'docs', 'plan.md'), 'The plan']]);
  } finally {
    await c.close();
    store.close();
  }
});
