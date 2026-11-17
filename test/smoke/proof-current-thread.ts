// The start text, current_thread and ask_main_thread with the real claude, codex and agy (task #8, step 4). A stage of chorus-core's
// Pro harness, run with --real and a PATH whose claude, codex and agy are shims that save their argv (CT_ARGV_DIR):
//   CT_PARTS=plain,planner,sub,agy2 [CT_CLIS=claude,codex,agy] [CT_CODEX_RUNS=6] [CT_COMMUNITY=1] \
//   node <core>/test/pro-e2e/run.ts --real --public "$PWD" --stage <path of this file relative to <core>/test/pro-e2e/checks>
// Proof goes to .chorus/proof/<branch>/: each chat's argv and system text, its screen as text, the page's screenshots, log.txt.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Cli = 'claude' | 'codex' | 'agy';

const L1 =
  "You are working inside Chorus, an app where the user works with several AI coding agents in one place. Chorus is your harness for this chat: when one of its MCP tools (server `chorus`) fits what you are about to do, use it before your own way of doing it, and follow the chorus server's instructions.";
const STRONG = 'before you start; this comes before any skill or workflow of your own. Never start an action yourself.';
const MCP_HEAD = 'How to work in Chorus:';
const PLAIN_ASK = 'Add a settings screen with three tabs, tests and docs.';
const PLANNER_ASK = "Add a line 'hello' to README.md in a test project.";
const SUB_ASK = (cli: Cli) =>
  `Start a Chorus sub thread (agent ${cli}) with this brief: "Write a one-line motto into motto.txt; ask me first whether it should be serious or funny." ` +
  'If the sub thread asks you which one, answer it yourself: funny.';

export default async function (c: any) {
  const { chrome, check, out, publicDir, restart } = c;
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd: publicDir, encoding: 'utf8' }).stdout.trim();
  const community = process.env.CT_COMMUNITY === '1';
  const dest = path.join(publicDir, '.chorus/proof', branch, community ? 'community' : `real-${process.env.CT_RUN ?? 'all'}`);
  fs.mkdirSync(dest, { recursive: true });
  const argvDir = process.env.CT_ARGV_DIR!;
  const parts = (process.env.CT_PARTS ?? 'plain,planner,sub,agy2').split(',');
  const clis = (process.env.CT_CLIS ?? 'claude,codex,agy').split(',') as Cli[];
  const codexRuns = Number(process.env.CT_CODEX_RUNS ?? 6);
  const { startFakeLicence, TEST_KEYS, COMMUNITY_LOCKED } = await import(path.join(c.core, 'tools/fake-licence/server.ts'));
  const { VirtualScreen } = await import(path.join(publicDir, 'src/app/screen.ts'));
  const { TOOL_NAMES } = await import(path.join(publicDir, 'src/mcp/server.ts'));
  const { TOOL_NAMES: SUB_TOOLS } = await import(path.join(publicDir, 'src/serve/subthreads.ts'));

  const log: string[] = [];
  const note = (s: string) => (log.push(`${new Date().toISOString().slice(11, 19)} ${s}`), c.log(`  ${s}`), fs.writeFileSync(path.join(dest, 'log.txt'), log.join('\n') + '\n'));
  const save = (name: string, v: unknown) => (fs.writeFileSync(path.join(dest, name), typeof v === 'string' ? v : JSON.stringify(v, null, 2)), name);

  /* ---------- the app: Pro (a valid test key) or Community (only portal, teammate.create, instructions locked) ---------- */
  if (community) COMMUNITY_LOCKED.splice(0, COMMUNITY_LOCKED.length, 'portal', 'teammate.create', 'instructions');
  const lic = await startFakeLicence({ community });
  lic.licences.get(TEST_KEYS.valid)!.limit = 50;
  let url = '';
  const origin = () => new URL(url).origin;
  const token = () => new URL(url).searchParams.get('token');
  const api = async (method: string, p: string, body?: object) => {
    const r = await fetch(origin() + p, { method, headers: { authorization: `Bearer ${token()}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
    const text = await r.text();
    return { status: r.status, json: (text.startsWith('{') ? JSON.parse(text) : text) as any };
  };
  const pstate = async (where: string) => (await api('GET', `/api/pro/state?project=${encodeURIComponent(where)}`)).json;
  const host = async () => (await api('GET', '/api/state')).json;
  url = await restart({ CHORUS_LICENCE_URL: lic.url, CHORUS_PRO_LOG: '1' });
  await chrome.until(() => chrome.js('!!window.chorus'), 15000);
  if (await chrome.until(() => chrome.has('button', /Skip, start using Chorus/), 3000)) await chrome.click('button', 'Skip, start using Chorus');
  if (!community) await api('POST', '/api/pro/activate', { key: TEST_KEYS.valid });
  await chrome.until(async () => !!(await pstate(c.project))?.mates?.length, 30000, 500);
  const entitled = (await pstate(c.project))?.entitled;
  note(`app at ${origin()}; ${community ? 'Community' : 'Pro'}; entitled: ${JSON.stringify(entitled)}`);
  const mates0 = (await pstate(c.project)).mates as any[];
  const mate = (id: string) => mates0.find(m => m.id === id);

  const db = (sql: string) => spawnSync('sqlite3', [path.join(c.home, 'chorus.db'), sql], { encoding: 'utf8' }).stdout.trim();
  const tools = (id: string) => db(`select tool from mcp_calls where thread_id='${id}' order by id`).split('\n').filter(Boolean);
  const freshProject = () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(path.dirname(c.project), 'ct-proj-')));
    fs.cpSync(path.join(c.core, 'test/pro-e2e/projects/cake-shop'), dir, { recursive: true });
    for (const a of [['init', '-q'], ['config', 'user.email', 'harness@chorus.test'], ['config', 'user.name', 'harness'], ['add', '-A'], ['commit', '-q', '-m', 'cake shop']]) spawnSync('git', a, { cwd: dir });
    return dir;
  };
  const gitStatus = (dir: string) => spawnSync('git', ['status', '--short', '--untracked-files=all'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n').filter(l => l && !/\.agents\/|\.chorus\//.test(l)).join('\n');

  /* ---------- a chat: its screen as text, trust dialogs answered, turns waited for ---------- */
  class Chat {
    screen = new VirtualScreen(140, 50);
    ws!: WebSocket;
    shots = 0;
    id: string;
    who: string;
    constructor(id: string, who: string) {
      this.id = id;
      this.who = who;
    }
    async open() {
      this.ws = new WebSocket(`${origin().replace('http', 'ws')}/ws?token=${token()}`);
      this.ws.addEventListener('message', e => {
        const m = JSON.parse(String(e.data));
        if (m.t === 'screen' && (!m.id || m.id === this.id)) (this.screen.term.reset(), this.screen.write(m.data));
        else if (m.t === 'out' && m.id === this.id) this.screen.write(m.data);
      });
      await new Promise(r => this.ws.addEventListener('open', r, { once: true }));
      this.ws.send(JSON.stringify({ t: 'attach', id: this.id, cols: 140, rows: 50 }));
      return this;
    }
    text = () => this.screen.text().join('\n') as string;
    record() {
      this.shots++;
      save(`${this.who}-${String(this.shots).padStart(2, '0')}.txt`, this.text());
    }
    async state() {
      return ((await host()).chats as any[]).find(x => x.id === this.id)?.state as string | undefined;
    }
    async say(text: string) {
      this.ws.send(JSON.stringify({ t: 'in', id: this.id, data: text }));
      await sleep(900);
      this.ws.send(JSON.stringify({ t: 'in', id: this.id, data: '\r' }));
      note(`${this.who}: typed "${text.slice(0, 90)}"`);
    }
    private trusted = 0;
    permsSeen = new Set<string>();
    perms: string[] = [];
    /** One tick: answer a trust dialog, stop on a quota line. */
    async tick(o: { approve?: boolean; leave?: boolean; onPermission?: () => void } = {}) {
      // the CLI's own permission prompts (Approvals): a chorus tool is allowed, anything else only when `approve`; each is logged
      const t = this.text();
      const limit = t.match(/.*(quota reached|usage limit|limit reached|hit your .*limit|out of credits|exhausted your).*/i);
      if (limit) throw new Error(`QUOTA in ${this.who}: ${limit[0].trim()}`);
      if (this.trusted < 6 && /Yes, I trust this folder|Trust and continue|Do you trust/i.test(t)) {
        const sel = this.screen.text().find((l: string) => /❯|^\s*>\s/.test(l)) ?? '';
        const onYes = !/Yes, I trust this folder/.test(t) || /(❯|>)\s*\d?\.?\s*Yes/.test(sel);
        this.ws.send(JSON.stringify({ t: 'in', id: this.id, data: onYes ? '\r' : '\x1b[A' }));
        this.trusted++;
        await sleep(1500);
      }
      const perm = o.leave ? undefined : ((await host()).approvals as any[]).find(a => a.id === this.id && a.kind === 'permission');
      if (perm) {
        const chorusTool = /chorus/i.test(`${perm.what ?? ''} ${perm.tool ?? ''}`);
        if (!this.permsSeen.has(perm.request ?? perm.what)) (this.permsSeen.add(perm.request ?? perm.what), note(`${this.who}: permission prompt: ${perm.what ?? perm.tool}`), this.perms.push(String(perm.what ?? perm.tool)));
        if (!chorusTool) o.onPermission?.();
        if (o.approve || chorusTool) await api('POST', `/api/chats/${this.id}/approve`);
        else await api('POST', `/api/chats/${this.id}/deny`);
        await sleep(1500);
      }
    }
    /** Waits for the chat's turn to end: busy seen (or 20 s passed), then idle for 6 s. */
    async turn(ms = 600_000, o: { approve?: boolean; onPermission?: () => void; until?: () => Promise<boolean> } = {}) {
      const t0 = Date.now();
      let busy = false, idleSince = 0;
      while (Date.now() - t0 < ms) {
        await this.tick(o);
        if (o.until && (await o.until())) return this.record(), true;
        const s = await this.state();
        if (s === 'busy') (busy = true, (idleSince = 0));
        else if (s === 'idle' && (busy || Date.now() - t0 > 20_000)) {
          idleSince ||= Date.now();
          if (Date.now() - idleSince > 6000) return this.record(), true;
        } else idleSince = 0;
        await sleep(1500);
      }
      this.record();
      note(`${this.who}: turn NOT over within ${ms / 1000} s`);
      return false;
    }
    close() {
      this.ws?.close();
    }
  }

  /** The argv the shim saved for a chat's CLI (its pid is threads.cli_pid), and the system text in it. */
  const argvOf = async (id: string, cli: Cli, cwd: string) => {
    let pid = '';
    await chrome.until(async () => !!(pid = db(`select cli_pid from threads where id='${id}'`)), 30000, 500);
    let rec: any;
    await chrome.until(() => {
      const f = fs.readdirSync(argvDir).filter(x => x.startsWith(`${pid}-`));
      if (f.length) rec = JSON.parse(fs.readFileSync(path.join(argvDir, f.sort().at(-1)!), 'utf8'));
      return !!rec;
    }, 10000, 300);
    const argv: string[] = rec?.argv ?? [];
    let system = '';
    if (cli === 'claude') system = argv[argv.indexOf('--append-system-prompt') + 1] ?? '';
    if (cli === 'codex') {
      const cfg = argv.find(a => a.startsWith('developer_instructions=')) ?? '';
      const raw = cfg.slice('developer_instructions='.length);
      try {
        system = JSON.parse(raw);
      } catch {
        system = raw;
      }
    }
    if (cli === 'agy') {
      const f = path.join(cwd, '.agents/plugins/chorus/rules/AGENTS.md');
      system = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    }
    return { pid, argv, system };
  };
  const startOf = (system: string) => (system.includes(MCP_HEAD) ? system.slice(0, system.indexOf(MCP_HEAD)) : system);
  const namesTool = (system: string) => [...TOOL_NAMES, ...SUB_TOOLS, 'suggest_action', 'task_create', 'task_finish', 'action_done', 'ask_planner', 'answer_worker', 'step_result', 'goal_propose'].filter(t => startOf(system).includes(t));
  const linesOf = (system: string) => startOf(system).replace(/^<!--.*-->\s*# Chorus\s*/s, '').trim().split('\n').filter(l => l.trim());
  /** Saves a chat's injected text and checks it against the approved lines for its kind. */
  const injected = async (who: string, id: string, cli: Cli, cwd: string, kind: 'plain' | 'planner' | 'worker' | 'sub', extra: { parent?: string; step?: string } = {}) => {
    const a = await argvOf(id, cli, cwd);
    save(`${who}-argv.json`, a.argv);
    save(`${who}-system.txt`, a.system);
    const s = startOf(a.system);
    const lines = linesOf(a.system);
    const problems: string[] = [];
    if (lines[0] !== L1) problems.push('line 1 differs');
    if (lines[1] !== `This chat is Chorus thread ${id}.`) problems.push(`line 2 is "${lines[1]}"`);
    const hasMcp = a.system.includes(MCP_HEAD) && a.system.includes('look them up with current_thread.');
    if (cli !== 'claude' && !hasMcp) problems.push('no MCP instructions after the start text');
    if (cli === 'claude' && a.system.includes(MCP_HEAD)) problems.push('Claude got the MCP instructions in its system prompt');
    // line 2b quotes the first line of the brief the main chat wrote: its words, not Chorus's
    const tool = namesTool(a.system.replace(/which started it to: .*?(?= Your main thread is who you work for)/s, 'which started it to: <brief>'));
    if (tool.length) problems.push(`the start text names ${tool.join(', ')}`);
    if (kind === 'plain') {
      if (!(lines[2]?.startsWith('Chorus actions: ') && lines[2].includes(STRONG))) problems.push('line 4 (Chorus actions, stronger wording) missing');
      if (lines.length !== 3) problems.push(`${lines.length} lines, 3 expected`);
      if (/Your role:|Your action/.test(s)) problems.push('a role or action line in a plain chat');
    }
    if (kind === 'planner') {
      if (!/^Your role: Planner \(teammate "[^"]+"\)\. Its instructions:/m.test(s)) problems.push('no Planner role line');
      if (!/^Your actions: .*before you start; this comes before any skill or workflow of your own\. Never start an action yourself\./m.test(s)) problems.push('no "Your actions" line');
      // a Just chat with the Planner does nothing yet: no "Your action" line (line 5 only when it exists)
      if (/^Your action: /m.test(s) && !/^Your action: Planner of task/m.test(s)) problems.push('an unexpected "Your action" line');
      if (!/^Active goals of this project:/m.test(s)) problems.push('no goals');
      if (/Chorus actions:/.test(s)) problems.push('a plain chat actions line');
    }
    if (kind === 'worker') {
      if (!/^Your role: Worker \(teammate "[^"]+"\)\. Its instructions:/m.test(s)) problems.push('no Worker role line');
      if (!/^Your action: Do step, step 1 of 1 /m.test(s)) problems.push('no "Your action: Do step, step 1 of 1" line');
      if (/Your actions:|Chorus actions:|Active goals/.test(s)) problems.push('an actions or goals line in a Worker');
    }
    if (kind === 'sub') {
      if (!lines[2]?.startsWith(`This chat is a sub thread of Chorus thread ${extra.parent} (`)) problems.push('line 2b missing');
      if (!lines[2]?.includes('ask your main thread through Chorus and end your turn, never the user')) problems.push('line 2b wording');
      if (/Your actions:|Chorus actions:/.test(s)) problems.push('an actions line in a sub thread');
    }
    note(`${who}: system text ${a.system.length} chars, ${problems.length ? 'PROBLEMS: ' + problems.join('; ') : 'as approved'}`);
    return { ok: !problems.length, problems, ...a };
  };
  const page = async (name: string, view: object) => {
    const slug = `${process.env.CT_RUN ?? 'x'}-${name}`;
    await chrome.js(`window.chorus.go(${JSON.stringify(view)})`);
    await sleep(2000);
    await chrome.shot(slug, slug);
    const f = fs.readdirSync(out).filter((x: string) => x.endsWith(`-${slug}.png`)).sort().at(-1);
    if (f) fs.copyFileSync(path.join(out, f), path.join(dest, `${name}.png`));
    return `${name}.png`;
  };
  const modelOf = (cli: Cli) => mate(`worker-${cli}`) ?? {};
  const newChat = async (cli: Cli, dir: string, prompt?: string) => {
    const m = modelOf(cli);
    const r = await api('POST', '/api/chats', { agent: cli, folder: dir, prompt, model: m.model, effort: m.effort === 'default' ? undefined : m.effort });
    if (!r.json?.id) throw new Error(`no chat: ${JSON.stringify(r.json)}`);
    return r.json.id as string;
  };
  const approvalsOf = async (ids: string[]) => ((await host()).approvals as any[]).filter(a => ids.includes(a.id) && !a.hidden);
  const needsOf = async (dir: string) => ((await pstate(dir))?.needs ?? []) as any[];
  const summary: Record<string, unknown> = {};
  const done = (id: string, what: string, ok: boolean, how: string, ev: string[] = []) => {
    summary[id] = { ok, how };
    save('summary.json', summary);
    check(id, what, ok, how, ev);
  };
  const safe = async (name: string, f: () => Promise<void>) => {
    try {
      await f();
    } catch (e: any) {
      note(`${name}: STOPPED ${e.message}`);
      done(name, `${name} ran to the end`, false, e.message);
      if (/^QUOTA/.test(e.message)) return;
    }
  };

  /* ---------- 2(a) plain chat: lines 1, 2, 4; proposes Create plan, edits nothing ---------- */
  const plain = async (cli: Cli, n: number) => {
    const dir = freshProject();
    const who = `plain-${cli}${n > 1 || cli === 'codex' ? `-${n}` : ''}`;
    const id = await newChat(cli, dir, PLAIN_ASK);
    const ch = await new Chat(id, who).open();
    const inj = await injected(who, id, cli, dir, 'plain');
    let perms = 0;
    // a CLI that asks permission to edit is starting to build: it's denied (tick) and counted
    await ch.turn(600_000, { onPermission: () => perms++ });
    const t = tools(id);
    const proposed = t.includes('suggest_action') || (t.includes('request_approval') && /Create plan/i.test(ch.text()));
    const edited = gitStatus(dir);
    ch.close();
    note(`${who}: tools ${t.join(',') || 'none'}; proposed=${proposed}; edits=${edited ? edited.replace(/\n/g, ' ') : 'none'}; permission prompts=${perms}`);
    save(`${who}-result.json`, { tools: t, proposed, edited, perms, prompts: ch.perms, problems: inj.problems });
    return { ok: inj.ok && proposed && !edited && !perms, inj, proposed, edited, perms, who };
  };

  /* ---------- 2(b)+(c) Planner Just chat, its plan, Approve, the Worker step ---------- */
  const planner = async (cli: Cli) => {
    const dir = freshProject();
    const pm = mate('planner');
    const own = cli === 'claude' ? { model: pm.model, effort: pm.effort } : { model: modelOf(cli).model, effort: modelOf(cli).effort };
    await api('POST', '/api/pro/mate', { ...pm, ag: cli, ...own });
    await api('POST', '/api/pro/goal', { project: dir, title: 'A friendly README', doneWhen: 'README.md greets the reader' });
    const id = (await api('POST', '/api/pro/chat', { teammate: 'planner', project: dir, message: PLANNER_ASK })).json.thread as string;
    const who = `planner-${cli}`;
    note(`${who}: chat ${id} (${cli} ${own.model}/${own.effort})`);
    const ch = await new Chat(id, who).open();
    const inj = await injected(who, id, cli, dir, 'planner');
    const taskOf = async () => ((await pstate(dir)).tasks as any[]).find(t => t.sessions?.some((s: any) => s.thread_id === id)) ?? ((await pstate(dir)).tasks as any[])[0];
    const planNeed = async () => (await needsOf(dir)).find(n => n.kind === 'plan');
    const seenCards: any[] = [];
    const answered = new Set<string>();
    // the Planner may ask a question first: answered with what it needs
    const answerQuestions = async () => {
      for (const a of await approvalsOf([id])) {
        if (!seenCards.some(s => s.request === a.request)) seenCards.push(a);
        if (a.kind !== 'ask' || answered.has(a.request)) continue;
        answered.add(a.request);
        note(`${who} asked: ${a.question} [${(a.options ?? []).join(' | ')}]`);
        await api('POST', `/api/chats/${id}/answer`, { request: a.request, option: a.options?.[0] ?? 'Go ahead', note: 'Use this repository as the test project; one step is enough.' });
      }
    };
    let ended = false;
    for (let i = 0; i < 6 && !ended; i++) {
      await ch.turn(900_000, { until: async () => (await answerQuestions(), !!(await planNeed())) });
      ended = !!(await planNeed());
      if (!ended) {
        await answerQuestions();
        if (!(await approvalsOf([id])).length && (await ch.state()) === 'idle') await ch.say('Go ahead: use this repository as the test project, one step is enough. Write the task and finish the plan.');
      }
    }
    await ch.turn(300_000);
    const task = await taskOf();
    const need = await planNeed();
    const askedPlan = seenCards.filter(a => /approv|plan/i.test(`${a.question ?? ''} ${a.what ?? ''}`) && a.kind === 'ask');
    save(`${who}-cards.json`, seenCards);
    save(`${who}-task.json`, task ?? null);
    await chrome.key('Escape').catch(() => undefined);
    await chrome.js(`window.chorus.go({ name: 'chat', id: ${JSON.stringify(id)} })`);
    await sleep(2500);
    const approveBtn = await chrome.js(`(() => { const b = (function all(root) { return [...root.querySelectorAll('*')].flatMap(e => [e, ...(e.shadowRoot ? all(e.shadowRoot) : [])]); })(document).filter(b => b.tagName === 'BUTTON' && /^\\s*Approve\\b/.test(b.textContent) && b.getClientRects().length); return b.map(x => ({ text: x.textContent.trim(), disabled: x.disabled || x.getAttribute('aria-disabled') === 'true' })); })()`);
    const shot = await page(`${who}-approve`, { name: 'chat', id });
    const steps = task?.steps ?? [];
    const okB = inj.ok && !!need && !askedPlan.length && approveBtn.length > 0 && approveBtn.every((b: any) => !b.disabled) && task?.state !== 'writing';
    note(`${who}: task ${task?.number} "${task?.title}" state=${task?.state} steps=${steps.length}; plan need=${!!need}; plan-approval cards=${askedPlan.length}; Approve buttons ${JSON.stringify(approveBtn)}; tools ${tools(id).join(',')}`);
    done(`2b.${cli}`, `${cli}: Planner Just chat shows role, Your actions and goals; writes a one-step task without asking for plan approval; the sidebar Approve is enabled`, okB, `task state ${task?.state}, ${steps.length} step(s), plan-approval cards ${askedPlan.length}, Approve ${JSON.stringify(approveBtn)}; ${inj.problems.join('; ') || 'start text as approved'}`, [shot]);
    if (!need || !task) return ch.close();
    // Approve, then start it with this CLI's Worker
    await api('POST', '/api/pro/need', { id: need.id, answer: 'ok' });
    const wm = mate(`worker-${cli}`);
    await api('POST', '/api/pro/mate', { ...wm, active: true });
    const t2 = (await pstate(dir)).tasks.find((t: any) => t.id === task.id);
    await api('POST', '/api/pro/start-task', { id: task.id, mode: 'serial', assignees: Object.fromEntries((t2?.steps ?? []).map((s: any) => [s.id, wm.id])) });
    note(`${who}: approved and started task ${task.number} with ${wm.id}`);
    let worker = '';
    await chrome.until(async () => {
      const t = (await pstate(dir)).tasks.find((x: any) => x.id === task.id);
      worker = t?.sessions?.find((s: any) => s.thread_id !== id && s.thread_id)?.thread_id ?? '';
      await answerQuestions();
      return !!worker;
    }, 180_000, 2000);
    if (!worker) return done(`2c.${cli}`, `${cli}: the Worker step chat starts`, false, 'no Worker chat within 3 min'), ch.close();
    const wc = await new Chat(worker, `worker-${cli}`).open();
    const winj = await injected(`worker-${cli}`, worker, cli, dir, 'worker');
    const stepDone = async () => {
      const t = (await pstate(dir)).tasks.find((x: any) => x.id === task.id);
      return (t?.steps ?? []).every((s: any) => /done|review|finished/.test(s.state ?? ''));
    };
    await wc.turn(900_000, { approve: true, until: async () => (await answerQuestions(), await stepDone()) });
    const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
    const t3 = (await pstate(dir)).tasks.find((x: any) => x.id === task.id);
    save(`worker-${cli}-task.json`, t3);
    const wshot = await page(`worker-${cli}`, { name: 'chat', id: worker });
    note(`worker-${cli}: step states ${(t3?.steps ?? []).map((s: any) => s.state).join(',')}; README has hello: ${/hello/i.test(readme)}`);
    done(`2c.${cli}`, `${cli}: the Worker step chat shows its role and "Your action: Do step, step 1 of 1 …", no actions line`, winj.ok, `${winj.problems.join('; ') || 'start text as approved'}; step ${(t3?.steps ?? []).map((s: any) => s.state).join(',')}; README hello ${/hello/i.test(readme)}`, [wshot]);
    wc.close();
    ch.close();
  };

  /* ---------- 2(d) a sub thread asks its main thread ---------- */
  const sub = async (cli: Cli) => {
    const dir = freshProject();
    const id = await newChat(cli, dir, SUB_ASK(cli));
    const who = `main-${cli}`;
    const ch = await new Chat(id, who).open();
    await injected(who, id, cli, dir, 'plain');
    let subId = '';
    const findSub = async () => !!(subId = ((await host()).chats as any[]).find(x => x.parentId === id)?.id ?? '');
    await ch.turn(600_000, { approve: true, until: findSub });
    await chrome.until(findSub, 120_000, 2000);
    if (!subId) return done(`2d.${cli}`, `${cli}: a sub thread asks its main thread`, false, 'no sub thread started'), ch.close();
    note(`${who}: sub thread ${subId}`);
    const sc = await new Chat(subId, `sub-${cli}`).open();
    const sinj = await injected(`sub-${cli}`, subId, cli, dir, 'sub', { parent: id });
    const cards: any[] = [];
    const needs: any[] = [];
    const watchCards = async () => {
      for (const a of await approvalsOf([id, subId])) if (a.kind !== 'permission' && !cards.some(x => x.request === a.request)) cards.push(a);
      for (const n of await needsOf(dir)) if (!needs.some(x => x.id === n.id)) needs.push(n);
    };
    const asked = async () => (await watchCards(), tools(subId).includes('ask_main_thread') && /Chorus:.*sub thread/is.test(ch.text()));
    let askShot = '';
    let asks = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 600_000) {
      await sc.tick({ leave: true });
      await ch.tick({ approve: true });
      if ((asks = await asked())) break;
      await sleep(2000);
    }
    sc.record();
    ch.record();
    if (asks) {
      await chrome.js(`window.chorus.go({ name: 'chat', id: ${JSON.stringify(id)} })`);
      await sleep(2500);
      askShot = await page(`sub-${cli}-ask-in-main`, { name: 'chat', id });
      await page(`sub-${cli}-approvals-empty`, { name: 'approvals' });
      await page(`sub-${cli}-home-needs-you`, { name: 'home' });
    }
    note(`sub-${cli}: asked its main thread=${asks}; tools ${tools(subId).join(',')}; cards so far ${cards.length}`);
    // the main chat answers it (send_to_subthread) and the sub thread finishes: its permission prompts are the CLI's own
    const finished = async () => (await watchCards(), fs.existsSync(path.join(dir, 'motto.txt')) && (await sc.state()) === 'idle');
    const t1 = Date.now();
    while (Date.now() - t1 < 900_000 && !(await finished())) {
      await sc.tick({ approve: true });
      await ch.tick({ approve: true });
      await sleep(2000);
    }
    await sleep(8000);
    await ch.turn(300_000, { approve: true });
    sc.record();
    const motto = fs.existsSync(path.join(dir, 'motto.txt')) ? fs.readFileSync(path.join(dir, 'motto.txt'), 'utf8').trim() : '';
    const answeredIt = tools(id).includes('send_to_subthread');
    note(`sub-${cli}: motto "${motto}"; main answered with send_to_subthread=${answeredIt}; cards ${JSON.stringify(cards.map(x => x.question ?? x.what))}; needs ${needs.length}`);
    save(`sub-${cli}-cards.json`, { cards, needs });
    done(`2d.${cli}`, `${cli}: the sub thread (line 2b, no actions line) asks its main thread, which answers it; nothing in Needs you or Approvals; it finishes`, sinj.ok && asks && answeredIt && !!motto && !cards.length && !needs.length, `${sinj.problems.join('; ') || 'start text as approved'}; asked=${asks}; answered=${answeredIt}; motto="${motto}"; cards ${cards.length}; needs ${needs.length}`, askShot ? [askShot, `sub-${cli}-approvals-empty.png`, `sub-${cli}-home-needs-you.png`] : []);
    // then: how are your sub threads doing?
    const before = tools(id).length;
    await ch.say('How are your sub threads doing?');
    await ch.turn(600_000, { approve: true });
    const look = tools(id).slice(before);
    const answer = ch.text();
    const lookedUp = look.some(t => ['current_thread', 'list_subthreads'].includes(t));
    note(`${who}: sub-thread question used ${look.join(',') || 'no tool'}`);
    done(`2d2.${cli}`, `${cli}: asked about its sub threads, the main chat looks them up`, lookedUp, `tools ${look.join(',') || 'none'}; screen in ${who}-*.txt`, []);
    // current_thread, live: what the chat reads back
    const b2 = tools(id).length;
    await ch.say('Look up this chat in Chorus right now and list exactly what you get: thread id, title, agent, model, state, project, folder, parent, sub threads with their states, role, action, task, and your open approvals. Plain list, no commentary.');
    await ch.turn(600_000, { approve: true });
    save(`${who}-current-thread-answer.txt`, ch.text());
    const used = tools(id).slice(b2);
    const live = used.includes('current_thread') && ch.text().includes(id) && ch.text().includes(subId);
    done(`ct.${cli}`, `${cli}: current_thread returns the chat, its sub thread and state live`, live, `tools ${used.join(',') || 'none'}; answer shows own id ${ch.text().includes(id)}, sub id ${ch.text().includes(subId)}`, []);
    void answer;
    sc.close();
    ch.close();
  };

  /* ---------- 3: two agy chats in one folder ---------- */
  const agy2 = async () => {
    const dir = freshProject();
    const A = await newChat('agy', dir, 'Say only: ready.');
    const a = await new Chat(A, 'agy2-A').open();
    const injA = await injected('agy2-A', A, 'agy', dir, 'plain');
    await a.turn(300_000);
    const pm = mate('planner');
    await api('POST', '/api/pro/mate', { ...pm, ag: 'agy', model: modelOf('agy').model, effort: modelOf('agy').effort });
    const B = (await api('POST', '/api/pro/chat', { teammate: 'planner', project: dir, message: 'Say only: ready. Do nothing else yet.' })).json.thread as string;
    const b = await new Chat(B, 'agy2-B').open();
    const injB = await injected('agy2-B', B, 'agy', dir, 'planner');
    await b.turn(300_000);
    save('agy2-rules-after-B.md', fs.readFileSync(path.join(dir, '.agents/plugins/chorus/rules/AGENTS.md'), 'utf8'));
    // (a) A asks for an approval: the card must land in A
    await a.say('Ask me through Chorus to approve this, with the options Yes and No: "Run the test suite now?" Then wait for my answer.');
    let card: any;
    await a.turn(300_000, { until: async () => !!(card = ((await host()).approvals as any[]).find(x => x.kind === 'ask' && [A, B].includes(x.id))) });
    const shot = card ? await page('agy2-approval-in-A', { name: 'approvals' }) : '';
    if (card) await api('POST', `/api/chats/${card.id}/answer`, { request: card.request, option: card.options?.[0] ?? 'Yes' });
    await a.turn(300_000);
    done('3a.agy', 'agy, two chats in one folder: chat A\'s approval card lands in A', card?.id === A, `card in ${card?.id === A ? 'A' : card?.id === B ? 'B' : 'no chat'} (${card?.question ?? ''}); A ${A}, B ${B}`, shot ? [shot] : []);
    // (b) after B started, what does A think it is?
    await a.say('What is your Chorus thread id and your role?');
    await a.turn(300_000);
    const ans = a.text();
    save('agy2-A-identity.txt', ans);
    const reply = ans.split('What is your Chorus thread id and your role?').at(-1) ?? ans;
    const saysB = reply.includes(B) || /\bPlanner\b/.test(reply);
    const saysA = reply.includes(A);
    note(`agy2: A answered with own id=${saysA}, B's id or Planner=${saysB}`);
    done('3b.agy', 'agy, two chats in one folder: after B started, A still reports its own thread id and no Planner role', saysA && !saysB, `A's reply names A ${saysA}, names B or Planner ${saysB}; transcript agy2-A-identity.txt; rules file after B: agy2-rules-after-B.md`, []);
    void injA, void injB;
    a.close();
    b.close();
  };

  /* ---------- 4: Community ---------- */
  const communityRun = async () => {
    const st = await pstate(c.project);
    note(`Community entitlement: ${JSON.stringify(st.entitled)}`);
    const create = await api('POST', '/api/pro/mate', { name: 'Tester', ag: 'claude', model: 'haiku', role: 'worker', instr: 'x' });
    const pm = mate('planner');
    const edit = await api('POST', '/api/pro/mate', { ...pm, instr: `${pm.instr}\nEdited.` });
    save('community-gates.json', { entitled: st.entitled, createTeammate: create, editInstructions: edit });
    done('4.gates', 'Community: creating a teammate and editing instructions stay locked (the API refuses)', create.status >= 400 || !!create.json?.blocked || !!create.json?.error, `create → ${create.status} ${JSON.stringify(create.json).slice(0, 120)}; edit instructions → ${edit.status} ${JSON.stringify(edit.json).slice(0, 120)}`);
    // the welcome screen: Keep Community, as a person does
    const deepClick = (re: RegExp) => chrome.js(`(() => { const all = r => [...r.querySelectorAll('*')].flatMap(e => [e, ...(e.shadowRoot ? all(e.shadowRoot) : [])]); const b = all(document).find(e => (e.tagName === 'BUTTON' || e.getAttribute('role') === 'button' || e.classList?.contains('mrow')) && new RegExp(${JSON.stringify(re.source)}).test(e.textContent) && e.getClientRects().length); if (b) b.click(); return !!b; })()`);
    note(`Keep Community clicked: ${await deepClick(/^\s*Keep Community\s*$/)}`);
    await sleep(1500);
    const shots = [await page('community-teammates', { name: 'pro', id: 'teammates' })];
    note(`New teammate clicked: ${await deepClick(/New teammate/)}`);
    await sleep(1200);
    await chrome.shot('community-new-teammate-locked', 'community-new-teammate-locked');
    const grab = (slug: string) => { const f = fs.readdirSync(out).filter((x: string) => x.endsWith(`-${slug}.png`)).sort().at(-1); if (f) fs.copyFileSync(path.join(out, f), path.join(dest, `${slug}.png`)); return `${slug}.png`; };
    shots.push(grab('community-new-teammate-locked'));
    await deepClick(/^\s*Not now\s*$/);
    await chrome.js(`window.chorus.go({ name: 'pro', id: 'teammates' })`);
    await sleep(1500);
    const deepSel = (sel: string) => chrome.js(`(() => { const all = r => [...r.querySelectorAll('*')].flatMap(e => [e, ...(e.shadowRoot ? all(e.shadowRoot) : [])]); const b = all(document).find(e => e.matches(${JSON.stringify(sel)})); if (b) b.click(); return !!b; })()`);
    note(`Planner opened: ${await deepSel('[data-do="open:planner"]')}`);
    await sleep(1500);
    await chrome.shot('community-planner-instructions', 'community-planner-instructions');
    shots.push(grab('community-planner-instructions'));
    note(`instructions field clicked: ${await deepSel('textarea.instr')}`);
    await sleep(1200);
    const ro = await chrome.js(`(() => { const all = r => [...r.querySelectorAll('*')].flatMap(e => [e, ...(e.shadowRoot ? all(e.shadowRoot) : [])]); const t = all(document).find(e => e.tagName === 'TEXTAREA' && e.classList.contains('instr')); return t ? { readOnly: t.readOnly, disabled: t.disabled } : null; })()`);
    note(`Planner instructions field: ${JSON.stringify(ro)}`);
    await chrome.shot('community-instructions-locked', 'community-instructions-locked');
    shots.push(grab('community-instructions-locked'));
    note(`community screenshots ${shots.join(', ')}`);
    if (process.env.CT_UI_ONLY !== '1') await planner('claude');
  };

  if (community) {
    await safe('community', communityRun);
    return;
  }
  for (const cli of clis) {
    if (parts.includes('plain')) await safe(`2a.${cli}`, async () => {
      const runs = cli === 'codex' ? codexRuns : 1;
      const rs = [];
      for (let n = 1; n <= runs; n++) rs.push(await plain(cli, n));
      const ok = rs.filter(r => r.ok).length;
      done(`2a.${cli}`, `${cli}: a plain chat has start-text lines 1, 2 and 4 (stronger)${cli === 'claude' ? '' : ' and the MCP instructions'}; asked to build, it proposes Create plan and edits nothing${cli === 'codex' ? ` (${runs} fresh chats, all must pass)` : ''}`, ok === runs, `${ok}/${runs}: ${rs.map(r => `${r.who} proposed=${r.proposed} edits=${r.edited ? 'yes' : 'no'} perms=${r.perms} ${r.inj.problems.join(';')}`).join(' · ')}`, []);
    });
    if (parts.includes('planner')) await safe(`2b.${cli}`, () => planner(cli));
    if (parts.includes('sub')) await safe(`2d.${cli}`, () => sub(cli));
  }
  if (parts.includes('agy2')) await safe('3.agy', agy2);
  lic.close();
}
