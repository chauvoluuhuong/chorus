// L2: the chorus request_approval tool (an agent asks the user through a card) and the note every agent gets about it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { artifactNote, mcpCommand } from '../../src/core/launch.ts';
import { Store } from '../../src/core/store.ts';
import { APPROVAL_NOTE } from '../../src/mcp/server.ts';

const text = (r: any) => r.content.map((x: any) => x.text).join('');

async function client(proj: string, threadId: string) {
  const m = mcpCommand(proj, threadId);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StdioClientTransport({ command: m.command, args: m.args }));
  return c;
}

test('request_approval: the question becomes a pending card in the store and the tool tells the agent to end its turn', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-req-'));
  const store = new Store(proj);
  store.createThread({ id: 't1', title: 'plan', agent: 'agy', cwd: proj });
  const c = await client(proj, 't1');
  try {
    // Claude and agy read the server instructions, Codex its developer instructions: both carry the note
    assert.ok(c.getInstructions()?.includes(APPROVAL_NOTE));
    assert.ok(artifactNote(proj, 't1').includes(APPROVAL_NOTE));
    const r = await c.callTool({ name: 'request_approval', arguments: { question: 'Apply the plan?', details: '1. add hello.txt\n2. commit' } });
    assert.match(text(r), /approval card r_[0-9a-f]{8} with the options: Approve \/ Decline\. End your turn/);
    const p = store.pendingRequests('t1');
    assert.equal(p.length, 1);
    assert.equal(p[0].question, 'Apply the plan?');
    assert.equal(p[0].details, '1. add hello.txt\n2. commit');
    assert.deepEqual(p[0].options, ['Approve', 'Decline']);
    await c.callTool({ name: 'request_approval', arguments: { question: 'Which database?', options: ['Postgres', 'SQLite', 'Ask me later'] } });
    assert.deepEqual(store.pendingRequests('t1')[1].options, ['Postgres', 'SQLite', 'Ask me later']);
    // answered once only (two windows, or the CLI app and the desktop)
    assert.equal(store.answerRequest(p[0].id, 'Approve', 'go'), true);
    assert.equal(store.answerRequest(p[0].id, 'Decline'), false);
    assert.equal(store.getRequest(p[0].id)?.answer, 'Approve');
    assert.equal(store.pendingRequests('t1').length, 1);
    assert.ok(store.mcpCalls('t1').some(m => m.tool === 'request_approval'));
  } finally {
    await c.close();
    store.close();
  }
});

test('agy: a chat start writes the note as a rule of a Chorus workspace plugin, kept out of git', async () => {
  const { buildInteractive } = await import('../../src/core/launch.ts');
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-agyrule-')));
  fs.mkdirSync(path.join(proj, '.git', 'info'), { recursive: true });
  buildInteractive('agy', { cwd: proj, project: proj, threadId: 't_rule' });
  const dir = path.join(proj, '.agents', 'plugins', 'chorus');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')), { name: 'chorus' });
  const rule = fs.readFileSync(path.join(dir, 'rules', 'AGENTS.md'), 'utf8');
  assert.ok(rule.includes('This chat is Chorus thread t_rule'));
  assert.ok(rule.includes(APPROVAL_NOTE));
  assert.match(fs.readFileSync(path.join(proj, '.git', 'info', 'exclude'), 'utf8'), /^\.agents\/plugins\/chorus\/$/m);
  assert.ok(JSON.parse(fs.readFileSync(path.join(proj, '.agents', 'mcp_config.json'), 'utf8')).mcpServers.chorus, 'the MCP server too');
});
