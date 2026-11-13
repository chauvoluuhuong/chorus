// Waiting items, the same everywhere (plan 2026-11-13, package C): the host's places that show a waiting item (the card docked in a
// chat, the Approve / Deny line in a chat, Approvals, Home) offer the same 🗑 behind the one warning; a delete in one place clears
// it from the others; the counts agree with the lists. Each place beside its scene of ui-mockup-v3.html. Fake agents, the module's
// dev bundle: no model calls. A stage of chorus-core's Pro harness (docs/testing.md):
//   node <core>/test/pro-e2e/run.ts --public "$PWD" --stage <path of test/smoke/proof-waiting-items relative to <core>/test/pro-e2e/checks>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const Q = 'Put the Export button to the right of the filters, or above the table?';
const D = 'Right of the filters: it sits with what it exports, and the table keeps its full height. The filter row already has 4 controls, so below 1280 px the button wraps under them.\nAbove the table: it always has room and lines up with the row count ("1,204 orders"), but it is further from the filters people just set.';

export default async function (c: any) {
  const { chrome, check, out, project, publicDir } = c;
  const { rig } = await import(path.join(c.core, 'test/pro-e2e/checks/lib.ts'));
  const script = path.join(out, 'waiting-script.json');
  const ask = (question: string, extra: object = {}) => ({ claude: [{ say: 'Read the brief: how to do it, how to check it' }, { call: 'request_approval', args: { question, details: D, options: ['Right of the filters', 'Above the table'], kind: 'question', ...extra } }, { say: 'Shown to you as a card: waiting for your answer' }], '*': [] });
  fs.writeFileSync(script, JSON.stringify(ask(Q)));
  const r = await rig(c, { CHORUS_FAKE_SCRIPT: script });
  const js = chrome.js;
  const skip = async () => (await chrome.has('button', /Skip, start using Chorus/)) && (await chrome.click('button', 'Skip, start using Chorus'));
  await chrome.until(() => chrome.has('button', /Skip, start using Chorus/), 15_000);
  await skip();
  const open = async (id: string) => (await skip(), await js(`window.chorus.go({ name: 'chat', id: ${JSON.stringify(id)} })`), await sleep(1500), skip());
  const chat = async (agent: string, prompt: string) => (await r.api('POST', '/api/chats', { agent, folder: project, prompt })).json.id as string;
  const pairs: [string, string, string][] = [];
  /** What the host shows waiting: the header's badge, the sidebar's Approvals count, the lists' rows. */
  const counts = () => js(`(() => {
    const badge = Number((document.querySelector('#top')?.textContent.match(/(\\d+) waiting/) ?? [])[1] ?? 0);
    const nav = Number(document.querySelector('#side [data-act="approvals"] .count, #side [data-act="approvals"] .n, #side [data-act="approvals"] .badge')?.textContent ?? 0);
    const host = (window.chorus.S.state?.approvals ?? []).filter(a => !a.hidden).length, pro = window.choruspro?.needsCount?.() ?? 0;
    const bang = [...document.querySelectorAll('#side .proj .bang')].reduce((n, b) => n + Number(b.textContent.replace('!', '')), 0);
    return { badge, nav, host, pro, bang };
  })()`);
  const del = async (sel: string) => { await chrome.click(sel); await sleep(500); };
  const dialog = () => js(`document.querySelector('#dialogs [role="dialog"]')?.textContent ?? ''`);

  /* ---------- the card docked in a chat: 🗑 beside Fold, also when folded ---------- */
  const a = await chat('claude', 'add a CSV export');
  await open(a);
  await chrome.until(() => js(`!!document.querySelector('#ask-dock .ask-who [data-act="appr-del"]')`), 25_000);
  await sleep(700);
  await chrome.shot('app-card', 'A question card docked in the chat, with 🗑 beside Fold');
  pairs.push(['app-card', 'mock-card', 'A question card, docked in the chat (UC-06)']);
  await chrome.click('#ask-dock [data-act="ask-fold"]');
  const foldedDel = await js(`!!document.querySelector('#ask-dock .ask-dock.min [data-act="appr-del"]')`);
  await chrome.click('#ask-dock [data-act="ask-fold"]');

  /* ---------- the Approve / Deny line of a command prompt: 🗑 at its end ---------- */
  const b = await chat('codex', 'build it');
  await open(b);
  await js('window.chorus.term.focus()');
  await chrome.typeLine(`show ${path.join(publicDir, 'fixtures/codex/0.163.0/approval-ask-nohook-enter/prompt-screen.txt')}`);
  await chrome.until(() => js(`!!document.querySelector('#chat-banners .banner.ask [data-act="appr-del"]')`), 15_000);
  await sleep(500);
  await chrome.shot('app-chat-ask', 'The agent asks: Approve / Deny in the chat, with 🗑');
  pairs.push(['app-chat-ask', 'mock-chat_ask', 'The agent asks: Approve / Deny in the chat (UC-06)']);
  const before = await counts();

  /* ---------- Approvals and Home list both; the counts agree ---------- */
  await js(`window.chorus.go({ name: 'approvals' })`);
  await sleep(1200);
  const rows = await js(`[...document.querySelectorAll('#view .item [data-act="appr-del"]')].map(b => b.dataset.arg)`);
  await chrome.shot('app-approvals', 'Approvals: every row with its 🗑');
  pairs.push(['app-approvals', 'mock-approvals', 'Approvals inbox (UC-06)']);
  await del(`#view [data-act="appr-del"][data-arg="${b}"]`);
  await chrome.shot('app-appr-del', 'Approvals: delete an item (warning)');
  pairs.push(['app-appr-del', 'mock-appr_del', 'Approvals: delete an item (warning) (UC-06)']);
  // Cancel: nothing changes
  await chrome.click('#dialogs [data-x="no"]');
  await sleep(500);
  const cancelled = await js(`!document.querySelector('#dialogs [role="dialog"]') && !!document.querySelector('#view [data-act="appr-del"][data-arg="${b}"]')`);
  check('w.1', 'The card in a chat has 🗑 beside Fold (also folded) and the Approve / Deny line has 🗑 at its end; Approvals and Home list both; the header badge, the sidebar\'s Approvals and the projects\' "!" agree with the lists; Cancel in the warning changes nothing',
    foldedDel && rows.includes(a) && rows.includes(b) && before.badge === before.host + before.pro && before.host === 2 && before.bang === 2 && cancelled,
    JSON.stringify({ foldedDel, rows, before, cancelled }), ['app-card.png', 'app-chat-ask.png', 'app-approvals.png', 'app-appr-del.png']);

  /* ---------- delete in the chat (the Approve / Deny line, no tick): gone there, from Approvals, Home and the counts ---------- */
  await open(b);
  await del('#chat-banners [data-act="appr-del"]');
  const warned = /Handle it in its chat, or the chat may stay waiting/.test(await dialog());
  await chrome.click('#dialogs [data-x="yes"]');
  await chrome.until(() => js(`!document.querySelector('#chat-banners .banner.ask')`), 5000);
  const lineGone = await js(`!document.querySelector('#chat-banners .banner.ask')`);
  const afterB = await counts();
  await js(`window.chorus.go({ name: 'approvals' })`);
  await sleep(900);
  const inAppr = await js(`!!document.querySelector('#view [data-act="appr-del"][data-arg="${b}"]')`);
  const decided = (await r.api('GET', '/api/approvals')).json.decided.length;
  check('w.2', 'A command prompt deleted from its chat: the warning first; then its line leaves the chat, Approvals and the counts; the agent is not answered',
    warned && lineGone && !inAppr && afterB.host === 1 && afterB.badge === afterB.host + afterB.pro && afterB.bang === 1 && decided === 0,
    JSON.stringify({ warned, lineGone, inAppr, afterB, decided }), []);

  /* ---------- delete the question from Approvals with Don't ask again: the card leaves the chat at once ---------- */
  await del(`#view [data-act="appr-del"][data-arg="${a}"]`);
  const warnedAgain = /Don't ask again/.test(await dialog());
  await chrome.click('#dialogs [data-x="noask"]');
  await chrome.click('#dialogs [data-x="yes"]');
  await chrome.until(() => js(`!document.querySelector('#view [data-act="appr-del"][data-arg="${a}"]')`), 5000);
  await open(a);
  const cardGone = await js(`!document.querySelector('#ask-dock .ask-dock')`);
  const afterA = await counts();
  check('w.3', 'A question deleted from Approvals, after the warning with Don\'t ask again ticked: the card leaves its chat too; nothing waits, the counts say 0',
    warnedAgain && cardGone && afterA.host === 0 && afterA.badge === afterA.pro && afterA.bang === 0, JSON.stringify({ warnedAgain, cardGone, afterA }), []);

  /* ---------- with Don't ask again: 🗑 on the card deletes at once; Home and Approvals follow ---------- */
  fs.writeFileSync(script, JSON.stringify(ask('Which table should the export read?')));
  const c2 = await chat('claude', 'one more question');
  await open(c2);
  await chrome.until(() => js(`!!document.querySelector('#ask-dock [data-act="appr-del"]')`), 25_000);
  await chrome.click('#ask-dock [data-act="appr-del"]');
  await sleep(600);
  const noDialog = await js(`!document.querySelector('#dialogs [role="dialog"]')`);
  const gone = await chrome.until(async () => !(await js(`window.chorus.S.state.approvals.some(x => x.id === ${JSON.stringify(c2)})`)), 5000);
  await js(`window.chorus.go({ name: 'approvals' })`);
  await sleep(800);
  const notInAppr = await js(`!document.querySelector('#view [data-act="appr-del"][data-arg="${c2}"]')`);
  check('w.4', 'Don\'t ask again ticked: 🗑 on the card deletes without the warning; the item leaves the chat, Approvals and the state at once', noDialog && gone && notInAppr, JSON.stringify({ noDialog, gone, notInAppr }), []);

  /* ---------- the module's waiting items in the same places, and the counts after a plan approval is deleted ---------- */
  await r.api('POST', '/api/ui', { key: 'noDelAsk', value: false });
  await js(`window.chorus.S.noDelAsk = false; localStorage.removeItem('chorus.noDelAsk')`);
  const mk = await r.api('POST', '/api/pro/dev/task', { project, title: 'CSV export of orders', description: 'Admins download the orders they filtered.', doneWhen: 'A filtered list downloads as a CSV.', steps: [{ title: 'Export button', howToDo: 'Button next to the filters.', howToCheck: 'Component test.', files: ['src/pages/orders.tsx'], assignee: 'worker-claude' }] });
  const task = mk.json.id as string;
  const plan = (await r.api('POST', '/api/pro/dev/need', { project, task, kind: 'plan', who: 'planner', what: 'Approve the plan for #1?', options: ['ok', 'Change it'] })).json.id;
  await js(`window.chorus.go({ name: 'approvals' })`);
  const apprSlot = `document.querySelector('[data-pro-slot="approvals"]')?.shadowRoot`;
  await chrome.until(async () => !!(await js(`${apprSlot}?.querySelector('[data-do="needdel:${plan}"]') ? 1 : 0`)), 15_000);
  const withPlan = await counts();
  await js(`${apprSlot}.querySelector('[data-do="needdel:${plan}"]').click()`);
  await sleep(500);
  const proWarn = /Handle it in its chat/.test(await dialog());
  await chrome.click('#dialogs [data-x="yes"]');
  await chrome.until(async () => (await counts()).pro === withPlan.pro - 1, 8000);
  await sleep(800);
  const afterPlan = await counts();
  const planRows = await js(`${apprSlot}?.querySelectorAll('[data-do^="needdel:"]').length ?? 0`);
  check('w.5', 'A plan approval deleted from Approvals (the module\'s row, the host\'s warning): the header badge, the sidebar\'s Approvals and the lists agree right after',
    proWarn && afterPlan.badge === afterPlan.host + afterPlan.pro && afterPlan.pro === planRows && afterPlan.badge === withPlan.badge - 1,
    JSON.stringify({ withPlan, proWarn, afterPlan, planRows }), []);

  /* ---------- a task chat with the Worker's question (UC-14), the Planner's grant (other: false) ---------- */
  fs.writeFileSync(script, JSON.stringify(ask(Q)));
  await js(`window.chorus.go({ name: 'pro', id: ${JSON.stringify(`howrun~${task}`)} })`);
  await sleep(1500);
  await js(`document.querySelector('[data-pro-slot="view"]').shadowRoot.querySelector('[data-do^="startrun:"]')?.click()`);
  let worker = '';
  for (let i = 0; i < 60 && !worker; i++) {
    worker = (((await r.state()).tasks ?? []).find((t: any) => t.id === task)?.sessions ?? []).find((s: any) => s.action === 'buildTask')?.thread_id ?? '';
    if (!worker) await sleep(500);
  }
  if (worker) {
    await open(worker);
    await chrome.until(() => js(`!!document.querySelector('#ask-dock [data-act="appr-del"]')`), 25_000);
    await sleep(900);
    await chrome.shot('app-task-ask', 'Chat with an ask: 🗑 beside Fold');
    pairs.push(['app-task-ask', 'mock-tk-ask', 'Chat with an ask (UC-14)']);
  }
  fs.writeFileSync(script, JSON.stringify({ claude: [{ say: 'Plan approved. One more question before the Workers start.' }, { call: 'request_approval', args: { question: 'Grant the Workers all permissions for this plan?', details: 'With the grant, every step\'s Worker chat of #1 starts with skip-permissions: no prompts while it edits files or runs commands. Your Workers\' own settings don\'t change, and the grant ends with the task.', options: ['Yes, grant', 'No'], kind: 'question', other: false } }, { say: 'Shown to you as a card: waiting for your answer' }], '*': [] }));
  const planner = (await r.api('POST', '/api/pro/run', { action: 'createPlan', teammate: 'planner', project, message: 'Plan the CSV export' })).json.thread as string;
  await open(planner);
  await chrome.until(() => js(`/Grant the Workers/.test(document.querySelector('#ask-dock .ask-q')?.textContent ?? '')`), 25_000);
  await sleep(900);
  await chrome.shot('app-grant', 'Planner: grant, then start, with 🗑 beside Fold');
  pairs.push(['app-grant', 'mock-tk-grant', 'Planner: grant, then start (UC-14)']);

  /* ---------- a phone: Home and Approvals ---------- */
  await chrome.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await js('location.reload()');
  await sleep(2500);
  await skip();
  await js(`window.chorus.go({ name: 'home' })`);
  await sleep(1500);
  const homeDel = await js(`document.querySelectorAll('#view .hm-need [data-act="appr-del"]').length`);
  await chrome.shot('app-phone-home', 'Home on a phone: Needs you, each with 🗑');
  await js(`window.chorus.go({ name: 'approvals' })`);
  await sleep(1500);
  await chrome.shot('app-phone-approvals', 'Approvals on a phone');
  const phone = await counts();
  check('w.6', 'A phone: Home\'s Needs you and Approvals show the same items with 🗑', homeDel >= 1 && phone.host >= 1, JSON.stringify({ homeDel, phone }), ['app-phone-home.png', 'app-phone-approvals.png']);
  await chrome.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  /* ---------- the mockup's scenes, the same size ---------- */
  const mock = path.join(publicDir, 'workspace/mockups/ui-mockup-v3.html');
  const scene = async (find: string, slug: string) => {
    await chrome.cdp('Page.navigate', { url: `file://${mock}` });
    await chrome.until(() => js('!!document.querySelector("#scenarios button")'), 8000);
    await js(`(() => { const b = [...document.querySelectorAll('#scenarios [data-scn]')].find(x => ${find}); b?.click(); })()`);
    await sleep(1500);
    await js(`document.getElementById('window')?.scrollIntoView()`);
    await chrome.shot(slug, slug);
  };
  const tk = (label: string) => `x.dataset.scn.startsWith('tk') && x.textContent.trim().endsWith(${JSON.stringify(label)})`;
  for (const id of ['card', 'chat_ask', 'approvals', 'appr_del']) await scene(`x.dataset.scn === '${id}'`, `mock-${id}`);
  await scene(tk('Chat with an ask'), 'mock-tk-ask');
  await scene(tk('Planner: grant, then start'), 'mock-tk-grant');
  await scene(`x.dataset.scn === 'rs_home'`, 'mock-rs-home');
  await scene(`x.dataset.scn === 'rs_approvals'`, 'mock-rs-approvals');

  /* ---------- each screen beside its scene ---------- */
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd: publicDir, encoding: 'utf8' }).stdout.trim();
  const dest = path.join(publicDir, '.chorus/proof', branch);
  fs.mkdirSync(dest, { recursive: true });
  const file = (slug: string) => fs.readdirSync(out).filter(f => f.replace(/^\d+-/, '') === `${slug}.png`).sort().at(-1);
  const pair = async (app: string, m: string, label: string, appW = 1440) => {
    const a = file(app), b = file(m);
    if (!a || !b) return;
    fs.copyFileSync(path.join(out, a), path.join(dest, `${app}.png`));
    fs.copyFileSync(path.join(out, b), path.join(dest, `${m}.png`));
    const page = path.join(dest, 'pair.html');
    fs.writeFileSync(page, `<!doctype html><body style="margin:0;font:600 15px system-ui;background:#ddd"><div style="padding:8px 14px">${label}: the app (left) · the mockup (right)</div><div style="display:flex;gap:12px;padding:0 12px;align-items:flex-start"><img src="${app}.png" style="width:${appW}px"><img src="${m}.png" style="width:1440px"></div></body>`);
    await chrome.cdp('Emulation.setDeviceMetricsOverride', { width: appW + 1480, height: 980, deviceScaleFactor: 1, mobile: false });
    await chrome.cdp('Page.navigate', { url: `file://${page}` });
    await sleep(700);
    const { data } = await chrome.cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(dest, `pair-${app.replace(/^app-/, '')}.png`), Buffer.from(data, 'base64'));
    fs.rmSync(page, { force: true });
  };
  for (const [a, m, label] of pairs) await pair(a, m, label);
  await pair('app-phone-home', 'mock-rs-home', 'Home on a phone (Responsive)', 390);
  await pair('app-phone-approvals', 'mock-rs-approvals', 'Approvals on a phone (Responsive)', 390);
  check('w.7', 'Each screen saved beside its mockup scene', [...pairs.map(p => p[0]), 'app-phone-home', 'app-phone-approvals'].every(a => fs.existsSync(path.join(dest, `${a}.png`))), dest, []);
  r.lic.close();
}
