// Who the docked ask card names (ui-mockup-v3 UC-06 and UC-14): a task chat's teammate when the module knows it, else the agent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a page module, plain JavaScript
import { askWho } from '../../src/desktop/ask-label.js';

const AGENT = { claude: { name: 'Claude Code' }, codex: { name: 'Codex' } };
const chat = { id: 't_1', agent: 'claude' };

test('a task chat: the teammate running its work session, with its agent', () => {
  const pro = { chatTeammate: (id: string) => (id === 't_1' ? { name: 'claude-worker-1', agent: 'claude' } : null) };
  assert.deepEqual(askWho(chat, pro, AGENT), { name: 'claude-worker-1', agent: 'claude', teammate: true });
});

test('a plain chat, the module not loaded yet, an older module without chatTeammate, or none: the agent', () => {
  const plain = { name: 'Claude Code', agent: 'claude', teammate: false };
  assert.deepEqual(askWho(chat, { chatTeammate: () => null }, AGENT), plain);
  assert.deepEqual(askWho(chat, { sideTabs: () => null }, AGENT), plain);
  assert.deepEqual(askWho(chat, undefined, AGENT), plain);
  assert.deepEqual(askWho(chat, { chatTeammate: () => { throw new Error('no data'); } }, AGENT), plain);
  assert.deepEqual(askWho({ id: 't_2', agent: 'codex' }, { chatTeammate: () => ({ name: '' }) }, AGENT), { name: 'Codex', agent: 'codex', teammate: false });
});
