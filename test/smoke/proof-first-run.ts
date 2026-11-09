#!/usr/bin/env node
// First launch after install (plan 2026-11-09-pro-banner-first-run): the Welcome's choice (Community or Pro) comes first, then the
// Doctor. Drives the desktop page in headless Chrome over a fresh Chorus home, like a person, and saves a screenshot per step.
// No model calls: the Doctor only runs its short check of the CLIs on this Mac.
//
//   node test/smoke/proof-first-run.ts [--out <dir>] [--plans <file.json>]
//
// --plans: the Welcome's words to show (what the backend's /v1/plans answers), for a backend change not deployed yet.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openChrome, sleep } from './chrome.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'src/cli/index.ts');
const argv = process.argv.slice(2);
const arg = (k: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const OUT = path.resolve(arg('--out') ?? path.join(ROOT, '.chorus/proof/first-run'));
const PLANS = arg('--plans');
fs.mkdirSync(OUT, { recursive: true });

let failed = 0;
function check(name: string, ok: boolean) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  return ok;
}

// a fresh install: no Chorus home, no doctor record, no licence (Community)
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-first-'));
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-first-proj-')));
const env = { ...process.env, CHORUS_NO_OPEN: '1', CHORUS_HOME: path.join(home, 'chorus'), CHORUS_DOCTOR_HOME: home } as Record<string, string>;
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];

let serve: ChildProcess | undefined;
function startServe(): Promise<string> {
  const p = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  serve = p;
  p.stderr!.on('data', d => fs.appendFileSync(path.join(OUT, 'serve.log'), d));
  return new Promise((resolve, reject) => {
    let buf = '';
    p.stdout!.on('data', d => {
      buf += d;
      const m = buf.match(/chorus serve: (\S+)/);
      if (m) resolve(m[1]);
    });
    p.on('exit', c => reject(new Error(`serve exited ${c}: ${buf}`)));
  });
}
process.on('exit', () => serve?.kill('SIGTERM'));

const { cdp, js, shot, until, click, close } = await openChrome({ out: OUT, width: 1440, height: 1000, log: s => console.log(s) });
if (PLANS) {
  // the page asks its server for /api/pro/plans; answer with the given words instead
  const words = fs.readFileSync(PLANS, 'utf8');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `{ const f = window.fetch; window.fetch = (u, o) => String(u).endsWith('/api/pro/plans') ? Promise.resolve(new Response(${JSON.stringify(words)}, { headers: { 'content-type': 'application/json' } })) : f(u, o); }` });
}
const view = () => js<string>('chorus.S.view.name');
const doctorOpen = () => js<boolean>('!!document.querySelector("#doctor-pop")');

console.log('First launch: Community');
let url = await startServe();
await cdp('Page.navigate', { url });
check('the Welcome opens first', await until(async () => (await view()) === 'welcome' && (await js<boolean>('!!document.querySelector(".plan-card.pro li")')), 15_000));
// the Doctor's first-launch check runs at start; give it time to be done, then the Doctor must still be waiting
await until(() => js<boolean>('!!chorus.S.state?.doctor?.agents'), 15_000);
await sleep(1500);
check('the Doctor waits while the Welcome is in front', !(await doctorOpen()));
const pro = await js<string[]>('[...document.querySelectorAll(".plan-card.pro li b")].map(b => b.textContent)');
console.log(`  Pro lists: ${pro.join(' · ') || '(plain lines)'}`);
await shot('welcome', 'First launch: the Welcome, Community or Pro. The Doctor waits.');

await click('.plan-card button', /Keep Community/);
check('Keep Community opens the Doctor', await until(doctorOpen, 5000));
await until(() => js<boolean>('!/Checking/.test(document.querySelector("#fr-title")?.textContent ?? "")'), 15_000);
await shot('doctor', 'Then the Doctor: the short check of the agents.');
await click('#fr-foot button', /start using Chorus|Continue/);
check('the Doctor closes into New chat', await until(async () => !(await doctorOpen()) && (await view()) === 'new', 5000));
await shot('new-chat', 'Chorus, ready.');

console.log('Second launch: same home');
serve!.kill('SIGTERM');
await sleep(800);
url = await startServe();
await cdp('Page.navigate', { url });
await until(() => js<boolean>('!!chorus.S.state && !!chorus.S.pro'), 15_000);
await sleep(2500);
check('no Welcome again', (await view()) !== 'welcome');
check('no Doctor again (nothing changed)', !(await doctorOpen()));

console.log('Trial ended: the screen names every locked gate');
await js(`(() => { chorus.S.pro = { ...chorus.S.pro, plan: 'free', locked: ['portal', 'instructions', 'actions', 'processes', 'failures', 'teammate.create', 'remote'] }; chorus.go({ name: 'pro-ended' }); })()`);
const ended = await js<string>('document.querySelector("#view").textContent');
check('it says what stays and lists all seven', /You keep the Planner/.test(ended) && /Edit processes/.test(ended) && /Use remote access/.test(ended));
await shot('trial-ended', 'Trial ended (a stand-in plan): what stays, and what now needs Pro.');

close();
serve?.kill('SIGTERM');
console.log(`${failed ? `${failed} FAILED` : 'all passed'} · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
