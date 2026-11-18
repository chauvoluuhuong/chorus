// The start text every chat Chorus starts is told in its CLI's system channel (approved 2026-11-17): Claude's
// --append-system-prompt, Codex's developer instructions, agy's rules file. Lines in one order, each only when it exists: the
// Chorus line, the thread id, the sub thread line, the role, the actions, the action, the goals (Planners only). Codex and agy also
// get the chorus server's instructions after it; Claude reads those as MCP instructions. No line names a tool. Nothing runs: the
// launch lines are only built.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildHeadless, buildInteractive, type InteractiveOpts, type Launch } from '../../src/core/launch.ts';
import { CHORUS_LINE, createServer, MCP_INSTRUCTIONS, startText, TOOL_NAMES, type ThreadRole } from '../../src/mcp/server.ts';
import { TOOL_NAMES as SUB_TOOL_NAMES } from '../../src/serve/subthreads.ts';
import type { AgentId } from '../../src/core/types.ts';

const AGENTS: AgentId[] = ['claude', 'codex', 'agy'];

/** The standing text a CLI gets from its launch line: Claude's system prompt addition, Codex's developer instructions, agy's rules file. */
function standing(agent: AgentId, l: Launch, cwd: string): string {
  if (agent === 'claude') return l.args[l.args.indexOf('--append-system-prompt') + 1];
  if (agent === 'codex') return JSON.parse(l.args.find(a => a.startsWith('developer_instructions='))!.slice('developer_instructions='.length));
  const rules = fs.readFileSync(path.join(cwd, '.agents', 'plugins', 'chorus', 'rules', 'AGENTS.md'), 'utf8');
  // after the file's own comment and "# Chorus" heading; before chorus-core's line on where agy finds the tools
  return rules.replace(/^<!--.*-->\n\n# Chorus\n\n/, '').replace(/\n\nYour chorus tools are described in [^\n]*\n$/, '').replace(/\n$/, '');
}
const cwd = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-note-')));

const L1 =
  'You are working inside Chorus, an app where the user works with several AI coding agents in one place. Chorus is your harness for this chat: when one of its MCP tools (server `chorus`) fits what you are about to do, use it before your own way of doing it, and follow the chorus server\'s instructions.';
const PROPOSE = 'ask the user first through a Chorus question card: "Would you like me to <action>? <one line why>", before any skill or workflow of your own; start the action through Chorus only after they say yes, and end it through Chorus when its work and check are finished.';
const ALL = ['Create plan', 'Review changes', 'Resolve conflict', 'Inspect failure', 'Find goals'];

const PLANNER_INSTR = 'You are the Planner.\n\nWhen the user wants something built or changed, turn it into a Chorus task with its steps.';
const GOALS = [{ id: 'g1', title: 'Fast', doneWhen: 'Under 2 s' }];
const plannerChat: ThreadRole = { teammate: { id: 'planner', name: 'Planner', kind: 'planner' }, instructions: PLANNER_INSTR, actions: ['Create plan', 'Review changes'], action: null, task: null, step: null, goals: GOALS };
const workerStep: ThreadRole = {
  teammate: { id: 'worker-codex', name: 'Codex Worker', kind: 'worker' },
  instructions: 'You are Codex Worker.',
  actions: [],
  action: { id: 'buildTask', label: 'Do step', text: 'Do step, step 2 of 4 of task #8 "Start text". When your step is done, say so.' },
  task: { number: 8, title: 'Start text', state: 'doing', doneWhen: 'W' },
  step: { position: 2, of: 4, title: 'S2' },
  goals: [],
};
const runningPlanner: ThreadRole = { ...plannerChat, action: { id: 'planner', label: 'Planner', text: 'Planner of task #8 "Start text", now running. Each step reports to you.' }, task: { number: 8, title: 'Start text', state: 'doing', doneWhen: 'W' } };

/** Each kind of chat and the exact text it is told (approved 2026-11-17). */
const KINDS: { kind: string; opts: Omit<InteractiveOpts, 'cwd' | 'project'>; text: string }[] = [
  { kind: 'plain chat without the bundle', opts: { threadId: 't_plain' }, text: [L1, 'This chat is Chorus thread t_plain.'].join('\n\n') },
  {
    kind: 'plain chat with the bundle',
    opts: { threadId: 't_plain', actionLabels: ALL },
    text: [L1, 'This chat is Chorus thread t_plain.', `Chorus actions: ${ALL.join(', ')}. When one of them fits what the user wants better than what you are doing (for example Create plan for work to be built in steps, Review changes for finished work), ${PROPOSE}`].join('\n\n'),
  },
  {
    kind: 'Planner Just chat',
    opts: { threadId: 't_pl', role: plannerChat },
    text: [L1, 'This chat is Chorus thread t_pl.', `Your role: Planner (teammate "Planner"). Its instructions:\n${PLANNER_INSTR}`, `Your actions: Create plan, Review changes. When one of them fits what the user wants better than what you are doing, ${PROPOSE}`, 'Active goals of this project:\n- Fast (id g1). Done when: Under 2 s'].join('\n\n'),
  },
  {
    kind: 'Worker step',
    opts: { threadId: 't_w', role: workerStep },
    text: [L1, 'This chat is Chorus thread t_w.', 'Your role: Worker (teammate "Codex Worker"). Its instructions:\nYou are Codex Worker.', 'Your action: Do step, step 2 of 4 of task #8 "Start text". When your step is done, say so.'].join('\n\n'),
  },
  {
    kind: 'running Planner',
    opts: { threadId: 't_run', role: runningPlanner },
    text: [L1, 'This chat is Chorus thread t_run.', `Your role: Planner (teammate "Planner"). Its instructions:\n${PLANNER_INSTR}`, `Your actions: Create plan, Review changes. When one of them fits what the user wants better than what you are doing, ${PROPOSE}`, 'Your action: Planner of task #8 "Start text", now running. Each step reports to you.', 'Active goals of this project:\n- Fast (id g1). Done when: Under 2 s'].join('\n\n'),
  },
  {
    kind: 'sub thread',
    opts: { threadId: 't_sub', parent: { id: 't_main', title: 'Pricing page', brief: 'Make the price list.\nUse euros.' }, actionLabels: ALL },
    text: [
      L1,
      'This chat is Chorus thread t_sub.',
      'This chat is a sub thread of Chorus thread t_main ("Pricing page"), which started it to: Make the price list. Your main thread is who you work for: when you need a decision, an approval or a fact before you can go on, ask your main thread through Chorus and end your turn, never the user. When your work is done, say so in your reply and end your turn: Chorus reports it to your main thread.',
    ].join('\n\n'),
  },
];

test('the Chorus line is the approved text', () => assert.equal(CHORUS_LINE, L1));

for (const agent of AGENTS) {
  test(`${agent}: each kind of chat gets exactly its approved start text${agent === 'claude' ? '' : ', then the MCP instructions'}`, () => {
    for (const k of KINDS) {
      const dir = cwd();
      const want = agent === 'claude' ? k.text : `${k.text}\n\n${MCP_INSTRUCTIONS}`;
      assert.equal(standing(agent, buildInteractive(agent, { cwd: dir, project: dir, prompt: 'hi', ...k.opts }), dir), want, `${agent} ${k.kind}`);
      // a resumed chat gets the same
      const again = cwd();
      assert.equal(standing(agent, buildInteractive(agent, { cwd: again, project: again, resumeId: 'sess-1', ...k.opts }), again), want, `${agent} ${k.kind}, resumed`);
    }
    const dir = cwd();
    assert.equal(standing(agent, buildHeadless(agent, { cwd: dir, project: dir, threadId: 't_h', prompt: 'hi' }), dir), agent === 'claude' ? KINDS[0].text.replace('t_plain', 't_h') : `${KINDS[0].text.replace('t_plain', 't_h')}\n\n${MCP_INSTRUCTIONS}`, `${agent} headless`);
  });
}

test('a Worker gets no actions line even with actions; a sub thread none even with a role; no goals without a Planner role', () => {
  const w = startText({ threadId: 't', role: { ...workerStep, actions: ['Create plan'] } });
  assert.doesNotMatch(w, /Your actions|Chorus actions/);
  const s = startText({ threadId: 't', role: plannerChat, parent: { id: 'm', title: 'M', brief: 'Do X.' } });
  assert.doesNotMatch(s, /Your actions|Chorus actions/);
  assert.match(s, /which started it to: Do X\. Your main thread/);
  assert.doesNotMatch(startText({ threadId: 't', role: workerStep }), /Active goals/);
  assert.doesNotMatch(startText({ threadId: 't', actionLabels: [] }), /Chorus actions/, 'no bundle: no actions line');
});

test('no line names a tool, and nothing says to call current_thread first', () => {
  const tools = [...TOOL_NAMES, ...SUB_TOOL_NAMES, 'ask_planner', 'action_done', 'task_create', 'start_action', 'read_mail', 'list_watches'];
  for (const k of KINDS) {
    const t = startText({ ...k.opts, threadId: k.opts.threadId });
    for (const n of tools) assert.ok(!t.includes(n), `${k.kind}: names ${n}`);
  }
  assert.doesNotMatch(MCP_INSTRUCTIONS, /current_thread first|first call current_thread|call current_thread (at|before)/i);
});

test('the MCP instructions are the approved text, under 3 KB', () => {
  assert.equal(
    MCP_INSTRUCTIONS,
    `How to work in Chorus:
- The user answers you in Chorus. When you need the user to approve, confirm or choose something before you go on, ask through Chorus as an approval card, never as a line in your reply. A Chorus task's plan is the exception: never ask the user to approve it; Chorus shows its Approve button once the plan is finished.
- Show every file or link meant for the user through Chorus right after you make it.
- Work that can run on its own, or that the user wants another agent to do, goes to a sub thread. After starting one, go on with your work or end your turn; Chorus reports each time it ends a turn. Never check on it in a loop.
- When you need to see or manage your sub threads, or know your parent chat, task or step, look them up with current_thread.
- To start a new chat thread (not a sub thread): call list_teammates and list_actions, propose the fitting teammate and action to the user through an approval card (kind question, your pick first), then call start_thread with what the user chose; the new chat gets that teammate's agent, model, effort and permissions.
- Messages from other chats and from Chorus arrive in your Chorus mail; read them with read_mail when Chorus tells you that you have mail, and answer with the tool the message names.
- Chorus watches what you started (your action, your sub threads, your mail) and acts on it; see its watch records, their status and how long, with list_watches, instead of checking in a loop.
- Chorus actions (Create plan, Review changes, …): ask "Would you like me to <action>? <why>" with a question card; after the user's yes, start it with start_action; finish with action_done. Chorus watches each turn end and reminds you if it is missing.`,
  );
  assert.ok(Buffer.byteLength(MCP_INSTRUCTIONS) < 3072, `${Buffer.byteLength(MCP_INSTRUCTIONS)} bytes`);
});

test('the MCP server sends the MCP instructions to a chat, none to an AI app with no chat', async () => {
  const dir = cwd();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-note-home-'));
  for (const [thread, want] of [['t_mcp', MCP_INSTRUCTIONS], [undefined, undefined]] as const) {
    const server = createServer(dir, thread, home, { role: async () => undefined });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(b);
    assert.equal(client.getInstructions(), want);
    await client.close();
  }
});

test('Chorus\'s own sub thread tools never ask: Claude Code gets them in --allowedTools; Codex approves every chorus tool; agy is answered by Chorus', () => {
  const SUB = ['start_subthread', 'send_to_subthread', 'list_subthreads', 'stop_subthread', 'ask_main_thread'];
  for (const agent of AGENTS) {
    for (const [what, l] of [
      ['interactive', buildInteractive(agent, { cwd: cwd(), project: '/p', threadId: 't_t', prompt: 'hi' })],
      ['headless', buildHeadless(agent, { cwd: cwd(), project: '/p', threadId: 't_t', prompt: 'hi' })],
    ] as const) {
      if (agent === 'claude') {
        const allowed = l.args[l.args.indexOf('--allowedTools') + 1].split(',');
        for (const n of SUB) assert.ok(allowed.includes(`mcp__chorus__${n}`), `${what}: ${n}`);
        for (const n of ['request_approval', 'current_thread', 'read_mail', 'list_watches']) assert.ok(allowed.includes(`mcp__chorus__${n}`), `${what}: ${n}`);
      } else if (agent === 'codex') assert.ok(l.args.includes('mcp_servers.chorus.default_tools_approval_mode="approve"'), what);
    }
  }
});

test('the tool list has start_action, read_mail and list_watches', async () => {
  const dir = cwd();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-note-home-'));
  const server = createServer(dir, 't_tools', home, { role: async () => undefined });
  // start_action comes from the paid module through chorus serve, like every action tool
  server.registerTool('start_action', { description: 'x', inputSchema: {} }, async () => ({ content: [] }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(b);
  const names = (await client.listTools()).tools.map(t => t.name);
  for (const n of ['start_action', 'read_mail', 'list_watches']) assert.ok(names.includes(n), n);
  assert.ok(TOOL_NAMES.includes('read_mail' as never) && TOOL_NAMES.includes('list_watches' as never), 'pre-allowed with the other chorus tools');
  await client.close();
});

test('the MCP instructions stay under 3 KB', () => assert.ok(Buffer.byteLength(MCP_INSTRUCTIONS) < 3072, `${Buffer.byteLength(MCP_INSTRUCTIONS)} bytes`));
