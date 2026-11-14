// Which AI CLI fits best (plan 2026-11-14): the Welcome's strip and New chat's faint line (src/desktop/cli-fit.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a page module, plain JavaScript
import { cliFitNote, newChatHint } from '../../src/desktop/cli-fit.js';

test('Welcome: one strip with the three marks, in the mockup\'s words', () => {
  const html = cliFitNote();
  assert.match(html, /^<div class="wl-strip" role="note">/);
  assert.equal(html.match(/class="badge mini (claude|codex|agy)"/g)?.length, 3);
  const text = html.replace(/<[^>]+>/g, '');
  assert.equal(text, "🙏Thank you for supporting Chorus. It works best with C Claude Code today: every feature is built and tested with it first. X Codex and A Antigravity work too, and we're still improving them. Use any of them, and switch at any time.");
});

test('New chat: Codex or Antigravity picked says Claude Code works best; Claude Code keeps the usual hint', () => {
  assert.equal(newChatHint({ agent: 'codex' }), "Codex works, and we're still improving it. Claude Code works best today.");
  assert.equal(newChatHint({ agent: 'agy' }), "Antigravity works, and we're still improving it. Claude Code works best today.");
  assert.equal(newChatHint({ agent: 'claude', mod: '⌘' }), '⌘↵ sends · you talk to the agent in its own screen');
  assert.equal(newChatHint({ agent: 'claude', touch: true }), 'you talk to the agent in its own screen');
  // a teammate's chat and a hand-off keep their own line
  assert.equal(newChatHint({ agent: 'codex', teammate: true, mod: 'Ctrl+' }), 'Ctrl+↵ sends · you talk to the agent in its own screen');
  assert.equal(newChatHint({ agent: 'codex', handoff: true }), 'The old chat stays as it is; the new one shows under it with ↳.');
});
