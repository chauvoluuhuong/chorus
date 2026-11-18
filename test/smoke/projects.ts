#!/usr/bin/env node
// L3 (task #11 step 10): projects with the real CLIs, through `chorus serve` on a temp Chorus home.
//
//   node test/smoke/projects.ts [--agents claude,codex,agy] [--only A,A2,B,C,D,E] [--keep]
//
//   A   a working folder and two variables added through the API reach a NEW chat of each CLI, and again after the chat was parked
//       (serve restarted) and RESUMED
//   A2  a folder added through the API while a chat of each CLI runs reaches it LIVE (decision 13): it reads and writes there with no
//       restart (same process id), and no CLI settings file changed
//   B   a real Claude chat sets its project up by itself: get_project, ONE propose_project_change card (description, a folder from
//       package.json, a folder to create, a variable), approved with "Approve and restart this chat" and a typed value; after the
//       restart get_project shows it all and the chat uses it. The value appears nowhere but project-env.json (grep: 0 hits)
//   C   Export this project and Delete it through the API: the zip has only its chats; the folders stay on disk
//   D   Claude and Codex name their own chat with rename_chat; Undo (POST chats/:id/title by "you") restores the old name
//   E   a real Claude chat in This computer (a stand-in …/.chorus/computer under the run folder, never the owner's) creates a NEW
//       project through ONE propose_new_project card; "Create" with a typed value; the project lists with 0 chats and "+2 folders";
//       This computer's entry is unchanged; a new chat there sees it all in get_project; the value is nowhere but project-env.json
//
// Every test folder lives under ~/.cache/chorus/projects-smoke/<run>/ (never $TMPDIR: Codex may write there anyway) and is removed at
// the end (--keep leaves it). Expected strings never appear in a prompt, so an echoed prompt cannot pass.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { VirtualScreen } from '../../src/app/screen.ts';
import { Store } from '../../src/core/store.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const argv = process.argv.slice(2);
const arg = (n: string, d: string) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const AGENTS = arg('agents', 'claude,codex,agy').split(',');
const ONLY = new Set(arg('only', 'A,A2,B,C,D,E').split(','));
const KEEP = argv.includes('--keep');
const HOME = os.homedir();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const RUN = path.join(HOME, '.cache/chorus/projects-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
const CHOME = path.join(RUN, 'chorus-home');
fs.mkdirSync(CHOME, { recursive: true });
const SERVE_LOG = path.join(RUN, 'serve.log');
const T0 = Date.now();
const log = (s: string) => console.log(`[${String(Math.round((Date.now() - T0) / 1000)).padStart(4)}s] ${s}`);
const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};
const tilde = (s: string) => s.replaceAll(HOME, '~');
const version = (cli: string) => (spawnSync(cli, ['--version'], { encoding: 'utf8' }).stdout.match(/\d+\.\d+\.\d+/) ?? [''])[0];

const CONTEXT = 'This is an automated integration test of a developer tool; the files and variables hold dummy test values, not real secrets. ';
const DIR_OK = 'e2e-dir-ok';
const VARS = { E2E_VAR: 'e2e-env-ok', E2E_TOKEN: 'e2e-token-ok' };
const SECRET = 'e2e-secret-xyz';
const LIVE_OK = 'e2e-live-ok';

const env = { ...process.env, CHORUS_HOME: CHOME, CHORUS_NO_OPEN: '1', CHORUS_MODEL_CLAUDE: process.env.CHORUS_MODEL_CLAUDE ?? 'haiku', AGY_CLI_DISABLE_AUTO_UPDATE: '1' } as Record<string, string>;
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];

/* ---------- chorus serve ---------- */

type Api = (method: string, p: string, body?: object) => Promise<any>;
let serve: ChildProcess | undefined;
let origin = '';
let auth = '';
const api: Api = async (method, p, body) => {
  const r = await fetch(origin + p, { method, headers: { authorization: auth, 'x-chorus': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: r.status, text };
  }
};
const renamedEvents: any[] = [];
let events: WebSocket | undefined;

async function startServe() {
  const out = fs.openSync(SERVE_LOG, 'a');
  serve = spawn(process.execPath, [path.join(ROOT, 'src/cli/index.ts'), 'serve', '--port', '0'], { cwd: RUN, env, stdio: ['ignore', 'pipe', out] });
  const url: string = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('chorus serve did not start')), 60_000);
    serve!.stdout!.on('data', d => {
      fs.appendFileSync(SERVE_LOG, d);
      const m = String(d).match(/chorus serve: (\S+)/);
      if (m) (clearTimeout(t), resolve(m[1]));
    });
  });
  const u = new URL(url);
  origin = u.origin;
  auth = `Bearer ${u.searchParams.get('token')}`;
  events = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { authorization: auth } });
  events.on('message', d => {
    const m = JSON.parse(String(d));
    if (m.t === 'renamed') renamedEvents.push(m);
  });
  await new Promise(r => events!.once('open', r));
  log(`chorus serve at ${origin}`);
}

async function stopServe() {
  events?.close();
  if (!serve) return;
  const s = serve;
  serve = undefined;
  const gone = new Promise(r => s.once('exit', r));
  s.kill('SIGTERM');
  await Promise.race([gone, sleep(15_000)]);
  await sleep(2000);
}

const store = () => new Store(RUN, { home: CHOME });
function turnsText(id: string, from = 0) {
  const s = store();
  try {
    return s.getTurns(id, { limit: 1000 }).slice(from).map(t => `${t.role}: ${t.text}`).join('\n');
  } finally {
    s.close();
  }
}
function turnCount(id: string) {
  const s = store();
  try {
    return s.getTurns(id, { limit: 1000 }).length;
  } finally {
    s.close();
  }
}
function thread(id: string) {
  const s = store();
  try {
    return s.getThread(id);
  } finally {
    s.close();
  }
}
function mcpCalls(id: string) {
  const s = store();
  try {
    return s.mcpCalls(id);
  } finally {
    s.close();
  }
}

/* ---------- one chat, as a person drives it ---------- */

class Chat {
  id: string;
  agent: string;
  who: string;
  screen = new VirtualScreen(120, 40);
  ws!: WebSocket;
  prompts: string[] = [];
  private seen = new Set<string>();
  private trusted = 0;
  private daemon = false;
  dirScreens = 0;
  private dirSeen = false;
  constructor(id: string, agent: string, who: string) {
    this.id = id;
    this.agent = agent;
    this.who = who;
  }
  static async start(agent: string, folder: string, prompt: string, who: string, extra: object = {}) {
    const r = await api('POST', '/api/chats', { agent, folder, prompt, ...extra });
    if (!r.id) throw new Error(`${who}: chat not started: ${JSON.stringify(r)}`);
    const c = new Chat(r.id, agent, who);
    await c.attach();
    log(`${who}: chat ${c.id} started`);
    return c;
  }
  async attach() {
    this.screen = new VirtualScreen(120, 40);
    this.ws = new WebSocket(origin.replace('http', 'ws') + '/ws', { headers: { authorization: auth } });
    this.ws.on('message', d => {
      const m = JSON.parse(String(d));
      if (m.t === 'screen' && (!m.id || m.id === this.id)) (this.screen.term.reset(), this.screen.write(m.data));
      else if (m.t === 'out' && m.id === this.id) this.screen.write(m.data);
    });
    await new Promise(r => this.ws.once('open', r));
    this.ws.send(JSON.stringify({ t: 'attach', id: this.id, cols: 120, rows: 40 }));
  }
  text() {
    return this.screen.text().join('\n');
  }
  key(data: string) {
    this.ws.send(JSON.stringify({ t: 'in', id: this.id, data }));
  }
  async say(text: string) {
    this.key(text);
    await sleep(1200);
    this.key('\r');
    log(`${this.who}: typed "${text.slice(0, 100)}${text.length > 100 ? '…' : ''}"`);
  }
  async info() {
    return ((await api('GET', '/api/state')).chats as any[]).find(x => x.id === this.id);
  }
  pid() {
    return thread(this.id)?.cli_pid ?? undefined;
  }
  /** One tick: the startup screens and the CLI's own permission prompts (approved like a person would; each one recorded). */
  async tick() {
    const t = this.text();
    const limit = t.split('\n').find(l => !/tip:|\/usage/i.test(l) && /quota reached|limit reached|hit your .*limit|out of credits|exhausted your/i.test(l));
    if (limit) throw new Error(`QUOTA in ${this.who}: ${limit.trim()}`);
    if (!this.daemon && /Background server has incompatible feature settings/.test(t) && /1\. Run without daemon this time/.test(t)) {
      this.key('1');
      await sleep(800);
      this.key('\r');
      this.daemon = true;
      log(`${this.who}: codex daemon screen: run without daemon`);
    }
    if (this.trusted < 6 && /Yes, I trust this folder|Trust and continue|Do you trust|Accessing workspace/i.test(t) && !/Adding a new directory/.test(t)) {
      const sel = this.screen.text().find(l => /❯|^\s*>\s/.test(l)) ?? '';
      const onYes = !/Yes, I trust this folder/.test(t) || /(❯|>)\s*\d?\.?\s*Yes/.test(sel);
      this.key(onYes ? '\r' : '\x1b[A');
      this.trusted++;
      log(`${this.who}: folder trust dialog (${onYes ? 'Enter' : 'Up'})`);
      await sleep(1500);
    }
    // Claude's own screen for a folder it was launched with (--add-dir): Chorus answers it, never the test; seen = counted once
    if (/Adding a new directory/.test(t) && /No, exit/.test(t) && !this.dirSeen) (this.dirSeen = true, this.dirScreens++, log(`${this.who}: Claude's "Adding a new directory" launch screen is up (Chorus answers it)`));
    if (!/Adding a new directory/.test(t)) this.dirSeen = false;
    const st = await api('GET', '/api/state');
    // a plain request_approval card the model chose to show (not a proposal card: part B answers those): approved like a person would
    const ask = (st.approvals as any[]).find(a => a.id === this.id && a.kind === 'ask' && !a.proposal);
    if (ask && !this.seen.has(`card ${ask.request}`)) {
      this.seen.add(`card ${ask.request}`);
      log(`${this.who}: approval card from the model: "${String(ask.question ?? '').slice(0, 100)}" → ${ask.options?.[0]}`);
      await api('POST', `/api/chats/${this.id}/answer`, { request: ask.request, option: ask.options?.[0] ?? 'Approve' });
    }
    const perm = (st.approvals as any[]).find(a => a.id === this.id && a.kind === 'permission');
    if (perm) {
      const what = String(perm.what ?? perm.tool ?? '');
      if (!this.seen.has(what)) (this.seen.add(what), this.prompts.push(what), log(`${this.who}: permission prompt: ${what.slice(0, 160)}`));
      await api('POST', `/api/chats/${this.id}/approve`);
      await sleep(1000);
    }
  }
  /** Ticks until pred() holds or the time is up. */
  async until(pred: () => boolean | Promise<boolean>, ms: number, what: string) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await this.tick();
      if (await pred()) return true;
      await sleep(2000);
    }
    const st = await this.info().catch(() => undefined);
    log(`${this.who}: timed out waiting for ${what} (state ${st?.state}, live ${st?.live}); its screen:\n${this.text().split('\n').filter(l => l.trim()).slice(-18).map(l => `      | ${l}`).join('\n')}`);
    return false;
  }
  /** idle for `quiet` ms in a row */
  async idle(ms = 180_000, quiet = 4000) {
    let since = 0;
    return this.until(async () => {
      const s = (await this.info())?.state;
      if (s !== 'idle') return (since = 0), false;
      since ||= Date.now();
      return Date.now() - since >= quiet;
    }, ms, 'idle');
  }
  close() {
    this.ws?.close();
  }
}

/* ---------- the user's CLI settings ---------- */

function settingsFiles(P: string) {
  const fixed = [
    path.join(HOME, '.claude', 'settings.json'),
    path.join(HOME, '.claude', 'settings.local.json'),
    path.join(HOME, '.codex', 'config.toml'),
    path.join(HOME, '.gemini', 'settings.json'),
    path.join(HOME, '.gemini', 'antigravity-cli', 'settings.json'),
  ];
  const local: string[] = [];
  const walk = (x: string) => {
    for (const e of fs.existsSync(x) ? fs.readdirSync(x, { withFileTypes: true }) : []) {
      const p = path.join(x, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(json|toml|ya?ml)$/.test(e.name)) local.push(p);
    }
  };
  for (const d of ['.claude', '.codex', '.gemini', '.agents', '.agent']) walk(path.join(P, d));
  return [...fixed, ...local];
}
const snapSettings = (P: string) => Object.fromEntries(settingsFiles(P).map(f => [f, fs.existsSync(f) ? sha1(fs.readFileSync(f, 'latin1')) : null]));
function settingsChanged(before: Record<string, string | null>, P: string, D: string) {
  const after = snapSettings(P);
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...files].filter(f => (before[f] ?? null) !== (after[f] ?? null));
  const naming = [...files].filter(f => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(D));
  return [...new Set([...changed, ...naming])].map(tilde);
}

/* ---------- helpers ---------- */

function mkProject(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: dir });
  return fs.realpathSync(dir);
}
function mkFolder(dir: string, files: Record<string, string> = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), c);
  return fs.realpathSync(dir);
}
const has = (text: string, needle: string) => text.includes(needle);
const count = (text: string, needle: string) => text.split(needle).length - 1;
/** what the chat said and showed (its turns and its screen) */
const said = (c: Chat, from = 0) => `${turnsText(c.id, from)}\n${c.text()}`;
const promptsNaming = (c: Chat, dir: string) => c.prompts.filter(p => p.includes(dir) || p.includes(tilde(dir)) || p.includes(path.basename(dir)));

/** A's prompt and what it must show: plain for Claude and agy, SHA-1 hashes for Codex (its model will not print "secret" values) */
function aPrompt(agent: string, D: string, again = false) {
  const lead = again ? 'Once more, fresh: ' : '';
  if (agent === 'codex') return { prompt: `${CONTEXT}${lead}Run these shell commands and print their output: \`shasum < ${D}/secret-note.txt\`, \`printf %s "$E2E_VAR" | shasum\`, \`printf %s "$E2E_TOKEN" | shasum\`.`, want: { dir: sha1(`${DIR_OK}\n`), var: sha1(VARS.E2E_VAR), token: sha1(VARS.E2E_TOKEN) } };
  return { prompt: `${CONTEXT}${lead}Read ${D}/secret-note.txt and print its content, then run \`echo $E2E_VAR $E2E_TOKEN\` in your shell and print the output.`, want: { dir: DIR_OK, var: VARS.E2E_VAR, token: VARS.E2E_TOKEN } };
}

/* ---------- A: new and resumed chats get the folder and the variables ---------- */

interface AChat { agent: string; P: string; D: string; chat: Chat; want: Record<string, string> }

async function partA(): Promise<AChat[]> {
  const rows: AChat[] = [];
  await Promise.all(AGENTS.map(async agent => {
    const P = mkProject(path.join(RUN, `A-${agent}`, 'P'));
    const D = mkFolder(path.join(RUN, `A-${agent}`, 'D'), { 'secret-note.txt': `${DIR_OK}\n` });
    const f = await api('POST', '/api/projects/folders', { folder: P, dir: D, why: 'the e2e test folder' });
    const v1 = await api('POST', '/api/projects/variables', { folder: P, name: 'E2E_VAR', value: VARS.E2E_VAR, why: 'e2e' });
    const v2 = await api('POST', '/api/projects/variables', { folder: P, name: 'E2E_TOKEN', value: VARS.E2E_TOKEN, why: 'e2e' });
    if (f.error && !/No project/.test(f.error)) throw new Error(`A ${agent}: add folder: ${f.error}`);
    for (const v of [v1, v2]) if (v.error && !/No project/.test(v.error)) throw new Error(`A ${agent}: add variable: ${v.error}`);
    const { prompt, want } = aPrompt(agent, D);
    const chat = await Chat.start(agent, P, prompt, `A ${agent}`);
    rows.push({ agent, P, D, chat, want });
    const ok = await chat.until(() => Object.values(want).every(w => has(said(chat), w)), 300_000, 'the folder and both variables');
    const s = said(chat);
    const miss = Object.entries(want).filter(([, w]) => !has(s, w)).map(([k]) => k);
    check(`A ${agent} ${version(agent)} new chat: folder + E2E_VAR + E2E_TOKEN`, ok, miss.length ? `missing ${miss.join(', ')}` : `prompts naming D: ${promptsNaming(chat, D).length}`);
    await chat.idle(120_000);
  }));
  const one = await api('GET', `/api/projects/one?folder=${encodeURIComponent(rows[0]?.P ?? '')}`);
  check('A project page lists the folder and the variable names, no value', !!rows[0] && one.folders?.some((x: any) => x.path === rows[0].D) && one.variables?.length === 2 && !JSON.stringify(one).includes(VARS.E2E_TOKEN), `folders ${one.folders?.length}, variables ${one.variables?.map((v: any) => v.name).join(',')}`);

  // park: Chorus quits (every chat stops); resume: it starts again and each chat is opened (its CLI's resume)
  for (const r of rows) r.chat.close();
  await stopServe();
  await startServe();
  await Promise.all(rows.map(async r => {
    const before = r.chat;
    const chat = new Chat(before.id, r.agent, `A ${r.agent} resumed`);
    r.chat = chat;
    await chat.attach();
    const parked = (await chat.info())?.state;
    await api('POST', `/api/chats/${chat.id}/select`);
    const up = await chat.until(async () => (await chat.info())?.live === true, 60_000, 'the resumed CLI');
    await chat.idle(120_000, 6000);
    const turns0 = turnCount(chat.id);
    const screen0 = chat.text();
    const { prompt, want } = aPrompt(r.agent, r.D, true);
    await chat.say(prompt);
    const fresh = () => {
      const t = turnsText(chat.id, turns0);
      const sc = chat.text();
      return Object.values(want).every(w => has(t, w) || count(sc, w) > count(screen0, w));
    };
    const ok = await chat.until(fresh, 300_000, 'the folder and both variables after resume');
    check(`A ${r.agent} resumed chat (was ${parked}): folder + E2E_VAR + E2E_TOKEN`, up && ok, `native session ${thread(chat.id)?.native_session_id ? 'kept' : 'missing'}`);
    await chat.idle(120_000);
  }));
  for (const r of rows) r.chat.close();
  return rows;
}

/* ---------- A2: a folder added while the chat runs reaches it live ---------- */

async function partA2() {
  await Promise.all(AGENTS.map(async agent => {
    const P2 = mkProject(path.join(RUN, `A2-${agent}`, 'P2'));
    const D3 = mkFolder(path.join(RUN, `A2-${agent}`, 'D3'), { 'note.txt': `${LIVE_OK}\n` });
    const chat = await Chat.start(agent, P2, 'Reply with only the word: ready', `A2 ${agent}`);
    await chat.until(() => /ready/i.test(turnsText(chat.id)) || /^\s*[•⏺●✦]?\s*ready\s*$/im.test(chat.text()), 240_000, 'ready');
    await chat.idle(120_000, 6000);
    const before = snapSettings(P2);
    const pid0 = chat.pid();
    const t0 = Date.now();
    const add = await api('POST', '/api/projects/folders', { folder: P2, dir: D3, why: 'live add e2e' });
    log(`A2 ${agent}: folder added in ${Math.round((Date.now() - t0) / 1000)}s: ${add.error ?? 'ok'}`);
    await chat.idle(240_000, 5000);
    const turns0 = turnCount(chat.id);
    const screen0 = chat.text();
    await chat.say(`${CONTEXT}Read ${D3}/note.txt and print its content, then create the file ${D3}/live.txt containing the word ok.`);
    const live = path.join(D3, 'live.txt');
    const ok = await chat.until(() => fs.existsSync(live) && (has(turnsText(chat.id, turns0), LIVE_OK) || count(chat.text(), LIVE_OK) > count(screen0, LIVE_OK)), 300_000, 'the live read and write');
    await chat.idle(120_000);
    const pid1 = chat.pid();
    const read = has(turnsText(chat.id, turns0), LIVE_OK) || count(chat.text(), LIVE_OK) > count(screen0, LIVE_OK);
    const changed = settingsChanged(before, P2, D3);
    const naming = promptsNaming(chat, D3);
    check(`A2 ${agent} live add: read ${read ? 'ok' : 'NO'}, write ${fs.existsSync(live) ? 'ok' : 'NO'}, no restart`, ok && read && fs.existsSync(live) && !!pid0 && pid0 === pid1, `pid ${pid0} → ${pid1}; CLI prompts naming D3 after the add: ${naming.length}${naming.length ? ` (${naming.map(n => n.slice(0, 80)).join(' | ')})` : ''}`);
    check(`A2 ${agent} settings files unchanged`, !changed.length, changed.join(', ') || 'none changed, none names D3');
    chat.close();
  }));
}

/* ---------- B: the model sets its project up ---------- */

function claudeTranscript(sid: string | null | undefined) {
  if (!sid) return undefined;
  const base = path.join(HOME, '.claude', 'projects');
  for (const d of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    const f = path.join(base, d, `${sid}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  return undefined;
}
/** every get_project result in the Claude transcript, parsed */
function getProjectResults(file: string | undefined) {
  if (!file) return [];
  const ids = new Set<string>();
  const out: any[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let j: any;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    for (const c of Array.isArray(j?.message?.content) ? j.message.content : []) {
      if (c.type === 'tool_use' && /get_project$/.test(c.name)) ids.add(c.id);
      if (c.type === 'tool_result' && ids.has(c.tool_use_id)) {
        const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join('') : String(c.content ?? '');
        try {
          out.push(JSON.parse(text));
        } catch {
          out.push({ raw: text });
        }
      }
    }
  }
  return out;
}

const SETUP = 'Set this project up for work: call get_project, then in ONE propose_project_change give it a short description, add the folders it needs, create a folder ../S-scratch for scratch output, and ask for a variable named E2E_SECRET that the tests need. Then end your turn.';

async function partB(): Promise<{ transcripts: string[] }> {
  const base = path.join(RUN, 'B');
  const lib = mkFolder(path.join(base, 'S-lib'), { 'package.json': JSON.stringify({ name: 's-lib', version: '1.0.0' }, null, 2), 'index.js': 'module.exports = 1;\n' });
  const S = mkProject(path.join(base, 'S'));
  fs.writeFileSync(path.join(S, 'package.json'), JSON.stringify({ name: 's', version: '1.0.0', dependencies: { 's-lib': 'file:../S-lib' } }, null, 2));
  const scratch = path.join(path.dirname(S), 'S-scratch');
  const model = process.env.SMOKE_B_MODEL ?? 'sonnet';
  const chat = await Chat.start('claude', S, SETUP, `B claude (${model})`, { model });
  let card: any;
  await chat.until(async () => {
    const st = await api('GET', '/api/state');
    card = (st.approvals as any[]).find(a => a.id === chat.id && a.proposal);
    return !!card;
  }, 360_000, 'the proposal card');
  const firstGp = getProjectResults(claudeTranscript(thread(chat.id)?.native_session_id))[0];
  const calls = mcpCalls(chat.id).map(m => m.tool);
  check('B get_project called before proposing, suggested_folders lists S-lib', calls.includes('get_project') && !!firstGp?.suggested_folders?.some((f: any) => (f.path ?? f) === lib), `calls: ${calls.join(', ')}; suggested: ${JSON.stringify(firstGp?.suggested_folders?.map((f: any) => tilde(f.path ?? f)))}; setup_hint: ${firstGp?.setup_hint ? 'yes' : 'no'}`);
  const cards = ((await api('GET', '/api/state')).approvals as any[]).filter(a => a.id === chat.id && a.proposal);
  const ch = (card?.proposal?.changes ?? []) as any[];
  const kinds = ch.map(c => `${c.kind}${c.path ? ` ${tilde(c.path)}` : ''}${c.name ? ` ${c.name}` : ''}`);
  const want = [
    ch.some(c => c.kind === 'set_note' && c.note),
    ch.some(c => c.kind === 'add_folder' && c.path === lib),
    ch.some(c => c.kind === 'create_folder' && c.path === scratch),
    ch.some(c => c.kind === 'set_variable' && c.name === 'E2E_SECRET'),
  ];
  check('B ONE card with set_note, add_folder S-lib, create_folder S-scratch, set_variable E2E_SECRET', cards.length === 1 && want.every(Boolean), `${cards.length} card(s): ${kinds.join('; ')}; options: ${card?.options?.join(' / ')}`);
  if (!card) return { transcripts: [] };
  const option = (card.options as string[]).find(o => /restart/i.test(o)) ?? card.options[0];
  const pid0 = chat.pid();
  const ans = await api('POST', `/api/chats/${chat.id}/answer`, { request: card.request, option, values: { E2E_SECRET: SECRET } });
  check('B approved with "Approve and restart this chat"; S-scratch created', ans.ok === true && fs.existsSync(scratch) && fs.statSync(scratch).isDirectory(), `${option}: ${ans.error ?? tilde(ans.text ?? '')}`);
  const restarted = await chat.until(async () => !!chat.pid() && chat.pid() !== pid0 && (await chat.info())?.live === true, 300_000, 'the restart at turn end');
  check('B the chat restarted at its turn end (conversation kept)', restarted, `pid ${pid0} → ${chat.pid()}`);
  await chat.idle(180_000, 6000);
  const turns0 = turnCount(chat.id);
  await chat.say(`${CONTEXT}Call get_project again, then list the files in ${tilde(lib)}, write ${tilde(scratch)}/ok.txt containing ok, and run \`echo \${#E2E_SECRET}\` (it prints the length only) and print its output.`);
  const okFile = path.join(scratch, 'ok.txt');
  const len = String(SECRET.length);
  await chat.until(() => fs.existsSync(okFile) && new RegExp(`\\b${len}\\b`).test(turnsText(chat.id, turns0)), 300_000, 'ok.txt and the length');
  await chat.idle(120_000);
  const all = getProjectResults(claudeTranscript(thread(chat.id)?.native_session_id));
  const gp = all.at(-1);
  const wf = (gp?.working_folders ?? []) as any[];
  const libF = wf.find(f => f.path === lib), scrF = wf.find(f => f.path === scratch);
  const v = (gp?.variables ?? []).find((x: any) => x.name === 'E2E_SECRET');
  const second = all.length >= 2 && !!gp?.note && libF?.why && libF?.in_this_chat === true && scrF?.why && scrF?.in_this_chat === true && scrF?.created === true && v?.in_this_chat === true && !(gp?.suggested_folders ?? []).some((f: any) => (f.path ?? f) === lib) && !gp?.setup_hint;
  check('B second get_project: note, both folders with why and in_this_chat, E2E_SECRET in_this_chat, S-lib no longer suggested, no setup_hint', !!second, `${all.length} get_project results; note ${gp?.note ? 'yes' : 'no'}; S-lib ${libF ? `why "${libF.why}" in_this_chat ${libF.in_this_chat}` : 'missing'}; S-scratch ${scrF ? `why "${scrF.why}" created ${scrF.created} in_this_chat ${scrF.in_this_chat}` : 'missing'}; E2E_SECRET in_this_chat ${v?.in_this_chat}; setup_hint ${gp?.setup_hint ? 'yes' : 'no'}`);
  check(`B S-scratch/ok.txt written and the length "${len}" printed`, fs.existsSync(okFile) && new RegExp(`\\b${len}\\b`).test(turnsText(chat.id, turns0)));
  chat.close();
  return { transcripts: [claudeTranscript(thread(chat.id)?.native_session_id)].filter(Boolean) as string[], S } as any;
}

/* ---------- C: export one project, delete it ---------- */

async function partC(P: string, D: string) {
  const ids = ((await api('GET', '/api/state')).chats as any[]).filter(c => c.cwd === P).map(c => c.id);
  const all = ((await api('GET', '/api/state')).chats as any[]).map(c => c.id);
  const ex = await api('POST', '/api/export', { project: P });
  let zipChats: string[] = [];
  let projectJson: any = {};
  if (ex.file) {
    const j = JSON.parse(spawnSync('unzip', ['-p', ex.file, 'chorus.json'], { encoding: 'utf8' }).stdout || '{}');
    zipChats = (j.chats ?? []).map((c: any) => c.id ?? c.thread?.id).filter(Boolean);
    projectJson = JSON.parse(spawnSync('unzip', ['-p', ex.file, 'project.json'], { encoding: 'utf8' }).stdout || '{}');
  }
  const only = zipChats.length === ids.length && zipChats.every(id => ids.includes(id));
  // project.json carries the variables' names and why, never a value (the chat's own turns may show a value it printed: that is its output)
  const namesOnly = Array.isArray(projectJson.variables) && projectJson.variables.every((v: any) => !('value' in v)) && !JSON.stringify(projectJson).includes(VARS.E2E_TOKEN) && !JSON.stringify(projectJson).includes(VARS.E2E_VAR);
  check('C Export this project: one zip with only its chats, names only', !!ex.file && only && all.length > ids.length && namesOnly, `${tilde(ex.file ?? ex.error ?? '')}: ${zipChats.length} chat(s) of ${ids.length} in the project, ${all.length} in Chorus; variables ${projectJson.variables?.map((v: any) => v.name).join(',')}`);
  const del = await api('DELETE', '/api/projects', { folder: P });
  const list = (await api('GET', '/api/projects')) as any[];
  const one = await api('GET', `/api/projects/one?folder=${encodeURIComponent(P)}`);
  check('C Delete: the project leaves Chorus, P and D stay on disk', !list.some(p => p.folder === P) && !!one.error && fs.existsSync(P) && fs.existsSync(path.join(D, 'secret-note.txt')), `removed ${del.removed} chat(s); P ${fs.existsSync(P) ? 'stays' : 'GONE'}, D ${fs.existsSync(D) ? 'stays' : 'GONE'}`);
  return ex.file as string | undefined;
}

/* ---------- D: the model names its chat ---------- */

async function partD() {
  await Promise.all(AGENTS.filter(a => a !== 'agy').map(async agent => {
    const P = mkProject(path.join(RUN, `D-${agent}`));
    const prompt = 'Plan, in three lines, a tiny script that prints the date. Then name this chat for what it is about.';
    const chat = await Chat.start(agent, P, prompt, `D ${agent}`);
    let ev: any;
    await chat.until(() => !!(ev = renamedEvents.find(e => e.id === chat.id && e.by === 'model')), 300_000, 'rename_chat');
    const first = String(ev?.from ?? '');
    const now = thread(chat.id)?.title ?? '';
    const sidebar = (await chat.info())?.title;
    check(`D ${agent} rename_chat: model-chosen title, 'renamed' event by model`, !!ev && !!first && now === ev.to && now !== first && now.length <= 60 && sidebar === now && mcpCalls(chat.id).some(m => m.tool === 'rename_chat'), `"${first}" → "${now}"`);
    const idle = await chat.idle(120_000);
    // a chat with no project settings: its CLI's transcript is matched (turns, native session) and the watcher sees it idle
    const row = thread(chat.id);
    const turns = turnsText(chat.id);
    check(`D ${agent} plain chat: transcript matched (turns, native session), idle after its turn`, idle && !!row?.native_session_id && /^assistant: /m.test(turns) && row?.state === 'waiting', `native ${row?.native_session_id ? 'yes' : 'NO'}, ${turnCount(chat.id)} turns, store state ${row?.state}`);
    const undo = await api('POST', `/api/chats/${chat.id}/title`, { title: first, by: 'you' });
    const back = thread(chat.id)?.title;
    check(`D ${agent} Undo restores the old name`, undo.ok === true && back === first && renamedEvents.some(e => e.id === chat.id && e.by === 'you'), `now "${back}"`);
    chat.close();
  }));
}

/* ---------- E: a chat in This computer creates a new project ---------- */

const E_SECRET = 'dummy-secret-123';

async function partE(): Promise<{ transcripts: string[] }> {
  const dir = mkFolder(path.join(RUN, 'E'));
  const computer = mkFolder(path.join(RUN, 'E-home', '.chorus', 'computer'));
  const lib = mkFolder(path.join(dir, 'dummy-lib'), { 'index.js': 'module.exports = 1;\n' });
  const app = path.join(dir, 'dummy-app');
  const notes = path.join(dir, 'dummy-notes');
  const pj = path.join(CHOME, 'projects.json');
  const before = JSON.stringify((fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')) : {})[computer] ?? null);
  const model = process.env.SMOKE_B_MODEL ?? 'sonnet';
  const prompt = `${CONTEXT}First check where this chat is with get_project. Then set me up a new project called dummy-app at ${dir}/dummy-app (create it), with a short description, a working folder ${lib} (exists) and a new folder ${notes}, and a variable DUMMY_TOKEN the app needs.`;
  const chat = await Chat.start('claude', computer, prompt, `E claude (${model})`, { model });
  let card: any;
  await chat.until(async () => {
    const st = await api('GET', '/api/state');
    card = (st.approvals as any[]).find(a => a.id === chat.id && a.proposal);
    return !!card;
  }, 360_000, 'the new-project card');
  const gp = getProjectResults(claudeTranscript(thread(chat.id)?.native_session_id))[0];
  const calls = mcpCalls(chat.id).map(m => m.tool);
  check('E get_project in This computer said is_project false', gp?.is_project === false && gp?.place === 'This computer', `calls: ${calls.join(', ')}; is_project ${gp?.is_project}; place ${gp?.place}`);
  const cards = ((await api('GET', '/api/state')).approvals as any[]).filter(a => a.id === chat.id && a.proposal);
  const p = card?.proposal ?? {};
  const ch = (p.changes ?? []) as any[];
  const shape = p.kind === 'new_project' && p.project === app && p.create === true && ch.some(c => c.kind === 'set_note' && c.note) && ch.some(c => c.kind === 'add_folder' && c.path === lib) && ch.some(c => c.kind === 'create_folder' && c.path === notes) && ch.some(c => c.kind === 'set_variable' && c.name === 'DUMMY_TOKEN');
  check('E ONE propose_new_project card (not propose_project_change): folder created, note, dummy-lib, dummy-notes new, DUMMY_TOKEN', cards.length === 1 && shape && calls.includes('propose_new_project') && !calls.includes('propose_project_change'), `${cards.length} card(s): ${p.kind} ${tilde(p.project ?? '')} create ${p.create}; ${ch.map(c => `${c.kind}${c.path ? ` ${tilde(c.path)}` : ''}${c.name ? ` ${c.name}` : ''}`).join('; ')}; options ${card?.options?.join(' / ')}`);
  if (!card) return { transcripts: [] };
  const ans = await api('POST', `/api/chats/${chat.id}/answer`, { request: card.request, option: 'Create', values: { DUMMY_TOKEN: E_SECRET } });
  check('E approved with "Create": dummy-app and dummy-notes made', ans.ok === true && fs.existsSync(app) && fs.existsSync(notes), tilde(ans.text ?? ans.error ?? ''));
  const list = (await api('GET', '/api/projects')) as any[];
  const row = list.find(x => x.folder === app);
  check('E GET projects lists dummy-app with 0 chats', row?.chats === 0, JSON.stringify(row ? { ...row, folder: tilde(row.folder) } : null));
  const side = ((await api('GET', '/api/state')).projects as any[]).find(x => x.folder === app);
  check('E the page state\'s sidebar has dummy-app with "+2 folders"', side?.registered === true && side?.folders?.length === 2, JSON.stringify(side ? { registered: side.registered, folders: side.folders.map(tilde) } : null));
  const after = JSON.stringify((fs.existsSync(pj) ? JSON.parse(fs.readFileSync(pj, 'utf8')) : {})[computer] ?? null);
  check('E the This computer entry is unchanged', before === after, `${before} → ${after}`);
  await chat.idle(180_000);
  chat.close();
  // a new chat in the new project sees it all
  const c2 = await Chat.start('claude', app, `${CONTEXT}Call get_project and say in one line how many working folders and variables this project has.`, `E claude in dummy-app (${model})`, { model });
  await c2.until(() => getProjectResults(claudeTranscript(thread(c2.id)?.native_session_id)).length > 0, 300_000, 'get_project in dummy-app');
  await c2.idle(120_000);
  const g2 = getProjectResults(claudeTranscript(thread(c2.id)?.native_session_id)).at(-1);
  const wf = (g2?.working_folders ?? []) as any[];
  const l = wf.find(f => f.path === lib), n = wf.find(f => f.path === notes);
  const v = (g2?.variables ?? []).find((x: any) => x.name === 'DUMMY_TOKEN');
  check('E new chat in dummy-app: get_project shows the note, both folders with why, DUMMY_TOKEN in_this_chat', !!g2?.note && g2?.is_project === true && !!l?.why && !!n?.why && n?.created === true && v?.in_this_chat === true, `note ${g2?.note ? 'yes' : 'no'}; dummy-lib why "${l?.why ?? '-'}"; dummy-notes why "${n?.why ?? '-'}" created ${n?.created}; DUMMY_TOKEN in_this_chat ${v?.in_this_chat}`);
  c2.close();
  return { transcripts: [claudeTranscript(thread(chat.id)?.native_session_id), claudeTranscript(thread(c2.id)?.native_session_id)].filter(Boolean) as string[] };
}

/* ---------- the secret appears nowhere ---------- */

function grepSecret(extra: string[], SECRET_ = SECRET) {
  const SECRET = SECRET_;
  const hits: string[] = [];
  const scan = (f: string) => {
    if (path.basename(f) === 'project-env.json') return;
    try {
      if (fs.readFileSync(f).includes(SECRET)) hits.push(tilde(f));
    } catch { /* gone */ }
  };
  const walk = (d: string) => {
    for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) scan(p);
    }
  };
  walk(CHOME);
  scan(SERVE_LOG);
  let n = 0;
  for (const f of extra) {
    if (f.endsWith('.zip')) {
      n++;
      if (spawnSync('unzip', ['-p', f], { encoding: 'latin1', maxBuffer: 1 << 28 }).stdout.includes(SECRET)) hits.push(`${tilde(f)} (inside)`);
    } else (n++, scan(f));
  }
  return { hits, scanned: n };
}

/* ---------- run ---------- */

console.log(`smoke:projects ${new Date().toISOString()} — ${AGENTS.map(a => `${a} ${version(a)}`).join(', ')}; Chorus home ${tilde(CHOME)}`);
let code = 0;
try {
  await startServe();
  let A: AChat[] = [];
  if (ONLY.has('A')) A = await partA();
  if (ONLY.has('A2')) await partA2();
  let b: any = { transcripts: [] };
  if (ONLY.has('B')) b = await partB();
  let zip: string | undefined;
  if (ONLY.has('C') && A.length) {
    const a = A.find(x => x.agent === 'claude') ?? A[0];
    zip = await partC(a.P, a.D);
  }
  if (ONLY.has('D')) await partD();
  let e: { transcripts: string[] } = { transcripts: [] };
  if (ONLY.has('E')) e = await partE();
  if (ONLY.has('E')) {
    const g = grepSecret(e.transcripts, E_SECRET);
    check(`E "${E_SECRET}" outside project-env.json (the Chorus home, the serve log, ${e.transcripts.length} transcript(s)): 0 hits`, !g.hits.length, `${g.hits.length} hits${g.hits.length ? `: ${g.hits.join(', ')}` : ''}`);
  }
  if (ONLY.has('B')) {
    // an export of S too, so the grep covers an export that holds the chat which handled the value
    const exS = b.S ? await api('POST', '/api/export', { project: b.S }) : {};
    await stopServe();
    const zips = [zip, exS.file].filter(Boolean) as string[];
    const g = grepSecret([...b.transcripts, ...zips]);
    check(`B the secret "${SECRET}" in the Chorus home (but project-env.json), the serve log, ${b.transcripts.length} transcript(s), ${zips.length} export zip(s)`, !g.hits.length, `${g.hits.length} hits${g.hits.length ? `: ${g.hits.join(', ')}` : ''}`);
    const envFile = path.join(CHOME, 'project-env.json');
    check('B project-env.json is mode 0600 and holds the value', fs.existsSync(envFile) && (fs.statSync(envFile).mode & 0o777) === 0o600 && fs.readFileSync(envFile, 'utf8').includes(SECRET), fs.existsSync(envFile) ? (fs.statSync(envFile).mode & 0o777).toString(8) : 'missing');
    for (const z of zips) fs.rmSync(z, { force: true });
  } else if (zip) fs.rmSync(zip, { force: true });
} catch (e) {
  check('run', false, String((e as Error).stack ?? e));
} finally {
  await stopServe();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; FAILED: ${failed.map(f => f.name).join(' | ')}` : ''} in ${Math.round((Date.now() - T0) / 1000)}s`);
  if (KEEP) console.log(`kept ${tilde(RUN)}`);
  else fs.rmSync(RUN, { recursive: true, force: true });
  code = failed.length ? 1 : 0;
}
process.exit(code);
