// Task #14 on the paid module's side of the page (mockup mail-courier.html v3, scenes 3 right, 4 and 5): a plain chat that runs Create
// plan (start_action) keeps its Task button; a new artifact lights Artifacts' border, a task change lights Task's; clicking Task clears
// its highlight and Artifacts stays lit; on a phone the Steps tab and the Artifacts button carry it. Fake agents, the module's dev
// bundle, a temp CHORUS_HOME: no model calls. A stage of chorus-core's Pro harness (docs/testing.md):
//   node <core>/test/pro-e2e/run.ts --public "$PWD" --stage <path of test/smoke/proof-mail-courier-pro relative to <core>/test/pro-e2e/checks>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export default async function (c: any) {
  const { chrome, check, out, project, publicDir } = c;
  const { rig } = await import(path.join(c.core, 'test/pro-e2e/checks/lib.ts'));
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd: publicDir, encoding: 'utf8' }).stdout.trim().replace(/\//g, '-');
  const dest = path.join(publicDir, '.chorus/proof', branch);
  fs.mkdirSync(dest, { recursive: true });
  // the chat: a plain chat, then Create plan in the same thread, its task, later an artifact, later a change to the task
  const script = path.join(out, 'courier-script.json');
  const note = path.join(project, 'notes', 'mail-courier.md');
  fs.writeFileSync(script, JSON.stringify({ claude: [
    { say: 'A plain chat. The user asks for a plan: Create plan, here.' },
    { call: 'start_action', args: { action: 'createPlan' } },
    { call: 'task_create', args: { title: 'Mail watchdog on the watcher', description: 'Make delivery between chats certain.', done_when: 'A stuck chat gets its mail.', no_goal: true } },
    { say: 'Task made.' },
    { wait: 9000 },
    { write: { path: 'notes/mail-courier.md', text: '# Mail courier\n' } },
    { call: 'show_artifact', args: { target: note, title: 'mail-courier.md' } },
    { wait: 7000 },
    { call: 'task_update', args: { description: 'Make delivery between chats certain: retry, then type one line.' } },
    { say: 'Task changed.' },
    { wait: 15000 },
    { call: 'task_update', args: { done_when: 'A stuck chat gets its mail; the draft comes back.' } },
    { say: 'Task changed again.' },
  ], '*': [] }));
  const r = await rig(c, { CHORUS_FAKE_SCRIPT: script });
  const js = chrome.js;
  const skip = async () => (await chrome.has('button', /Skip, start using Chorus/)) && (await chrome.click('button', 'Skip, start using Chorus'));
  await chrome.until(() => chrome.has('button', /Skip, start using Chorus/), 15_000);
  await skip();
  const shot = async (slug: string, what: string) => {
    await chrome.shot(slug, what);
    const f = fs.readdirSync(out).filter((x: string) => x.endsWith(`-${slug}.png`)).sort().at(-1);
    if (f) fs.copyFileSync(path.join(out, f), path.join(dest, `${slug}.png`));
    return slug;
  };
  const head = (sel: string) => js(`!!document.querySelector('#chat-head ${sel}')`);

  // a Just chat on the Planner (a session of action 'chat'); its Create plan adds a second session to the same thread
  const id = (await r.api('POST', '/api/pro/chat', { teammate: 'planner', project, message: 'Plan the mail watchdog' })).json.thread as string;
  c.log(`  chat ${id}`);
  await sleep(1500);
  await skip();
  await js(`window.chorus.go({ name: 'chat', id: ${JSON.stringify(id)} })`);
  // the right panel opens on Task for a task chat: close it, so the button is what shows
  const taskBtn = await chrome.until(() => head('[data-arg=task]'), 30_000);
  if (await head('[data-arg=task].on')) await js(`document.querySelector('#chat-head [data-arg=task]').click()`);
  await sleep(600);
  const sessions = r.db(`select count(*) from session where thread_id='${id}'`, 'pro.db');
  check('14.8a', 'A plain chat that ran Create plan (two sessions in its thread) shows the Task button', taskBtn && Number(sessions) >= 2, `sessions in the thread: ${sessions}`, [await shot('task-button-start-action', 'A plain chat that ran Create plan keeps its Task button')]);

  const artLit = await chrome.until(() => head('[data-arg=artifacts].hl'), 30_000);
  await sleep(300);
  check('14.8b', 'A new artifact lights the Artifacts border; Task is not lit', artLit && !(await head('[data-arg=task].hl')), 'border only', [await shot('artifacts-highlight', 'A new artifact: the Artifacts border lights up')]);

  const taskLit = await chrome.until(() => head('[data-arg=task].hl'), 30_000);
  await sleep(2400); // past the two glows: lit, still
  check('14.8c', 'A task change lights the Task border too (scene 4: both lit)', taskLit && (await head('[data-arg=artifacts].hl')), 'glowed twice, then stays lit', [await shot('task-highlight', 'Scene 4: Task and Artifacts both keep a yellow border')]);

  await js(`document.querySelector('#chat-head [data-arg=task]').click()`);
  await sleep(700);
  check('14.8d', 'Clicking Task opens its panel and clears its highlight; Artifacts stays lit (scene 5)', !(await head('[data-arg=task].hl')) && (await head('[data-arg=task].on')) && (await head('[data-arg=artifacts].hl')), 'cleared on click', [await shot('highlight-cleared', 'Scene 5: Task clicked, its highlight gone; Artifacts still lit')]);

  // a phone: the Steps tab and the Artifacts button carry it (a new change, seen nowhere yet)
  await js(`document.querySelector('#chat-head [data-arg=task]').click()`); // close the panel again
  await chrome.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 780, deviceScaleFactor: 2, mobile: true });
  await sleep(1500);
  await skip();
  const phoneArt = await chrome.until(() => js(`!!document.querySelector('#top .ph-art.hl')`), 10_000);
  const steps = await chrome.until(() => js(`!!document.querySelector('#chat-tabs .seg button.hl')`), 40_000);
  await sleep(2400);
  check('14.8e', 'Phone: the Steps tab and the Artifacts button beside ⋯ keep the highlight (scene 3, right)', phoneArt && steps, 'phone width 390', [await shot('phone-highlight', 'Phone: the Steps tab and the Artifacts button keep the highlight')]);
  await chrome.cdp('Emulation.clearDeviceMetricsOverride', {});
}
