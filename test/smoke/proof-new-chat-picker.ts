// Regression (fix/new-chat-picker): on New chat and the hand-off form, the "/" list stays open and filters, and the caret stays where
// it was, when the page redraws the form while you type (the optional module's board event → host.refresh → renderView, as when
// chats are running), and Escape closes the list and leaves the caret in place. Also: a skill's long description is two lines at most in
// the list. A stage of chorus-core's Pro harness (fake agents, the module's dev bundle), like proof-planner-loop.ts:
//   node <core>/test/pro-e2e/run.ts --public "$PWD" --stage <path of test/smoke/proof-new-chat-picker relative to <core>/test/pro-e2e/checks>
import path from 'node:path';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const LONG = 'Turns raw exports into tidy tables: renames the columns to the ones the admin pages use, drops empty rows, fixes dates to ISO 8601, splits full names, and keeps a log of every change it made so a person can check it afterwards.';

export default async function (c: any) {
  const { chrome, check, project } = c;
  const { rig } = await import(path.join(c.core, 'test/pro-e2e/checks/lib.ts'));
  const r = await rig(c);
  const js = chrome.js;
  const skip = async () => (await chrome.has('button', /Skip, start using Chorus/)) && (await chrome.click('button', 'Skip, start using Chorus'));
  await chrome.until(() => chrome.has('button', /Skip, start using Chorus/), 15_000);
  await skip();
  for (const [name, d] of [['hydrate-data', LONG], ['brand-style', 'Our colours, type and spacing'], ['gift-cards', 'How gift cards work']]) await r.api('POST', '/api/skills', { name, description: d });
  /** The module's board event, as when chats are running: it reloads and asks the page to redraw (host.refresh). */
  const board = async () => {
    const before = await js(`window.__redraws ?? 0`);
    await r.api('POST', '/api/pro/dev/need', { project, kind: 'gate', who: 'planner', what: `Go on? ${Date.now()}`, options: ['Go on', 'Stop here'] });
    await chrome.until(async () => (await js(`window.__redraws ?? 0`)) > before, 6000, 100);
    await sleep(400);
  };
  const field = () => js(`(() => { const t = document.querySelector('#nc-prompt'); const box = document.querySelector('.tpick'); return { value: t?.value, caret: t?.selectionStart, focused: document.activeElement === t, open: !!box && !box.hidden && getComputedStyle(box).display !== 'none', rows: [...document.querySelectorAll('.tpick:not([hidden]) [data-i] .mono')].map(e => e.textContent) }; })()`);
  // count the page's redraws of the form (a new #view content), to know the board event reached it
  await js(`(() => { window.__redraws = 0; new MutationObserver(() => window.__redraws++).observe(document.getElementById('view'), { childList: true }); })()`);

  const run = async (label: string) => {
    await chrome.click('#nc-prompt');
    await js(`(() => { const t = document.querySelector('#nc-prompt'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await chrome.typeLine('Use /', false);
    await sleep(700);
    const opened = await field();
    await board();
    const afterPush = await field();
    await chrome.typeLine('hy', false);
    await sleep(700);
    const typed = await field();
    await chrome.key('Escape');
    await sleep(200);
    const esc = await field();
    await chrome.typeLine('Z', false);
    await sleep(200);
    const z = await field();
    const ok = opened.open && opened.rows.length === 3 && afterPush.caret === 5 && afterPush.focused && typed.value === 'Use /hy' && typed.caret === 7 && typed.open && JSON.stringify(typed.rows) === '["/hydrate-data"]' && !esc.open && esc.caret === 7 && z.value === 'Use /hyZ';
    return { ok, opened, afterPush, typed, esc, z, label };
  };

  await js(`window.chorus.go({ name: 'new' })`);
  await sleep(1200);
  await skip();
  const n = await run('New chat');
  // the long description is two lines at most in the list (the mockup's rows wrap to two)
  await js(`(() => { const t = document.querySelector('#nc-prompt'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await chrome.typeLine('/hyd', false);
  await sleep(700);
  const clamp = await js(`(() => { const s = document.querySelector('.tpick [data-i] small'); if (!s) return null; const lh = parseFloat(getComputedStyle(s).lineHeight) || 16; return { h: s.getBoundingClientRect().height, lh, clamp: getComputedStyle(s).webkitLineClamp, more: s.scrollHeight > s.clientHeight + 2 }; })()`);
  await chrome.shot('picker-long-description', 'New chat: / with a long description, two lines at most');
  await chrome.key('Escape');
  check('p.1', 'New chat: with the / list open, the page redraws (the module\'s board event) and you type on: the list stays open and filters, the caret stays; Escape closes it and leaves the caret; a long description is two lines at most, cut with an ellipsis',
    n.ok && !!clamp && clamp.h <= clamp.lh * 2.5 && clamp.h > clamp.lh * 1.5, JSON.stringify({ ...n, clamp }), ['picker-long-description.png']);

  // the hand-off form: the same field, for a chat that continues another
  const chat = (await r.api('POST', '/api/chats', { agent: 'codex', folder: project })).json.id as string;
  await js(`window.chorus.go({ name: 'new', from: ${JSON.stringify(chat)} })`);
  await sleep(1500);
  await skip();
  const h = await run('Hand off');
  check('p.2', 'The hand-off form: the same', h.ok, JSON.stringify(h), []);
  r.lic.close();
}
