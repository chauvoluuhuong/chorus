// Which AI CLI fits best (plan 2026-11-14, the strip): Claude Code works best today; Codex and Antigravity work and are still being
// improved. Said once on the Welcome screen, and on New chat by the faint line under the box when Codex or Antigravity is picked.

const NAMES = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' };
const LETTERS = { claude: 'C', codex: 'X', agy: 'A' };
const mark = k => `<span class="badge mini ${k}">${LETTERS[k]}</span>`;

/** The Welcome's note: one bordered strip under its lead. */
export const cliFitNote = () =>
  `<div class="wl-strip" role="note"><span class="wl-thanks" aria-hidden="true">🙏</span><span>Thank you for supporting Chorus. It works best with ${mark('claude')} Claude Code today: every feature is built and tested with it first. ${mark('codex')} Codex and ${mark('agy')} Antigravity work too, and we're still improving them. Use any of them, and switch at any time.</span></div>`;

/** New chat's faint line under the box (plain text): with Codex or Antigravity picked and no teammate, that it works and Claude Code
 *  works best; otherwise the usual hint. A hand-off and the optional module's own hint keep their words. */
export function newChatHint({ agent, handoff = false, teammate = false, moduleHint = '', touch = false, mod = '⌘' }) {
  if (handoff) return 'The old chat stays as it is; the new one shows under it with ↳.';
  if (moduleHint) return moduleHint;
  if (agent !== 'claude' && NAMES[agent] && !teammate) return `${NAMES[agent]} works, and we're still improving it. Claude Code works best today.`;
  return `${touch ? '' : `${mod}↵ sends · `}you talk to the agent in its own screen`;
}
