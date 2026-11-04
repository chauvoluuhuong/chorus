// L2: the scripted fake agent (tools/fake-agent/script.ts) calls given tools with given arguments, through the real `chorus mcp`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mcpCommand } from '../../src/core/launch.ts';
import { Store } from '../../src/core/store.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FAKE = path.join(ROOT, 'tools/fake-agent/fake-agent.ts');
const TUI = path.join(ROOT, 'tools/fake-agent/fake-tui.mjs');
const require = createRequire(import.meta.url);

function setup() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-script-'));
  const store = new Store(project);
  store.createThread({ id: 't_script', title: 'Scripted', agent: 'codex', cwd: project, project, state: 'waiting' });
  store.close();
  return { project, mcp: mcpCommand(project, 't_script') };
}

const steps = (project: string) => [
  { say: 'working' },
  { write: { path: path.join(project, 'made/by-script.txt'), text: 'hello' } },
  { call: 'request_approval', args: { question: 'Ship it?' } },
  { call: 'list_threads', args: {} },
];

test('a script calls the given tools with the given arguments and writes its files', () => {
  const { project, mcp } = setup();
  const file = path.join(project, 'script.json');
  fs.writeFileSync(file, JSON.stringify(steps(project)));
  const r = spawnSync(process.execPath, [FAKE, '--mcp-command', mcp.command, '--mcp-args', JSON.stringify(mcp.args), '--script', file, 'go'], { cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const events = r.stdout.trim().split('\n').map(l => JSON.parse(l));
  const tools = events.filter(e => e.item?.type === 'mcp_tool_call').map(e => [e.item.tool, e.item.arguments, e.item.status]);
  assert.deepEqual(tools, [['request_approval', { question: 'Ship it?' }, 'completed'], ['list_threads', {}, 'completed']]);
  assert.equal(fs.readFileSync(path.join(project, 'made/by-script.txt'), 'utf8'), 'hello');
  const store = new Store(project);
  assert.deepEqual(store.pendingRequests('t_script').map(r => r.question), ['Ship it?']);
  store.close();
});

test('a tool the server refuses is reported as failed, and the script goes on', () => {
  const { project, mcp } = setup();
  const file = path.join(project, 'script.json');
  fs.writeFileSync(file, JSON.stringify([{ call: 'get_skill', args: { name: 'no-such-skill' } }, { say: 'still here' }]));
  const r = spawnSync(process.execPath, [FAKE, '--mcp-command', mcp.command, '--mcp-args', JSON.stringify(mcp.args), '--script', file, 'go'], { cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const events = r.stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.equal(events.find(e => e.item?.tool === 'get_skill').item.status, 'failed');
  assert.equal(events.find(e => e.item?.type === 'agent_message').item.text, 'still here');
});

test('an exit step ends the agent with that code', () => {
  const { project, mcp } = setup();
  const file = path.join(project, 'script.json');
  fs.writeFileSync(file, JSON.stringify([{ exit: 3 }, { say: 'never' }]));
  const r = spawnSync(process.execPath, [FAKE, '--mcp-command', mcp.command, '--mcp-args', JSON.stringify(mcp.args), '--script', file, 'go'], { cwd: project, encoding: 'utf8' });
  assert.equal(r.status, 3);
});

test('the fake TUI plays a script on its screen', async () => {
  const pty = require('node-pty');
  const { project, mcp } = setup();
  const file = path.join(project, 'script.json');
  fs.writeFileSync(file, JSON.stringify(steps(project)));
  const p = pty.spawn(process.execPath, [TUI, 'codex', mcp.command, JSON.stringify(mcp.args)], { name: 'xterm-256color', cols: 200, rows: 30, cwd: project, env: { ...process.env, CHORUS_FAKE_SCRIPT: file } });
  let screen = '';
  p.onData((d: string) => (screen += d));
  const end = Date.now() + 15000;
  while (!screen.includes('CALLED list_threads') && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  p.kill();
  assert.match(screen, /working/);
  assert.match(screen, /CALLED request_approval \{"question":"Ship it\?"\}/);
  assert.match(screen, /CALLED list_threads/);
});
