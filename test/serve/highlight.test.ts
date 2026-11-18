// The lasting border highlight on a chat's Task and Artifacts buttons (task #14, mockup mail-courier.html v3, scenes 4–5), and the
// window dimmed while the mail watchdog types (scenes 1–3): the page modules on their own (src/desktop/highlight.js, mail-typing.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a page module, plain JavaScript
import { artifactsMark, HL_GLOW_MS, makeHighlights } from '../../src/desktop/highlight.js';
// @ts-expect-error: a page module, plain JavaScript
import { MAIL_TYPING_MAX_MS, mailTypingHtml } from '../../src/desktop/mail-typing.js';
// @ts-expect-error: a page module, plain JavaScript
import { COUNT_BOOT_MS, COUNT_MS, makeCounts, sideBtn } from '../../src/desktop/counts.js';

const rig = () => {
  const env = { t: 1_000_000 };
  return { env, h: makeHighlights({ now: () => env.t }) };
};

test('a task revision that goes up lights the Task button; the first value a chat shows does not', () => {
  const { h } = rig();
  assert.equal(h.lit('t1', 'task', 3, false), false, 'the starting point');
  assert.equal(h.lit('t1', 'task', 3, false), false);
  assert.equal(h.lit('t1', 'task', 4, false), true, 'the task changed');
  assert.equal(h.lit('t1', 'task', 4, false), true, 'stays lit');
  assert.equal(h.lit('t1', 'task', undefined, false), false, 'no task known');
});

test('clicking the button clears it; an open panel never lights', () => {
  const { h } = rig();
  h.lit('t1', 'artifacts', 2, false);
  assert.equal(h.lit('t1', 'artifacts', 3, false), true);
  h.see('t1', 'artifacts', 3);
  assert.equal(h.lit('t1', 'artifacts', 3, false), false, 'cleared on click');
  assert.equal(h.lit('t1', 'artifacts', 4, true), false, 'its panel is open: seen at once');
  assert.equal(h.lit('t1', 'artifacts', 4, false), false, 'and still seen once it closes');
  assert.equal(h.lit('t1', 'artifacts', 5, false), true);
});

test('the glow: twice in 2 s, kept in step across redraws, then lit with no motion; the count flash stays on top', () => {
  const { env, h } = rig();
  h.lit('t1', 'task', 1, false);
  h.lit('t1', 'task', 2, false);
  assert.equal(h.hlClass('t1', 'task'), ' hl" style="animation-delay:-0ms');
  env.t += 700;
  assert.equal(h.hlClass('t1', 'task'), ' hl" style="animation-delay:-700ms', 'a redraw continues the glow');
  assert.equal(h.hlClass('t1', 'task', true), ' hl', 'the count flash brings its own style');
  env.t += HL_GLOW_MS;
  assert.equal(h.hlClass('t1', 'task'), ' hl hl-done');
  // in a real button: the class tail goes where the count flash's goes
  const html = sideBtn('', 'task', 'Task', '☰', '', h.hlClass('t1', 'task')) as string;
  assert.match(html, /class="btn hl hl-done"/);
  assert.equal(h.hlClass('t2', 'task'), '', 'not lit: nothing');
});

test('a second change while the border is lit glows again (task #13): a fresh delay, no hl-done, still lit', () => {
  const { env, h } = rig();
  h.lit('t1', 'task', 1, false);
  assert.equal(h.lit('t1', 'task', 2, false), true);
  env.t += HL_GLOW_MS + 5000;
  assert.equal(h.lit('t1', 'task', 2, false), true);
  assert.equal(h.hlClass('t1', 'task'), ' hl hl-done', 'the first glow is over, the border stays lit');
  // the task changes again while lit
  assert.equal(h.lit('t1', 'task', 3, false), true);
  assert.equal(h.hlClass('t1', 'task'), ' hl" style="animation-delay:-0ms', 'the glow plays again from the start');
  env.t += 400;
  assert.equal(h.lit('t1', 'task', 3, false), true);
  assert.equal(h.hlClass('t1', 'task'), ' hl" style="animation-delay:-400ms', 'a redraw does not restart it');
  env.t += HL_GLOW_MS;
  assert.equal(h.hlClass('t1', 'task'), ' hl hl-done');
  // a change inside a running glow restarts it too
  h.lit('t1', 'artifacts', 0, false);
  h.lit('t1', 'artifacts', 1, false);
  env.t += 500;
  h.lit('t1', 'artifacts', 2, false);
  assert.equal(h.hlClass('t1', 'artifacts'), ' hl" style="animation-delay:-0ms');
  // an artifact deleted (the mark goes down but stays above seen) does not glow; growing back does
  env.t += HL_GLOW_MS;
  h.lit('t1', 'artifacts', 1, false);
  assert.equal(h.hlClass('t1', 'artifacts'), ' hl hl-done');
  h.lit('t1', 'artifacts', 2, false);
  assert.equal(h.hlClass('t1', 'artifacts'), ' hl" style="animation-delay:-0ms');
});

test('after a replay, see() and an open panel still clear it, and the next change starts fresh', () => {
  const { env, h } = rig();
  h.lit('t1', 'task', 1, false);
  h.lit('t1', 'task', 2, false);
  env.t += HL_GLOW_MS;
  h.lit('t1', 'task', 3, false);
  h.see('t1', 'task', 3);
  assert.equal(h.lit('t1', 'task', 3, false), false, 'pressed: cleared');
  assert.equal(h.hlClass('t1', 'task'), '');
  assert.equal(h.lit('t1', 'task', 4, false), true);
  assert.equal(h.hlClass('t1', 'task'), ' hl" style="animation-delay:-0ms');
  env.t += HL_GLOW_MS;
  h.lit('t1', 'task', 5, false);
  assert.equal(h.lit('t1', 'task', 5, true), false, 'its panel opened: seen');
  assert.equal(h.hlClass('t1', 'task'), '');
  assert.equal(h.lit('t1', 'task', 5, false), false, 'and still seen once it closes');
});

test('the count flash plays on every change, also while the border is lit, and stays on top of the glow', () => {
  const { env, h } = rig();
  const k = makeCounts({ now: () => env.t, uptime: () => COUNT_BOOT_MS + 1, hidden: () => false });
  // what app.js hlFlash does for the Artifacts button
  const btn = (n: number) => {
    k.noteCount('art:t1', n);
    const flash = k.countFlash('art:t1') as string;
    const lit = h.lit('t1', 'artifacts', n, false);
    return sideBtn('', 'artifacts', 'Artifacts', '▤', '', `${lit ? h.hlClass('t1', 'artifacts', !!flash) : ''}${flash}`) as string;
  };
  assert.match(btn(1), /class="btn"/);
  assert.match(btn(2), /class="btn hl flash" style="animation-delay:-0ms"/, 'first change: flash on top, border lit');
  env.t += COUNT_MS;
  assert.match(btn(2), /class="btn hl" style="animation-delay:-1100ms"/, 'the glow goes on after the flash');
  env.t += HL_GLOW_MS;
  assert.match(btn(2), /class="btn hl hl-done"/);
  assert.match(btn(3), /class="btn hl flash" style="animation-delay:-0ms"/, 'second change while lit: the flash again');
  env.t += COUNT_MS;
  assert.match(btn(3), /class="btn hl" style="animation-delay:-1100ms"/, 'and the glow again');
  h.see('t1', 'artifacts', 3);
  assert.match(btn(3), /class="btn"/, 'pressed: cleared');
});

test('the marks are kept: changed() hands them out once per change; another device\'s (or a reload\'s) marks clear the highlight', () => {
  const { h } = rig();
  h.lit('t1', 'task', 5, false);
  const m = h.changed();
  assert.deepEqual(m, { t1: { task: 5 } });
  assert.equal(h.changed(), undefined, 'nothing new');
  assert.equal(h.lit('t1', 'task', 6, false), true);
  // a reload: a new page loads the kept marks and sees the same highlight
  const reload = rig().h;
  reload.load(m);
  assert.equal(reload.lit('t1', 'task', 6, false), true, 'kept after a reload');
  // the click on another device reached the server: its marks arrive
  h.load({ t1: { task: 6 } });
  assert.equal(h.lit('t1', 'task', 6, false), false, 'cleared everywhere');
});

test('the artifacts mark grows with a new artifact and with a new version', () => {
  assert.equal(artifactsMark({ artifacts: 3, artifactsRev: 0 }), 3);
  assert.equal(artifactsMark({ artifacts: 3, artifactsRev: 1 }), 4);
  assert.equal(artifactsMark({}), 0);
});

test('the overlay card: sender, this chat, the two texts; never an input, a composer or a Send button', () => {
  const esc = (s: string) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const html = mailTypingHtml({ from: { title: 'Step 2 · type-in <helpers>', agent: 'claude' }, to: { agent: 'codex' }, esc, letter: (a: string) => a[0].toUpperCase() });
  assert.match(html, /<h3>Delivering a message to this chat<\/h3>/);
  assert.match(html, /From <b>Step 2 · type-in &lt;helpers&gt;<\/b>\. What you typed is saved and comes back in a moment\./);
  assert.match(html, /mt-who a claude">C</);
  assert.match(html, /mt-who b codex">C</);
  assert.match(html, /mt-lbl b">This chat</);
  assert.doesNotMatch(html, /<input|<textarea|contenteditable|Send/i);
  assert.match(mailTypingHtml({ from: {}, to: {}, esc, letter: () => '?' }), /From <b>Chorus<\/b>/, 'mail from Chorus itself');
  assert.equal(MAIL_TYPING_MAX_MS, 10_000);
});
