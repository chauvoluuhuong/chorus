// The Planner loop with the real Claude Code (plan 2026-11-13, item 3; cheapest model, few short turns): a Planner chat plans a
// two-step task, the plan is approved, the Planner asks for the grant, "start" typed into its chat starts step 1 with the skip flag,
// and step 1's Worker asks the Planner one question and gets the answer in its own chat. Every chat's screen is saved as text as it
// goes (the screen record), with the page's screens at each turn. A stage of chorus-core's Pro harness, run with --real:
//   node <core>/test/pro-e2e/run.ts --real --public "$PWD" --stage <path of test/smoke/proof-planner-real relative to <core>/test/pro-e2e/checks>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const ASK =
  'Plan a two-step task for this repository, and keep it small: step 1 adds a function add(a, b) to src/util.js, step 2 adds sub(a, b) to the same file. ' +
  'In step 1\'s "how to do it", write that the Worker must first ask the Planner with ask_planner (kind question) whether add should also accept numeric strings, wait for the answer, and follow it. ' +
  'Ask me what you need before you write the task. If I ask, the answer to the Worker\'s question is: no, numbers only.';

export default async function (c: any) {
  const { chrome, check, out, project, publicDir } = c;
  const { rig } = await import(path.join(c.core, 'test/pro-e2e/checks/lib.ts'));
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd: publicDir, encoding: 'utf8' }).stdout.trim();
  const dest = path.join(publicDir, '.chorus/proof', branch, 'real-planner-loop');
  fs.mkdirSync(dest, { recursive: true });
  const r = await rig(c);
  const js = chrome.js;
  const state = () => r.state();
  const host = async () => (await r.api('GET', '/api/state')).json;
  const log: string[] = [];
  const note = (s: string) => (log.push(`${new Date().toISOString().slice(11, 19)} ${s}`), c.log(`  ${s}`), fs.writeFileSync(path.join(dest, 'log.txt'), log.join('\n') + '\n'));
  const skip = async () => (await chrome.has('button', /Skip, start using Chorus/)) && (await chrome.click('button', 'Skip, start using Chorus'));
  await chrome.until(() => chrome.has('button', /Skip, start using Chorus/), 20_000);
  await skip();

  // the cheapest model for both teammates
  for (const role of ['planner', 'worker-claude']) {
    const m = (await state()).mates.find((x: any) => x.role === role || x.id === role);
    if (m) await r.api('POST', '/api/pro/mate', { ...m, ag: 'claude', model: 'haiku', effort: 'low' });
  }
  /** Each chat's screen, saved as text whenever it changes: the screen record. */
  const shots = new Map<string, number>();
  const record = async (who: string, id: string) => {
    const w = await r.watch(id, () => false, { ms: 1500, approve: true });
    const n = (shots.get(who) ?? 0) + 1;
    shots.set(who, n);
    fs.writeFileSync(path.join(dest, `${who}-${String(n).padStart(2, '0')}.txt`), w.screen);
    return w.screen as string;
  };
  const page = async (slug: string, id: string) => {
    await js(`window.chorus.go({ name: 'chat', id: ${JSON.stringify(id)} })`);
    await sleep(1800);
    await skip();
    await chrome.shot(slug, slug);
    const f = fs.readdirSync(out).filter((x: string) => x.endsWith(`-${slug}.png`)).sort().at(-1);
    if (f) fs.copyFileSync(path.join(out, f), path.join(dest, `${slug}.png`));
  };
  const until = async (what: string, fn: () => Promise<boolean>, ms: number, each?: () => Promise<void>) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return note(`${what}: after ${Math.round((Date.now() - t0) / 1000)} s`), true;
      await each?.();
      await sleep(2000);
    }
    note(`${what}: NOT within ${ms / 1000} s`);
    return false;
  };
  /** A question card from the Planner: answered with its first option (what a person in a hurry does); the grant is answered by its own step. */
  const answered = new Set<string>();
  const answerPlanner = async (thread: string) => {
    for (const a of (await host()).approvals ?? []) {
      if (a.id !== thread || a.kind !== 'ask' || answered.has(a.request) || /grant/i.test(a.question)) continue;
      answered.add(a.request);
      note(`the Planner asked: ${a.question} → ${a.options[0]}`);
      await r.api('POST', `/api/chats/${thread}/answer`, { request: a.request, option: a.options[0] });
    }
  };

  /* 1. the Planner plans: its questions first, then the task */
  const planner = (await r.api('POST', '/api/pro/run', { action: 'createPlan', teammate: 'planner', project, message: ASK })).json.thread as string;
  note(`Planner chat ${planner}`);
  const taskOf = async () => (await state()).tasks.find((t: any) => t.sessions?.some((s: any) => s.thread_id === planner));
  const planned = await until('the plan is written (a plan to approve)', async () => (await state()).needs.some((n: any) => n.kind === 'plan'), 600_000, async () => (await record('planner', planner), await answerPlanner(planner)));
  await page('real-1-planned', planner);
  const T = await taskOf();
  note(`task #${T?.number}: ${T?.steps?.length} steps · ${T?.steps?.map((s: any) => s.title).join(' / ')}`);

  /* 2. approved: core tells the Planner, which asks for the grant */
  const need = (await state()).needs.find((n: any) => n.kind === 'plan');
  if (need) await r.api('POST', '/api/pro/need', { id: need.id, answer: 'ok' });
  let grant: any;
  const asked = await until('the Planner asks "Grant the Workers all permissions for this plan?"', async () => !!(grant = ((await host()).approvals ?? []).find((a: any) => a.id === planner && a.kind === 'ask' && /grant/i.test(a.question))), 300_000, async () => (await record('planner', planner), await answerPlanner(planner)));
  await page('real-2-grant-card', planner);
  if (grant) {
    note(`grant card: ${grant.question} [${grant.options.join(' / ')}] kind ${grant.askKind}`);
    const yes = grant.options.find((o: string) => /yes|grant/i.test(o)) ?? grant.options[0];
    await r.api('POST', `/api/chats/${planner}/answer`, { request: grant.request, option: yes });
    note(`answered: ${yes}`);
  }
  const granted = await until('the task has the grant', async () => !!(await taskOf())?.grant || !!(await taskOf())?.skip_permissions || /grant/i.test(JSON.stringify(await taskOf())), 240_000, async () => void (await record('planner', planner)));

  /* 3. "start", typed into the Planner's chat as a person does */
  await until('the Planner chat is idle', async () => r.db(`select state from threads where id='${planner}'`) === 'waiting', 240_000, async () => void (await record('planner', planner)));
  await js(`window.chorus.go({ name: 'chat', id: ${JSON.stringify(planner)} })`);
  await sleep(1500);
  await js('window.chorus.term.focus()');
  await chrome.typeLine('start');
  note('typed "start" into the Planner chat');
  let worker = '';
  const started = await until('step 1\'s Worker chat starts', async () => !!(worker = ((await taskOf())?.sessions ?? []).find((s: any) => s.action === 'buildTask')?.thread_id ?? ''), 300_000, async () => void (await record('planner', planner)));
  const skipFlag = worker ? r.db(`select skip_permissions from threads where id='${worker}'`) : '';
  note(`Worker chat ${worker}: skip_permissions=${skipFlag}`);
  await page('real-3-worker-started', worker || planner);

  /* 4. the Worker asks the Planner, the Planner answers, the answer reaches the Worker's chat */
  const mail = async () => ((await r.api('GET', `/api/pro/dev/mail?task=${T?.id}`)).json?.messages ?? []) as any[];
  const asks = await until('the Worker asks the Planner (ask_planner), typed into the Planner chat', async () => (await mail()).some(m => m.kind === 'ask' && m.state === 'sent'), 600_000, async () => (await record('worker', worker), await record('planner', planner), await answerPlanner(planner)));
  const answers = await until('the Planner answers (answer_worker), typed into the Worker chat', async () => (await mail()).some(m => m.kind === 'answer' && m.state === 'sent'), 600_000, async () => (await record('planner', planner), await record('worker', worker), await answerPlanner(planner)));
  await sleep(4000);
  const wScreen = await record('worker', worker), pScreen = await record('planner', planner);
  await page('real-4-worker-answered', worker || planner);
  fs.writeFileSync(path.join(dest, 'mail.json'), JSON.stringify(await mail(), null, 2));
  fs.writeFileSync(path.join(dest, 'tools.json'), JSON.stringify({ planner: r.toolsOf(planner), worker: worker ? r.toolsOf(worker) : [] }, null, 2));
  const answerSeen = /the Planner answered your question/i.test(wScreen.replace(/\s+/g, ' '));
  check('real.1', 'Real Claude Code (haiku): the Planner asks first and writes a two-step task; approved, it asks for the grant (a question card); "start" typed into its chat starts step 1 with the skip flag; the Worker asks the Planner (ask_planner) and the answer is typed into the Worker\'s chat',
    planned && asked && !!grant && started && skipFlag === '1' && asks && answers && answerSeen,
    JSON.stringify({ planned, asked, grant: grant?.question, granted, started, skipFlag, asks, answers, answerSeen, plannerTools: r.toolsOf(planner), workerTools: worker ? r.toolsOf(worker) : [], plannerTail: pScreen.split('\n').filter((l: string) => l.trim()).slice(-6) }),
    ['real-2-grant-card.png', 'real-3-worker-started.png', 'real-4-worker-answered.png']);
  r.lic.close();
}
