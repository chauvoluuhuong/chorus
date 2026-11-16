// Every chat Chorus starts reads Chorus's intro first (plan 2026-11-14, Stage 5; owner, 2026-11-16: "regardless the instruction
// we always add this system prompt at the first place"): for each CLI, interactive and headless, with and without a teammate's
// note, a resumed chat and a sub thread. Nothing runs: the launch lines are only built.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { artifactNote, buildHeadless, buildInteractive, type Launch } from '../../src/core/launch.ts';
import { APPROVAL_NOTE, ARTIFACT_NOTE, CHORUS_INTRO, createServer, SUBTHREADS_NOTE } from '../../src/mcp/server.ts';
import { SUB_NOTE } from '../../src/serve/subthreads.ts';
import type { AgentId } from '../../src/core/types.ts';

const AGENTS: AgentId[] = ['claude', 'codex', 'agy'];
const TEAMMATE_NOTE = 'You are the Reviewer of this team. Review the step against the plan before you reply.';

/** The standing text a CLI gets from its launch line: Claude's system prompt addition, Codex's developer instructions, agy's rules file. */
function standing(agent: AgentId, l: Launch, cwd: string): string {
  if (agent === 'claude') return l.args[l.args.indexOf('--append-system-prompt') + 1];
  if (agent === 'codex') return JSON.parse(l.args.find(a => a.startsWith('developer_instructions='))!.slice('developer_instructions='.length));
  const rules = fs.readFileSync(path.join(cwd, '.agents', 'plugins', 'chorus', 'rules', 'AGENTS.md'), 'utf8');
  // after the file's own comment and "# Chorus" heading, the note's first line
  return rules.split('\n').filter(x => x && !x.startsWith('<!--') && !x.startsWith('#')).join('\n');
}
const cwd = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-note-')));

test('the note is in one fixed order: the intro, the thread id, artifacts, approvals, sub threads; under 3 KB', () => {
  const n = artifactNote('/p', 't_1234abcd');
  assert.ok(n.startsWith(CHORUS_INTRO));
  const at = [CHORUS_INTRO, 'This chat is Chorus thread t_1234abcd.', ARTIFACT_NOTE, APPROVAL_NOTE, SUBTHREADS_NOTE].map(x => n.indexOf(x));
  assert.ok(at.every(i => i >= 0), 'every part is there');
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'in this order');
  assert.ok(Buffer.byteLength(n) < 3072, `${Buffer.byteLength(n)} bytes: Claude's MCP instructions stop near 4 KB`);
});

for (const agent of AGENTS) {
  test(`${agent}: the standing text starts with the intro, interactive and headless, with and without a teammate's note, resumed, a sub thread`, () => {
    const cases: [string, (dir: string) => Launch][] = [
      ['interactive', dir => buildInteractive(agent, { cwd: dir, project: dir, threadId: 't_a', prompt: 'hi' })],
      ['interactive with a teammate\'s note', dir => buildInteractive(agent, { cwd: dir, project: dir, threadId: 't_b', prompt: 'hi', note: TEAMMATE_NOTE })],
      ['resumed', dir => buildInteractive(agent, { cwd: dir, project: dir, threadId: 't_c', resumeId: 'sess-1' })],
      ['a sub thread', dir => buildInteractive(agent, { cwd: dir, project: dir, threadId: 't_d', prompt: `Make the price list.\n\n${SUB_NOTE}` })],
      ['headless', dir => buildHeadless(agent, { cwd: dir, project: dir, threadId: 't_e', prompt: 'hi' })],
    ];
    for (const [what, build] of cases) {
      const dir = cwd();
      const text = standing(agent, build(dir), dir);
      assert.ok(text.startsWith(CHORUS_INTRO), `${agent} ${what}: ${text.slice(0, 80)}`);
      if (what.includes('note')) assert.ok(text.indexOf(TEAMMATE_NOTE) > text.indexOf(SUBTHREADS_NOTE), `${agent} ${what}: the teammate's note comes after Chorus's`);
    }
  });
}

test('the MCP server\'s instructions start with the intro too', async () => {
  const dir = cwd();
  const server = createServer(dir, 't_mcp', fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-note-home-')));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  assert.equal(client.getInstructions(), artifactNote(dir, 't_mcp'));
  assert.ok(client.getInstructions()!.startsWith(CHORUS_INTRO));
  await client.close();
});

test('Chorus\'s own sub thread tools never ask: Claude Code gets them in --allowedTools; Codex approves every chorus tool; agy is answered by Chorus', () => {
  const SUB = ['start_subthread', 'send_to_subthread', 'list_subthreads', 'stop_subthread'];
  for (const agent of AGENTS) {
    for (const [what, l] of [
      ['interactive', buildInteractive(agent, { cwd: cwd(), project: '/p', threadId: 't_t', prompt: 'hi' })],
      ['headless', buildHeadless(agent, { cwd: cwd(), project: '/p', threadId: 't_t', prompt: 'hi' })],
    ] as const) {
      if (agent === 'claude') {
        const allowed = l.args[l.args.indexOf('--allowedTools') + 1].split(',');
        for (const n of SUB) assert.ok(allowed.includes(`mcp__chorus__${n}`), `${what}: ${n}`);
        assert.ok(allowed.includes('mcp__chorus__request_approval'), `${what}: the others stay`);
      } else if (agent === 'codex') assert.ok(l.args.includes('mcp_servers.chorus.default_tools_approval_mode="approve"'), what);
    }
  }
});
