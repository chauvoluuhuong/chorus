// Chat and setup fixes (package C, plan 2026-11-12): the docked ask card, the one right sidebar (Task · Artifacts · Activity ·
// Record), and the Update band, in the real page, each beside its scene of the mockup ui-mockup-v3.html. Fake agents (a script
// makes Claude ask through request_approval), the optional module's dev bundle and its fake licence: no model calls.
// It is a stage of chorus-core's Pro harness, which starts `chorus serve` from this checkout:
//   node ../chorus-core/test/pro-e2e/run.ts --public "$PWD" --stage "$(node -p "require('path').relative('../chorus-core/test/pro-e2e/checks', 'test/smoke/proof-chat-fixes')")"
// The pictures and side-by-side pairs are copied to .chorus/proof/<branch>/ (docs/testing.md).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const Q1 = 'Put the Export button right of the filters?';
const Q2 = 'Put the Export button to the right of the filters, or above the table?';
const D2 =
  'Right of the filters: it sits with what it exports, and the table keeps its full height. The filter row already has 4 controls, so below 1280 px the button wraps under them.\nAbove the table: it always has room and lines up with the row count ("1,204 orders"), but it is further from the filters people just set.\nBoth download exactly what is filtered, with the same columns as the table, up to 50k rows.';

export default async function (c: any) {
  const { chrome, check, out, project, publicDir } = c;
  const { rig } = await import(path.join(c.core, 'test/pro-e2e/checks/lib.ts'));
  // Claude asks twice (the second ask replaces the first card); Codex only talks
  const script = path.join(out, 'ask-script.json');
  fs.writeFileSync(script, JSON.stringify({ claude: [{ say: 'Reading the brief: how to do it, how to check it' }, { call: 'request_approval', args: { question: Q1, options: ['Right of the filters', 'Above the table'] } }, { wait: 2500 }, { call: 'request_approval', args: { question: Q2, details: D2, options: ['Right of the filters', 'Above the table'] } }, { say: 'Shown to you as a card: waiting for your answer' }], '*': [] }));
  const r = await rig(c, { CHORUS_FAKE_SCRIPT: script });
  // the host's first-run agent check comes up once its check ends, late: it would cover every screen
  const skipDoctor = async () => (await chrome.has('button', /Skip, start using Chorus/)) && (await chrome.click('button', 'Skip, start using Chorus'));
  if (await chrome.until(() => chrome.has('button', /Skip, start using Chorus/), 40_000)) await skipDoctor();
  c.log(`  pro status: ${JSON.stringify((await r.api('GET', '/api/pro/status')).json).slice(0, 300)}`);
  const js = chrome.js;
  const open = async (id: string) => (await skipDoctor(), await js(`window.chorus.go({ name: 'chat', id: ${JSON.stringify(id)} })`), await sleep(1500), skipDoctor());
  const chat = async (agent: string, prompt: string) => (await r.api('POST', '/api/chats', { agent, folder: project, prompt })).json.id as string;
  const view = () => js(`(() => { const id = window.chorus.S.view.id; return window.chorus.S.side[id] ?? '(default)'; })()`);
  const lit = () => js(`[...document.querySelectorAll('#chat-head [data-act="side"].on')].map(b => b.dataset.arg)`);
  const sidebar = () => js(`(() => { const d = document.getElementById('drawer'), t = document.getElementById('task-side'); return !d.hidden ? 'drawer:' + window.chorus.S.drawer : t && getComputedStyle(t).display !== 'none' ? 'task' : 'closed'; })()`);
  const box = (sel: string) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; })()`);
  const pairs: [string, string, string][] = [];

  /* ---------- a plain chat: closed sidebar; Artifacts, Activity, Record; a click or key in the screen closes them ---------- */
  const plain = await chat('codex', 'why is the build slow?');
  await open(plain);
  const startClosed = (await sidebar()) === 'closed' && !(await js(`!!document.querySelector('#chat-head [data-arg="task"]')`));
  await chrome.shot('app-chat', 'A chat: the agent\'s own screen, the sidebar closed');
  pairs.push(['app-chat', 'mock-chat', "A chat: the agent's own screen (UC-05)"]);
  const seen: Record<string, unknown> = {};
  for (const k of ['artifacts', 'activity', 'record']) {
    await chrome.click(`#chat-head [data-act="side"][data-arg="${k}"]`);
    await sleep(900);
    seen[k] = { sidebar: await sidebar(), lit: await lit(), head: await js(`document.querySelector('#drawer .drawer-head .title')?.textContent`) };
    await chrome.shot(`app-${k}`, `${k} in the sidebar`);
    pairs.push([`app-${k}`, `mock-${k}`, `${k[0].toUpperCase() + k.slice(1)} in the sidebar (UC-${{ artifacts: '07', activity: '11', record: '10' }[k]})`]);
  }
  // the lit one again closes it; ✕ closes it
  await chrome.click('#chat-head [data-act="side"][data-arg="record"]');
  const litAgain = await sidebar();
  await chrome.click('#chat-head [data-act="side"][data-arg="activity"]');
  await chrome.click('#drawer .drawer-head .icon-btn');
  const xCloses = await sidebar();
  // a click in the agent's screen closes a peek view; so does a key press there
  await chrome.click('#chat-head [data-act="side"][data-arg="artifacts"]');
  const termW0 = await js('window.chorus.term.cols');
  await chrome.click('#term-slot');
  await sleep(400);
  const clickCloses = await sidebar();
  const termW1 = await js('window.chorus.term.cols');
  await chrome.click('#chat-head [data-act="side"][data-arg="activity"]');
  await js('window.chorus.term.focus()');
  await chrome.key('Escape');
  await sleep(300);
  const keyCloses = await sidebar();
  check('c.1', 'A plain chat starts with the sidebar closed and no Task button; Artifacts, Activity and Record open their view in the one sidebar (title row, ✕, the pressed button lit); the lit one or ✕ closes it; a click or a key press in the agent\'s screen closes it; the terminal refits',
    startClosed && seen.artifacts && (seen as any).artifacts.sidebar === 'drawer:artifacts' && JSON.stringify((seen as any).activity.lit) === '["activity"]' && (seen as any).record.head === 'Record' && litAgain === 'closed' && xCloses === 'closed' && clickCloses === 'closed' && keyCloses === 'closed' && termW1 > termW0,
    JSON.stringify({ startClosed, seen, litAgain, xCloses, clickCloses, keyCloses, termW0, termW1 }), ['app-chat.png', 'app-artifacts.png', 'app-activity.png', 'app-record.png']);

  /* ---------- a CLI permission prompt: the thin red Approve/Deny line, over the chat column only ---------- */
  await js('window.chorus.term.focus()');
  await chrome.typeLine(`show ${path.join(publicDir, 'fixtures/codex/0.163.0/approval-ask-nohook-enter/prompt-screen.txt')}`);
  const banner = await chrome.until(() => js('!!document.querySelector("#chat-col #chat-banners .banner.ask")'), 15_000);
  await sleep(500);
  const bannerBox = await box('#chat-banners .banner.ask'), colBox = await box('#chat-col');
  await chrome.shot('app-chat-ask', 'The agent asks: Approve / Deny in the chat column');
  pairs.push(['app-chat-ask', 'mock-chat_ask', 'The agent asks: Approve / Deny in the chat (UC-06)']);
  const red = await js(`getComputedStyle(document.querySelector('#chat-banners .banner.ask')).backgroundColor`);
  await chrome.click('#chat-banners [data-act="deny"]');
  check('c.2', 'A CLI permission prompt is a thin red Approve/Deny banner inside the chat column only', banner && !!bannerBox && !!colBox && bannerBox.r <= colBox.r + 1 && bannerBox.l >= colBox.l - 1, JSON.stringify({ bannerBox, colBox, red }), ['app-chat-ask.png']);

  /* ---------- an ask card in a plain chat: asked twice, only the newest shows; Show more, Other…, note, Fold ---------- */
  const asker = await chat('claude', 'add a CSV export');
  await open(asker);
  await chrome.until(() => js(`document.querySelector('#ask-dock .ask-q')?.textContent === ${JSON.stringify(Q1)}`), 20_000);
  const first = await js(`document.querySelector('#ask-dock .ask-q')?.textContent`);
  const second = await chrome.until(() => js(`document.querySelector('#ask-dock .ask-q')?.textContent === ${JSON.stringify(Q2)}`), 20_000);
  const asks = await js(`window.chorus.S.state.approvals.filter(a => a.id === ${JSON.stringify(asker)} && a.kind === 'ask').length`);
  const cards = await js(`document.querySelectorAll('#view .ask-dock').length`);
  // 3 lines at this width: no Show more (it shows once the column is narrower, in the task chat below)
  const more = await js(`!document.querySelector('#ask-dock .ask-more').hidden`);
  const plainLabel = await js(`document.querySelector('#ask-dock .ask-who b')?.textContent`);
  const dockBox = await box('#ask-dock .ask-dock'), col2 = await box('#chat-col');
  const look = await js(`(() => { const d = document.querySelector('#ask-dock .ask-dock'), s = getComputedStyle(d), b = getComputedStyle(d.querySelector('.ask-who b')); return { bg: s.backgroundColor, border: s.borderTopColor + ' ' + s.borderTopWidth, label: b.color, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), panel: getComputedStyle(document.documentElement).getPropertyValue('--panel').trim() }; })()`);
  await chrome.shot('app-card', 'An ask card, docked in the chat: options, Other…, note, Fold');
  pairs.push(['app-card', 'mock-card', 'An ask card, docked in the chat (UC-06)']);
  await chrome.click('#ask-dock [data-act="other"]');
  const other = await js(`!document.querySelector('#ask-dock .other-row').hidden`);
  // a card click does not close what is open in the sidebar
  await chrome.click('#chat-head [data-act="side"][data-arg="record"]');
  await chrome.click('#ask-dock .ask-q');
  const cardClickKeeps = await sidebar();
  await chrome.click('#chat-head [data-act="side"][data-arg="record"]');
  // Fold: one line, remembered for this request after a reload
  await chrome.click('#ask-dock [data-act="ask-fold"]');
  const folded = await js(`!!document.querySelector('#ask-dock .ask-dock.min .ask-line')`);
  await chrome.shot('app-card-folded', 'The ask card folded to one line');
  await js('location.reload()');
  await sleep(2500);
  await open(asker);
  const stillFolded = await js(`!!document.querySelector('#ask-dock .ask-dock.min')`);
  await chrome.click('#ask-dock [data-act="ask-fold"]');
  check('c.3', 'Asked twice in one chat: only the newest card shows; it docks over the bottom of the chat column (panel colour, accent border and "asks you" label); Show more only when the details pass 3 lines; Fold to one line is remembered; a click on the card does not close the sidebar',
    first === Q1 && second && asks === 1 && cards === 1 && other && !more && plainLabel === 'Claude Code asks you' && !!dockBox && !!col2 && dockBox.r <= col2.r && dockBox.b <= col2.b && folded && stillFolded && cardClickKeeps === 'drawer:record',
    JSON.stringify({ first, second, asks, cards, other, more, plainLabel, dockBox, col2, folded, stillFolded, cardClickKeeps, look }), ['app-card.png', 'app-card-folded.png']);

  /* ---------- a task chat: Task open at first, the card beside it; Task stays open on a screen click; closed: full width ---------- */
  const mk = await r.api('POST', '/api/pro/dev/task', { project, title: 'CSV export of orders', description: 'Admins download the orders they filtered as a CSV, same columns as the table.', doneWhen: 'A filtered list downloads as a CSV with the same rows.', steps: [{ title: 'Export button', howToDo: 'Button next to the filters; downloads with the current filters.', howToCheck: 'Component test; a screenshot of the page.', files: ['src/pages/orders.tsx'], assignee: 'worker-claude' }] });
  const task = mk.json.id as string;
  if (!task) throw new Error(`no task: ${JSON.stringify(mk.json)}`);
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
  await chrome.until(() => js(`document.querySelector('#ask-dock .ask-q')?.textContent === ${JSON.stringify(Q2)}`), 25_000);
  await chrome.until(() => js(`!!document.querySelector('#chat-head [data-arg="task"]')`), 10_000);
  await sleep(800);
  const taskStart = { sidebar: await sidebar(), lit: await lit(), title: await js(`document.querySelector('#task-side .task-head .title')?.textContent`), border: await js(`getComputedStyle(document.querySelector('#task-side [data-pro-slot="chat-side"]').shadowRoot.querySelector('.res')).borderLeftWidth`) };
  const dockT = await box('#ask-dock .ask-dock'), sideT = await box('#task-side');
  // the teammate's name (UC-14), and it comes in when the module's data arrives after the card is drawn
  const mateName = (((await tasks()).find((t: any) => t.id === task)?.sessions ?? []).find((s: any) => s.thread_id === thread)?.teammate ?? '') as string;
  const mates = ((await r.state()) ?? {}).mates ?? [];
  const teammate = mates.find((m: any) => m.id === mateName)?.name ?? mateName;
  const taskLabel = await js(`document.querySelector('#ask-dock .ask-who b')?.textContent`);
  const mark = await js(`document.querySelector('#ask-dock .ask-who .badge.mini')?.textContent ?? ''`);
  const late = await js(`(() => { const p = window.choruspro, f = p.chatTeammate; p.chatTeammate = () => null; window.chorus.renderChatParts(); const before = document.querySelector('#ask-dock .ask-who b').textContent; p.chatTeammate = f; window.chorus.renderChatParts(); return [before, document.querySelector('#ask-dock .ask-who b').textContent]; })()`);
  const labelOk = !!teammate && taskLabel === `${teammate} asks you` && mark === 'C' && late[0] === 'Claude Code asks you' && late[1] === taskLabel;
  const moreT = await js(`!document.querySelector('#ask-dock .ask-more').hidden`);
  await chrome.click('#ask-dock .ask-more');
  const openedT = await js(`!document.querySelector('#ask-dock .what > div').classList.contains('clamp') && document.querySelector('#ask-dock .ask-more').textContent === 'Show less'`);
  await chrome.click('#ask-dock .ask-more');
  await chrome.shot('app-task-ask', 'Chat with an ask: a task chat, the Task open in the sidebar, the card over the chat column');
  pairs.push(['app-task-ask', 'mock-tk-ask', 'Chat with an ask (UC-14)']);
  await chrome.click('#term-slot');
  const taskStays = await sidebar();
  const cols0 = await js('window.chorus.term.cols');
  await chrome.click('#chat-head [data-act="side"][data-arg="task"]');
  await sleep(500);
  const closedT = await sidebar(), dockWide = await box('#ask-dock .ask-dock'), cols1 = await js('window.chorus.term.cols');
  const moreWide = await js(`!document.querySelector('#ask-dock .ask-more').hidden`);
  await chrome.shot('app-sidebar-closed', 'Sidebar closed: the chat and its card take the full width');
  pairs.push(['app-sidebar-closed', 'mock-tk-closed', 'Sidebar closed (UC-14)']);
  // remembered per chat: the plain chat is still closed, this one still closed when you come back
  await open(plain);
  const plainAgain = await sidebar();
  await open(thread);
  const taskAgain = await sidebar();
  await chrome.click('#chat-head [data-act="side"][data-arg="task"]');
  check('c.4', 'A task chat has Task first among Task · Artifacts · Activity · Record and starts with Task open (title row, ✕; the panel draws no frame of its own); the card names the teammate with its agent\'s mark, also when the module\'s data comes after the card; the card\'s details pass 3 lines in the narrower column: Show more opens them; the card stays over the chat column; a click in the screen keeps Task open; Task again closes the sidebar and the chat and card take the full width (the terminal refits); what was open is remembered per chat',
    taskStart.sidebar === 'task' && JSON.stringify(taskStart.lit) === '["task"]' && taskStart.title === 'Task' && taskStart.border === '0px' && labelOk && moreT && openedT && !!dockT && !!sideT && dockT.r <= sideT.l && taskStays === 'task' && closedT === 'closed' && !!dockWide && dockWide.r > dockT.r + 300 && cols1 > cols0 && !moreWide && plainAgain === 'closed' && taskAgain === 'closed',
    JSON.stringify({ taskStart, teammate, taskLabel, mark, late, moreT, openedT, dockT, sideT, taskStays, closedT, dockWide, moreWide, cols0, cols1, plainAgain, taskAgain }), ['app-task-ask.png', 'app-sidebar-closed.png']);
  // answered from the card: it leaves, the task chat as it is then
  await chrome.click('#ask-dock [data-act="pick"]', 'Right of the filters');
  const gone = await chrome.until(() => js(`!document.querySelector('#ask-dock .ask-dock')`), 10_000);
  await sleep(600);
  await chrome.shot('app-task-chat', 'A task chat: Task open in the sidebar');
  pairs.push(['app-task-chat', 'mock-tk-task', 'A task chat (UC-14)']);
  check('c.5', 'Answering from the card types the answer and the card leaves', gone, '', ['app-task-chat.png']);
  await open(plain);
  await chrome.shot('app-plain-chat', 'A chat (plain): closed sidebar');
  pairs.push(['app-plain-chat', 'mock-tk-chat', 'A chat (UC-14)']);

  /* ---------- Update Chorus: the band's four states (the states the server pushes, drawn by the page) ---------- */
  const upd = async (install: object | null, slug: string, mock: string, label: string) => {
    await js(`(() => { const u = { version: '2.2.1', currentVersion: '2.2.0', ...(${JSON.stringify(install)} ? { install: ${JSON.stringify(install)} } : {}) }; window.chorus.S.state.update = u; window.chorus.renderUpdate(u); document.getElementById('app-update').hidden = false; window.chorus.renderChrome(); })()`);
    await chrome.shot(slug, label);
    pairs.push([slug, mock, label]);
  };
  await upd(null, 'app-update', 'mock-update', 'Update: available (UC-17)');
  const btns = await js(`[...document.querySelectorAll('#app-update button')].map(b => b.textContent)`);
  await upd({ phase: 'downloading', pct: 40 }, 'app-update-run', 'mock-update_run', 'Update: updating (UC-17)');
  await upd({ phase: 'installing', pct: 100 }, 'app-update-installing', 'mock-update_run', 'Update: installing (UC-17)');
  await upd({ phase: 'ready', pct: 100 }, 'app-update-ready', 'mock-update_ready', 'Update: Restart Chorus (UC-17)');
  const restart = await js(`[...document.querySelectorAll('#app-update button')].map(b => b.textContent)`);
  await upd({ phase: 'failed', pct: 0, lines: ['curl: (28) Failed to connect to github.com port 443 after 30002 ms', 'chorus install: download failed, nothing was changed'] }, 'app-update-failed', 'mock-update_failed', 'Update: failed (UC-17)');
  const failed = await js(`[...document.querySelectorAll('#app-update button')].map(b => b.textContent)`);
  const top = await js(`document.querySelector('.update-btn')?.textContent`);
  check('c.6', 'The Update band under the top bar (the top bar\'s button opens and closes it): Update Chorus → Updating… (percent, then Installing…) → Restart Chorus; failed: the installer\'s last lines, Open the instructions and Try again',
    JSON.stringify(btns) === '["Skip this version","Update Chorus"]' && JSON.stringify(restart) === '["Restart Chorus"]' && JSON.stringify(failed) === '["Open the instructions","Try again"]', JSON.stringify({ btns, restart, failed, top }), ['app-update.png', 'app-update-run.png', 'app-update-ready.png', 'app-update-failed.png']);
  await js(`(() => { window.chorus.S.state.update = null; window.chorus.renderUpdate(null); window.chorus.renderChrome(); })()`);

  /* ---------- the mockup's scenes, the same size ---------- */
  const mock = path.join(publicDir, 'workspace/mockups/ui-mockup-v3.html');
  const scene = async (find: string, slug: string, then = '') => {
    await chrome.cdp('Page.navigate', { url: `file://${mock}` });
    await chrome.until(() => js('!!document.querySelector("#scenarios button")'), 8000);
    await js(`(() => { const b = [...document.querySelectorAll('#scenarios [data-scn]')].find(x => ${find}); b?.click(); })()`);
    await sleep(1500);
    if (then) (await js(then), await sleep(600));
    await js(`document.getElementById('window')?.scrollIntoView()`);
    await chrome.shot(slug, slug);
  };
  const tk = (label: string) => `x.dataset.scn.startsWith('tk') && x.textContent.trim().endsWith(${JSON.stringify(label)})`;
  for (const id of ['chat', 'chat_ask', 'card', 'artifacts', 'activity', 'record', 'update', 'update_ready', 'update_failed']) await scene(`x.dataset.scn === '${id}'`, `mock-${id}`);
  await scene(`x.dataset.scn === 'update_run'`, 'mock-update_run');
  await scene(tk('Chat with an ask'), 'mock-tk-ask');
  await scene(tk('Sidebar closed'), 'mock-tk-closed');
  await scene(tk('A task chat'), 'mock-tk-task');
  await scene(tk('A chat'), 'mock-tk-chat');

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
  check('c.7', 'Each screen saved beside its mockup scene', pairs.every(([a, m]) => fs.existsSync(path.join(dest, `${a}.png`)) && fs.existsSync(path.join(dest, `${m}.png`))), dest, []);
  r.lic.close();
}
