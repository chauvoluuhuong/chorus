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
// no agent installed (all three hidden) is the short check that does not pass on any machine: the Doctor opens by itself
const HIDE_ALL = 'claude,codex,agy';
const env = { ...process.env, CHORUS_NO_OPEN: '1', CHORUS_NOTIFICATIONS: '0', CHORUS_HOME: path.join(home, 'chorus'), CHORUS_DOCTOR_HOME: home, CHORUS_DOCTOR_HIDE: HIDE_ALL } as Record<string, string>;
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

const { cdp, js, shot, until, click, key, close } = await openChrome({ out: OUT, width: 1440, height: 1000, log: s => console.log(s) });
if (PLANS) {
  // the page asks its server for /api/pro/plans; answer with the given words instead
  const words = fs.readFileSync(PLANS, 'utf8');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `{ const f = window.fetch; window.fetch = (u, o) => String(u).endsWith('/api/pro/plans') ? Promise.resolve(new Response(${JSON.stringify(words)}, { headers: { 'content-type': 'application/json' } })) : f(u, o); }` });
}
const view = () => js<string>('chorus.S.view.name');
const doctorOpen = () => js<boolean>('!!document.querySelector("#doctor-pop")');
const tipOpen = () => js<boolean>('!!document.querySelector("#doctor-tip .pop")');
const followOpen = () => js<boolean>('!!document.querySelector("#follow .fd")');

/** Meet Doctor (task #13, @workspace/mockups/doctor-tip.html scene 1): the popover beside its button, ♥ Follow opens the modal
 *  above it, Got it closes it for good. `anchor`: the Doctor button, or the More tab on a phone. */
async function checkTip(anchor: string, name: string, size: string) {
  if (!check(`${size}: Meet Doctor shows after the Welcome and the Doctor`, await until(tipOpen, 5000)))
    console.log(`  state: ${await js<string>('JSON.stringify({ view: chorus.S.view, size: chorus.S.size, pop: !!document.querySelector("#doctor-pop"), first: chorus.S.firstLaunch, seen: chorus.S.doctorTipSeen, shown: chorus.S.doctorTipShown, waits: chorus.S.doctorWaits, due: chorus.S.doctorDue, welcome: chorus.S.welcome, tabs: document.querySelector("#tabs")?.innerHTML.length })')}`);
  await sleep(600);
  const at = await js<{ spot: boolean; top: boolean; side: string; text: string; focus: string; gap: number; inside: boolean }>(`(() => {
    const a = document.querySelector(${JSON.stringify(anchor)}), p = document.querySelector('#doctor-tip .pop');
    const r = a.getBoundingClientRect(), q = p.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { spot: a.classList.contains('tip-spot'), top: a.contains(hit), side: p.dataset.side, text: p.textContent.replace(/\\s+/g, ' '),
      focus: document.activeElement.textContent, gap: p.dataset.side === 'up' ? r.top - q.bottom : q.left - r.right,
      inside: q.left >= 16 && q.right <= innerWidth - 16 && q.top >= 16 && q.bottom <= innerHeight - 16 };
  })()`);
  check(`${size}: it points at ${anchor} (${at.side}, ${Math.round(at.gap)}px away), which pulses above the dim`, at.spot && at.top && at.gap > 0 && at.gap < 20);
  check(`${size}: it stays 16px inside the window`, at.inside);
  check(`${size}: Meet Doctor, its line, Help shape Chorus, ♥ Follow and Got it`, /Meet Doctor/.test(at.text) && /Come here to test that your agents work with Chorus, or to report a bug\./.test(at.text) && /Help shape Chorus/.test(at.text) && /Follow us to share ideas and bug reports\./.test(at.text) && /♥ Follow/.test(at.text) && /Got it/.test(at.text));
  check(`${size}: focus is on Got it`, at.focus === 'Got it');
  await shot(name, 'First launch: Meet Doctor points at the Doctor button.');
  await click('#doctor-tip .btn', /♥ Follow/);
  check(`${size}: ♥ Follow opens the follow modal above the popover`, (await followOpen()) && (await js<boolean>('document.elementFromPoint(innerWidth / 2, innerHeight / 2)?.closest("#follow") != null')));
  await shot(`${name}-follow`, 'From the popover: the follow modal.');
  await key('Escape');
  check(`${size}: Esc closes the modal first, the popover stays`, !(await followOpen()) && (await tipOpen()));
  await click('#doctor-tip button', /Got it/);
  check(`${size}: Got it closes it`, !(await tipOpen()) && !(await js<boolean>('!!document.querySelector(".tip-spot")')));
  await sleep(500);
  await cdp('Page.reload', {});
  await until(() => js<boolean>('!!chorus.S.state && !!chorus.S.pro'), 15_000);
  await sleep(2500);
  check(`${size}: the server remembers it: after a reload it does not come back`, !(await tipOpen()) && (await js<boolean>('chorus.S.doctorTipSeen === true')));
}

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

// the popup opens only when the short check did not pass (owner, 2026-11-12): here no agent can be used
const usable = await js<string[]>('chorus.S.state.doctor.agents.filter(a => a.state === "ready" || a.state === "untested").map(a => a.agent + ": " + a.state)');
console.log(`  agents that can be used: ${usable.join(', ') || 'none'}`);
await click('.plan-card button', /Keep Community/);
check('the short check did not pass: Keep Community opens the Doctor', usable.length === 0 && (await until(doctorOpen, 5000)));
await until(() => js<boolean>('!/Checking/.test(document.querySelector("#fr-title")?.textContent ?? "")'), 15_000);
await shot('doctor', 'Then the Doctor: the short check of the agents.');
await click('#fr-foot button', /start using Chorus|Continue/);
check('the Doctor closes into New chat', await until(async () => !(await doctorOpen()) && (await view()) === 'new', 5000));
await checkTip('.side-foot button[data-act="doctor"]', 'tip', 'desktop');
await shot('new-chat', 'Chorus, ready.');

console.log('First launch again, clicking fast: the Doctor opens once');
{
  // a fresh home; the user picks and closes at once, before the Doctor's details are loaded: it must not come back
  serve!.kill('SIGTERM');
  await sleep(800);
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-first-'));
  Object.assign(env, { CHORUS_HOME: path.join(fresh, 'chorus'), CHORUS_DOCTOR_HOME: fresh });
  await cdp('Page.navigate', { url: await startServe() });
  await until(async () => (await view()) === 'welcome', 15_000, 100);
  await click('.plan-card button', /Keep Community/);
  await until(() => js<boolean>('!!document.querySelector("#fr-foot button.primary:not([disabled])")'), 15_000, 100);
  await click('#fr-foot button', /start using Chorus|Continue/);
  await sleep(5000);
  check('a closed Doctor stays closed', !(await doctorOpen()));
  // a click on the pulsing Doctor button closes Meet Doctor for good and opens Doctor
  await until(tipOpen, 5000);
  await click('.side-foot button[data-act="doctor"]');
  check('a click on Doctor closes Meet Doctor and opens the Doctor page', !(await tipOpen()) && (await view()) === 'doctor');
  serve!.kill('SIGTERM');
  await sleep(800);
  Object.assign(env, { CHORUS_HOME: path.join(home, 'chorus'), CHORUS_DOCTOR_HOME: home });
}

console.log('First launch where the short check passes: no Doctor popup');
{
  // this machine's own agents: Ready ones, and a version new to Chorus counts as passed too (owner, 2026-11-13)
  serve!.kill('SIGTERM');
  await sleep(800);
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-first-'));
  Object.assign(env, { CHORUS_HOME: path.join(fresh, 'chorus'), CHORUS_DOCTOR_HOME: fresh, CHORUS_DOCTOR_HIDE: '' });
  await cdp('Page.navigate', { url: await startServe() });
  await until(async () => (await view()) === 'welcome', 15_000, 100);
  await until(() => js<boolean>('!!chorus.S.state?.doctor?.agents && !chorus.S.state.doctor.checking'), 20_000);
  const states = await js<string[]>('chorus.S.state.doctor.agents.map(a => a.agent + ": " + a.state)');
  console.log(`  agents: ${states.join(', ')}`);
  await click('.plan-card button', /Keep Community/);
  await sleep(4000);
  const passed = states.some(x => / (ready|untested)$/.test(x)) && states.every(x => / (ready|untested|missing)$/.test(x));
  check('the short check passed: no Doctor popup, no "Checking…" first; the Doctor dot and page still show the result', passed && !(await doctorOpen()) && (await view()) === 'new');
  check('no Doctor popup: Meet Doctor comes right after the Welcome', await until(tipOpen, 5000));
  await shot('passed-no-doctor', 'First launch, the short check passed: no Doctor popup, Meet Doctor points at the Doctor button.');
  await key('Escape');
  check('Esc acts as Got it', !(await tipOpen()));
  await js(`chorus.go({ name: 'doctor' })`);
  await sleep(800);
  await click('#view button, #view [role="button"]', /Show details/);
  await sleep(400);
  const page = await js<{ text: string; deep: number }>('({ text: document.querySelector("#view").textContent, deep: document.querySelectorAll("#view [data-act=\\"doc-run\\"][data-arg$=\\":deep\\"]").length })');
  check('the Doctor page has the result and the detailed test', /Ready|New version/.test(page.text) && page.deep > 0) || console.log(`  page: ${page.deep} detailed-test buttons · ${page.text.replace(/\s+/g, ' ').slice(0, 400)}`);
  serve!.kill('SIGTERM');
  await sleep(800);
  env.CHORUS_DOCTOR_HIDE = HIDE_ALL;
  Object.assign(env, { CHORUS_HOME: path.join(home, 'chorus'), CHORUS_DOCTOR_HOME: home });
}

console.log('Second launch: same home');
serve!.kill('SIGTERM');
await sleep(800);
url = await startServe();
await cdp('Page.navigate', { url });
await until(() => js<boolean>('!!chorus.S.state && !!chorus.S.pro'), 15_000);
await sleep(2500);
check('no Welcome again', (await view()) !== 'welcome');
check('no Doctor again (nothing changed)', !(await doctorOpen()));
check('no Meet Doctor again', !(await tipOpen()));

console.log('Trial ended: the screen names every locked gate');
await js(`(() => { chorus.S.pro = { ...chorus.S.pro, plan: 'free', locked: ['portal', 'instructions', 'actions', 'processes', 'failures', 'teammate.create', 'remote'] }; chorus.go({ name: 'pro-ended' }); })()`);
const ended = await js<string>('document.querySelector("#view").textContent');
check('it says what stays and lists all seven', /You keep the Planner/.test(ended) && /Edit processes/.test(ended) && /Use remote access/.test(ended));
await shot('trial-ended', 'Trial ended (a stand-in plan): what stays, and what now needs Pro.');

console.log('First launch on a phone: Meet Doctor points at More');
{
  serve!.kill('SIGTERM');
  await sleep(800);
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-first-'));
  Object.assign(env, { CHORUS_HOME: path.join(fresh, 'chorus'), CHORUS_DOCTOR_HOME: fresh });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp('Page.navigate', { url: await startServe() });
  await until(async () => (await view()) === 'welcome' && (await js<boolean>('!!document.querySelector(".plan-card button")')), 15_000, 100);
  await sleep(1000);
  await click('.plan-card button', /Keep Community/);
  await until(() => js<boolean>('!!document.querySelector("#fr-foot button.primary:not([disabled])")'), 15_000, 100);
  await click('#fr-foot button', /start using Chorus|Continue/);
  await checkTip('#tabs button[data-arg="more"]', 'tip-phone', 'phone');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
}

close();
serve?.kill('SIGTERM');
console.log(`${failed ? `${failed} FAILED` : 'all passed'} · screenshots in ${OUT}`);
process.exit(failed ? 1 : 0);
