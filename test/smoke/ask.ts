#!/usr/bin/env node
// L3: do the real agents ask through Chorus (the request_approval tool and the note injected at start) instead of asking in
// their reply? Each agent gets a task that needs the user's OK first; the card must reach `chorus serve`, the answer must
// reach the agent, and the agent must then do the task. Agents' own permission prompts on the way are approved.
//
//   node test/smoke/ask.ts [--agents claude,codex,agy]
// Evidence: fixtures/ask/<date>/<agent>.json and the screen when the card arrived (emails masked).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { VirtualScreen } from '../../src/app/screen.ts';
import { Store } from '../../src/core/store.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const agents = (argv.includes('--agents') ? argv[argv.indexOf('--agents') + 1] : 'claude,codex,agy').split(',');
const OUT = path.join(ROOT, 'fixtures/ask', new Date().toISOString().slice(0, 10));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const mask = (s: string) => s.replace(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi, '<email>').replaceAll(os.homedir(), '~');
const TASK = 'Create a file hello.txt in the current directory containing the word hi. Get my approval for your plan before you create anything.';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-ask-home-'));
const env = { ...process.env, CHORUS_HOME: home, CHORUS_NO_OPEN: '1', CHORUS_MODEL_CLAUDE: 'haiku' } as Record<string, string>;
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];
const version = (cli: string) => (spawnSync(cli, ['--version'], { encoding: 'utf8' }).stdout.match(/\d+\.\d+\.\d+/) ?? [''])[0];

let failed = 0;
for (const agent of agents) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `chorus-ask-${agent}-`)));
  spawnSync('git', ['init', '-q'], { cwd: project });
  const serve = spawn(process.execPath, [path.join(ROOT, 'src/cli/index.ts'), 'serve', '--port', '0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'inherit'] });
  const url: string = await new Promise(r => serve.stdout!.on('data', d => { const m = String(d).match(/chorus serve: (\S+)/); if (m) r(m[1]); }));
  const u = new URL(url);
  const H = { authorization: `Bearer ${u.searchParams.get('token')}`, 'x-chorus': '1', 'content-type': 'application/json' };
  const api = async (method: string, p: string, body?: object) => (await fetch(u.origin + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined })).json() as Promise<any>;
  const res: Record<string, any> = { agent, version: version(agent), task: TASK };
  const t0 = Date.now();
  const log = (s: string) => console.log(`[${agent} ${Math.round((Date.now() - t0) / 1000)}s] ${s}`);
  try {
    const { id } = await api('POST', '/api/chats', { agent, folder: project, prompt: TASK });
    const screen = new VirtualScreen(120, 40);
    const ws = new WebSocket(u.origin.replace('http', 'ws') + '/ws', { headers: { authorization: H.authorization } });
    ws.on('message', d => { const m = JSON.parse(String(d)); if (m.t === 'screen') { screen.term.reset(); screen.write(m.data); } else if (m.t === 'out' && m.id === id) screen.write(m.data); });
    await new Promise(r => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'attach', id, cols: 120, rows: 40 }));
    const key = (data: string) => ws.send(JSON.stringify({ t: 'in', id, data }));
    const text = () => screen.text().join('\n');
    const store = () => new Store(project, { home });
    let card: any;
    let prompts = 0;
    let trusted = 0;
    // until the card arrives: answer folder-trust dialogs and the agent's own permission prompts like a person
    while (Date.now() - t0 < 240000 && !card) {
      const st = await api('GET', '/api/state');
      card = st.approvals.find((a: any) => a.kind === 'ask');
      const prompt = st.approvals.find((a: any) => a.kind === 'permission');
      if (!card && prompt) {
        log(`permission prompt: ${prompt.what}`);
        await api('POST', `/api/chats/${id}/approve`);
        prompts++;
      } else if (!card && trusted < 12 && /Yes, I trust this folder|Trust and continue|Do you trust/i.test(text())) {
        // Claude's cursor may not start on "Yes": move it there first (the dialog reads keys only once it is drawn)
        // Claude marks the selected row with ❯, agy with > at the start of the row
        const sel = screen.text().find(l => /❯|^\s*>\s/.test(l)) ?? '';
        const onYes = !/Yes, I trust this folder/.test(text()) || /(❯|>)\s*\d?\.?\s*Yes/.test(sel);
        log(`folder trust dialog (${onYes ? 'Enter' : 'Up'})`);
        key(onYes ? '\r' : '\x1b[A');
        trusted++;
      }
      await sleep(2000);
    }
    res.cardArrived = !!card;
    res.card = card && { question: card.question, details: card.details, options: card.options };
    res.permissionPromptsBeforeCard = prompts;
    res.screenAtCard = mask(text());
    log(card ? `card: ${card.question} [${card.options.join(' / ')}]` : 'no card');
    if (card) {
      await sleep(1500);
      const ok = await api('POST', `/api/chats/${id}/answer`, { request: card.request, option: card.options[0], note: 'go ahead' });
      res.answered = ok.ok;
      log(`answered ${card.options[0]}`);
      const file = path.join(project, 'hello.txt');
      while (Date.now() - t0 < 480000 && !fs.existsSync(file)) {
        const st = await api('GET', '/api/state');
        if (st.approvals.some((a: any) => a.kind === 'permission')) {
          log(`permission prompt: ${st.approvals.find((a: any) => a.kind === 'permission').what}`);
          await api('POST', `/api/chats/${id}/approve`);
        }
        await sleep(2000);
      }
      res.fileCreated = fs.existsSync(file);
      await sleep(3000);
      const s = store();
      const turns = s.getTurns(id, { limit: 100 });
      res.answerSeenByAgent = turns.some(t => t.role === 'user' && t.text.includes(`Chorus approval ${card.request}`));
      res.toolCalled = s.mcpCalls(id).some(m => m.tool === 'request_approval');
      res.askedInReplyInstead = turns.some(t => t.role === 'assistant' && /reply (with )?["“]?approve|click \**proceed|do you approve/i.test(t.text));
      s.close();
    }
    res.ok = !!(res.cardArrived && res.answered && res.fileCreated && res.answerSeenByAgent);
    ws.close();
  } catch (e) {
    res.error = String((e as Error).message);
  }
  serve.kill('SIGTERM');
  await sleep(1500);
  if (!res.ok) failed++;
  fs.writeFileSync(path.join(OUT, `${agent}.json`), JSON.stringify(res, null, 2) + '\n');
  console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${agent} ${res.version}: card ${res.cardArrived ? 'yes' : 'no'}, answer typed ${res.answerSeenByAgent ? 'yes' : 'no'}, file ${res.fileCreated ? 'created' : 'not created'}`);
}
console.log(`\nevidence: ${path.relative(ROOT, OUT)}`);
process.exit(failed ? 1 : 0);
