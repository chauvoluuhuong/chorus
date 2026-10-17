#!/usr/bin/env node
// L3 smoke: the phase proofs against the REAL claude / codex / agy (docs/testing.md).
//
//   npm run smoke -- [--agents claude,codex,agy] [--phase 1,2,3]
//
//   Phase 1: scripted task per CLI; extracted turns, tool calls, usage and artifact match what happened
//   Phase 2: a marker skill synced from .chorus/skills is used by each CLI
//   Phase 3: a thread of one CLI is captured; a thread of another CLI loads it through the Chorus MCP server
//
// Raw captures are saved under <tmp>/chorus-smoke-*/ for fixtures when something fails.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureStream, captureTranscript } from '../../src/core/capture.ts';
import { buildHandoff, handoffPrompt } from '../../src/core/handoff.ts';
import { buildHeadless, run } from '../../src/core/launch.ts';
import { syncSkills } from '../../src/core/skills.ts';
import { Store } from '../../src/core/store.ts';
import type { AgentId } from '../../src/core/types.ts';

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => (argv.indexOf(`--${n}`) >= 0 ? argv[argv.indexOf(`--${n}`) + 1] : d);
const agents = opt('agents', 'claude,codex,agy').split(',') as AgentId[];
const phases = opt('phase', '1,2,3').split(',').map(Number);
const MODELS: Partial<Record<AgentId, string>> = { claude: 'haiku' };
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-smoke-'));

let failed = 0;
let skipped = 0;
const log = (s: string) => console.log(s);
function check(name: string, ok: boolean, detail = '') {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : detail ? `  (${detail.slice(0, 200)})` : ''}`);
  if (!ok) failed++;
  return ok;
}

const AUTH = /authenticate|oauth|not logged in|log in|login|expired|api key|unauthor/i;
const authHint = (out: string) => out.match(/[^"\n]*(?:authenticate|OAuth|not logged in|expired)[^"\n]*/i)?.[0].slice(0, 120) ?? 'login required';

function workspace(label: string) {
  const dir = fs.mkdtempSync(path.join(OUT, `${label}-`));
  fs.mkdirSync(path.join(dir, '.git'));
  return fs.realpathSync(dir);
}

async function thread(store: Store, project: string, agent: AgentId, prompt: string, o: { title: string; parent?: string; resume?: string } ) {
  const t = store.createThread({ title: o.title, agent, cwd: project, parent_thread_id: o.parent });
  const launch = buildHeadless(agent, { prompt, cwd: project, project, threadId: t.id, model: MODELS[agent], resumeId: o.resume });
  const r = await run(launch, { timeoutMs: 420_000 });
  const dir = path.join(OUT, `${agent}-${t.id}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stdout.jsonl'), r.stdout);
  fs.writeFileSync(path.join(dir, 'stderr.txt'), r.stderr);
  const needsAuth = r.code !== 0 && AUTH.test(r.stdout + r.stderr);
  if (launch.sessionId) store.updateThread(t.id, { native_session_id: launch.sessionId });
  const session = captureStream(store, t.id, r.stdout, prompt);
  return { t: store.getThread(t.id)!, r, session, needsAuth };
}

/* ---------- Phase 1 ---------- */
async function phase1(agent: AgentId) {
  log(`\nPhase 1 · ${agent}`);
  const project = workspace(`p1-${agent}`);
  const store = new Store(project);
  const art = path.join(store.root, 'threads');
  const prompt = (id: string) =>
    `Do these steps in order. 1) Use your shell tool to run: echo chorus-probe-$((6*7)). ` +
    `2) Write a markdown file at ${path.join(art, id, 'artifacts', 'report.md')} (create folders) containing the line "probe report". ` +
    `3) Reply with exactly: all done`;
  // thread id is needed in the prompt, so create the thread first
  const t0 = store.createThread({ id: 't_p1_' + agent, title: 'phase 1 task', agent, cwd: project });
  store.close();
  const store2 = new Store(project);
  const p = prompt(t0.id);
  const launch = buildHeadless(agent, { prompt: p, cwd: project, project, threadId: t0.id, model: MODELS[agent] });
  const r = await run(launch, { timeoutMs: 420_000 });
  fs.mkdirSync(path.join(OUT, `p1-${agent}-raw`), { recursive: true });
  fs.writeFileSync(path.join(OUT, `p1-${agent}-raw`, 'stdout.jsonl'), r.stdout);
  if (r.code !== 0 && AUTH.test(r.stdout + r.stderr)) {
    log(`  SKIP  ${agent} is not logged in: authenticate it, then re-run (${authHint(r.stdout + r.stderr)})`);
    skipped++;
    return;
  }
  if (launch.sessionId) store2.updateThread(t0.id, { native_session_id: launch.sessionId });
  const s = captureStream(store2, t0.id, r.stdout, p);
  check('exit code 0', r.code === 0, r.stderr);
  check('session id extracted', !!s.nativeSessionId);
  const shell = s.toolCalls.find(c => c.target.includes('chorus-probe'));
  check('shell tool call extracted with its output', !!shell && shell.status === 'ok' && /chorus-probe-42/.test(shell.result ?? ''), JSON.stringify(shell));
  check('final assistant turn is "all done"', /all done/i.test(s.turns.at(-1)?.text ?? ''), s.turns.at(-1)?.text);
  check('token usage extracted', s.usage.outputTokens > 0 && s.usage.inputTokens > 0, JSON.stringify(s.usage));
  const art1 = store2.listArtifacts(t0.id).map(a => a.path);
  check('artifact registered', art1.includes('report.md'), JSON.stringify(art1));
  // the CLI's own transcript must tell the same story (this is what interactive sessions rely on)
  const tr = captureTranscript(store2, t0.id);
  check('transcript found by session id', !!tr);
  if (tr) {
    check('transcript has the same tool call', tr.toolCalls.some(c => c.target.includes('chorus-probe')), JSON.stringify(tr.toolCalls.map(c => c.target)));
    check('transcript has the same final answer', /all done/i.test(tr.turns.at(-1)?.text ?? ''), tr.turns.at(-1)?.text);
  }
  store2.close();
}

/* ---------- Phase 2 ---------- */
async function phase2(agent: AgentId) {
  log(`\nPhase 2 · ${agent}`);
  const project = workspace(`p2-${agent}`);
  const marker = `kiwi-${Math.random().toString(36).slice(2, 6)}`;
  const dir = path.join(project, '.chorus/skills/probe-greeting');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: probe-greeting\ndescription: Use this skill when the user asks for the probe greeting. It defines the exact answer.\n---\n\nWhen the user asks for the probe greeting, reply with exactly: ${marker}\n`,
  );
  const rep = syncSkills(project);
  check('skill synced to the CLI folder', rep.linked.length > 0 && rep.conflicts.length === 0, JSON.stringify(rep));
  const store = new Store(project);
  const { t, r, session, needsAuth } = await thread(store, project, agent, 'What is the probe greeting? Reply with only the greeting.', { title: 'skill check' });
  if (needsAuth) {
    log(`  SKIP  ${agent} is not logged in: authenticate it (claude: claude auth login), then re-run`);
    skipped++;
    return;
  }
  check('answer contains the marker from the skill', (session.turns.at(-1)?.text ?? '').includes(marker), session.turns.at(-1)?.text);
  const readSkill = session.toolCalls.some(c => /probe-greeting/.test(c.target + c.tool));
  check('capture shows the skill being loaded (Skill tool or SKILL.md read)', readSkill, JSON.stringify(session.toolCalls.map(c => `${c.tool}:${c.target}`)));
  void t; void r;
  store.close();
}

/* ---------- Phase 3 ---------- */
async function phase3(from: AgentId, to: AgentId) {
  log(`\nPhase 3 · ${from} thread → ${to} thread`);
  const project = workspace(`p3-${from}-${to}`);
  fs.writeFileSync(path.join(project, 'package.json'), '{"type":"module"}');
  const store = new Store(project);
  const task =
    'In this directory create calc.js exporting function add(a, b) and calc.test.js using node:test and node:assert that checks add(2, 3) === 5. ' +
    'Run `node --test` with your shell tool and reply with one line saying whether the tests passed.';
  const a = await thread(store, project, from, task, { title: 'add function' });
  if (a.needsAuth) {
    log(`  SKIP  ${from} is not logged in: authenticate it (claude: claude auth login), then re-run`);
    skipped++;
    return;
  }
  check(`${from} created calc.js`, fs.existsSync(path.join(project, 'calc.js')));
  check(`${from} thread captured with a test run`, a.session.toolCalls.some(c => /node --test/.test(c.target)), JSON.stringify(a.session.toolCalls.map(c => c.target)));
  const digest = buildHandoff(store, a.t).text;
  check('handoff digest names the files and the test command', /calc\.js/.test(digest) && /node --test/.test(digest), digest.slice(0, 300));

  const b = await thread(store, project, to, handoffPrompt(a.t), { title: 'continue', parent: a.t.id });
  if (b.needsAuth) {
    log(`  SKIP  ${to} is not logged in: authenticate it (claude: claude auth login), then re-run`);
    skipped++;
    return;
  }
  const loaded = store.mcpCalls(b.t.id).some(m => m.tool === 'get_handoff_context');
  check(`${to} called get_handoff_context (Chorus saw it)`, loaded, JSON.stringify(store.mcpCalls(b.t.id)));
  const summary = b.session.turns.at(-1)?.text ?? '';
  check(`${to} summary names calc.js`, /calc(\.test)?\.js/.test(summary), summary);
  check(`${to} summary reports the test result`, /pass|✓|ok|succe/i.test(summary), summary);
  store.close();
}

/* ---------- main ---------- */
log(`captures: ${OUT}`);
if (phases.includes(1)) for (const a of agents) await phase1(a);
if (phases.includes(2)) for (const a of agents) await phase2(a);
if (phases.includes(3)) {
  const pairs: [AgentId, AgentId][] = [];
  for (let i = 0; i < agents.length; i++) pairs.push([agents[i], agents[(i + 1) % agents.length]]);
  for (const [a, b] of agents.length > 1 ? pairs : []) await phase3(a, b);
}
log(`\n${failed ? 'FAILED' : 'OK'}: ${failed} failed, ${skipped} skipped (not logged in). Captures: ${OUT}`);
process.exit(failed ? 1 : 0);
