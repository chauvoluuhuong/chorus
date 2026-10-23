// Chorus desktop (Phase 5): a window over `chorus serve`. Everything it shows comes from the server; every button is one API
// call. The agents run in the server's PTYs; their own screens are drawn here with xterm.js.
/* global Terminal, FitAddon */

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const AGENT = { claude: { name: 'Claude Code', letter: 'C' }, codex: { name: 'Codex', letter: 'X' }, agy: { name: 'Antigravity', letter: 'A' } };
const STATE_LABEL = { busy: 'working', idle: 'waiting for you', approval: 'needs approval', starting: 'starting', parked: 'not running', ended: 'ended' };
const isMac = /Mac/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';
// drawn, not typed: a "+" character sits on the font's baseline and looks off-centre in the circle
const PLUS = '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M5 1v8M1 5h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const home = () => (S.info?.home || S.homeGuess || '');
const tilde = p => (home() && p?.startsWith(home()) ? '~' + p.slice(home().length) : p ?? '');
const base = p => (p || '').replace(/\/+$/, '').split('/').pop() || '/';

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'x-chorus': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

/* ---------- app state ---------- */

const S = {
  state: null,
  view: { name: 'new' },
  history: [],
  drawer: localStorage.getItem('chorus.drawer') || null,
  info: null,
  form: null,
  browse: null,
  folded: new Set(JSON.parse(localStorage.getItem('chorus.folded') || '[]')),
  asked: new Set(),
  detail: {},
  drawerData: null,
  actFilter: 'all',
  mem: { q: '', sel: null, items: [], where: '', record: null },
  skills: null,
  decided: [],
  scope: 'all',
  doctor: null,
  docJobs: {},
  docAutoClose: null,
  attached: null,
  screen: { live: true, exited: false, waiting: true },
  shownDialogs: new Set(),
  homeGuess: '',
};

/* ---------- the socket ---------- */

let ws;
let outbox = [];
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    $('#conn').hidden = true;
    for (const m of outbox.splice(0)) ws.send(m);
    if (S.attached) {
      const id = S.attached;
      S.attached = null;
      attachTerm(id);
    }
  };
  ws.onclose = () => {
    $('#conn').hidden = false;
    setTimeout(connect, 1000);
  };
  ws.onmessage = e => onMessage(JSON.parse(e.data));
}
function send(m) {
  const s = JSON.stringify(m);
  if (ws?.readyState === 1) ws.send(s);
  else outbox.push(s);
}

function onMessage(m) {
  if (m.t === 'state') return onState(m.state);
  if (m.t === 'screen' && m.id === S.attached) {
    term.reset();
    term.write(m.data);
    S.screen = { live: m.live, exited: !m.live, waiting: false };
    return drawTermOver();
  }
  if (m.t === 'out' && m.id === S.attached) return term.write(m.data);
  if (m.t === 'exit' && m.id === S.attached) {
    S.screen.exited = true;
    return drawTermOver();
  }
  if (m.t === 'flash') return flash(m.text);
  if (m.t === 'dropped' && m.id === S.attached) return toast(`Added to the message: ${m.paths.map(base).join(', ')}`);
}

/** The controller's flashes were written for the terminal app: drop the key hints, keep what happened. */
function plainText(s) {
  return String(s || '')
    .replace(/\s*[:·]\s*(⌃\\|⌃Space|ctrl\+\\|ctrl\+space)\s+\S.*$/i, '')
    .replace(/(⌃\\|ctrl\+\\)\s+\w\s+/gi, '');
}

function flash(text) {
  if (/^! /.test(text)) return; // an approval request: the desktop makes its own toast with buttons (onState)
  if (/^preview: /.test(text)) return;
  toast(plainText(text));
}

function onState(st) {
  const first = !S.state;
  S.state = st;
  if (!S.homeGuess) S.homeGuess = st.project.split('/').slice(0, 3).join('/');
  // a request on a chat you are not looking at: a toast with the answer buttons (the CLI app's flash and bell)
  for (const a of st.approvals) {
    const key = a.id + '|' + a.what;
    if (S.asked.has(key)) continue;
    S.asked.add(key);
    if (!first && !(S.view.name === 'chat' && S.view.id === a.id)) askToast(a);
  }
  // the toast of a request goes when the request does (answered here, in the agent, or elsewhere)
  for (const [k, el] of askToasts) if (!st.approvals.some(a => a.id + '|' + a.what === k)) (el.remove(), askToasts.delete(k));
  if (S.view.name === 'chat' && !st.chats.some(c => c.id === S.view.id)) {
    S.history = [];
    return go({ name: 'new' }, false);
  }
  showDialogs(st.dialogs);
  // first load: the doctor's popup when this is a first launch or something was updated (docs/doctor.md §6.1)
  if (first) void loadDoctor().then(d => d.due && openDoctorPopup()).catch(() => {});
  renderChrome();
  if (S.view.name === 'chat') renderChatParts();
  else if (S.view.name === 'approvals' && !$('#view').contains(document.activeElement?.closest('.note-input, .other-input'))) renderView();
  else if (S.view.name === 'new' && S.form) renderAgentsOnly();
}

/* ---------- the terminal: the agent's own screen ---------- */

const term = new Terminal({
  fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--f-mono'),
  fontSize: 13,
  lineHeight: 1.12,
  cursorBlink: true,
  allowProposedApi: true,
  scrollback: 5000,
  macOptionIsMeta: true,
  macOptionClickForcesSelection: true,
  theme: {
    background: '#1d1c1a', foreground: '#e8e6df', cursor: '#4fc1b6', cursorAccent: '#1d1c1a', selectionBackground: '#4a473f',
    black: '#2a2926', red: '#ef7e72', green: '#8ccf7e', yellow: '#f0b85a', blue: '#8fb8ff', magenta: '#d39bd8', cyan: '#4fc1b6', white: '#d9d6cc',
    brightBlack: '#6f6c64', brightRed: '#ff9b90', brightGreen: '#a9e39b', brightYellow: '#ffd17f', brightBlue: '#adcbff', brightMagenta: '#e7b6ea', brightCyan: '#7fdcd2', brightWhite: '#f5f4ee',
  },
});
const fit = new FitAddon.FitAddon();
term.loadAddon(fit);
// The server's own terminal answers the agent's questions (cursor position, device attributes, colours …). This one must stay
// quiet, or every answer would reach the agent twice and show up as typed text.
const quiet = () => true;
for (const id of [{ final: 'c' }, { prefix: '>', final: 'c' }, { prefix: '=', final: 'c' }, { final: 'n' }, { prefix: '?', final: 'n' }, { intermediates: '$', final: 'p' }, { prefix: '?', intermediates: '$', final: 'p' }, { prefix: '>', final: 'q' }, { prefix: '?', final: 'u' }]) term.parser.registerCsiHandler(id, quiet);
for (const n of [4, 10, 11, 12]) term.parser.registerOscHandler(n, d => d.includes('?'));
term.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, quiet);
const termEl = document.createElement('div');
termEl.style.height = '100%';
let termOpened = false;
term.onData(d => S.attached && send({ t: 'in', id: S.attached, data: d }));
term.onBinary(d => S.attached && send({ t: 'in', id: S.attached, data: d }));
let lastSize = '';
function refit() {
  if (!termEl.isConnected || !termEl.clientWidth) return;
  try {
    fit.fit();
  } catch {
    return;
  }
  const s = `${term.cols}x${term.rows}`;
  if (s !== lastSize && S.attached) send({ t: 'resize', id: S.attached, cols: term.cols, rows: term.rows });
  lastSize = s;
}
// agy draws top-down from its cursor and keeps no rows under its footer: its screen is shown anchored to the bottom, like
// the terminal app does it (docs/phase5.md §8.2). Moving the drawn screen moves xterm's mouse coordinates with it.
function anchorBottom() {
  const el = termEl.querySelector('.xterm-screen');
  if (!el) return;
  const b = term.buffer.active;
  let off = 0;
  if (S.state?.chats.find(c => c.id === S.attached)?.agent === 'agy' && b.viewportY === b.baseY) {
    let last = b.cursorY;
    for (let y = term.rows - 1; y > last; y--)
      if (b.getLine(b.baseY + y)?.translateToString(true).trim()) {
        last = y;
        break;
      }
    off = term.rows - 1 - last;
  }
  const t = off ? `translateY(${(off * el.clientHeight) / term.rows}px)` : '';
  if (el.style.transform !== t) el.style.transform = t;
}
term.onRender(anchorBottom);
let fitTimer;
new ResizeObserver(() => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(refit, 40);
}).observe(termEl);

function attachTerm(id) {
  if (S.attached === id) return;
  S.attached = id;
  S.screen = { live: true, exited: false, waiting: true };
  term.reset();
  refit();
  lastSize = `${term.cols}x${term.rows}`;
  send({ t: 'attach', id, cols: term.cols, rows: term.rows });
  drawTermOver();
}
function detachTerm() {
  if (!S.attached) return;
  S.attached = null;
  send({ t: 'detach' });
}

function drawTermOver() {
  const el = $('#term-over');
  if (!el) return;
  const chat = S.state?.chats.find(c => c.id === S.attached);
  let msg = '';
  if (S.screen.waiting) msg = chat?.state === 'parked' ? 'Resuming the agent…' : 'Connecting…';
  else if (S.screen.exited || chat?.state === 'ended') msg = 'The agent has exited. Its record stays in Memory.';
  el.hidden = !msg;
  el.innerHTML = msg ? `<div>${esc(msg)}</div>` : '';
}

/* ---------- navigation ---------- */

function go(view, push = true) {
  if (push && S.view && JSON.stringify(S.view) !== JSON.stringify(view)) S.history.push(S.view);
  S.history = S.history.slice(-30);
  S.view = view;
  S.drawerData = null;
  // the address keeps the screen, so a reload comes back to it
  history.replaceState(null, '', `#/${view.name}${view.id ? `/${view.id}` : view.from ? `/from/${view.from}` : view.folder ? `/in/${encodeURIComponent(view.folder)}` : ''}`);
  if (view.name !== 'chat') detachTerm();
  if (view.name === 'chat') void api('POST', `/api/chats/${view.id}/select`).catch(() => {});
  if (view.name === 'new') void openNew(view.from, view.folder);
  if (view.name === 'memory') void loadMemory();
  if (view.name === 'skills') void loadSkills();
  if (view.name === 'approvals') void loadDecided();
  if (view.name === 'doctor') void loadDoctor().then(() => renderView());
  renderChrome();
  renderView();
}
function back() {
  const v = S.history.pop();
  if (v) go(v, false);
}

/* ---------- sidebar, top bar, notice ---------- */

function chatsByProject() {
  const groups = new Map();
  for (const c of S.state?.chats ?? []) {
    if (!groups.has(c.cwd)) groups.set(c.cwd, []);
    groups.get(c.cwd).push(c);
  }
  return groups;
}

function renderChrome() {
  const st = S.state;
  const waiting = st?.approvals.length ?? 0;
  const v = S.view;
  const on = n => (v.name === n ? ' on' : '');
  let tree = '';
  for (const [cwd, chats] of chatsByProject()) {
    const folded = S.folded.has(cwd);
    const bang = chats.filter(c => c.state === 'approval').length;
    // the project in front: the chat you look at is in it, or the New chat form starts there. Its ＋ always shows; others on hover.
    const here = (v.name === 'chat' && chats.some(c => c.id === v.id)) || (v.name === 'new' && !v.from && (S.form?.folder ?? v.folder) === cwd);
    tree += `<div class="proj-row${here ? ' here' : ''}"><button class="proj" data-act="fold" data-arg="${esc(cwd)}" title="${esc(tilde(cwd))}"><span class="caret">${folded ? '▸' : '▾'}</span><span class="pname">${esc(base(cwd))}</span>${bang ? `<span class="bang">!${bang}</span>` : ''}</button><button class="proj-add" data-act="new-in" data-arg="${esc(cwd)}" title="New chat in ${esc(tilde(cwd))}" aria-label="New chat in ${esc(base(cwd))}">${PLUS}</button></div>`;
    if (folded) continue;
    for (const c of chats) {
      const child = c.parentId && chats.some(p => p.id === c.parentId);
      tree += `<button class="chat-row${child ? ' child' : ''}${v.name === 'chat' && v.id === c.id ? ' on' : ''}" data-act="chat" data-arg="${esc(c.id)}" title="${esc(c.title)} · ${esc(AGENT[c.agent]?.name ?? c.agent)} · ${esc(STATE_LABEL[c.state] ?? '')}">
        ${child ? '<span class="arrow">↳</span>' : ''}<span class="dot ${esc(c.state)}"></span><span class="t">${esc(c.title)}</span><span class="badge mini ${esc(c.agent)}">${esc(AGENT[c.agent]?.letter ?? '?')}</span></button>`;
    }
  }
  if (!tree) tree = '<div class="faint" style="padding:8px 18px;font-size:13px">No chats yet.</div>';
  const agents = st?.agents ?? {};
  const agentFoot = Object.keys(AGENT)
    .map(a => {
      const i = agents[a];
      const mark = !i ? '…' : i.ok ? '✓' : '✗';
      return `<span title="${esc(AGENT[a].name)} ${esc(i?.version ?? '')} ${esc(i?.login ?? (i ? 'not installed' : 'checking'))}"><span class="badge mini ${a}">${AGENT[a].letter}</span> ${mark}</span>`;
    })
    .join(' ');
  $('#side').innerHTML = `
    <div class="brand"><span class="logo"><i></i><i></i><i></i></span><b>Chorus</b><button class="icon-btn" data-act="sidebar" title="Hide the sidebar (${MOD}B)">⇤</button></div>
    <nav class="nav">
      <button class="new${v.name === 'new' && !v.from && !v.folder ? ' on' : ''}" data-act="new"><span class="plus">${PLUS}</span>New chat<kbd style="margin-left:auto">${MOD}N</kbd></button>
      <button class="${on('approvals').trim()}" data-act="approvals"><span class="ico">⚑</span>Approvals${waiting ? `<span class="count">${waiting}</span>` : ''}</button>
      <button class="${on('memory').trim()}" data-act="memory"><span class="ico">◫</span>Memory</button>
      <button class="${on('skills').trim()}" data-act="skills"><span class="ico">✦</span>Skills</button>
    </nav>
    <div class="side-head">PROJECTS<button data-act="add-project" title="Start a chat in another folder">+ add</button></div>
    <div class="tree">${tree}</div>
    <div class="side-foot">${agentFoot}<span style="flex:1"></span><button data-act="doctor">Doctor</button></div>`;

  const chat = v.name === 'chat' ? st?.chats.find(c => c.id === v.id) : undefined;
  let crumbs = '';
  if (chat) crumbs = `<a data-act="fold-open" data-arg="${esc(chat.cwd)}">${esc(base(chat.cwd))}</a><span class="sep">›</span><span class="here">${esc(chat.title)}</span>`;
  else if (v.name === 'new') crumbs = `<span>${esc(base(S.form?.folder ?? st?.project ?? ''))}</span><span class="sep">›</span><span class="here">${v.from ? 'Hand off' : 'New chat'}</span>`;
  else crumbs = `<span class="here">${{ approvals: 'Approvals', memory: 'Memory', skills: 'Skills', doctor: 'Doctor' }[v.name] ?? ''}</span>`;
  $('#top').innerHTML = `
    ${$('#app').classList.contains('side-off') ? `<button class="icon-btn" data-act="sidebar" title="Show the sidebar (${MOD}B)">⇥</button>` : ''}
    ${S.history.length ? '<button class="btn" data-act="back" title="Back">‹ Back</button>' : ''}
    <div class="crumbs">${crumbs}</div>
    ${waiting ? `<button class="btn waiting" data-act="approvals">! ${waiting} waiting</button>` : ''}`;

  // the controller's warning line (limit, quota, context not loaded), with a button for what it suggests
  const notice = plainText(st?.notice ?? '');
  const about = st?.chats.find(c => notice.includes(`"${c.title}"`) || notice.startsWith(`⚠ ${c.title}`)) ?? chat;
  const ctx = /context not loaded/.test(notice);
  const n = $('#notice');
  n.hidden = !notice || (ctx && about?.id === chat?.id); // the chat's own banner says it already
  if (!n.hidden) {
    const btn = ctx ? `<button class="btn" data-act="retry" data-arg="${esc(about?.id ?? '')}">Ask again</button>` : /limit|quota/i.test(notice) && about ? `<button class="btn" data-act="handoff" data-arg="${esc(about.id)}">Hand off</button>` : '';
    n.innerHTML = `<span>${esc(notice)}</span>${btn}`;
  }
}

/* ---------- views ---------- */

function renderView() {
  const v = S.view;
  const el = $('#view');
  if (v.name === 'chat') return renderChat();
  el.innerHTML = { new: newChatHtml, approvals: approvalsHtml, memory: memoryHtml, skills: skillsHtml, doctor: doctorHtml }[v.name]?.() ?? '';
  if (v.name === 'new') {
    const ta = $('#nc-prompt');
    if (ta && !v.from) ta.focus();
  }
  if (v.name === 'memory') {
    const q = $('#mem-q');
    if (q && S.mem.focus) {
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }
  }
}

/* New chat: agent, model, effort, folder, skip permissions, and (here only) a first message */

/** `folder`: the ＋ of a project row: the chat starts in that project. Otherwise the project in front (the server decides). */
async function openNew(from, folder) {
  S.info = null;
  S.form = null;
  renderView();
  try {
    S.info = await api('GET', '/api/newchat' + (from ? `?from=${encodeURIComponent(from)}` : ''));
  } catch (e) {
    return toast(String(e.message));
  }
  const src = S.info.from;
  const agent = src ? S.info.agents.find(a => a.id !== src.agent).id : localStorage.getItem('chorus.agent') || 'claude';
  S.form = { agent, model: 'default', effort: 'default', folder: folder ?? S.info.folder, skip: src ? src.skip : false, prompt: '', error: '', busy: false };
  if (S.view.name === 'new') {
    renderChrome();
    renderView();
  }
}

function agentCards() {
  const f = S.form;
  return S.info.agents
    .filter(a => !S.info.from || a.id !== S.info.from.agent || true)
    .map(a => {
      const live = S.state?.agents?.[a.id] ?? a.info;
      const sub = !live ? '<span class="sub">checking…</span>' : !live.version ? '<span class="sub bad">not installed</span>' : `<span class="sub${live.ok ? '' : ' bad'}">${esc(live.version)} · ${esc(live.login ?? '')}</span>`;
      const q = a.quota ? `<span class="sub ${a.quota.level === 'err' ? 'bad' : a.quota.level === 'warn' ? 'warn' : ''}">plan ${esc(a.quota.text)}</span>` : '';
      const same = S.info.from && a.id === S.info.from.agent;
      return `<button class="agent${f.agent === a.id ? ' on' : ''}" data-act="nc-agent" data-arg="${a.id}"><span class="name"><span class="badge mini ${a.id}">${AGENT[a.id].letter}</span>${AGENT[a.id].name}${same ? ' <span class="faint" style="font-weight:400">(same agent)</span>' : ''}</span>${sub}${q}</button>`;
    })
    .join('');
}
function renderAgentsOnly() {
  const el = $('#nc-agents');
  if (el && S.info && S.form) el.innerHTML = agentCards();
}

function newChatHtml() {
  const f = S.form;
  const src = S.info?.from;
  if (!f) return '<div class="page hero"><h1>What should we build?</h1><p class="lead">Loading the agents…</p></div>';
  const a = S.info.agents.find(x => x.id === f.agent);
  const efforts = a.efforts[f.model] ?? ['default'];
  if (!efforts.includes(f.effort)) f.effort = efforts[0];
  const recent = [...new Set([...(S.info.recent ?? []), S.info.computer])].filter(r => r && r !== f.folder);
  return `<div class="page hero">
    <h1><span class="logo" style="height:26px"><i style="width:5px;height:14px"></i><i style="width:5px;height:26px"></i><i style="width:5px;height:19px"></i></span>${src ? 'Continue with another agent' : 'What should we build?'}</h1>
    <p class="lead">${src ? 'A new chat loads the record of the old one through the Chorus MCP server, sums it up and waits for your OK.' : 'Pick an agent and a project folder. You talk to the agent in its own screen.'}</p>
    <div class="card form">
      ${src ? `<div class="handoff-src">Continues <b>${esc(src.title)}</b> <span class="badge ${esc(src.agent)}">${esc(AGENT[src.agent]?.name ?? src.agent)}</span></div>` : ''}
      <div class="field"><label>AGENT</label><div class="agents" id="nc-agents">${agentCards()}</div></div>
      <div class="row2">
        <div class="field"><label for="nc-model">MODEL</label><select id="nc-model" data-change="nc-model">${a.models.map(m => `<option${m === f.model ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
        <div class="field"><label for="nc-effort">EFFORT</label><select id="nc-effort" data-change="nc-effort">${efforts.map(m => `<option${m === f.effort ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="nc-folder">PROJECT FOLDER</label>
        <div class="folder"><input id="nc-folder" type="text" value="${esc(tilde(f.folder))}" data-input="nc-folder" spellcheck="false"${src ? ' disabled' : ''}>${src ? '' : '<button class="btn" data-act="browse">Browse…</button>'}</div>
        ${src || !recent.length ? '' : `<div class="chips">${recent.map(r => `<button class="chip" data-act="nc-folder" data-arg="${esc(r)}">${esc(r === S.info.computer ? 'This computer (no project)' : tilde(r))}</button>`).join('')}</div>`}
      </div>
      ${src ? '' : `<div class="field"><label for="nc-prompt">FIRST MESSAGE <span class="faint" style="font-weight:400">(optional: you can also type it in the agent)</span></label><textarea id="nc-prompt" data-input="nc-prompt" placeholder="What do you want to build today?">${esc(f.prompt)}</textarea></div>`}
      <label class="toggle"><input type="checkbox" data-change="nc-skip"${f.skip ? ' checked' : ''}><span><b>Skip permission prompts</b> <span class="muted">· starts ${esc(AGENT[f.agent].name)} with <code>${esc(a.skipFlag)}</code></span><br><span class="muted" style="font-size:12.5px">${f.skip ? 'Nothing reaches the approvals inbox for this chat: the agent runs commands and edits files without asking.' : 'Off: the agent asks, and Chorus shows it in the approvals inbox.'}</span></span></label>
      ${f.error ? `<div class="err">${esc(f.error)}</div>` : ''}
      <div class="form-foot"><span class="hint">${src ? '' : `${MOD}↵ starts from the message box`}</span><button class="btn primary" data-act="nc-start"${f.busy ? ' disabled' : ''}>${src ? 'Hand off' : 'Start chat'} <kbd>↵</kbd></button></div>
    </div></div>`;
}

async function startChat() {
  const f = S.form;
  if (!f || f.busy) return;
  f.busy = true;
  f.error = '';
  renderView();
  const src = S.info.from;
  try {
    localStorage.setItem('chorus.agent', f.agent);
    const body = { agent: f.agent, to: f.agent, model: f.model, effort: f.effort, folder: f.folder, skip: f.skip, prompt: f.prompt };
    const r = src ? await api('POST', `/api/chats/${src.id}/handoff`, body) : await api('POST', '/api/chats', body);
    if (r.error || !r.id) throw new Error(r.error || 'could not start the chat');
    S.history = S.history.filter(v => v.name !== 'new');
    go({ name: 'chat', id: r.id }, false);
  } catch (e) {
    f.busy = false;
    f.error = e.message;
    renderView();
  }
}

/* Folder browser (Browse… and "+ add") */

async function openBrowse(dir, then) {
  try {
    S.browse = { ...(await api('GET', `/api/folders?dir=${encodeURIComponent(dir)}`)), then: then ?? S.browse?.then };
  } catch (e) {
    return toast(e.message);
  }
  drawBrowse();
}
function drawBrowse() {
  const b = S.browse;
  let el = $('#browse');
  if (!b) return el?.remove();
  if (!el) {
    el = document.createElement('div');
    el.id = 'browse';
    el.className = 'scrim';
    $('#dialogs').append(el);
  }
  el.innerHTML = `<div class="dialog" role="dialog" aria-label="Choose a project folder"><h2>Choose a project folder</h2>
    <div class="body"><div class="mono">${esc(tilde(b.dir))}</div><div class="muted" style="font-size:12.5px">${b.folders.length} folder${b.folders.length === 1 ? '' : 's'}, sorted by name</div>
    <div class="folders">${b.parent ? '<button data-act="br-up">‹ ..</button>' : ''}${b.folders.map(n => `<button data-act="br-open" data-arg="${esc(n)}">▸ ${esc(n)}</button>`).join('')}</div></div>
    <div class="foot"><button class="btn" data-act="br-new">New folder…</button><span style="flex:1"></span><button class="btn" data-act="br-cancel">Cancel</button><button class="btn primary" data-act="br-use">Use this folder</button></div></div>`;
}

/* Approvals: everything waiting on you, from every chat */

async function loadDecided() {
  try {
    S.decided = (await api('GET', '/api/approvals')).decided;
  } catch {
    S.decided = [];
  }
  if (S.view.name === 'approvals') renderView();
}

function approvalsHtml() {
  const st = S.state;
  const cur = st?.chats.find(c => c.id === st.current);
  const all = st?.approvals ?? [];
  const items = S.scope === 'all' || !cur ? all : all.filter(a => a.cwd === cur.cwd);
  const wait = since => { const s = Date.now() / 1000 - since; return s < 60 ? `${Math.max(0, Math.round(s))}s` : `${Math.round(s / 60)}m`; };
  const riskBadge = r => (r ? `<span class="badge ${r.level === 'err' ? 'bad' : r.level === 'warn' ? 'warn' : 'plain'}">${esc(r.label)}</span>` : '');
  return `<div class="page"><h1>Approvals</h1><p class="lead">What your agents are asking for, from every chat: their permission prompts (answering types the agent's own key) and the questions they put to you through Chorus (your choice and note become your next message to that agent). You do not have to switch to the chat.</p>
    <div class="toolbar"><div class="seg"><button class="${S.scope === 'all' ? 'on' : ''}" data-act="scope" data-arg="all">All projects</button><button class="${S.scope === 'this' ? 'on' : ''}" data-act="scope" data-arg="this">This project</button></div><span class="grow"></span><span class="muted">${all.length} waiting</span></div>
    <div class="card list">${
      items.length
        ? items
            .map(
              a => `<div class="item"><div class="head"><span class="dot approval"></span><span class="t">${esc(a.title)}</span><span class="badge ${esc(a.agent)}">${esc(AGENT[a.agent]?.name ?? a.agent)}</span><span class="faint">${esc(base(a.cwd))} · waiting ${wait(a.since)}</span><span style="flex:1"></span>${riskBadge(a.risk)}</div>
          ${
            a.kind === 'ask'
              ? `${askCard(a)}<div class="acts"><span style="flex:1"></span><button class="btn" data-act="chat" data-arg="${esc(a.id)}">Open chat ›</button></div>`
              : `<div class="what">${esc(a.what)}</div>
          <div class="acts"><button class="btn good" data-act="approve" data-arg="${esc(a.id)}">✓ Approve</button><button class="btn danger" data-act="deny" data-arg="${esc(a.id)}">✕ Deny</button><span style="flex:1"></span><button class="btn" data-act="chat" data-arg="${esc(a.id)}">Open chat ›</button></div>`
          }</div>`,
            )
            .join('')
        : '<div class="empty">Nothing is waiting for you.</div>'
    }</div>
    <div class="section-title">Decided today</div>
    <div class="card list">${S.decided.length ? S.decided.map(d => `<div class="item"><div class="head"><span class="badge ${d.decision === 'approved' ? 'ok' : 'bad'}">${esc(d.decision)}</span><span class="badge ${esc(d.agent)}">${esc(AGENT[d.agent]?.letter ?? '')}</span><span class="mono" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.what)}</span><span class="faint">${esc(d.time)}</span></div></div>`).join('') : '<div class="empty">No answers yet today.</div>'}</div></div>`;
}

async function answer(id, approve) {
  try {
    await api('POST', `/api/chats/${id}/${approve ? 'approve' : 'deny'}`);
  } catch (e) {
    toast(e.message);
  }
  void loadDecided();
}

/* Memory: every chat Chorus recorded, in any project */

let memTimer;
async function loadMemory() {
  try {
    const r = await api('GET', `/api/memory?q=${encodeURIComponent(S.mem.q)}`);
    S.mem.items = r.items;
    S.mem.where = r.where;
    if (!r.items.some(i => i.id === S.mem.sel)) S.mem.sel = r.items[0]?.id ?? null;
  } catch (e) {
    toast(e.message);
  }
  if (S.view.name === 'memory') renderView();
}

function memoryHtml() {
  const m = S.mem;
  const sel = m.items.find(i => i.id === m.sel);
  const rows = m.items
    .map(i => `<div class="item${i.id === m.sel ? ' sel' : ''}" data-act="mem-sel" data-arg="${esc(i.id)}"><div class="head">${i.child ? '<span class="faint">↳</span>' : ''}<span class="t">${esc(i.title)}</span><span class="badge mini ${esc(i.agent)}">${esc(AGENT[i.agent]?.letter ?? '')}</span><span style="flex:1"></span><span class="faint" style="font-size:12px">${esc(i.ago)}</span></div><div class="muted" style="font-size:12.5px">${esc(i.project)} · ${i.turns} turn${i.turns === 1 ? '' : 's'}</div></div>`)
    .join('');
  const calls = sel?.recent?.length ? `<div class="calls">${sel.recent.map(c => `<div><span class="${c.ok ? 'ok' : 'failed'}">${c.ok ? '✓' : '✗'}</span> ${esc(c.tool)} ${esc(c.target)} <span class="faint">${esc(c.note)}</span>${c.detail ? `<div class="faint" style="padding-left:14px;white-space:pre-wrap">${esc(String(c.detail).split('\n').slice(0, 3).join('\n'))}</div>` : ''}</div>`).join('')}</div>` : '<span class="faint">none</span>';
  const detail = sel
    ? `<div class="card"><div class="drawer-head" style="border-radius:14px 14px 0 0"><span class="badge ${esc(sel.agent)}">${esc(AGENT[sel.agent]?.name ?? sel.agent)}</span><span class="grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sel.title)}</span></div>
      <dl class="kv"><dt>Project</dt><dd>${esc(sel.project)}</dd><dt>Asked</dt><dd>${esc(sel.asked) || '<span class="faint">—</span>'}</dd><dt>Last answer</dt><dd>${esc(sel.last) || '<span class="faint">—</span>'}</dd><dt>Files</dt><dd class="mono">${esc(sel.files) || '<span class="faint">none</span>'}</dd><dt>Tools</dt><dd class="mono">${esc(sel.tools) || '<span class="faint">none</span>'}</dd><dt>Recent calls</dt><dd>${calls}</dd></dl>
      <div class="form-foot" style="padding:0 16px 16px;flex-wrap:wrap"><button class="btn primary" data-act="chat" data-arg="${esc(sel.id)}">Open chat</button><button class="btn" data-act="handoff" data-arg="${esc(sel.id)}">Continue with another agent</button><button class="btn" data-act="mem-record" data-arg="${esc(sel.id)}">${m.record?.id === sel.id ? 'Hide' : 'What an agent reads'}</button><span style="flex:1"></span><button class="btn danger" data-act="delete" data-arg="${esc(sel.id)}">Delete</button></div>
      ${m.record?.id === sel.id ? `<pre class="record" style="border-top:1px solid var(--line)">${esc(m.record.text)}</pre>` : ''}</div>`
    : '';
  return `<div class="page" style="max-width:1100px"><h1>Memory</h1><p class="lead">Every chat Chorus recorded, in every project: what an agent gets from <span class="mono">get_handoff_context</span> when it continues one. Stored in <span class="mono">${esc(m.where)}</span>.</p>
    <div class="toolbar"><input id="mem-q" type="search" placeholder="Search titles, questions, answers, files…" value="${esc(m.q)}" data-input="mem-q" style="max-width:420px"><span class="grow"></span><span class="muted">${m.items.length} chat${m.items.length === 1 ? '' : 's'}</span></div>
    ${m.items.length ? `<div class="mem"><div class="card list rows">${rows}</div>${detail}</div>` : `<div class="card empty">${m.q ? 'Nothing matches.' : 'Nothing recorded yet.'}</div>`}</div>`;
}

/* Skills: one library for the three agents */

async function loadSkills() {
  try {
    S.skills = await api('GET', '/api/skills');
  } catch (e) {
    toast(e.message);
  }
  if (S.view.name === 'skills') renderView();
}

function skillsHtml() {
  const k = S.skills;
  if (!k) return '<div class="page"><h1>Skills</h1><p class="lead">Loading…</p></div>';
  return `<div class="page"><h1>Skills</h1><p class="lead">One library for Claude Code, Codex and Antigravity: a skill turned on here is linked into each agent's own skills folder when a chat starts. Library: <span class="mono">${esc(k.where)}</span></p>
    <div class="toolbar"><span class="grow"></span><button class="btn" data-act="sk-new">+ New skill</button></div>
    <div class="card list">${k.items.length ? k.items.map(s => `<div class="item skill"><input type="checkbox" class="switch" data-change="sk-toggle" data-arg="${esc(s.folder)}"${s.on ? ' checked' : ''} aria-label="${esc(s.name)} on or off"><div class="grow"><div style="font-weight:600">${esc(s.name)}</div><div class="muted" style="font-size:13px">${esc(s.description)}</div></div><button class="btn" data-act="sk-edit" data-arg="${esc(s.folder)}">Edit</button></div>`).join('') : '<div class="empty">No skills in the library yet.</div>'}</div>
    <div class="section-title">Found in the agents' own folders</div>
    <div class="card list">${k.found.length ? k.found.map(f => `<div class="item skill"><span class="badge mini ${esc(f.agent)}">${esc(AGENT[f.agent]?.letter ?? '·')}</span><div class="grow"><div style="font-weight:600">${esc(f.name)}</div><div class="muted mono">${esc(tilde(f.from))}</div></div><button class="btn" data-act="sk-import" data-arg="${esc(f.dir)}">Import</button></div>`).join('') : '<div class="empty">Nothing new to import.</div>'}</div></div>`;
}

/* ---------- the doctor (docs/doctor.md §6): popup on first launch and after an update, and the Doctor page ---------- */

const DOC_STEPS = 7;
async function loadDoctor() {
  S.doctor = await api('GET', '/api/doctor');
  return S.doctor;
}

function doctorRows(d) {
  return d.fast.agents
    .map(a => {
      const job = S.docJobs[a.agent];
      const running = job && !job.done;
      const deep = job?.action === 'deep' && job.done ? job : null;
      let badge = '';
      let note = '';
      let acts = '';
      if (running) {
        badge = `<span class="badge plain"><span class="spin"></span>${job.action === 'deep' ? `Testing · ${job.results.length} of ${DOC_STEPS}` : job.action === 'login' ? 'Signing in…' : 'Installing…'}</span>`;
        if (job.action !== 'deep') note = `<span class="mono">${esc(job.command)}</span>`;
      } else if (deep && deep.ok) {
        badge = `<span class="badge ok">✔ Works on this Mac</span>`;
      } else if (deep && !deep.ok) {
        const f = deep.results.find(r => r.status === 'fail');
        badge = `<span class="badge bad">✖ Problem</span>`;
        note = `${esc(f ? `${f.title}: ${f.reason}` : 'a check did not pass')}${a.testedInstall && a.newestTested !== a.version ? `<br>Chorus is tested with ${esc(a.newestTested)}. Optional: <span class="mono">${esc(a.testedInstall)}</span>` : ''}`;
        acts = `${a.testedInstall && a.newestTested !== a.version ? `<button class="btn" data-act="doc-run" data-arg="${a.agent}:tested">Install ${esc(a.newestTested)}</button>` : ''}<button class="btn" data-act="doc-report">Report issue</button>`;
      } else if (a.state === 'ready') {
        badge = `<span class="badge ok">✔ ${a.coverage === 'tested' ? 'Tested' : 'In tested range'}, ready</span>`;
      } else if (a.state === 'missing') {
        badge = `<span class="badge warn">Not installed</span>`;
        note = `<span class="mono">${esc(a.install.command)}</span>${a.install.version ? ` <span class="faint">(${esc(a.install.version)}, the newest tested)</span>` : ''}`;
        acts = `<button class="btn" data-act="doc-open" data-arg="${a.agent}">Open page ↗</button><button class="btn primary" data-act="doc-run" data-arg="${a.agent}:install">Install</button>`;
      } else if (a.state === 'needs-login') {
        badge = `<span class="badge warn">Needs login</span>`;
        note = a.agent === 'agy' ? 'Run <span class="mono">agy</span> once in a terminal to sign in with Google.' : `<span class="mono">${esc(a.loginCommand.join(' '))}</span>`;
        acts = a.agent === 'agy' ? '' : `<button class="btn primary" data-act="doc-run" data-arg="${a.agent}:login">Sign in</button>`;
      } else if (a.state === 'untested') {
        badge = `<span class="badge warn">New version</span>`;
        note = `Chorus is tested up to ${esc(a.newestTested ?? 'none')}. Checking that ${esc(a.version)} works takes 1–3 min and a few short model turns on your plan.`;
        acts = `<button class="btn primary" data-act="doc-run" data-arg="${a.agent}:deep">Test it</button>`;
      }
      const results = job?.action === 'deep' && job.results.length ? `<div class="doc-results">${job.results.map(r => `<div><span class="${r.status === 'pass' ? 'ok' : r.status === 'fail' ? 'bad' : 'faint'}">${{ pass: '✔', fail: '✖', skip: '–', blocked: '⚠' }[r.status]}</span> ${esc(r.title)}${r.reason ? ` <span class="faint">(${esc(r.reason)})</span>` : ''}</div>`).join('')}</div>` : '';
      const out = job && job.action !== 'deep' && job.output ? `<pre class="record doc-out">${esc(job.output.slice(-1500))}</pre>` : '';
      return `<div class="doc-row"><span class="badge mini ${a.agent}">${AGENT[a.agent].letter}</span><div class="grow"><div><b>${esc(a.name)}</b> <span class="muted mono">${esc(a.version ?? '')}</span> ${badge}</div>${note ? `<div class="muted doc-note">${note}</div>` : ''}${results}${out}</div><div class="doc-acts">${acts}</div></div>`;
    })
    .join('');
}

function doctorHtml() {
  const d = S.doctor;
  if (!d) return `<div class="page"><h1>Doctor</h1><p class="lead">Checking your agents…</p></div>`;
  return `<div class="page"><h1>Doctor</h1><p class="lead">Your AI CLIs: whether Chorus is tested with their versions, and what each one needs. Checked in ${(d.fast.ms / 1000).toFixed(1)} s, no model calls.</p>
    <div class="card list" id="doc-rows">${doctorRows(d)}</div>
    <div class="toolbar"><button class="btn" data-act="doc-recheck">Check again</button>${d.fast.agents.filter(a => a.state !== 'missing').map(a => `<button class="btn" data-act="doc-run" data-arg="${a.agent}:deep">Full test of ${esc(a.name)}</button>`).join('')}</div>
    <div class="section-title">Chorus</div><div class="card"><pre class="record">${esc((d.lines ?? []).map(tilde).join('\n'))}</pre></div></div>`;
}

function openDoctorPopup() {
  if ($('#doctor-pop')) return;
  const el = document.createElement('div');
  el.className = 'scrim';
  el.id = 'doctor-pop';
  el.innerHTML = `<div class="dialog doc-dialog" role="dialog"><h2>Checking your agents</h2><div class="body" id="doc-pop-rows"></div><div class="foot"><span class="faint grow" id="doc-pop-note"></span><button class="btn primary" data-act="doc-continue">Continue</button></div></div>`;
  $('#dialogs').append(el);
  drawDoctor();
}

function drawDoctor() {
  const d = S.doctor;
  if (!d) return;
  const pop = $('#doc-pop-rows');
  if (pop) {
    pop.innerHTML = doctorRows(d);
    const busy = Object.values(S.docJobs).some(j => !j.done);
    const allReady = d.fast.agents.every(a => a.state === 'ready') && !busy;
    $('#doc-pop-note').textContent = allReady ? 'Every agent is on a tested version. Closing…' : busy ? 'You can continue: the test keeps running and its result shows on the Doctor page.' : '';
    if (allReady && !S.docAutoClose) S.docAutoClose = setTimeout(closeDoctorPopup, 2500);
  }
  if (S.view.name === 'doctor') renderView();
}

function closeDoctorPopup() {
  $('#doctor-pop')?.remove();
  void api('POST', '/api/doctor/seen').catch(() => {});
}

async function pollDoctorJob(agent, id) {
  const j = await api('GET', `/api/doctor/${id}`).catch(() => null);
  if (!j) return;
  S.docJobs[agent] = j;
  if (j.done && j.action !== 'deep') await loadDoctor();
  drawDoctor();
  if (!j.done) setTimeout(() => pollDoctorJob(agent, id), 1000);
  else toast(j.ok ? `${AGENT[agent].name}: ${j.action === 'deep' ? 'works with Chorus' : 'done'}` : `${AGENT[agent].name}: ${j.action === 'deep' ? 'a check did not pass' : 'the command failed'}`);
}

async function reportIssue() {
  const { title, body } = await api('POST', '/api/doctor/issue');
  const el = document.createElement('div');
  el.className = 'scrim';
  el.innerHTML = `<div class="dialog doc-dialog" role="dialog"><h2>Report an issue</h2><div class="body"><p class="muted">This goes to github.com/chauvoluuhuong/chorus/issues. Emails, account ids, keys and your home path are taken out; read it and edit what you like before sending.</p><input type="text" class="dlg-input" id="doc-issue-title" value="${esc(title)}"><textarea class="doc-issue" id="doc-issue-body" spellcheck="false">${esc(body)}</textarea></div><div class="foot"><span class="grow"></span><button class="btn" data-act="doc-issue-cancel">Cancel</button><button class="btn primary" data-act="doc-send">${S.doctor?.gh ? 'Create issue' : 'Open on GitHub'}</button></div></div>`;
  $('#dialogs').append(el);
}

/* ---------- a chat ---------- */

function renderChat() {
  const id = S.view.id;
  $('#view').innerHTML = `<div class="chat"><div class="chat-head" id="chat-head"></div><div id="chat-banners"></div>
    <div class="chat-body"><div class="term-wrap" id="term-slot"><div class="term-over" id="term-over" hidden></div></div><aside class="drawer" id="drawer" hidden></aside></div></div>`;
  $('#term-slot').prepend(termEl);
  if (!termOpened) {
    term.open(termEl);
    termOpened = true;
  }
  renderChatParts();
  requestAnimationFrame(() => {
    refit();
    attachTerm(id);
    drawTermOver();
    term.focus();
  });
  void loadDetail(id);
  if (S.drawer) void loadDrawer();
}

function meter(pct) {
  if (pct == null) return '';
  const p = Math.round(pct);
  return `<span class="meter ${p >= 90 ? 'bad' : p >= 75 ? 'warn' : ''}" title="plan usage (5 h window)"><span class="bar"><i style="width:${Math.min(100, p)}%"></i></span>5h ${p}%</span>`;
}

function renderChatParts() {
  const c = S.state?.chats.find(x => x.id === S.view.id);
  const head = $('#chat-head');
  if (!c || !head) return;
  const d = S.detail[c.id];
  head.innerHTML = `<span class="badge ${esc(c.agent)}">${esc(AGENT[c.agent]?.name ?? c.agent)}</span>
    <div class="meta"><span class="dot ${esc(c.state)}"></span><span>${esc(STATE_LABEL[c.state] ?? c.state)}</span>
      ${c.model || c.effort ? `<span>· ${[c.model, c.effort].filter(Boolean).map(esc).join(' · ')}</span>` : ''}${c.skip ? '<span class="badge warn" title="started without permission prompts">skip</span>' : ''}${meter(c.usage)}
      <span class="mono faint path" title="${esc(c.cwd)}">‎${esc(tilde(c.cwd))}‎</span>${c.toast ? `<span class="badge ok">${esc(c.toast)}</span>` : ''}</div>
    <button class="btn" data-act="handoff" data-arg="${esc(c.id)}" title="Continue this chat with another agent">⇄ Hand off</button>
    <button class="btn${S.drawer === 'artifacts' ? ' on' : ''}" data-act="drawer" data-arg="artifacts">Artifacts${c.artifacts ? ` <span class="badge plain">${c.artifacts}</span>` : ''}</button>
    <button class="btn${S.drawer === 'activity' ? ' on' : ''}" data-act="drawer" data-arg="activity">Activity</button>
    <button class="btn${S.drawer === 'record' ? ' on' : ''}" data-act="drawer" data-arg="record">Record</button>
    <button class="icon-btn" data-act="delete" data-arg="${esc(c.id)}" title="Delete this chat">🗑</button>`;
  let banners = '';
  for (const ask of S.state.approvals.filter(a => a.id === c.id)) {
    if (ask.kind === 'ask') banners += `<div class="banner ask card"><b>${esc(AGENT[c.agent]?.name ?? c.agent)} asks you</b><div class="ask-body">${askCard(ask)}</div></div>`;
    else banners += `<div class="banner ask"><b>${esc(AGENT[c.agent]?.name ?? c.agent)} asks</b><span class="what" title="${esc(ask.what)}">${esc(ask.what)}</span><button class="btn good" data-act="approve" data-arg="${esc(c.id)}">✓ Approve</button><button class="btn danger" data-act="deny" data-arg="${esc(c.id)}">✕ Deny</button></div>`;
  }
  if (c.parentId && d && !d.contextLoaded && c.state === 'idle' && d.turns.some(t => t.role === 'assistant')) banners += `<div class="banner info"><span>⚠ This chat has not loaded the record of the chat it continues.</span><button class="btn" data-act="retry" data-arg="${esc(c.id)}">Ask again</button></div>`;
  const bannerEl = $('#chat-banners');
  if (bannerEl.dataset.html !== banners && !bannerEl.contains(document.activeElement)) {
    bannerEl.innerHTML = banners;
    bannerEl.dataset.html = banners;
  }
  const dr = $('#drawer');
  dr.hidden = !S.drawer;
  if (S.drawer) dr.innerHTML = drawerHtml(c);
  drawTermOver();
}

async function loadDetail(id) {
  try {
    S.detail[id] = await api('GET', `/api/chats/${id}`);
  } catch {
    return;
  }
  if (S.view.name === 'chat' && S.view.id === id) renderChatParts();
}

async function loadDrawer() {
  const id = S.view.id;
  const kind = S.drawer;
  if (!id || !kind) return;
  try {
    const data = kind === 'artifacts' ? await api('GET', `/api/chats/${id}/artifacts`) : kind === 'activity' ? await api('GET', `/api/chats/${id}/activity`) : await api('GET', `/api/chats/${id}`);
    if (S.view.id !== id || S.drawer !== kind) return;
    S.drawerData = { id, kind, data };
    if (kind === 'record') S.detail[id] = data;
  } catch {
    return;
  }
  renderChatParts();
}

function drawerHtml(c) {
  const dd = S.drawerData;
  const title = { artifacts: 'Artifacts', activity: 'Activity', record: 'Record' }[S.drawer];
  const head = `<div class="drawer-head"><span class="grow">${title}</span><button class="icon-btn" data-act="drawer" data-arg="${S.drawer}" title="Close">✕</button></div>`;
  if (!dd || dd.id !== c.id || dd.kind !== S.drawer) return head + '<div class="drawer-body"><div class="empty">Loading…</div></div>';
  const x = dd.data;
  if (S.drawer === 'artifacts') {
    const items = x.items.length
      ? x.items.map(a => `<div class="art"><div class="name">${esc(a.path)}</div><div class="faint" style="font-size:12px">v${a.versions.length} · ${esc(a.ago)}</div><div class="acts"><button class="btn primary" data-act="art-open" data-arg="${esc(a.path)}">Open</button><button class="btn" data-act="art-folder" data-arg="${esc(a.path)}">Show in folder</button><button class="btn" data-act="copy" data-arg="${esc(a.abs)}">Copy path</button></div></div>`).join('')
      : '<div class="empty">No artifacts yet. Files the agent writes into this chat\'s artifacts folder show up here and open in the browser, reloading while the agent edits them.</div>';
    const files = x.files.length ? `<div class="section-title" style="margin:16px 16px 6px">Files written by tools</div><div class="calls" style="padding:0 16px 16px">${x.files.map(f => `<div>${esc(tilde(f))}</div>`).join('')}</div>` : '';
    return head + `<div class="drawer-body"><div class="mono faint" style="padding:10px 16px;border-bottom:1px solid var(--line)">${esc(tilde(x.folder))}/</div>${items}${files}</div>`;
  }
  if (S.drawer === 'activity') {
    const kinds = ['all', 'tool', 'mcp', 'approval', 'file', 'usage'];
    const count = k => x.rows.filter(r => !r.divider && (k === 'all' || r.kind === k)).length;
    const rows = x.rows.filter(r => S.actFilter === 'all' || r.kind === S.actFilter || r.divider);
    const clock = iso => (iso ? new Date(iso).toTimeString().slice(0, 8) : '');
    const dur = ms => (ms == null ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
    const k = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    return (
      head +
      `<div class="drawer-body"><div class="muted" style="padding:10px 16px 0;font-size:12.5px">in ${k(x.tokensIn)} · out ${k(x.tokensOut)} tokens${x.cost ? ` · $${x.cost.toFixed(2)}` : ''}</div>
      <div class="filters">${kinds.map(kk => `<button class="chip${S.actFilter === kk ? ' on' : ''}" style="${S.actFilter === kk ? 'background:var(--sel);color:var(--ink)' : ''}" data-act="act-filter" data-arg="${kk}">${kk} ${count(kk)}</button>`).join('')}</div>
      ${rows.length ? rows.map(r => (r.divider ? `<div class="act-div">${esc(r.text)}</div>` : `<div class="act-row"><span class="faint">${clock(r.shownTs ?? r.ts)}</span><span class="badge mini ${esc(r.agent)}" style="width:auto;padding:0 5px">${esc(r.verb)}</span><span class="w">${esc(r.text)}</span><span class="${esc(r.status ?? '')}">${esc(r.status === 'running' ? '…' : r.status ?? '')}${r.durationMs != null ? ` <span class="faint">${dur(r.durationMs)}</span>` : ''}</span></div>`)).join('') : '<div class="empty">Nothing recorded yet.</div>'}</div>`
    );
  }
  const u = x.usage;
  return (
    head +
    `<div class="drawer-body"><div class="muted" style="padding:10px 16px;font-size:12.5px;border-bottom:1px solid var(--line)">What <span class="mono">get_handoff_context</span> returns for this chat: the next agent starts from this.${x.parent ? `<br>Continues <a href="#" data-act="chat" data-arg="${esc(x.parent.id)}">${esc(x.parent.title)}</a> · ${x.contextLoaded ? '<span style="color:var(--ok)">record loaded</span>' : '<span style="color:var(--warn)">record not loaded yet</span>'}` : ''}</div>
    <pre class="record">${esc(x.record)}</pre>${u ? `<div class="muted" style="padding:0 16px 16px;font-size:12.5px">usage: ${u.inputTokens} in / ${u.outputTokens} out${u.costUsd != null ? ` · $${u.costUsd.toFixed(4)}` : ''}${u.limitUtilization != null ? ` · plan ${Math.round(u.limitUtilization * 100)}%` : ''}</div>` : ''}</div>`
  );
}

/* ---------- dialogs the server asks (delete?, limit reached, how to open a file) ---------- */

function showDialogs(list) {
  const ids = new Set(list.map(d => d.id));
  for (const el of document.querySelectorAll('[data-dialog]')) if (!ids.has(el.dataset.dialog)) el.remove();
  for (const d of list) {
    if (document.querySelector(`[data-dialog="${CSS.escape(d.id)}"]`)) continue;
    const el = document.createElement('div');
    el.className = 'scrim';
    el.dataset.dialog = d.id;
    const lines = d.lines.map(l => `<p>${esc(plainText(l))}</p>`).join('');
    if (d.kind === 'prompt') {
      el.innerHTML = `<div class="dialog" role="dialog"><h2>${esc(d.title)}</h2><div class="body">${lines}<input type="text" class="dlg-input" value="${esc(d.initial ?? '')}"></div><div class="foot"><button class="btn" data-act="dlg" data-arg="${esc(d.id)}" data-value="">Cancel</button><button class="btn primary" data-act="dlg-ok" data-arg="${esc(d.id)}">OK</button></div></div>`;
    } else {
      const opts = d.options ?? [];
      // the first option is the suggested one; a destructive one is drawn as such. Esc cancels (the options already include a "no")
      el.innerHTML = `<div class="dialog" role="dialog"><h2>${esc(d.title)}</h2><div class="body">${lines}</div><div class="opts">${opts.map((o, i) => `<button class="btn${i === 0 ? (/delete|remove/i.test(o.label) ? ' danger-fill' : ' primary') : ''}" data-act="dlg" data-arg="${esc(d.id)}" data-value="${esc(o.key)}">${esc(o.label)}</button>`).join('')}${opts.length ? '' : `<button class="btn" data-act="dlg" data-arg="${esc(d.id)}" data-value="">Close</button>`}</div><div class="faint" style="padding:0 20px 14px;font-size:12px">Esc cancels</div></div>`;
    }
    $('#dialogs').append(el);
    (el.querySelector('.dlg-input') || el.querySelector('.opts .btn'))?.focus();
  }
}

/** A dialog of our own (new skill name), shaped like the server's. */
function localPrompt(title, lines, initial = '') {
  return new Promise(resolve => {
    const el = document.createElement('div');
    el.className = 'scrim';
    el.innerHTML = `<div class="dialog" role="dialog"><h2>${esc(title)}</h2><div class="body">${lines.map(l => `<p>${esc(l)}</p>`).join('')}<input type="text" class="dlg-input" value="${esc(initial)}"></div><div class="foot"><button class="btn" data-x="cancel">Cancel</button><button class="btn primary" data-x="ok">OK</button></div></div>`;
    const input = el.querySelector('input');
    const done = v => {
      el.remove();
      resolve(v);
    };
    el.addEventListener('click', e => {
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (x) done(x === 'ok' ? input.value : undefined);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') done(input.value);
      if (e.key === 'Escape') done(undefined);
    });
    $('#dialogs').append(el);
    input.focus();
  });
}

/* ---------- request_approval cards: the agent's question, its options, a note ---------- */

function optionButtons(a, cls = 'btn') {
  return a.options.map((o, i) => `<button class="${cls}${i === 0 ? ' primary' : ''}" data-act="pick" data-arg="${esc(a.id)}" data-req="${esc(a.request)}" data-value="${esc(o)}">${esc(o)}</button>`).join('');
}
/** The agent's options, "Other…" for an answer of your own (sent as "Other: <your words>"), and a note for any of them. */
function askCard(a) {
  const req = `data-arg="${esc(a.id)}" data-req="${esc(a.request)}"`;
  return `<div class="ask-q">${esc(a.question)}</div>${a.details ? `<div class="what">${esc(a.details)}</div>` : ''}
    <div class="acts">${optionButtons(a)}<button class="btn" data-act="other">Other…</button></div>
    <div class="acts other-row" hidden><input type="text" class="other-input" placeholder="Your own answer" aria-label="Your own answer"><button class="btn primary" data-act="pick-other" ${req}>Send</button></div>
    <input type="text" class="note-input" placeholder="Add a note (optional)" aria-label="Note for the agent">`;
}

/* ---------- dropped files (docs/phase5.md §8.3, docs/integrations/file-drop.md) ---------- */
// A drop works on the agent screen of the chat in front (its path, or a copy into the chat) and on the New chat form (the path
// goes into the first message). The native window gives full paths (Tauri calls window.chorusDrop); a browser gives the bytes
// only, so there the file is always copied into the chat. Nothing is sent: the path waits in the agent's input.

const dropEl = document.createElement('div');
dropEl.className = 'drop-over';
let dropZone = null;
let dropKey = '';

function dropTarget() {
  if (S.view.name === 'chat' && S.attached && S.screen.live && !S.screen.exited) return 'chat';
  if (S.view.name === 'new' && S.form && !S.info?.from) return 'new';
  return null;
}
/** The drop zones under the pointer; returns the zone the pointer is on (or the only one). */
function showDrop(x, y, native) {
  const where = dropTarget();
  const host = where === 'chat' ? $('#term-slot') : where === 'new' ? $('#view .card.form') : null;
  if (!host) return hideDrop();
  const agent = AGENT[S.state?.chats.find(c => c.id === S.attached)?.agent]?.name ?? 'The agent';
  const zones =
    where === 'new' ? [['path', 'Add the path to the first message', 'the agent reads the file where it is']]
    : native ? [['path', 'Add the path', `${agent} reads the file where it is`], ['copy', 'Copy into the chat', 'saved in the chat\'s attachments folder: no "read this file?" prompt']]
    : [['copy', 'Copy into the chat', 'a browser gives the file, not its path']];
  const key = where + zones.length;
  if (dropKey !== key || dropEl.parentElement !== host) {
    dropEl.innerHTML = zones.map(([z, t, sub]) => `<div class="drop-zone" data-zone="${z}"><b>${esc(t)}</b><span>${esc(sub)}</span></div>`).join('');
    host.append(dropEl);
    dropKey = key;
  }
  dropEl.hidden = false;
  const under = document.elementFromPoint(x, y)?.closest('[data-zone]');
  dropZone = under && dropEl.contains(under) ? under.dataset.zone : zones.length === 1 ? zones[0][0] : null;
  for (const el of dropEl.querySelectorAll('[data-zone]')) el.classList.toggle('on', el.dataset.zone === dropZone);
  return dropZone;
}
function hideDrop() {
  dropEl.hidden = true;
  dropZone = null;
}
const escapeLikeTerminal = p => p.replace(/([ \t\\'"()&;$`!*?[\]{}|<>#])/g, '\\$1');

function deliverPaths(paths, copy) {
  if (dropTarget() === 'new') {
    const f = S.form;
    f.prompt += (f.prompt && !/\s$/.test(f.prompt) ? ' ' : '') + paths.map(escapeLikeTerminal).join(' ') + ' ';
    renderView();
    const ta = $('#nc-prompt');
    ta?.focus();
    ta?.setSelectionRange(ta.value.length, ta.value.length);
    return;
  }
  send({ t: 'drop', id: S.attached, paths, copy });
  term.focus();
}

// the native window (Tauri): enter / over / drop / leave with full paths and the pointer in CSS pixels
window.chorusDrop = ({ kind, paths, x, y }) => {
  if (kind === 'leave') return hideDrop();
  const zone = showDrop(x, y, true);
  if (kind !== 'drop') return;
  hideDrop();
  if (zone && paths?.length) deliverPaths(paths, zone === 'copy');
};

// a browser: the bytes of each file go to the server, which saves them in the chat and puts the path in
const hasFiles = e => [...(e.dataTransfer?.types ?? [])].includes('Files');
for (const ev of ['dragenter', 'dragover'])
  document.addEventListener(ev, e => {
    if (!hasFiles(e) || !dropTarget()) return;
    e.preventDefault();
    showDrop(e.clientX, e.clientY, false);
  });
document.addEventListener('dragleave', e => {
  if (!e.relatedTarget) hideDrop();
});
document.addEventListener('drop', async e => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const where = dropTarget();
  hideDrop();
  if (where === 'new') return toast('Start the chat, then drop the file on it: a browser does not give a file\'s path');
  if (where !== 'chat') return;
  const id = S.attached;
  for (const f of e.dataTransfer.files) {
    const r = await fetch(`/api/chats/${encodeURIComponent(id)}/attachments?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: { 'x-chorus': '1' }, body: f, credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return toast(j.error || `could not add ${f.name}`);
    toast(`Copied into the chat and added to the message: ${f.name}`);
  }
  term.focus();
});

/* ---------- toasts ---------- */

function toast(text, opts = {}) {
  if (!text) return;
  const el = document.createElement('div');
  el.className = 'toast' + (opts.cls ? ` ${opts.cls}` : '');
  el.innerHTML = `<span>${esc(text)}</span>${opts.buttons ?? ''}`;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), opts.ms ?? 4000);
  return el;
}
const askToasts = new Map();
function askToast(a) {
  const ask = a.kind === 'ask';
  const el = toast(`${AGENT[a.agent]?.name ?? a.agent} in "${a.title}" asks${ask ? ' you' : ''}: ${ask ? a.question : a.what.split(' · ').slice(-1)[0]}`, {
    cls: 'ask',
    ms: 10 * 60 * 1000,
    buttons: ask
      ? `${optionButtons({ ...a, options: a.options.slice(0, 3) })}<button class="btn" data-act="chat" data-arg="${esc(a.id)}">Open</button>`
      : `<button class="btn" data-act="approve" data-arg="${esc(a.id)}">Approve</button><button class="btn" data-act="deny" data-arg="${esc(a.id)}">Deny</button><button class="btn" data-act="chat" data-arg="${esc(a.id)}">Open</button>`,
  });
  el?.addEventListener('click', e => e.target.closest('[data-act]') && setTimeout(() => el.remove(), 0));
  askToasts.set(a.id + '|' + a.what, el);
}

/* ---------- input ---------- */

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const arg = el.dataset.arg;
  if (el.tagName === 'A') e.preventDefault();
  switch (act) {
    case 'new':
      return go({ name: 'new' });
    case 'new-in':
      return go({ name: 'new', folder: arg });
    case 'approvals':
    case 'memory':
    case 'skills':
    case 'doctor':
      return go({ name: act });
    case 'chat':
      return go({ name: 'chat', id: arg });
    case 'doc-continue':
      clearTimeout(S.docAutoClose);
      return closeDoctorPopup();
    case 'doc-open':
      return void api('POST', '/api/doctor/open', { agent: arg });
    case 'doc-run': {
      const [agent, action] = arg.split(':');
      if (action === 'install' || action === 'tested') void api('POST', '/api/doctor/open', { agent }).catch(() => {});
      const j = await api('POST', '/api/doctor/run', { agent, action }).catch(err => (toast(err.message), null));
      if (!j || j.error) return j?.error && toast(j.error);
      S.docJobs[agent] = j;
      clearTimeout(S.docAutoClose);
      drawDoctor();
      return void pollDoctorJob(agent, j.id);
    }
    case 'doc-recheck':
      S.docJobs = {};
      return void loadDoctor().then(drawDoctor);
    case 'doc-report':
      return void reportIssue();
    case 'doc-issue-cancel':
      return el.closest('.scrim')?.remove();
    case 'doc-send': {
      const r = await api('POST', '/api/doctor/issue/send', { title: $('#doc-issue-title').value, body: $('#doc-issue-body').value }).catch(err => ({ error: err.message }));
      el.closest('.scrim')?.remove();
      return toast(r.error ? `Not sent: ${r.error}` : r.via === 'gh' ? `Issue created: ${r.url}` : 'Opened GitHub; the report is on your clipboard: paste it as the description');
    }
    case 'back':
      return back();
    case 'sidebar':
      $('#app').classList.toggle('side-off');
      renderChrome();
      return setTimeout(refit, 50);
    case 'fold':
      S.folded.has(arg) ? S.folded.delete(arg) : S.folded.add(arg);
      localStorage.setItem('chorus.folded', JSON.stringify([...S.folded]));
      return renderChrome();
    case 'fold-open':
      S.folded.delete(arg);
      return renderChrome();
    case 'add-project':
      go({ name: 'new' });
      return openBrowse(S.state?.project ?? '~', dir => S.form && ((S.form.folder = dir), renderChrome(), renderView()));
    case 'handoff':
      return go({ name: 'new', from: arg });
    case 'approve':
    case 'deny':
      return answer(arg, act === 'approve');
    case 'pick': {
      const note = el.closest('.item, .banner, .toast')?.querySelector('.note-input')?.value ?? '';
      await api('POST', `/api/chats/${arg}/answer`, { request: el.dataset.req, option: el.dataset.value, note });
      document.activeElement?.blur(); // the card redraws (and goes) only when nothing in it has the focus
      return loadDecided();
    }
    case 'other': {
      const row = el.closest('.item, .banner')?.querySelector('.other-row');
      if (!row) return;
      row.hidden = false;
      return row.querySelector('.other-input').focus();
    }
    case 'pick-other': {
      const card = el.closest('.item, .banner');
      const own = card?.querySelector('.other-input');
      if (!own?.value.trim()) return own?.focus();
      const note = card.querySelector('.note-input')?.value ?? '';
      await api('POST', `/api/chats/${arg}/answer`, { request: el.dataset.req, option: `Other: ${own.value.trim()}`, note });
      document.activeElement?.blur();
      return loadDecided();
    }
    case 'retry':
      return api('POST', `/api/chats/${arg}/retry`).catch(err => toast(err.message));
    case 'delete':
      return api('DELETE', `/api/chats/${arg}`).catch(err => toast(err.message));
    case 'drawer':
      S.drawer = S.drawer === arg ? null : arg;
      S.drawerData = null;
      localStorage.setItem('chorus.drawer', S.drawer ?? '');
      renderChatParts();
      setTimeout(refit, 30);
      return loadDrawer();
    case 'act-filter':
      S.actFilter = arg;
      return renderChatParts();
    case 'art-open':
    case 'art-folder':
      return api('POST', `/api/chats/${S.view.id}/open`, { path: arg, via: act === 'art-folder' ? 'folder' : undefined }).catch(err => toast(err.message));
    case 'copy':
      try {
        await navigator.clipboard.writeText(arg);
        toast('path copied');
      } catch {
        toast(arg, { ms: 8000 });
      }
      return;
    case 'nc-agent':
      if (!S.form) return;
      S.form.agent = arg;
      S.form.model = 'default';
      S.form.effort = 'default';
      return renderView();
    case 'nc-folder':
      S.form.folder = arg;
      renderChrome(); // the sidebar marks the project the form starts in
      return renderView();
    case 'nc-start':
      return startChat();
    case 'browse':
      return openBrowse(S.form?.folder ?? '~', dir => S.form && ((S.form.folder = dir), renderChrome(), renderView()));
    case 'br-up':
      return openBrowse(S.browse.parent);
    case 'br-open':
      return openBrowse(`${S.browse.dir}/${arg}`);
    case 'br-cancel':
      S.browse = null;
      return drawBrowse();
    case 'br-use': {
      const { dir, then } = S.browse;
      S.browse = null;
      drawBrowse();
      return then?.(dir);
    }
    case 'br-new': {
      const name = await localPrompt('New folder', [`In ${tilde(S.browse.dir)}`]);
      if (!name) return;
      try {
        const r = await api('POST', '/api/folders', { dir: S.browse.dir, name });
        S.browse = { ...r, then: S.browse.then };
        drawBrowse();
      } catch (err) {
        toast(err.message);
      }
      return;
    }
    case 'scope':
      S.scope = arg;
      return renderView();
    case 'mem-sel':
      S.mem.sel = arg;
      S.mem.focus = false;
      return renderView();
    case 'mem-record':
      if (S.mem.record?.id === arg) S.mem.record = null;
      else {
        const d = await api('GET', `/api/chats/${arg}`);
        S.mem.record = { id: arg, text: d.record };
      }
      return renderView();
    case 'sk-import':
      S.skills = await api('POST', '/api/skills/import', { dir: arg });
      return renderView();
    case 'sk-edit':
      return api('POST', `/api/skills/${encodeURIComponent(arg)}/edit`).catch(err => toast(err.message));
    case 'sk-new': {
      const name = await localPrompt('New skill', ['A skill is a folder with a SKILL.md every agent can load.', 'Name it with lowercase words and dashes.']);
      if (!name) return;
      const r = await api('POST', '/api/skills', { name });
      if (r.error) return toast(r.error);
      S.skills = r;
      return renderView();
    }
    case 'dlg':
      await api('POST', `/api/dialogs/${arg}`, { value: el.dataset.value || null });
      return el.closest('.scrim')?.remove();
    case 'dlg-ok': {
      const v = el.closest('.dialog').querySelector('.dlg-input').value;
      await api('POST', `/api/dialogs/${arg}`, { value: v });
      return el.closest('.scrim')?.remove();
    }
  }
});

document.addEventListener('change', async e => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const f = S.form;
  switch (el.dataset.change) {
    case 'nc-model':
      f.model = el.value;
      return renderView();
    case 'nc-effort':
      f.effort = el.value;
      return;
    case 'nc-skip':
      f.skip = el.checked;
      return renderView();
    case 'sk-toggle':
      S.skills = await api('POST', `/api/skills/${encodeURIComponent(el.dataset.arg)}/toggle`);
      return renderView();
  }
});

document.addEventListener('input', e => {
  const el = e.target.closest('[data-input]');
  if (!el) return;
  switch (el.dataset.input) {
    case 'nc-folder':
      S.form.folder = el.value.replace(/^~(?=\/|$)/, home());
      return;
    case 'nc-prompt':
      S.form.prompt = el.value;
      return;
    case 'mem-q':
      S.mem.q = el.value;
      S.mem.focus = true;
      clearTimeout(memTimer);
      memTimer = setTimeout(loadMemory, 200);
      return;
  }
});

document.addEventListener(
  'keydown',
  e => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const dlg = [...document.querySelectorAll('#dialogs .scrim')].pop();
    if (dlg) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (dlg.dataset.dialog) return void api('POST', `/api/dialogs/${dlg.dataset.dialog}`, { value: null }).then(() => dlg.remove());
        return dlg.querySelector('[data-x="cancel"], [data-act="br-cancel"]')?.click();
      }
      if (dlg.dataset.dialog && !e.target.closest('input')) {
        const key = e.key === 'Enter' ? '\r' : e.key;
        const b = dlg.querySelector(`[data-value="${CSS.escape(key)}"]`);
        if (b) {
          e.preventDefault();
          return b.click();
        }
      }
      if (e.key === 'Enter' && e.target.closest('.dlg-input') && dlg.dataset.dialog) {
        e.preventDefault();
        return dlg.querySelector('[data-act="dlg-ok"]')?.click();
      }
      return;
    }
    if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      return go({ name: 'new' });
    }
    if (mod && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      return document.querySelector('[data-act="sidebar"]')?.click();
    }
    if (mod && e.key.toLowerCase() === 'i') {
      e.preventDefault();
      return go({ name: 'approvals' });
    }
    if (mod && /^[1-9]$/.test(e.key)) {
      const c = S.state?.chats[Number(e.key) - 1];
      if (c) {
        e.preventDefault();
        return go({ name: 'chat', id: c.id });
      }
    }
    if (S.view.name === 'new' && e.key === 'Enter' && !e.shiftKey && S.form) {
      const inPrompt = e.target.id === 'nc-prompt';
      if (!inPrompt || mod) {
        if (e.target.tagName === 'BUTTON' && e.target.dataset.act !== 'nc-start') return;
        e.preventDefault();
        return startChat();
      }
    }
    if (e.key === 'Enter' && e.target.classList?.contains('other-input')) {
      e.preventDefault();
      return e.target.closest('.other-row').querySelector('[data-act="pick-other"]').click();
    }
    if (e.key === 'Escape' && S.view.name !== 'chat' && S.history.length && !e.target.closest('input, textarea')) back();
  },
  true,
);

// the drawer keeps up with the agent while it is open
setInterval(() => {
  if (S.view.name === 'chat' && S.drawer && !document.hidden) void loadDrawer();
  if (S.view.name === 'chat' && !document.hidden) void loadDetail(S.view.id);
}, 2500);

// a button whose request failed says so
window.addEventListener('unhandledrejection', e => toast(String(e.reason?.message ?? e.reason)));

// for the e2e proof and for debugging from the developer tools
window.chorus = { S, term, go };

// the token came in the address (chorus serve printed it); it is a cookie now, so it leaves the address bar
if (location.search) history.replaceState(null, '', '/' + location.hash);

function fromHash() {
  const [name, a, b] = location.hash.replace(/^#\/?/, '').split('/');
  if (name === 'chat' && a) return { name, id: a };
  if (name === 'new' && a === 'from' && b) return { name, from: b };
  if (name === 'new' && a === 'in' && b) return { name, folder: decodeURIComponent(b) };
  if (['approvals', 'memory', 'skills', 'doctor'].includes(name)) return { name };
  return { name: 'new' };
}

connect();
renderChrome();
go(fromHash(), false);
