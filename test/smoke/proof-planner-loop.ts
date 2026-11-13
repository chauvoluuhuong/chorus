// Planner loop, approvals, artifacts (package D, plan 2026-11-13): the host's screens in the real page, each beside its scene of the
// mockup ui-mockup-v3.html. Fake agents run a script (request_approval as a question or an approval, show_artifact), the optional
// module's dev bundle and its fake licence: no model calls. A stage of chorus-core's Pro harness, which starts `chorus serve` from
// this checkout (docs/testing.md):
//   node <core>/test/pro-e2e/run.ts --public "$PWD" --stage <path of test/smoke/proof-planner-loop relative to <core>/test/pro-e2e/checks>
// The pictures and side-by-side pairs are copied to .chorus/proof/<branch>/.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const Q = 'Put the Export button to the right of the filters, or above the table?';
const D = 'Right of the filters: it sits with what it exports, and the table keeps its full height. The filter row already has 4 controls, so below 1280 px the button wraps under them.\nAbove the table: it always has room and lines up with the row count ("1,204 orders"), but it is further from the filters people just set.\nBoth download exactly what is filtered, with the same columns as the table, up to 50k rows.';
const SKIPLINE = 'skipped. Decide yourself and say what you chose.';

export default async function (c: any) {
  const { chrome, check, out, project, publicDir } = c;
  const { rig } = await import(path.join(c.core, 'test/pro-e2e/checks/lib.ts'));
  const outside = path.join(out, 'orders-filtered.csv');
  const script = path.join(out, 'planner-loop-script.json');
  fs.writeFileSync(script, JSON.stringify({
    claude: [{ say: 'Read the brief: how to do it, how to check it' }, { call: 'request_approval', args: { question: Q, details: D, options: ['Right of the filters', 'Above the table'], kind: 'question' } }, { say: 'Shown to you as a card: waiting for your answer' }],
    agy: [{ call: 'request_approval', args: { question: 'Run npx prisma migrate dev --name add_orders?', details: 'Creates and applies the add_orders migration on the development database.', kind: 'approval' } }],
    codex: [
      { write: { path: 'exports/export-button.html', text: '<p>Export button mockup</p>' } },
      { call: 'show_artifact', args: { target: 'exports/export-button.html', title: 'Export button mockup' } },
      { write: { path: outside, text: 'id,total\n1,12.50\n' } },
      { call: 'show_artifact', args: { target: outside, title: 'Orders, filtered (CSV)' } },
      { call: 'show_artifact', args: { target: 'https://example.com/orders-preview', title: 'Preview on staging' } },
    ],
  }));
  const r = await rig(c, { CHORUS_FAKE_SCRIPT: script });
  const js = chrome.js;
  const skipDoctor = async () => (await chrome.has('button', /Skip, start using Chorus/)) && (await chrome.click('button', 'Skip, start using Chorus'));
  await chrome.until(() => chrome.has('button', /Skip, start using Chorus/), 15_000);
  await skipDoctor();
  const open = async (id: string) => (await skipDoctor(), await js(`window.chorus.go({ name: 'chat', id: ${JSON.stringify(id)} })`), await sleep(1500), skipDoctor());
  const chat = async (agent: string, prompt: string) => (await r.api('POST', '/api/chats', { agent, folder: project, prompt })).json.id as string;
  const box = (sel: string) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e || !e.offsetParent) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width }; })()`);
  const pairs: [string, string, string][] = [];

  /* ---------- New chat: "/" lists the skills that are on, "@" the folder's files; no folder, no list and no request ---------- */
  for (const [name, d] of [['brand-style', 'Our colours, type and spacing for every page'], ['gift-cards', 'How gift cards work in this shop'], ['csv-export', 'Exports follow the table: same columns, filtered rows']]) await r.api('POST', '/api/skills', { name, description: d });
  fs.mkdirSync(path.join(project, 'src', 'pages'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'pages', 'orders.tsx'), 'export {}');
  await js(`window.chorus.go({ name: 'new' })`);
  await sleep(1200);
  await skipDoctor();
  await js(`(() => { const f = window.fetch; window.__files = 0; window.fetch = (u, o) => (String(u).includes('/api/files') && window.__files++, f(u, o)); })()`);
  await chrome.click('#nc-prompt');
  await chrome.typeLine('Add a gift card page in our style. Use /', false);
  await sleep(700);
  const slash = await js(`[...document.querySelectorAll('.tpick:not([hidden]) [data-i] .mono')].map(e => e.textContent)`);
  await chrome.shot('app-nc-slash', 'New chat: / lists your skills');
  pairs.push(['app-nc-slash', 'mock-nc_slash', 'New chat: / lists your skills (UC-09)']);
  await chrome.key('ArrowDown');
  await chrome.key('Enter');
  const afterPick = await js(`document.querySelector('#nc-prompt').value`);
  await js(`(() => { const t = document.querySelector('#nc-prompt'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await chrome.typeLine('Add a CSV export button. Use /brand-style and start from @', false);
  await sleep(1200);
  const at = await js(`[...document.querySelectorAll('.tpick:not([hidden]) [data-i]')].map(e => e.textContent)`);
  await chrome.shot('app-nc-at', "New chat: @ lists the project's files");
  pairs.push(['app-nc-at', 'mock-nc_at', "New chat: @ lists the project's files (UC-01)"]);
  await chrome.typeLine('ord', false);
  await sleep(800);
  await chrome.key('Enter');
  const atPick = await js(`document.querySelector('#nc-prompt').value`);
  // no project folder chosen: "@" is plain text, no list, no request
  await js(`(() => { window.chorus.S.form.folder = ''; window.__files = 0; const t = document.querySelector('#nc-prompt'); t.value = ''; t.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await chrome.typeLine('see @', false);
  await sleep(800);
  const noFolder = await js(`({ open: !!document.querySelector('.tpick:not([hidden])'), asked: window.__files, text: document.querySelector('#nc-prompt').value })`);
  await chrome.key('Escape');
  check('d.1', 'New chat: / lists the skills that are on and puts /name in; @ lists the chosen folder\'s files and puts @path in; with no folder, @ opens nothing and asks nothing',
    slash.includes('/brand-style') && slash.includes('/gift-cards') && afterPick.endsWith(`Use ${slash[1]} `) && at.length > 0 && /from @src\/[\w./-]*ord[\w./-]* $/.test(atPick) && !noFolder.open && noFolder.asked === 0 && noFolder.text === 'see @',
    JSON.stringify({ slash, afterPick, at: at.slice(0, 4), atPick, noFolder }), ['app-nc-slash.png', 'app-nc-at.png']);

  /* ---------- Artifacts by report; the sidebar's left edge resizes it ---------- */
  const plain = await chat('codex', 'make the export mockup');
  await open(plain);
  await chrome.until(() => js(`window.chorus.S.state.chats.find(c => c.id === ${JSON.stringify(plain)})?.artifacts >= 3`), 20_000);
  await chrome.click('#chat-head [data-act="side"][data-arg="artifacts"]');
  await chrome.until(() => js(`document.querySelectorAll('#drawer .art-row').length >= 3`), 10_000);
  const rows = await js(`[...document.querySelectorAll('#drawer .art-row')].map(e => ({ t: e.querySelector('b').textContent, go: e.querySelector('.art-go, .badge')?.textContent, tag: e.tagName }))`);
  await chrome.shot('app-artifacts', 'Artifacts: what the agent reported, a click opens it');
  pairs.push(['app-artifacts', 'mock-artifacts', 'Artifacts in the sidebar (UC-07)']);
  // resize: hover the edge, drag it, the width stays for the app; min 280, at most 60% of the chat; double-click puts it back
  const edge = await box('#drawer .side-resize');
  await chrome.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: edge.l + 4, y: edge.t + 300 });
  await sleep(300);
  await chrome.shot('app-resize', 'Right sidebar: drag to resize');
  pairs.push(['app-resize', 'mock-resize', 'Right sidebar: drag to resize (UC-07)']);
  const dragTo = async (dx: number) => {
    const e = await box('#drawer .side-resize');
    await chrome.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: e.l + 4, y: e.t + 300, button: 'left', clickCount: 1 });
    await chrome.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: e.l + 4 + dx, y: e.t + 300, button: 'left' });
    await chrome.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: e.l + 4 + dx, y: e.t + 300, button: 'left', clickCount: 1 });
    await sleep(300);
    return (await box('#drawer')).w;
  };
  const w0 = (await box('#drawer')).w, cols0 = await js('window.chorus.term.cols'), tw0 = (await box('#term-slot')).w;
  const wider = await dragTo(-160);
  await chrome.until(async () => (await js('window.chorus.term.cols')) !== cols0, 2000, 100);
  const cols1 = await js('window.chorus.term.cols'), tw1 = (await box('#term-slot')).w;
  const atMin = await dragTo(2000);
  const body = (await box('#chat-body')).w;
  const atMax = await dragTo(-3000);
  await dragTo(-(Math.round(w0 + 160 - atMax)));
  const kept = await js('window.chorus.S.sideW');
  await js('location.reload()');
  await sleep(2500);
  await open(plain);
  const afterReload = (await box('#drawer'))?.w;
  const e2 = await box('#drawer .side-resize');
  await chrome.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: e2.l + 4, y: e2.t + 300, button: 'left', clickCount: 2 });
  await chrome.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: e2.l + 4, y: e2.t + 300, button: 'left', clickCount: 2 });
  await js(`document.querySelector('#drawer .side-resize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(300);
  const reset = (await box('#drawer')).w;
  check('d.2', 'Artifacts lists the reported files (any folder) and links with title, path and when, a click opens them; the sidebar\'s left edge drags (min 280, at most 60% of the chat), the width is kept after a reload, double-click puts it back, the terminal refits',
    rows.length >= 3 && rows.some((x: any) => x.t === 'Export button mockup') && rows.some((x: any) => x.t === 'Preview on staging' && x.go === '↗') && rows.every((x: any) => x.tag === 'BUTTON')
      && Math.abs(wider - (w0 + 160)) <= 2 && cols1 < cols0 && atMin === 280 && Math.abs(atMax - body * 0.6) <= 2 && Math.abs((afterReload ?? 0) - kept) <= 2 && reset === w0,
    JSON.stringify({ rows, w0, wider, cols0, cols1, tw0, tw1, atMin, atMax, body, kept, afterReload, reset }), ['app-artifacts.png', 'app-resize.png']);
  // a click opens it on this computer (CHORUS_NO_OPEN in the harness: the route answers ok)
  const opened = await js(`fetch('/api/chats/${plain}/open-report', { method: 'POST', headers: { 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ id: window.chorus.S.drawerData.data.reported[0].id }) }).then(r => r.json())`);
  // the same chat from a device on the private link: files inside the project open there, the others say Open on the Mac
  await js(`sessionStorage.setItem('chorus-view', 'device'); location.reload()`);
  await sleep(2500);
  await open(plain);
  await chrome.until(() => js(`document.querySelectorAll('#drawer .art-row').length >= 3`), 10_000);
  const dev = await js(`[...document.querySelectorAll('#drawer .art-row')].map(e => ({ t: e.querySelector('b').textContent, tag: e.tagName, mac: /Open on the Mac/.test(e.textContent) }))`);
  await chrome.shot('app-artifacts-remote', 'Artifacts from a device on the private link');
  pairs.push(['app-artifacts-remote', 'mock-artifacts_remote', 'Artifacts from a device on the private link (UC-07)']);
  await js(`sessionStorage.removeItem('chorus-view'); location.reload()`);
  await sleep(2500);
  check('d.3', 'From a device: a reported file inside the chat\'s project opens there; a file elsewhere and a link say Open on the Mac',
    opened.ok === true && dev.find((x: any) => x.t === 'Export button mockup')?.tag === 'A' && dev.find((x: any) => x.t === 'Orders, filtered (CSV)')?.mac && dev.find((x: any) => x.t === 'Preview on staging')?.mac,
    JSON.stringify({ opened, dev }), ['app-artifacts-remote.png']);

  /* ---------- a question card (Skip) and an approval card (no Skip); the terminal ends above the card and keeps the typing ---------- */
  const asker = await chat('claude', 'add a CSV export');
  await open(asker);
  await js('window.chorus.term.focus()');
  await chrome.until(() => js(`document.querySelector('#ask-dock .ask-q')?.textContent === ${JSON.stringify(Q)}`), 25_000);
  await sleep(600);
  const qCard = await js(`({ skip: !!document.querySelector('#ask-dock [data-act="skip"]'), other: !!document.querySelector('#ask-dock [data-act="other"]'), focus: !!document.activeElement?.closest('#term-slot') })`);
  const term = await box('#term-slot'), dock = await box('#ask-dock .ask-dock');
  await chrome.shot('app-card', 'A question card, docked in the chat: options, Other…, Skip, note, Fold');
  pairs.push(['app-card', 'mock-card', 'A question card, docked in the chat (UC-06)']);
  await chrome.click('#ask-dock [data-act="skip"]');
  const skipped = await chrome.until(() => js(`!document.querySelector('#ask-dock .ask-dock') && !window.chorus.S.state.approvals.some(a => a.id === ${JSON.stringify(asker)})`), 8000);
  await sleep(1200);
  const skipTyped = await js(`window.chorus.term.buffer.active ? [...Array(window.chorus.term.rows).keys()].map(i => window.chorus.term.buffer.active.getLine(window.chorus.term.buffer.active.baseY + i)?.translateToString(true)).join('\\n') : ''`);
  const appr = await chat('agy', 'migrate');
  await open(appr);
  await chrome.until(() => js(`!!document.querySelector('#ask-dock .ask-q')`), 25_000);
  await sleep(600);
  const aCard = await js(`({ skip: !!document.querySelector('#ask-dock [data-act="skip"]'), opts: [...document.querySelectorAll('#ask-dock [data-act="pick"]')].map(b => b.textContent) })`);
  await chrome.shot('app-card-approval', 'An approval card: Approve / Decline, no Skip');
  pairs.push(['app-card-approval', 'mock-card_approval', 'An approval card: Approve / Decline, no Skip (UC-06)']);
  // typing to the agent instead: the card and its Approvals row go at once
  await chrome.click('#term-slot');
  await chrome.typeLine('no, wait for me');
  const typedAway = await chrome.until(() => js(`!document.querySelector('#ask-dock .ask-dock') && !window.chorus.S.state.approvals.some(a => a.id === ${JSON.stringify(appr)})`), 4000, 100);
  check('d.4', 'A question card has Skip (an approval none); while it is open the terminal ends above it and keeps the focus; Skip types the skip line and the card and its Approvals row go; typing to the agent instead removes the card at once',
    qCard.skip && qCard.other && qCard.focus && !!term && !!dock && term.b <= dock.t + 1 && skipped && skipTyped.includes(SKIPLINE) && !aCard.skip && JSON.stringify(aCard.opts) === '["Approve","Decline"]' && typedAway,
    JSON.stringify({ qCard, term, dock, skipped, skipTyped: skipTyped.includes(SKIPLINE), aCard, typedAway }), ['app-card.png', 'app-card-approval.png']);

  /* ---------- Approvals: 🗑 with a warning and Don't ask again; a command prompt keeps its line in the chat ---------- */
  const prompter = await chat('codex', 'build it');
  await sleep(1500);
  await js(`window.chorus.go({ name: 'approvals' })`);
  await sleep(800);
  // the prompt is put on its screen through a socket of its own: no viewer resizes it (a resize would scroll the fake's prompt away)
  const u = new URL(r.url());
  const ws = new WebSocket(`${u.origin.replace('http', 'ws')}/ws?token=${u.searchParams.get('token')}`);
  await new Promise(x => ws.addEventListener('open', x, { once: true }));
  ws.send(JSON.stringify({ t: 'in', id: prompter, data: `show ${path.join(publicDir, 'fixtures/codex/0.163.0/approval-ask-nohook-enter/prompt-screen.txt')}\r` }));
  await chrome.until(() => js(`!!document.querySelector('[data-act="appr-del"][data-arg="${prompter}"]')`), 15_000);
  ws.close();
  await chrome.click(`[data-act="appr-del"][data-arg="${prompter}"]`);
  await sleep(500);
  const dlg = await js(`document.querySelector('#dialogs [role="dialog"]')?.textContent ?? ''`);
  await chrome.shot('app-appr-del', 'Approvals: delete an item (warning)');
  pairs.push(['app-appr-del', 'mock-appr_del', 'Approvals: delete an item (warning) (UC-06)']);
  await chrome.click('#dialogs [data-x="noask"]');
  await chrome.click('#dialogs [data-x="yes"]');
  const gone = await chrome.until(() => js(`!document.querySelector('[data-act="appr-del"][data-arg="${prompter}"]')`), 5000);
  await open(prompter);
  const lineStays = await js(`!!document.querySelector('#chat-banners .banner.ask')`);
  // the module's rows go through the same warning: "Don't ask again" was ticked, so none now
  const need = (await r.api('POST', '/api/pro/dev/need', { project, kind: 'gate', who: 'planner', what: 'Run Review changes next?', options: ['Go on', 'Stop here'] })).json.id;
  await js(`window.chorus.go({ name: 'approvals' })`);
  const apprSlot = `document.querySelector('[data-pro-slot="approvals"]')?.shadowRoot`;
  await chrome.until(async () => !!(await js(`${apprSlot}?.querySelector('[data-do="needdel:${need}"]') ? 1 : 0`)), 15_000);
  await js(`${apprSlot}.querySelector('[data-do="needdel:${need}"]').click()`);
  const needGone = await chrome.until(async () => !(await r.state()).needs.some((n: any) => n.id === need), 8000);
  const noDialog = await js(`!document.querySelector('#dialogs [role="dialog"]')`);
  check('d.5', 'Approvals: 🗑 on a row warns first ("handle it in its chat"), with Don\'t ask again; Delete takes the item off only (a command prompt keeps its Approve/Deny line in the chat); ticked, the next delete (a module row) asks nothing',
    /Handle it in its chat, or the chat may stay waiting/.test(dlg) && /Don't ask again/.test(dlg) && gone && lineStays && needGone && noDialog,
    JSON.stringify({ dlg: dlg.slice(0, 120), gone, lineStays, needGone, noDialog }), ['app-appr-del.png']);

  /* ---------- a task chat with the Worker's question (UC-14) ---------- */
  const mk = await r.api('POST', '/api/pro/dev/task', { project, title: 'CSV export of orders', description: 'Admins download the orders they filtered as a CSV, same columns as the table.', doneWhen: 'A filtered list downloads as a CSV with the same rows.', steps: [{ title: 'Export button', howToDo: 'Button next to the filters; downloads with the current filters.', howToCheck: 'Component test; a screenshot of the page.', files: ['src/pages/orders.tsx'], assignee: 'worker-claude' }] });
  const task = mk.json.id as string;
  const tasks = async () => ((await r.state()) ?? {}).tasks ?? [];
  for (let i = 0; i < 20 && !(await tasks()).find((t: any) => t.id === task); i++) await sleep(500);
  await js(`window.chorus.go({ name: 'pro', id: ${JSON.stringify(`howrun~${task}`)} })`);
  await sleep(1500);
  await js(`document.querySelector('[data-pro-slot="view"]').shadowRoot.querySelector('[data-do^="startrun:"]')?.click()`);
  let thread = '';
  for (let i = 0; i < 60 && !thread; i++) {
    thread = ((await tasks()).find((t: any) => t.id === task)?.sessions ?? []).find((s: any) => s.action === 'buildTask')?.thread_id ?? '';
    if (!thread) await sleep(500);
  }
  await open(thread);
  await chrome.until(() => js(`!!document.querySelector('#ask-dock [data-act="skip"]')`), 25_000);
  await sleep(900);
  await chrome.shot('app-task-ask', 'Chat with an ask: Skip beside the options, the terminal above the card');
  pairs.push(['app-task-ask', 'mock-tk-ask', 'Chat with an ask (UC-14)']);
  check('d.6', 'A task chat\'s question card has Skip and sits under the terminal, beside the task', !!(await box('#task-side')) && !!(await js(`!!document.querySelector('#ask-dock [data-act="skip"]')`)), '', ['app-task-ask.png']);

  /* ---------- the Planner's grant question: only Yes, grant / No, and Skip (other: false; UC-14 Planner: grant, then start) ---------- */
  // the fake agents read the script when a chat starts: this Claude chat asks the grant question
  fs.writeFileSync(script, JSON.stringify({ claude: [{ say: 'Plan approved. One more question before the Workers start.' }, { call: 'request_approval', args: { question: 'Grant the Workers all permissions for this plan?', details: 'With the grant, every step\'s Worker chat of #1 starts with skip-permissions: no prompts while it edits files or runs commands. Your Workers\' own settings don\'t change, and the grant ends with the task.', options: ['Yes, grant', 'No'], kind: 'question', other: false } }, { say: 'Shown to you as a card: waiting for your answer' }], '*': [] }));
  const granter = (await r.api('POST', '/api/pro/run', { action: 'createPlan', teammate: 'planner', project, message: 'Plan the CSV export' })).json.thread as string;
  await open(granter);
  await chrome.until(() => js(`/Grant the Workers/.test(document.querySelector('#ask-dock .ask-q')?.textContent ?? '')`), 25_000);
  await sleep(900);
  const grantBtns = await js(`[...document.querySelectorAll('#ask-dock .acts button')].filter(b => b.offsetParent).map(b => b.textContent)`);
  await chrome.shot('app-grant', 'Planner: grant, then start');
  pairs.push(['app-grant', 'mock-tk-grant', 'Planner: grant, then start (UC-14)']);
  check('d.8', 'The grant question (other: false): Yes, grant / No / Skip, no Other…', JSON.stringify(grantBtns) === '["Yes, grant","No","Skip"]', JSON.stringify(grantBtns), ['app-grant.png']);

  /* ---------- the mockup's scenes, the same size ---------- */
  const mock = path.join(publicDir, 'workspace/mockups/ui-mockup-v3.html');
  const scene = async (find: string, slug: string, then = '') => {
    await chrome.cdp('Page.navigate', { url: `file://${mock}` });
    await chrome.until(() => js('!!document.querySelector("#scenarios button")'), 8000);
    await js(`(() => { const b = [...document.querySelectorAll('#scenarios [data-scn]')].find(x => ${find}); b?.click(); })()`);
    await sleep(1500);
    if (then) (await js(then), await sleep(700));
    await js(`document.getElementById('window')?.scrollIntoView()`);
    await chrome.shot(slug, slug);
  };
  const tk = (label: string) => `x.dataset.scn.startsWith('tk') && x.textContent.trim().endsWith(${JSON.stringify(label)})`;
  for (const id of ['card', 'card_approval', 'appr_del', 'artifacts', 'artifacts_remote']) await scene(`x.dataset.scn === '${id}'`, `mock-${id}`);
  await scene(`x.dataset.scn === 'resize'`, 'mock-resize', `(() => { const h = document.querySelector('[data-resize]'); const b = h.getBoundingClientRect(); h.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: b.left + 4, clientY: b.top + 300 })); })()`);
  for (const id of ['nc_slash', 'nc_at']) await scene(`x.dataset.scn === '${id}'`, `mock-${id}`);
  await scene(tk('Chat with an ask'), 'mock-tk-ask');
  await scene(tk('Planner: grant, then start'), 'mock-tk-grant');

  /* ---------- each screen beside its scene, one picture per pair, in .chorus/proof/<branch>/ ---------- */
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd: publicDir, encoding: 'utf8' }).stdout.trim();
  const dest = path.join(publicDir, '.chorus/proof', branch);
  fs.mkdirSync(dest, { recursive: true });
  const file = (slug: string) => fs.readdirSync(out).filter(f => f.replace(/^\d+-/, '') === `${slug}.png`).sort().at(-1);
  await chrome.cdp('Emulation.setDeviceMetricsOverride', { width: 2900, height: 980, deviceScaleFactor: 1, mobile: false });
  for (const [app, m, label] of pairs) {
    const a = file(app), b = file(m);
    if (!a || !b) continue;
    fs.copyFileSync(path.join(out, a), path.join(dest, `${app}.png`));
    fs.copyFileSync(path.join(out, b), path.join(dest, `${m}.png`));
    const page = path.join(dest, 'pair.html');
    fs.writeFileSync(page, `<!doctype html><body style="margin:0;font:600 15px system-ui;background:#ddd"><div style="padding:8px 14px">${label}: the app (left) · the mockup (right)</div><div style="display:flex;gap:12px;padding:0 12px"><img src="${app}.png" style="width:1440px"><img src="${m}.png" style="width:1440px"></div></body>`);
    await chrome.cdp('Page.navigate', { url: `file://${page}` });
    await sleep(700);
    const { data } = await chrome.cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(dest, `pair-${app.replace(/^app-/, '')}.png`), Buffer.from(data, 'base64'));
  }
  fs.rmSync(path.join(dest, 'pair.html'), { force: true });
  check('d.7', 'Each screen saved beside its mockup scene', pairs.every(([a, m]) => fs.existsSync(path.join(dest, `${a}.png`)) && fs.existsSync(path.join(dest, `${m}.png`))), dest, []);
  r.lic.close();
}
