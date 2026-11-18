#!/usr/bin/env node
// smoke:courier (task #14): the mail watchdog with the REAL claude, codex and agy, each on its cheapest model, chorus serve in this
// process on a temp CHORUS_HOME with the watchdog's clock at CHORUS_COURIER_MS=20000. Per CLI, a main chat and a sub thread:
//   1. normal delivery: the sub thread's report reaches main through the CLI's transport, and main calls read_mail;
//   5. second serve: another `chorus serve` starts and stops on the same home; mail still arrives through the transport;
//   2. transport broken, idle receiver, a 2-line draft (and in a second run a wrapped ~300-character one): the watchdog types the line,
//      a turn starts, read_mail is called, the mail goes delivered → read; the draft is back unsent; keys pressed meanwhile come after it;
//   3. busy receiver: the line is typed mid-turn and queued by the CLI; delivered_at stays empty until its turn starts; the draft stays;
//   4. a permission dialog on screen: nothing is typed; once it is answered, the line goes.
// The transport is broken for real: Claude's push finds no open stream (the hub's push refuses), Codex's `codex queue` and agy's
// `agy agentapi send-message` run a stub on PATH that exits 1. Output and final screens: .chorus/proof/<branch>/smoke/.
//   node test/smoke/courier.ts [claude,codex,agy] [--only 1,5,2,3,4]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inputState, SCRUB_ENV, transcriptHas } from '@chauvoluuhuong/chorus-core';
import { Controller } from '../../src/app/controller.ts';
import { buildInteractive } from '../../src/core/launch.ts';
import { Store } from '../../src/core/store.ts';
import type { AgentId } from '../../src/core/types.ts';
import { screenRows } from '../../src/serve/mail.ts';
import { ChatLaunch } from '../../src/serve/pro.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'src/cli/index.ts');
const argv = process.argv.slice(2);
const clis = (argv[0] && !argv[0].startsWith('--') ? argv[0] : 'claude,codex,agy').split(',') as AgentId[];
const only = (argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : '1,5,2,3,4').split(',');
const branch = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim().replace(/\//g, '-');
const OUT = path.join(ROOT, '.chorus/proof', branch, 'smoke');
fs.mkdirSync(OUT, { recursive: true });
const CHEAP: Record<AgentId, string> = { claude: 'haiku', codex: 'gpt-5.6-luna', agy: 'gemini-3.8-flash-low' };
const COURIER_MS = 20_000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const lines: string[] = [];
const log = (s: string) => (console.log(s), lines.push(s), fs.writeFileSync(path.join(OUT, 'smoke.log'), lines.join('\n') + '\n'));
const results: { cli: string; n: string; ok: boolean; what: string }[] = [];
const check = (cli: string, n: string, ok: boolean, what: string) => (results.push({ cli, n, ok, what }), log(`  ${ok ? 'PASS' : 'FAIL'}  ${cli} ${n}: ${what}`));
async function until(pred: () => boolean | Promise<boolean>, ms: number, every = 500) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await sleep(every);
  }
  return !!(await pred());
}

// a stub that fails every call: Codex's and agy's transports run their CLI's command through PATH at send time
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-courier-stub-'));
for (const b of ['codex', 'agy']) fs.writeFileSync(path.join(stubDir, b), '#!/bin/sh\necho "stub: transport broken by smoke:courier" >&2\nexit 1\n', { mode: 0o755 });
const realPath = process.env.PATH ?? '';

async function runCli(agent: AgentId) {
  const version = spawnSync(agent, ['--version'], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
  log(`\n== ${agent} ${version} (${CHEAP[agent]})`);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `chorus-courier-home-${agent}-`)));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `chorus-courier-${agent}-`)));
  spawnSync('git', ['init', '-q'], { cwd: project });
  process.env.CHORUS_HOME = home;
  process.env.CHORUS_COURIER_MS = String(COURIER_MS);
  for (const k of SCRUB_ENV) delete process.env[k];
  const store = new Store(project, { home });
  const launch = new ChatLaunch(store);
  const c = new Controller({ project, store, app: headlessApp(), models: { [agent]: CHEAP[agent] }, opener: async () => ({ ok: true }), launcher: (a, o) => buildInteractive(a, { ...o, ...launch.extras(o, a) }) });
  c.restore();
  const srv = new ChorusServer({ controller: c, chatLaunch: launch, check: async () => ({ node: { version: '22', ok: true }, platform: 'smoke', agents: [{ agent, state: 'ready' }], ms: 1 }) as any });
  const url = await srv.start(0);
  const S = srv as any;
  const api = async (method: string, p: string, body?: object) => {
    const r = await fetch(url + p, { method, headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    return t.startsWith('{') ? JSON.parse(t) : t;
  };
  const ws = new WebSocket(`${url.replace('http', 'ws')}/ws?token=${srv.token}`);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const typingEvents: any[] = [];
  let onTyping: ((m: any) => void) | undefined;
  ws.addEventListener('message', e => {
    const m = JSON.parse(String(e.data));
    if (m.t === 'mail-typing') (typingEvents.push(m), onTyping?.(m));
  });
  const keys = (id: string, data: string) => ws.send(JSON.stringify({ t: 'in', id, data }));
  const host = (id: string) => c.app.entry(id)?.host;
  const screen = (id: string) => (host(id)?.screen.text() ?? []).join('\n');
  const input = (id: string) => {
    const h = host(id);
    return h ? inputState(agent, screenRows(h.screen), h.screen.cols) : undefined;
  };
  const look = (id: string) => srv.look(id)?.state;
  const transcript = (id: string) => {
    const f = store.getThread(id)?.transcript_path;
    try {
      return f ? fs.readFileSync(f, 'utf8') : '';
    } catch {
      return '';
    }
  };
  const save = (name: string, id: string) => fs.writeFileSync(path.join(OUT, `${agent}-${name}.txt`), screen(id).replaceAll(os.homedir(), '~') + '\n');
  /** answers a trust question at start like a person; the channel warning is serve's own */
  const settle = async (id: string, ms = 90_000) => {
    let trust = 0;
    return until(() => {
      const sc = screen(id);
      if (trust < 3 && /Yes, I trust this folder|Do you trust the contents|Trust and continue/.test(sc)) {
        const sel = sc.split('\n').find(l => /❯|›|^\s*>\s/.test(l)) ?? '';
        host(id)?.write(/No, exit/.test(sel) ? '\x1b[B' : '');
        setTimeout(() => host(id)?.write('\r'), 300);
        trust++;
        return false;
      }
      return look(id) === 'waiting' && !!input(id)?.ready;
    }, ms, 700);
  };
  const breakTransport = () => {
    if (agent === 'claude') (S._push ??= S.channels.push), (S.channels.push = () => false);
    else process.env.PATH = `${stubDir}:${realPath}`;
  };
  const fixTransport = () => {
    if (agent === 'claude' && S._push) S.channels.push = S._push;
    process.env.PATH = realPath;
  };
  const MAIN_BRIEF = 'You are the main chat of a Chorus smoke test. Whenever a Chorus message arrives, or a line says you have unread messages, call your chorus tool read_mail at once, then reply with only: OK. Use no other tool. Now reply with only: READY.';

  try {
    // the main chat, and its sub thread (started through the main chat's own tool, as a model would)
    const main = (await api('POST', '/api/chats', { agent, folder: project, prompt: MAIN_BRIEF })).id as string;
    store.updateThread(main, { title: 'main' });
    check(agent, '0', await settle(main), 'the main chat is up and idle');
    const mcp = JSON.parse(fs.readFileSync(path.join(home, 'serve.json'), 'utf8')).mcpToken as string;
    const call = async (name: string, args: object, threadId: string) => (await fetch(`${url}/api/pro/mcp/call`, { method: 'POST', headers: { authorization: `Bearer ${mcp}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ name, args, threadId }) })).json() as any;
    const subTag = `SUB-${Math.random().toString(36).slice(2, 7)}`;
    const started = await call('start_subthread', { title: 'sub', agent, brief: `Smoke test sub thread. Reply with only: ${subTag}. Use no tool.` }, main);
    const sub = store.listThreads().find(t => t.parent_thread_id === main)?.id;
    check(agent, '0', !!sub, `the sub thread started (${JSON.stringify(started).slice(0, 80)})`);
    if (!sub) return;
    await settle(sub, 120_000);
    const mailTo = (id: string) => S.mail.list({ to: id }) as any[];
    const newest = (id: string) => mailTo(id).at(-1);
    const sendNote = (tag: string) => S.mail.send({ from: { who: 'chat', thread: sub, role: 'sub thread' }, to: { thread: main }, kind: 'note', subject: `sub thread note ${tag}`, body: `A note from the sub thread: ${tag}. Mark it read with read_mail.`, refs: {} }) as string;
    const readBy = async (id: string, ms: number) => until(() => S.mail.get(id)?.state === 'read' || S.mail.get(id)?.state === 'answered', ms, 1000);

    /* 1. normal delivery: the sub thread's own report, at its turn end */
    if (only.includes('1')) {
      // the report Chorus sends main at the sub thread's turn end (SubThreads: from Chorus, about the sub thread)
      const isReport = (m: any) => m.kind === 'report' && m.refs?.about === sub;
      const ok = await until(() => mailTo(main).some(isReport), 120_000, 1000);
      const m = mailTo(main).find(isReport);
      const read = ok && (await readBy(m.id, 120_000));
      const cur = m && S.mail.get(m.id);
      check(agent, '1', read && cur.route === 'transport' && cur.channel === agent, `the sub thread's report reached main through the ${agent} transport and main called read_mail (${cur?.state}, route ${cur?.route}, channel ${cur?.channel})`);
      await settle(main, 120_000);
      save('1-normal', main);
    }

    /* 5. a second serve on the same home starts and stops; mail still arrives through the transport */
    if (only.includes('5')) {
      const before = fs.readFileSync(path.join(home, 'serve.json'), 'utf8');
      const env = { ...process.env, CHORUS_HOME: home, CHORUS_NO_OPEN: '1', CHORUS_NOTIFICATIONS: '0', CHORUS_UPDATES: '0' } as Record<string, string>;
      const b = spawn(process.execPath, [CLI, 'serve', '--port', '0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let outB = '';
      b.stdout!.on('data', d => (outB += d));
      b.stderr!.on('data', d => (outB += d));
      const upB = await until(() => /chorus serve: \S+/.test(outB), 30_000);
      const keptOnStart = fs.readFileSync(path.join(home, 'serve.json'), 'utf8') === before;
      b.kill('SIGTERM');
      await new Promise(r => b.once('exit', r));
      const keptOnClose = fs.existsSync(path.join(home, 'serve.json')) && fs.readFileSync(path.join(home, 'serve.json'), 'utf8') === before;
      const id = sendNote('second-serve');
      const read = await readBy(id, 120_000);
      const m = S.mail.get(id);
      check(agent, '5', upB && keptOnStart && keptOnClose && read && m.route === 'transport', `a second serve came up (${upB}) and left serve.json alone (start ${keptOnStart}, close ${keptOnClose}); a note then arrived through the transport and was read (${m.state}, ${m.route})`);
      fs.writeFileSync(path.join(OUT, `${agent}-5-second-serve.txt`), `second serve output:\n${outB.replaceAll(os.homedir(), '~')}\nserve.json kept on start: ${keptOnStart}, on close: ${keptOnClose}\nmail ${id}: ${JSON.stringify(m, null, 1)}\n`);
      await settle(main, 120_000);
    }

    /* 2. transport broken, idle receiver: the watchdog types the line; the draft comes back unsent; keys pressed meanwhile after it */
    for (const kind of only.includes('2') ? ['two-lines', 'wrapped'] : []) {
      await settle(main, 120_000);
      breakTransport();
      const draft = kind === 'two-lines' ? ['draft one: keep this', 'draft two: and this'] : [Array.from({ length: 24 }, (_, i) => `word${i}-courier`).join(' ')];
      keys(main, draft[0]);
      if (draft[1]) (await sleep(300), keys(main, '\x1b\r'), await sleep(300), keys(main, draft[1]));
      const want = draft.join('\n');
      const drafted = await until(() => input(main)?.draft === want, 10_000, 300);
      check(agent, `2 ${kind}`, drafted, `the draft is in the input (${JSON.stringify(input(main)?.draft?.slice(0, 50))})`);
      let pressed = false;
      onTyping = m => {
        if (m.thread === main && m.phase === 'start' && !pressed) (pressed = true), setTimeout(() => keys(main, '!'), 100);
      };
      const t0 = Date.now();
      const id = sendNote(`idle-${kind}`);
      const typed = await until(() => !!S.mail.get(id)?.typed_at, COURIER_MS + 60_000, 500);
      const read = typed && (await readBy(id, 150_000));
      const m = S.mail.get(id);
      const t = transcript(main);
      await until(() => look(main) === 'waiting' && input(main)?.ready === true, 120_000, 1000);
      const back = input(main)?.draft;
      save(`2-${kind}`, main);
      check(agent, `2 ${kind}`, typed && m.route === 'typed' && m.channel === 'typed' && !!m.delivered_at && read, `typed after ${Math.round((Date.now() - t0) / 1000)} s, confirmed by the transcript, read with read_mail (${m.state}; attempts ${(m.attempts ?? []).map((a: any) => `${a.route}:${a.result}`).join(', ')})`);
      check(agent, `2 ${kind}`, transcriptHas(agent, t, [id]) && !t.includes(draft[0].slice(0, 16)), 'the line is a user message in the transcript; the draft never is');
      check(agent, `2 ${kind}`, back === `${want}!`, `the draft is back, unsent, with the key pressed meanwhile after it (${JSON.stringify(back?.slice(-40))})`);
      // the input empty again for the next scenario (the user's own keys)
      keys(main, '\x15'.repeat(6));
      fixTransport();
      onTyping = undefined;
    }

    /* 3. busy receiver: the line is typed mid-turn and queued by the CLI */
    if (only.includes('3')) {
      await settle(main, 120_000);
      keys(main, 'Without using any tool, write the numbers from 1 to 4000, one per line, with no other text.');
      await sleep(400);
      keys(main, '\r');
      const busy = await until(() => look(main) === 'working', 30_000, 300);
      breakTransport();
      await sleep(1500);
      keys(main, 'busy draft one');
      await sleep(300);
      keys(main, '\x1b\r');
      await sleep(300);
      keys(main, 'busy draft two');
      const id = sendNote('busy');
      const typed = await until(() => !!S.mail.get(id)?.typed_at, COURIER_MS + 60_000, 500);
      const stillWorking = look(main) === 'working';
      const m1 = S.mail.get(id);
      const notYet = !m1.delivered_at;
      save('3-busy-typed', main);
      check(agent, '3', busy && typed && stillWorking && notYet, `typed while the long turn still ran (working ${stillWorking}); delivered_at empty meanwhile (${notYet})`);
      const read = await readBy(id, 300_000);
      const m = S.mail.get(id);
      await until(() => look(main) === 'waiting', 120_000, 1000);
      save('3-busy-end', main);
      const back = input(main)?.draft;
      check(agent, '3', read && !!m.delivered_at && Date.parse(m.delivered_at) > Date.parse(m.typed_at), `delivered only once the queued turn started (typed ${m.typed_at}, delivered ${m.delivered_at}), then read`);
      check(agent, '3', back === 'busy draft one\nbusy draft two' && !transcript(main).includes('busy draft one'), `the draft is kept, unsent (${JSON.stringify(back)})`);
      keys(main, '\x15'.repeat(6));
      fixTransport();
    }

    /* 4. a permission dialog on screen: nothing is typed; once it is answered, the line goes */
    if (only.includes('4')) {
      await settle(main, 120_000);
      const ask = agent === 'claude' ? 'Use your Bash tool to run exactly this command: echo hi > smoke-file.txt' : agent === 'codex' ? 'Run the shell command `ls -la ~` and request escalated permissions (sandbox_permissions: require_escalated) for it.' : 'Read the file /etc/hosts and tell me its first line.';
      keys(main, ask);
      await sleep(400);
      keys(main, '\r');
      const dialog = await until(() => input(main)?.dialog === 'dialog', 90_000, 500);
      save('4-dialog', main);
      breakTransport();
      const id = sendNote('dialog');
      const dialogScreen = screen(main);
      await sleep(COURIER_MS + 15_000);
      const m0 = S.mail.get(id);
      const untouched = !m0.typed_at && input(main)?.dialog === 'dialog';
      check(agent, '4', dialog && untouched, `a dialog is on screen (${dialog}); nothing typed while it stays (${untouched}; the screen ${screen(main) === dialogScreen ? 'unchanged' : 'changed'})`);
      // the user answers it: the card's Approve, else Enter on its first option
      const card = (await api('GET', '/api/state')).approvals?.find((a: any) => a.id === main && a.kind === 'permission');
      if (card) await api('POST', `/api/chats/${main}/approve`);
      else keys(main, '\r');
      const typed = await until(() => !!S.mail.get(id)?.typed_at || S.mail.get(id)?.state === 'read', COURIER_MS + 120_000, 1000);
      const read = await readBy(id, 180_000);
      save('4-after', main);
      check(agent, '4', typed && read, `once answered, the line went and was read (${S.mail.get(id).state}, route ${S.mail.get(id).route})`);
      fixTransport();
    }
  } catch (e) {
    check(agent, 'x', false, `stopped: ${(e as Error).stack?.slice(0, 400)}`);
  } finally {
    fixTransport();
    ws.close();
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await sleep(2000);
    store.close();
  }
}

for (const agent of clis) await runCli(agent);
const by = (cli: string) => results.filter(r => r.cli === cli);
log('\n== summary');
for (const cli of clis) log(`${cli}: ${by(cli).filter(r => r.ok).length}/${by(cli).length} passed${by(cli).some(r => !r.ok) ? ` · failed: ${by(cli).filter(r => !r.ok).map(r => r.n).join(', ')}` : ''}`);
process.exit(results.some(r => !r.ok) ? 1 : 0);
