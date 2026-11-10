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
const svg = d => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  home: svg('<path d="M4 11.5 12 4l8 7.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/>'),
  chats: svg('<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z"/>'),
  plus: svg('<path d="M12 5v14M5 12h14" stroke-width="2.4"/>'),
  approvals: svg('<path d="M6 21V4.5M6 5h11l-2 4 2 4H6"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
  bell: svg('<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6" stroke-width="2.2"/>'),
};

/* ---------- three sizes (docs/features/responsive.md): phone ≤ 640 · tablet 641–1024 · desktop ≥ 1025 ----------
   Written on <html data-size>: the contract with the optional module, which picks its phone renderings from it. */
const MQ_PHONE = matchMedia('(max-width: 640px)');
const MQ_TABLET = matchMedia('(max-width: 1024px)');
const MQ_TOUCH = matchMedia('(hover: none), (pointer: coarse)');
const sizeNow = () => (MQ_PHONE.matches ? 'phone' : MQ_TABLET.matches ? 'tablet' : 'desktop');
document.documentElement.dataset.size = sizeNow();
/** The phone's own places, reached from the tab bar; on wider screens the sidebar holds them and they open New chat. */
const PHONE_ROOTS = ['home', 'chats', 'approvals', 'more'];
const startView = () => ({ name: S.size === 'phone' ? 'home' : 'new' });

const home = () => (S.info?.home || S.homeGuess || '');
const tilde = p => (home() && p?.startsWith(home()) ? '~' + p.slice(home().length) : p ?? '');
const base = p => (p || '').replace(/\/+$/, '').split('/').pop() || '/';

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'x-chorus': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    pageError(`${method} ${url.split('?')[0]}: ${j.error || `HTTP ${r.status}`}`);
    throw new Error(j.error || `HTTP ${r.status}`);
  }
  // a page the server can't open itself (Chorus in a container): this browser opens it, or says where it is
  if (typeof j.open === 'string' && /^https:\/\//.test(j.open)) {
    const w = window.open(j.open, '_blank');
    if (w) w.opener = null;
    else toast('The browser blocked the new tab.', { ms: 20000, buttons: `<a class="btn" href="${esc(j.open)}" target="_blank" rel="noopener">Open the page ↗</a>` });
  }
  return j;
}

/** The newest errors this page saw: they go in an issue report (Report on the Doctor page). */
const pageErrors = [];
function pageError(text) {
  pageErrors.push(`${new Date().toISOString()} ${text}`);
  if (pageErrors.length > 30) pageErrors.shift();
}
window.addEventListener('error', e => pageError(`${e.message} (${String(e.filename).split('/').pop()}:${e.lineno})`));
window.addEventListener('unhandledrejection', e => pageError(`unhandled: ${e.reason?.message ?? e.reason}`));

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
  // projects taken off the sidebar: folder -> ids of the chats it had then. Only the sidebar forgets them (chats and folder stay);
  // a chat that is new since then brings the project back.
  hidden: JSON.parse(localStorage.getItem('chorus.hidden') || '{}'),
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
  docOpen: new Set(),
  docNotNow: new Set(),
  docKept: new Set(),
  docRan: false,
  attached: null,
  screen: { live: true, exited: false, waiting: true },
  shownDialogs: new Set(),
  homeGuess: '',
  news: null,
  newsDetail: null,
  size: sizeNow(),
  // a phone: the Chats tab's search, filter and project; the ⋯ sheet; a task chat's tab (Chat, Steps, Plan)
  cl: { q: '', filter: 'all', proj: '', focus: false },
  sheet: null,
  chatTab: 'chat',
};

/* ---------- the socket ---------- */

// The Chorus window, not a browser tab: the shell opens the page with ?window=native (the address is cleaned later, so it is kept for
// reloads in this window's session). While the window is open, only it sets the agents' screen size.
const NATIVE = (() => {
  let yes = !!(window.__TAURI_INTERNALS__ || window.__TAURI__) || new URLSearchParams(location.search).get('window') === 'native';
  try {
    if (yes) sessionStorage.setItem('chorus-window', 'native');
    else yes = sessionStorage.getItem('chorus-window') === 'native';
  } catch { /* no storage: the address and the globals decide */ }
  return yes;
})();

let ws;
let outbox = [];
function connect() {
  // the window says it is the window: while it is open, a browser tab on the same Chorus never resizes the agents
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws${NATIVE ? '?window=native' : ''}`);
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
  if (m.t === 'pro-status') return void onProStatus(m.status);
  if (m.t === 'pro-signed-in') return void onProStatus(m.status).then(() => {
    if (!m.status.unlocked) return toast(m.status.message || 'Signing in did not work. Try again.');
    remember('welcome', 'pro');
    S.welcome = 'pro';
    if (m.then === 'upgrade') return upgrade();
    go({ name: m.status.plan === 'trial' ? 'pro-started' : 'new' });
    if (m.status.plan === 'free') toast('Signed in. This email already had a trial: Community keeps working, and Upgrade unlocks Pro.');
  });
  if (m.t === 'pro') return window.choruspro?.onEvent?.(m.event, m.data);
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
  renderUpdate(st.update);
  const first = !S.state;
  if (first) {
    takeUi(st.ui ?? {});
    queueMicrotask(planScreens);
  }
  const previousNews = S.state?.notifications;
  const doctorChanged = JSON.stringify(S.state?.doctor) !== JSON.stringify(st.doctor);
  S.state = st;
  if (JSON.stringify(previousNews) !== JSON.stringify(st.notifications) && !$('#news').hidden && !S.newsDetail) void loadNews();
  if (!S.homeGuess) S.homeGuess = st.project.split('/').slice(0, 3).join('/');
  // a request no longer pops up at the bottom (owner, 2026-11-07): it waits in Approvals and the top bar's "waiting" button
  if (S.view.name === 'chat' && !st.chats.some(c => c.id === S.view.id)) {
    S.history = [];
    return go(startView(), false);
  }
  showDialogs(st.dialogs);
  // first load: the doctor's popup when this is a first launch or something was updated (docs/doctor.md §6.1)
  if (first) void firstDoctor();
  renderChrome();
  if (doctorChanged) drawDoctor();
  else renderDoctorDot();
  if (S.view.name === 'chat') renderChatParts();
  else if (['approvals', 'home'].includes(S.view.name) && !$('#view').contains(document.activeElement?.closest('.note-input, .other-input'))) renderView();
  else if (S.view.name === 'chats' || S.view.name === 'more') renderView();
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
  $('#app').classList.remove('side-open');
  // Home, Chats and More are a phone's: on a wider screen the sidebar holds what they show
  if (S.size !== 'phone' && ['home', 'chats', 'more'].includes(view.name)) view = { name: 'new' };
  if (view.name === 'chat' && !(S.view.name === 'chat' && S.view.id === view.id)) S.chatTab = 'chat';
  S.sheet = null;
  drawSheet();
  if (push && S.view && JSON.stringify(S.view) !== JSON.stringify(view)) S.history.push(S.view);
  S.history = S.history.slice(-30);
  S.view = view;
  S.drawerData = null;
  if (view.name === 'pro-ended' && !S.endedSeen) (S.endedSeen = true), remember('ended', true);
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
  renderDoctorDot();
  renderView();
  doctorWhenReady();
}
function back() {
  const v = S.history.pop();
  if (v) go(v, false);
  else if (S.size === 'phone') go({ name: 'home' }, false);
}

/** The window crossed 640 or 1024 px (a phone turned, a window resized): the same screen, drawn for the new size. */
function onSize() {
  const was = S.size;
  S.size = sizeNow();
  if (was === S.size) return;
  document.documentElement.dataset.size = S.size;
  $('#app').classList.remove('side-open');
  S.sheet = null;
  drawSheet();
  if (S.size !== 'phone') document.documentElement.classList.remove('kb');
  if (S.size !== 'phone' && ['home', 'chats', 'more'].includes(S.view.name)) return go({ name: 'new' }, false);
  renderChrome();
  renderDoctorDot();
  if (S.view.name === 'chat') renderChatParts();
  else renderView();
  setTimeout(refit, 60);
}
MQ_PHONE.addEventListener('change', onSize);
MQ_TABLET.addEventListener('change', onSize);
// the on-screen keyboard: a phone's tab bar steps aside while it is up
window.visualViewport?.addEventListener('resize', () => document.documentElement.classList.toggle('kb', S.size === 'phone' && innerHeight - visualViewport.height > 140));

/* ---------- the optional module: slots stay empty unless it is unlocked ---------- */

const proSlot = (name, attrs = '') => `<div data-pro-slot="${name}"${attrs}></div>`;

function fillSidebarSlots() {
  for (const el of document.querySelectorAll('#side [data-pro-slot]')) window.choruspro?.render(el.dataset.proSlot, el, { ...el.dataset, view: S.view.id });
}

function fillChatSlots() {
  for (const el of document.querySelectorAll('#view [data-pro-slot^="chat-"]')) window.choruspro?.render(el.dataset.proSlot, el, { ...el.dataset, cwd: S.state?.chats.find(c => c.id === el.dataset.chat)?.cwd, chatRow: S.state?.chats.find(c => c.id === el.dataset.chat), chats: S.state?.chats });
}

function fillSlots() {
  for (const el of document.querySelectorAll('[data-pro-slot]')) {
    if (window.choruspro) window.choruspro.render(el.dataset.proSlot, el, { ...el.dataset, view: S.view.id, id: S.view.id, open: S.view.name === 'chat' ? S.view.id : '', project: S.form?.folder ?? S.state?.project, cwd: el.dataset.cwd ?? S.state?.chats.find(c => c.id === el.dataset.chat)?.cwd, chatRow: S.state?.chats.find(c => c.id === el.dataset.chat), chats: S.state?.chats });
    else if (el.dataset.proSlot === 'nav' && el.dataset.part) {
      // a phone's More: the same locked items as rows (Team), Remote access locked too (This Mac)
      const row = (ic, t, act) => `<button class="mrow locked" data-act="${act}"><span class="ico">${ic}</span>${t}<span class="val"${act === 'unlock' ? '' : ' aria-label="Pro only"'}>${act === 'unlock' ? '' : '🔒'}</span><span class="chev">›</span></button>`;
      const team = (community() ? [['☺', 'Teammates', 'plan-welcome'], ['⇢', 'Processes', 'plan-welcome']] : []).concat(S.pro?.dev ? [['⚿', 'Unlock', 'unlock']] : []);
      el.innerHTML = (el.dataset.part === 'team' ? team : community() ? [['⇆', 'Remote access', 'plan-welcome']] : []).map(r => row(...r)).join('');
    } else if (el.dataset.proSlot === 'nav') {
      // Community: the Pro items show, locked; a click offers the trial. A dev build also has Unlock (a test key)
      const lock = community() ? [['☺', 'Teammates'], ['⇢', 'Processes']].map(([ic, t]) => `<button class="locked" data-act="plan-welcome" title="Pro only"><span class="ico">${ic}</span>${t}<span class="lock" aria-label="Pro only">🔒</span></button>`).join('') : '';
      el.innerHTML = lock + (S.pro?.dev ? `<button class="${S.view.name === 'unlock' ? 'on' : ''}" data-act="unlock"><span class="ico">⚿</span>Unlock</button>` : '');
    }
  }
}

async function onProStatus(st) {
  S.pro = st;
  document.querySelector('#pro-css')?.remove();
  if (!st.unlocked) delete window.choruspro;
  else if (!window.choruspro) {
    await new Promise(done => {
      const js = Object.assign(document.createElement('script'), { src: '/api/pro/ui.js', onload: done, onerror: done });
      document.head.append(Object.assign(document.createElement('link'), { id: 'pro-css', rel: 'stylesheet', href: '/api/pro/ui.css' }), js);
    });
  }
  window.choruspro?.init?.({ go: id => go({ name: 'pro', id }), newChat: folder => go({ name: 'new', folder }), refresh: () => { renderChrome(); fillChatSlots(); if (['new', 'approvals', 'home', 'more'].includes(S.view.name)) renderView(); else if (S.view.name === 'chat') renderChatParts(); }, doctor: () => go({ name: 'doctor' }), toast, openChat: id => go({ name: 'chat', id }), upgrade, back: () => history.length && go(S.history.pop() ?? startView(), false) });
  if (S.view.name === 'pro' && !st.unlocked) return go(startView());
  // back from paying (the browser's link to /api/pro/paid, or Check again): the server's answer, never the browser's word
  if (S.view.name === 'paying' && st.plan === 'pro') return go({ name: 'pro-paid' });
  renderChrome();
  drawPlanBanner();
  if (S.view.name !== 'chat') renderView();
  planScreens();
  doctorWhenReady();
}

function unlockHtml() {
  const p = S.pro;
  return `<div class="page hero"><h1>Unlock</h1><div class="card form"><div class="field"><label for="pro-key">KEY</label><input id="pro-key" type="text" spellcheck="false"></div>
    ${p?.message && !p.unlocked ? `<div class="err" id="pro-why">${esc(p.message)}</div>` : ''}${p?.unlocked ? '<div id="pro-why">Unlocked.</div>' : ''}
    <div class="form-foot"><span class="hint">Development builds only</span><button class="btn primary" data-act="pro-unlock">Unlock</button></div></div></div>`;
}

/* ---------- the plan: Welcome, Try Pro, the plan box, the trial banners (chorus-core plan stage 6) ---------- */
// The words of the Welcome screen come from the backend (/api/pro/plans), so no sales text sits in this repo. Community runs the module
// with every Pro gate locked (its own token, no account); signing up opens /try in the user's own browser, which comes back to
// /api/pro/signed-in with a one-time code, and the account's licence replaces the Community one.

const DAY = 86_400_000;
const daysLeft = iso => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / DAY));
// no paid code on this install: what a Community user sees (a dev build adds Unlock for a test key)
// Community: no account. Since 2026-11-09 it runs the module too (plan `community`, every Pro gate locked: it plans and runs steps);
// with no connection on its first launch it has no paid code, as before
const community = () => !!S.pro && (!S.pro.unlocked || S.pro.plan === 'community');
// Upgrade (chorus-core plan stage 8): the backend's payment page opens in the user's own browser (prices live there, not here). Only the
// server's signed licence makes this install Pro: the page that comes back, or Check again, asks it.
async function upgrade() {
  const r = await api('POST', '/api/pro/upgrade').catch(err => ({ error: err.message }));
  if (r.signIn) {
    // no account on this install yet: sign in first, then straight on to payment (then=upgrade)
    const t = await api('POST', '/api/pro/try', { then: 'upgrade' }).catch(err => ({ error: err.message }));
    if (t.error) return toast(t.error);
    return go({ name: 'trying' });
  }
  if (r.error) return toast(r.error);
  go({ name: r.pro ? 'pro-paid' : 'paying' });
}
async function recheck() {
  const st = await api('POST', '/api/pro/recheck').catch(err => ({ error: err.message }));
  if (st.error) return toast(st.error);
  await onProStatus(st);
  if (st.plan !== 'pro') toast(st.message || 'Not confirmed yet. A payment can take a few seconds: try again in a moment.');
}
/** The Pro gates by id, as Admin › Free and Pro names them (chorus-admin server/gates.mjs; their lines stay in the backend). */
const GATE_NAMES = { portal: 'Open the Portal', instructions: 'Edit instructions', actions: 'Create and edit actions', processes: 'Edit processes', failures: 'Add failure notes', 'teammate.create': 'Create a new teammate', remote: 'Use remote access' };

/** First launch, or a trial that just ended: the screen that says so, once. */
function planScreens() {
  if (!S.pro || !S.state || !['new', 'home'].includes(S.view.name)) return;
  if (community() && S.welcome === undefined) return go({ name: 'welcome' });
  if (S.pro.plan === 'free' && !S.endedSeen) return go({ name: 'pro-ended' });
}

function planBox() {
  const p = S.pro;
  if (!p) return '';
  // Upgrade is there whenever there is something to buy, from a trial's first day (plan 2026-11-09); the email says which account
  const who = p.email ? `<span class="who" title="Signed in as ${esc(p.email)}">${esc(p.email)}</span>` : '';
  const up = '<button class="btn primary" data-act="plan-upgrade">Upgrade</button>';
  const box = (title, sub, button = '', warn = false) => `<div class="plan-box"><b>${esc(title)}</b><span class="${warn ? 'warn' : 'muted'}">${esc(sub)}</span>${who}${button}</div>`;
  if (community()) return box('Community', 'Free', '<button class="btn" data-act="plan-welcome">Try Pro free</button><button class="btn primary" data-act="plan-buy">Buy Pro</button>');
  if (p.plan === 'trial') {
    const n = daysLeft(p.ends);
    return box('Pro trial', `${n} day${n === 1 ? '' : 's'} left`, up, n <= 3);
  }
  if (p.plan === 'free') return box('No Pro', 'Your trial ended', up);
  if (p.plan === 'pro') return box('Pro', 'For life · thank you');
  return '';
}

/** The trial's last days: a line under the top bar, until Later (then again the next day). */
function drawPlanBanner() {
  const el = $('#plan-banner');
  const p = S.pro, n = p?.plan === 'trial' ? daysLeft(p.ends) : 99, today = new Date().toDateString();
  el.hidden = !(n <= 3 && S.bannerDay !== today);
  if (!el.hidden) el.innerHTML = `<span>Your Pro trial ends ${n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`}.</span><span style="flex:1"></span><button class="btn primary" data-act="plan-upgrade">Upgrade</button><button class="btn" data-act="plan-later">Later</button>`;
}

let planWords;
function welcomeHtml() {
  if (planWords === undefined) {
    planWords = null;
    void api('GET', '/api/pro/plans').then(w => { planWords = w; if (S.view.name === 'welcome') renderView(); }, () => { planWords = { offline: true }; renderView(); });
  }
  const w = planWords && !planWords.offline ? planWords : null;
  // the backend's features (a name and its line), else its plain items; offline, Pro lists the gates' names
  const list = (c, pro) => c?.features ? c.features.map(f => `<li><div><b>${esc(f.name)}</b>${f.detail ? `<span>${esc(f.detail)}</span>` : ''}</div></li>`) : (c?.items ?? (pro ? Object.values(GATE_NAMES) : [])).map(i => `<li>${esc(i)}</li>`);
  const card = (c, pro) => `<div class="plan-card${pro ? ' pro' : ''}"><h2>${esc(c?.name ?? (pro ? 'Pro' : 'Community'))}${pro && c?.badge ? ` <span class="badge acc">${esc(c.badge)}</span>` : ''}</h2><div class="muted">${esc(c?.sub ?? (pro ? 'Everything in Community, plus' : 'Free'))}</div>
    <ul>${list(c, pro).join('')}</ul>
    <button class="btn${pro ? ' primary' : ''} wide" data-act="${pro ? 'plan-try' : 'plan-community'}">${esc(c?.button ?? (pro ? 'Try Pro free' : 'Keep Community'))}</button><div class="fine">${esc(c?.fine ?? '')}</div></div>`;
  return `<div class="page welcome"><h1>${esc(w?.title ?? 'Welcome to Chorus')}</h1><p class="lead">${esc(w?.lede ?? 'Start free, or try Pro. You can change your mind any time.')}</p>
    ${planWords === null ? '<p class="muted" role="status" style="text-align:center">Loading…</p>' : `<div class="plan-cards">${card(w?.community, false)}${card(w?.pro, true)}</div>`}</div>`;
}
const tryingHtml = () => `<div class="page welcome center"><div class="big">↗</div><h1>Finish in your browser</h1><p class="lead">Sign in with Google or your email on the page that opened. Chorus picks it up here when you're done.</p>
  <div class="row-c"><button class="btn" data-act="plan-try">Open the page again</button><button class="btn" data-act="plan-community">Not now</button></div></div>`;
const payingHtml = () => `<div class="page welcome center"><div class="big">↗</div><h1>Finish paying in your browser</h1><p class="lead">Choose how to pay on the page that opened. Chorus shows Pro here once the payment is confirmed, usually within a few seconds.</p>
  <div class="row-c"><button class="btn primary" data-act="plan-recheck">Check again</button><button class="btn" data-act="plan-upgrade">Open the page again</button><button class="btn" data-act="new">Not now</button></div></div>`;
const paidHtml = () => `<div class="page welcome center"><div class="big">✓</div><h1>You have Chorus Pro</h1><p class="lead">Thank you for supporting Chorus. Pro is yours on up to three of your computers.</p>
  <div class="row-c"><button class="btn primary" data-act="pro-view" data-arg="teammates">Open Teammates</button><button class="btn" data-act="new">Start a chat</button></div></div>`;
const startedHtml = () => `<div class="page welcome center"><div class="big">✓</div><h1>Your Pro trial has started</h1><p class="lead">${S.pro?.ends ? `${daysLeft(S.pro.ends)} days from today. ` : ''}Your first step is meeting your teammates.</p>
  <div class="row-c"><button class="btn primary" data-act="pro-view" data-arg="teammates">Meet your teammates</button><button class="btn" data-act="new">Start a chat</button></div></div>`;
function endedHtml() {
  const off = (S.pro?.locked ?? []).filter(g => GATE_NAMES[g]).map(g => `<b>${esc(GATE_NAMES[g])}</b>`);
  const listed = off.length > 1 ? `${off.slice(0, -1).join(', ')} and ${off.at(-1)}` : off[0];
  return `<div class="page welcome center"><h1>Your Pro trial has ended</h1><p class="lead">You keep the Planner, your plans and tasks, and Workers that run the steps.${off.length ? ` These now need Pro: ${listed}.` : ' Everything keeps working.'}</p>
    <div class="row-c"><button class="btn primary" data-act="plan-upgrade">Upgrade</button><button class="btn" data-act="pro-view" data-arg="teammates">Open Teammates</button></div></div>`;
}

/* ---------- your choices, kept by the server ---------- */
// The native window's server takes a new port at each launch, and a browser keeps its storage per address, so what the page
// remembers lives on the server (POST /api/ui). Browser storage stays as a copy, and fills the server once if it has nothing yet.

function remember(key, value) {
  try {
    localStorage.setItem(`chorus.${key}`, typeof value === 'string' ? value : JSON.stringify(value));
  } catch {
    /* no storage: the server's copy is enough */
  }
  void api('POST', '/api/ui', { key, value }).catch(() => {});
}
function takeUi(ui) {
  if (ui.hidden) S.hidden = ui.hidden;
  else if (Object.keys(S.hidden).length) remember('hidden', S.hidden);
  if (ui.folded) S.folded = new Set(ui.folded);
  else if (S.folded.size) remember('folded', [...S.folded]);
  if (ui.drawer !== undefined) S.drawer = ui.drawer || null;
  S.agentPref = typeof ui.agent === 'string' ? ui.agent : undefined;
  S.welcome = ui.welcome;
  S.endedSeen = !!ui.ended;
  S.bannerDay = ui.banner;
}

/* ---------- sidebar, top bar, notice ---------- */

function chatsByProject() {
  const groups = new Map((window.choruspro?.projects?.() ?? []).map(cwd => [cwd, []]));
  for (const c of S.state?.chats ?? []) {
    if (S.hidden[c.cwd]?.includes(c.id) && c.id !== S.view.id) continue;
    if (!groups.has(c.cwd)) groups.set(c.cwd, []);
    groups.get(c.cwd).push(c);
  }
  // a project with tasks is listed even with no chat left: taken off the sidebar, it stays off until a new chat starts there
  for (const [cwd, chats] of groups) if (S.hidden[cwd] && !chats.length) groups.delete(cwd);
  return groups;
}

/** The project tree of the sidebar, and of a phone's Chats tab. `keep`: only these chats, and only projects that have one. */
function treeHtml(keep) {
  const v = S.view;
  let tree = '';
  for (const [cwd, all] of chatsByProject()) {
    const chats = keep ? all.filter(keep) : all;
    if (keep && !chats.length) continue;
    const folded = S.folded.has(cwd) && !keep;
    const bang = all.filter(c => c.state === 'approval').length;
    // the project in front: the chat you look at is in it, or the New chat form starts there. Its ＋ always shows; others on hover.
    const here = (v.name === 'chat' && chats.some(c => c.id === v.id)) || (v.name === 'new' && !v.from && (S.form?.folder ?? v.folder) === cwd);
    tree += `<div class="proj-row${here ? ' here' : ''}"><button class="proj" data-act="fold" data-arg="${esc(cwd)}" title="${esc(tilde(cwd))}"><span class="caret">${folded ? '▸' : '▾'}</span><span class="pname">${esc(base(cwd))}</span>${bang ? `<span class="bang">!${bang}</span>` : ''}</button><button class="proj-rm" data-act="rm-project" data-arg="${esc(cwd)}" title="Remove from the sidebar (the folder and its chats are kept)" aria-label="Remove ${esc(base(cwd))} from the sidebar">×</button><button class="proj-add" data-act="new-in" data-arg="${esc(cwd)}" title="New chat in ${esc(tilde(cwd))}" aria-label="New chat in ${esc(base(cwd))}">${PLUS}</button></div>`;
    if (folded) continue;
    if (!keep) tree += `<div data-pro-slot="project" data-cwd="${esc(cwd)}"></div>`;
    for (const c of chats) {
      if (!keep && window.choruspro?.hidesChat?.(c.id)) continue; // shown under its task
      const child = c.parentId && chats.some(p => p.id === c.parentId);
      tree += `<button class="chat-row${child ? ' child' : ''}${v.name === 'chat' && v.id === c.id ? ' on' : ''}" data-act="chat" data-arg="${esc(c.id)}" title="${esc(c.title)} · ${esc(AGENT[c.agent]?.name ?? c.agent)} · ${esc(STATE_LABEL[c.state] ?? '')}">
        ${child ? '<span class="arrow">↳</span>' : ''}<span class="dot ${esc(c.state)}"></span><span class="t">${esc(c.title)}</span><span class="badge mini ${esc(c.agent)}">${esc(AGENT[c.agent]?.letter ?? '?')}</span></button>`;
    }
  }
  return tree;
}

/** Chats' requests and Chorus's own (a plan to approve, work to check). */
const waitingCount = () => (S.state?.approvals.length ?? 0) + (window.choruspro?.needsCount?.() ?? 0);

function renderChrome() {
  const st = S.state;
  const waiting = waitingCount();
  const v = S.view;
  const on = n => (v.name === n ? ' on' : '');
  // a phone has no sidebar: Home, Chats and More hold its parts
  if (S.size === 'phone') {
    if ($('#side').innerHTML) $('#side').innerHTML = '';
  } else {
    const tree = treeHtml() || '<div class="faint" style="padding:8px 18px;font-size:13px">No chats yet.</div>';
    // each agent as the doctor's last check saw it; a click opens Doctor
    const agentFoot = Object.keys(AGENT)
      .map(a => {
        const i = drAgent(a) ?? { agent: a };
        const st = agentStatus(i, false);
        const hint = i.state === 'needs-login' ? ' · logged in already? Check again in Doctor' : '';
        return `<span class="foot-agent" data-act="doctor" title="${esc(`${AGENT[a].name} ${i.version ?? ''} · ${st.label}${hint}`)}"><span class="badge mini ${a}">${AGENT[a].letter}</span> ${agentMark(i, st)}</span>`;
      })
      .join(' ');
    $('#side').innerHTML = `
    <div class="brand"><span class="logo"><i></i><i></i><i></i></span><b>Chorus</b><button class="icon-btn" data-act="sidebar" title="${S.size === 'desktop' ? `Hide the sidebar (${MOD}B)` : 'Close'}" aria-label="${S.size === 'desktop' ? 'Hide the sidebar' : 'Close the sidebar'}">⇤</button></div>
    <nav class="nav">
      <button class="new${v.name === 'new' && !v.from && !v.folder ? ' on' : ''}" data-act="new"><span class="plus">${PLUS}</span>New chat<kbd style="margin-left:auto">${MOD}N</kbd></button>
      <button class="${on('approvals').trim()}" data-act="approvals"><span class="ico">⚑</span>Approvals${waiting ? `<span class="count">${waiting}</span>` : ''}</button>
      <button class="${on('memory').trim()}" data-act="memory"><span class="ico">◫</span>Memory</button>
      <button class="${on('skills').trim()}" data-act="skills"><span class="ico">✦</span>Skills</button>
      ${proSlot('nav')}
    </nav>
    ${proSlot('side')}
    <div class="side-head">PROJECTS<button data-act="add-project" title="Start a chat in another folder">+ add</button></div>
    <div class="tree">${tree}</div>
    ${planBox()}<div class="side-foot">${agentFoot}<span style="flex:1"></span><button data-act="doctor">Doctor</button></div>`;
  }

  const chat = v.name === 'chat' ? st?.chats.find(c => c.id === v.id) : undefined;
  if (S.size === 'phone') {
    $('#top').className = PHONE_ROOTS.includes(v.name) ? 'root' : '';
    $('#top').innerHTML = phoneTop(chat);
  } else {
    // a tablet: icon buttons (whole words on a desktop, written as they always were)
    const wide = S.size === 'desktop';
    let crumbs = '';
    if (chat) crumbs = `<a data-act="fold-open" data-arg="${esc(chat.cwd)}">${esc(base(chat.cwd))}</a><span class="sep">›</span><span class="here">${window.choruspro?.chatCrumb?.(chat.id) ?? esc(chat.title)}</span>`;
    else if (v.name === 'new') crumbs = `<span>${esc(base(S.form?.folder ?? st?.project ?? ''))}</span><span class="sep">›</span><span class="here">${v.from ? 'Hand off' : 'New chat'}</span>`;
    else if (v.name === 'pro') crumbs = window.choruspro?.crumbs?.(v.id) ?? '';
    else crumbs = `<span class="here">${{ approvals: 'Approvals', memory: 'Memory', skills: 'Skills', doctor: 'Doctor' }[v.name] ?? ''}</span>`;
    $('#top').className = '';
    $('#top').innerHTML = `
    <button class="icon-btn menu-btn" data-act="menu" aria-label="Chats and projects" aria-expanded="${$('#app').classList.contains('side-open')}">☰</button>
    ${$('#app').classList.contains('side-off') && S.size === 'desktop' ? `<button class="icon-btn" data-act="sidebar" title="Show the sidebar (${MOD}B)">⇥</button>` : ''}
    ${S.history.length ? `<button class="btn" data-act="back" title="Back" aria-label="Back">${wide ? '‹ Back' : '‹'}</button>` : ''}
    <div class="crumbs">${crumbs}</div>
    ${waiting ? `<button class="btn waiting" data-act="approvals" aria-label="${waiting} waiting">! ${waiting}${wide ? ' waiting' : ''}</button>` : ''}
    ${st?.update ? `<button class="btn update-btn" data-act="update-toggle" aria-expanded="${!$('#app-update').hidden}" aria-controls="app-update" title="Chorus ${esc(st.update.version)} is available">↑ <span class="update-label">Update to </span>${esc(st.update.version)}</button>` : ''}
    <button class="btn export-btn" data-act="export" title="Save all your chats and their files to one .zip in Downloads" aria-label="Export"${S.exporting ? ' disabled' : ''}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14"/></svg><span class="export-label">${S.exporting ? 'Exporting…' : 'Export'}</span></button>
    <button class="btn news-toggle" data-act="news-toggle" aria-label="Notifications${st?.notifications?.unread ? `, ${st.notifications.unread} unread` : ''}" aria-expanded="${!$('#news').hidden}" aria-controls="news"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg><span class="news-label">Notifications</span>${st?.notifications?.unread ? `<span class="news-count">${Math.min(st.notifications.unread, 99)}</span>` : ''}</button>`;
  }
  renderTabs(waiting);

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
  fillSlots();
}

/** A phone's top bar: ‹ Back (not on the four places of the tab bar), the screen's title, at most two icons. */
function phoneTop(chat) {
  const v = S.view, st = S.state;
  const root = PHONE_ROOTS.includes(v.name);
  const unread = st?.notifications?.unread ?? 0;
  const ico = (act, label, inner, arg = '') => `<button class="icon-btn ph-ico" data-act="${act}"${arg ? ` data-arg="${esc(arg)}"` : ''} aria-label="${esc(label)}">${inner}</button>`;
  let title = '';
  let icons = '';
  if (v.name === 'home') {
    title = '<span class="logo"><i></i><i></i><i></i></span>Chorus';
    if (st?.update) icons += ico('update-toggle', `Chorus ${st.update.version} is available`, `${ICON.up}<span class="n acc">1</span>`);
    icons += ico('news-toggle', `Notifications${unread ? `, ${unread} unread` : ''}`, `${ICON.bell}${unread ? `<span class="n">${Math.min(unread, 99)}</span>` : ''}`);
  } else if (v.name === 'chats') {
    title = 'Chats';
    icons = ico('add-project', 'Add a project', '＋');
  } else if (v.name === 'chat') {
    title = esc(chat?.title ?? '');
    icons = chat ? ico('chat-menu', 'This chat: hand off, artifacts, activity, record, delete', '⋯') : '';
  } else if (v.name === 'memory') {
    title = v.rec ? esc(S.mem.items.find(i => i.id === v.rec)?.title ?? 'Memory') : 'Memory';
  } else if (v.name === 'pro') {
    const t = document.createElement('template');
    t.innerHTML = window.choruspro?.crumbs?.(v.id) ?? '';
    title = esc(t.content.querySelector('.here')?.textContent ?? '');
  } else {
    title = { approvals: 'Approvals', more: 'More', new: v.from ? 'Hand off' : 'New chat', skills: 'Skills', doctor: 'Doctor', unlock: 'Unlock' }[v.name] ?? '';
  }
  return `${root ? '' : ico('back', 'Back', '‹')}<div class="ph-title">${title}</div>${icons}`;
}

/** A phone's tab bar: Home · Chats · a round ＋ (New chat) · Approvals · More. */
function renderTabs(waiting) {
  const el = $('#tabs');
  if (S.size !== 'phone') {
    if (el.innerHTML) el.innerHTML = '';
    return;
  }
  const v = S.view, pro = v.name === 'pro' ? String(v.id ?? '') : '';
  const here = {
    home: v.name === 'home' || pro.startsWith('portal'),
    chats: v.name === 'chats' || v.name === 'chat' || /^(task|chat|howrun)~/.test(pro),
    approvals: v.name === 'approvals',
    more: ['more', 'memory', 'skills', 'doctor', 'unlock'].includes(v.name) || /^(teammates|processes|remote)/.test(pro),
  };
  const t = (id, label, n = 0) => `<button class="${here[id] ? 'on' : ''}" data-act="tab" data-arg="${id}"${here[id] ? ' aria-current="page"' : ''}>${ICON[id]}${label}${n ? `<span class="n">${Math.min(n, 99)}</span>` : ''}</button>`;
  el.innerHTML = `${t('home', 'Home')}${t('chats', 'Chats')}<button class="newtab" data-act="new" aria-label="New chat">${ICON.plus}</button>${t('approvals', 'Approvals', waiting)}${t('more', 'More')}`;
}

/* ---------- views ---------- */

function renderView() {
  const v = S.view;
  const el = $('#view');
  if (v.name === 'chat') return renderChat();
  // the module's page keeps its own state: a push of the app's state must not rebuild it
  const slot = el.querySelector('[data-pro-slot="view"]');
  if (v.name === 'pro' && slot?.dataset.id === v.id) return;
  const scroll = el.scrollTop;
  el.innerHTML = { new: newChatHtml, approvals: approvalsHtml, memory: memoryHtml, skills: skillsHtml, doctor: doctorHtml, unlock: unlockHtml, welcome: welcomeHtml, trying: tryingHtml, paying: payingHtml, 'pro-paid': paidHtml, 'pro-started': startedHtml, 'pro-ended': endedHtml, home: homeHtml, chats: chatsHtml, more: moreHtml, pro: () => `<div data-pro-slot="view" data-id="${esc(v.id ?? '')}" style="height:100%"></div>` }[v.name]?.() ?? '';
  // a state push redraws a phone's Home and Chats: where you were stays (another screen starts at its top)
  if (['home', 'chats', 'more', 'approvals'].includes(v.name) && el.dataset.v === v.name) el.scrollTop = scroll;
  el.dataset.v = v.name;
  fillSlots();
  // a phone does not open the keyboard by itself
  if (v.name === 'new') {
    const ta = $('#nc-prompt');
    if (ta && !v.from && !MQ_TOUCH.matches) ta.focus();
  }
  if (v.name === 'chats' && S.cl.focus) {
    const q = $('#cl-q');
    q?.focus();
    q?.setSelectionRange(q.value.length, q.value.length);
  }
  if (v.name === 'memory') {
    const q = $('#mem-q');
    if (q && S.mem.focus) {
      q.focus();
      q.setSelectionRange(q.value.length, q.value.length);
    }
  }
}

/* ---------- a phone's Home, Chats and More: the sidebar's parts, each a place of the tab bar ---------- */

const chatSub = c => `${esc(base(c.cwd))} · ${esc(STATE_LABEL[c.state] ?? c.state)}`;
/** Home answers "what needs me, what is running" first: a one-tap composer, three counts, the requests with their answers, the
 *  chats active now, the projects. */
function homeHtml() {
  const st = S.state;
  const chats = st?.chats ?? [];
  const asks = st?.approvals ?? [];
  const need = waitingCount();
  const working = chats.filter(c => c.state === 'busy' || c.state === 'starting').length;
  const turn = chats.filter(c => c.state === 'idle').length;
  const stat = (cls, v, k, filter) => `<button class="hm-stat${cls}" data-act="${filter ? 'cl-filter' : 'approvals'}" data-arg="${filter}"><span class="v">${v}</span><span class="k">${k}</span></button>`;
  const ORDER = { approval: 0, busy: 1, starting: 1, idle: 2 };
  const active = chats.filter(c => c.state in ORDER).sort((a, b) => ORDER[a.state] - ORDER[b.state]).slice(0, 6);
  const row = c => `<button class="hm-row" data-act="chat" data-arg="${esc(c.id)}"><span class="dot ${esc(c.state)}"></span><span class="tx"><b>${esc(c.title)}</b><span>${chatSub(c)}</span></span><span class="badge mini ${esc(c.agent)}">${esc(AGENT[c.agent]?.letter ?? '?')}</span><span class="chev">›</span></button>`;
  const projects = [...chatsByProject()].map(([cwd, cs]) => {
    const bang = cs.filter(c => c.state === 'approval').length;
    return `<button class="card hm-proj" data-act="proj-open" data-arg="${esc(cwd)}"><b><span>${esc(base(cwd))}</span>${bang ? `<i>!${bang}</i>` : ''}</b><span class="sub">${cs.length} chat${cs.length === 1 ? '' : 's'}</span><span class="dots">${cs.slice(0, 8).map(c => `<span class="dot ${esc(c.state)}"></span>`).join('')}</span></button>`;
  }).join('');
  return `<div class="hm">
    <button class="hm-ask" data-act="new">What are we working on?<span class="go">${ICON.up}</span></button>
    <div class="hm-stats">${stat(need ? ' need' : '', need, 'need you', '')}${stat('', working, '<span class="dot busy"></span>working', 'working')}${stat('', turn, '<span class="dot idle"></span>your turn', 'turn')}</div>
    <div><div class="hm-h">Needs you${need ? `<button data-act="approvals">See all ${need}</button>` : ''}</div>
      ${asks.length ? `<div class="card list hm-need">${asks.slice(0, 3).map(approvalItem).join('')}</div>` : ''}${proSlot('home')}
      ${need ? '' : '<div class="card empty">Nothing is waiting for you.</div>'}</div>
    <div><div class="hm-h">Active now<button data-act="tab" data-arg="chats">All chats</button></div>
      ${active.length ? `<div class="card">${active.map(row).join('')}</div>` : '<div class="card empty">No agent is working right now.</div>'}</div>
    <div><div class="hm-h">Projects<button data-act="add-project">＋ Add</button></div>
      ${projects ? `<div class="hm-projs">${projects}</div>` : '<div class="card empty">No projects yet: start a chat in a folder.</div>'}</div>
  </div>`;
}

const CHAT_FILTERS = [
  ['all', 'All', () => true],
  ['needs', 'Needs you', c => c.state === 'approval'],
  ['working', 'Working', c => c.state === 'busy' || c.state === 'starting'],
  ['turn', 'Your turn', c => c.state === 'idle'],
  ['resting', 'Resting', c => c.state === 'parked' || c.state === 'ended'],
];
/** Chats: the sidebar's project tree (tasks and hand-offs included), with search and filters. */
function chatsHtml() {
  const f = S.cl;
  const q = f.q.trim().toLowerCase();
  const match = c => (!f.proj || c.cwd === f.proj) && (!q || c.title.toLowerCase().includes(q) || base(c.cwd).toLowerCase().includes(q));
  const chats = (S.state?.chats ?? []).filter(match);
  const pick = (CHAT_FILTERS.find(x => x[0] === f.filter) ?? CHAT_FILTERS[0])[2];
  const filtered = f.filter !== 'all' || !!q || !!f.proj;
  const tree = filtered ? treeHtml(c => match(c) && pick(c)) : treeHtml();
  return `<div class="cl"><div class="find"><input id="cl-q" type="search" data-input="cl-q" placeholder="Search chats" aria-label="Search chats" value="${esc(f.q)}"></div>
    ${f.proj ? `<div class="cl-proj">In <b>${esc(base(f.proj))}</b><button class="btn" data-act="cl-proj" data-arg="">✕ All projects</button></div>` : ''}
    <div class="filt" role="tablist">${CHAT_FILTERS.map(([id, label, test]) => `<button class="${f.filter === id ? 'on' : ''}" data-act="cl-filter" data-arg="${id}" role="tab" aria-selected="${f.filter === id}">${label} · ${chats.filter(test).length}</button>`).join('')}</div>
    <div class="tree">${tree || `<div class="empty">${filtered ? 'No chat matches.' : 'No chats yet.'}</div>`}</div></div>`;
}

/** More: everything that is not a chat, grouped, each row with its state. */
function moreHtml() {
  const st = S.state;
  const r = (act, ic, t, val = '') => `<button class="mrow" data-act="${act}"><span class="ico">${ic}</span>${t}<span class="val">${val}</span><span class="chev">›</span></button>`;
  const marks = Object.keys(AGENT).map(a => { const i = drAgent(a) ?? { agent: a }; return `<span class="badge mini ${a}">${AGENT[a].letter}</span>${agentMark(i, agentStatus(i, false))}`; }).join(' ');
  const unread = st?.notifications?.unread ?? 0;
  const on = S.skills?.items?.filter(s => s.on).length;
  const c = S.doctor?.chorus;
  // a paid bundle older than this page draws its sidebar items whole: they go in Team, as they come
  const parts = !window.choruspro || !!window.choruspro.sideTabs;
  return `<div class="more">
    <div><div class="hm-h">Library</div><div class="card">${r('memory', '◫', 'Memory')}${r('skills', '✦', 'Skills', on != null ? `${on} on` : '')}</div></div>
    <div><div class="hm-h">Team</div><div class="card">${parts ? proSlot('nav', ' data-part="team"') : proSlot('nav', ' class="nav old-nav"')}</div></div>
    <div><div class="hm-h">This Mac</div><div class="card">${parts ? proSlot('nav', ' data-part="mac"') : ''}${r('doctor', '✚', 'Doctor', marks)}${r('news-toggle', '♢', 'Notifications', unread ? `${unread} new` : '')}${r('export', '⤓', S.exporting ? 'Exporting…' : 'Export all chats', 'to Downloads')}${st?.update ? r('update-toggle', '↑', `Update to ${esc(st.update.version)}`) : ''}</div></div>
    ${planBox() ? `<div><div class="hm-h">Plan</div>${planBox()}</div>` : ''}
    ${c ? `<div class="ver">${esc(c.app.replace(/^chorus/, 'Chorus'))} · core ${esc(c.core)}</div>` : ''}
  </div>`;
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
  const agent = src ? S.info.agents.find(a => a.id !== src.agent).id : (S.agentPref || localStorage.getItem('chorus.agent') || 'claude');
  S.form = { agent, model: 'default', effort: 'default', folder: folder ?? S.info.folder, skip: src ? src.skip : false, prompt: '', error: '', busy: false };
  if (S.view.name === 'new') {
    renderChrome();
  renderDoctorDot();
    renderView();
  }
}

function agentRows() {
  const f = S.form, from = S.info.from;
  return S.info.agents
    .map(a => {
      const live = drAgent(a.id) ?? { agent: a.id };
      const st = agentStatus(live, false);
      const sub = st.kind === 'plain' ? 'checking…' : live.state === 'missing' ? '<span class="bad">Not installed</span>' : live.state === 'needs-login' ? `<span class="bad">${esc(live.version ?? '')} · Not logged in</span>` : `${esc(live.version ?? '')} · ${esc(live.login === 'yes' ? 'Logged in' : st.label)}`;
      const q = a.quota ? ` · <span class="${a.quota.level === 'err' ? 'bad' : a.quota.level === 'warn' ? 'warn' : ''}">plan ${esc(a.quota.text)}</span>` : '';
      return `<button class="${f.agent === a.id && !window.choruspro?.teammatePicked?.() ? 'on' : ''}" data-act="nc-agent" data-arg="${a.id}"><span class="nc-mi"><span class="badge mini ${a.id}">${AGENT[a.id].letter}</span>${AGENT[a.id].name}${from?.agent === a.id ? ' <span class="faint">(same agent)</span>' : ''}</span><span class="nc-sub">${sub}${q}</span></button>`;
    })
    .join('');
}
function renderAgentsOnly() {
  if (S.ncMenu === 'agent' || S.ncMenu === 'who') renderView();
}

function newChatHtml() {
  const f = S.form;
  const src = S.info?.from;
  if (!f) return '<div class="page nc-wrap"><h1 class="nc-h">What are we working on?</h1><p class="nc-hint">Loading the agents…</p></div>';
  const a = S.info.agents.find(x => x.id === f.agent);
  const efforts = a.efforts[f.model] ?? ['default'];
  if (!efforts.includes(f.effort)) f.effort = efforts[0];
  const recent = [...new Set([...(S.info.recent ?? []), S.info.computer])].filter(Boolean);
  const m = S.ncMenu;
  const menu = (id, body) => (m === id ? `<div class="nc-menu" role="menu"><div class="grab"></div>${body}</div>` : '');
  const pk = (id, label, cls = '', dis = false, body = '') => `<span class="nc-pk-wrap"><button class="nc-pk ${cls}" data-act="nc-menu" data-arg="${id}" aria-expanded="${m === id}"${dis ? ' disabled' : ''}>${label}</button>${menu(id, body)}</span>`;
  const agentLabel = `<span class="badge mini ${f.agent}">${AGENT[f.agent].letter}</span>${AGENT[f.agent].name}`;
  // the optional module adds who and what; without it the first picker is the agent
  const T = src ? undefined : window.choruspro?.newChat?.({ pk, agentRows: agentRows(), agentLabel });
  const folderName = f.folder === S.info.computer ? 'This computer' : base(f.folder);
  const folders = `${recent.map(r => `<button class="${r === f.folder ? 'on' : ''}" data-act="nc-folder" data-arg="${esc(r)}"><span class="nc-mi">${esc(r === S.info.computer ? 'This computer (no project)' : base(r))}</span><span class="nc-sub">${esc(r === S.info.computer ? 'chats that belong to no folder' : tilde(r))}</span></button>`).join('')}<button data-act="browse"><span class="nc-mi">Browse…</span><span class="nc-sub">Pick another folder</span></button>`;
  const modelLabel = `${f.model === 'default' ? 'Default model' : esc(f.model)}${f.effort === 'default' ? '' : ` · ${esc(f.effort)}`}`;
  const models = `<div class="nc-sel"><label for="nc-model">Model</label><select id="nc-model" data-change="nc-model">${a.models.map(x => `<option${x === f.model ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></div><div class="nc-sel"><label for="nc-effort">Effort</label><select id="nc-effort" data-change="nc-effort">${efforts.map(x => `<option${x === f.effort ? ' selected' : ''}>${esc(x)}</option>`).join('')}</select></div>`;
  const perms = [[false, 'Ask me', 'The agent asks before it edits files or runs commands; you answer here or in Approvals.'], [true, 'Skip permission prompts', `Starts ${AGENT[f.agent].name} with ${a.skipFlag}. Nothing from this chat reaches Approvals.`]]
    .map(([v, t, d]) => `<button class="${f.skip === v ? 'on' : ''}" data-act="nc-skip" data-arg="${v ? 1 : 0}"><span class="nc-mi${v ? ' bad' : ''}">${v ? '⚠' : '✓'} ${t}</span><span class="nc-sub">${esc(d)}</span></button>`)
    .join('');
  // a teammate: its model is its own, but its permissions are chosen again for this chat, starting from the teammate's setting
  const tAgent = T?.agent && AGENT[T.agent] ? T.agent : f.agent;
  const tPerms = [[false, 'Ask me', 'The agent asks before it edits files or runs commands; you answer here or in Approvals.'], [true, 'Skip permission prompts', `Starts ${AGENT[tAgent].name} with ${S.info.agents.find(x => x.id === tAgent)?.skipFlag ?? 'its skip flag'}. Nothing from this chat reaches Approvals.`]]
    .map(([v, t, d]) => `<button class="${T?.skip === v ? 'on' : ''}" data-act="pro-nc" data-arg="skip:${v ? 1 : 0}"><span class="nc-mi${v ? ' bad' : ''}">${v ? '⚠' : '✓'} ${t}</span><span class="nc-sub">${esc(d)}</span></button>`)
    .join('');
  const engine = T?.info
    ? `<span class="nc-info">${esc(T.info)}</span>${typeof T.skip === 'boolean' ? pk('perm', T.skip ? '⚠ Skip permissions' : 'Ask before acting', T.skip ? 'nc-danger' : 'nc-dim', false, tPerms) : ''}`
    : `${pk('model', modelLabel, 'nc-dim', false, models)}${pk('perm', f.skip ? '⚠ Skip permissions' : 'Ask before acting', f.skip ? 'nc-danger' : 'nc-dim', false, perms)}`;
  return `<div class="page nc-wrap">
    <h1 class="nc-h">${src ? 'Continue with another agent' : 'What are we working on?'}</h1>
    ${src ? `<p class="nc-src">Continues <b>${esc(src.title)}</b> <span class="badge ${esc(src.agent)}">${esc(AGENT[src.agent]?.name ?? src.agent)}</span>. The new agent loads its record through the Chorus MCP server and waits for your OK.</p>` : ''}
    <div class="nc-box">
      <textarea id="nc-prompt" data-input="nc-prompt" aria-label="Message" placeholder="${src ? 'Anything to add for the next agent? (optional)' : 'Describe the work…'}">${esc(f.prompt)}</textarea>
      <div class="nc-bar">
        <div class="nc-left">
          ${T?.picks ?? pk('agent', agentLabel, 'nc-strong', false, agentRows())}
          ${pk('folder', `<span class="nc-ico">▢</span>${esc(folderName)}`, '', !!src, folders)}
          ${engine}
        </div>
        <div class="nc-right"><button class="btn primary nc-send" data-act="nc-start" title="Send (${MOD}↵)"${f.busy ? ' disabled' : ''}>${src ? 'Hand off' : esc(T?.send ?? 'Send')} <kbd>${MOD}↵</kbd></button></div>
      </div>
      ${f.skip && !T?.info ? `<div class="nc-warn">⚠ Starts ${esc(AGENT[f.agent].name)} with <code>${esc(a.skipFlag)}</code>: it won't stop to ask before editing files or running commands, and nothing from this chat reaches Approvals.</div>` : ''}
      ${f.error ? `<div class="nc-warn">${esc(f.error)}</div>` : ''}
    </div>
    <p class="nc-hint">${src ? 'The old chat stays as it is; the new one shows under it with ↳.' : T?.hint || `${MQ_TOUCH.matches ? '' : `${MOD}↵ sends · `}you talk to the agent in its own screen`}</p>
  </div>`;
}

async function startChat() {
  const f = S.form;
  if (!f || f.busy) return;
  f.busy = true;
  f.error = '';
  renderView();
  const src = S.info.from;
  try {
    remember('agent', f.agent);
    const thread = await window.choruspro?.startNew?.({ folder: f.folder, prompt: f.prompt, from: src?.id });
    if (thread) {
      S.history = S.history.filter(v => v.name !== 'new');
      f.busy = false;
      return go({ name: 'chat', id: thread }, false);
    }
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

/** The system's own picker (pick or make a folder anywhere); the dialog below only where the system has none. */
async function pickFolder(dir, then) {
  // a phone or a tablet (through the private link): the Mac's own picker would open on the Mac, out of reach
  if (MQ_TOUCH.matches && !NATIVE) return openBrowse(dir, then);
  let r;
  try {
    r = await api('POST', '/api/folders/pick', { dir });
  } catch (e) {
    return toast(e.message);
  }
  if (r.dir) return then(r.dir);
  if (r.none) return openBrowse(dir, then);
}

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

const waitFor = since => { const s = Date.now() / 1000 - since; return s < 60 ? `${Math.max(0, Math.round(s))}s` : `${Math.round(s / 60)}m`; };
const riskBadge = r => (r ? `<span class="badge ${r.level === 'err' ? 'bad' : r.level === 'warn' ? 'warn' : 'plain'}">${esc(r.label)}</span>` : '');
/** One request from a chat, with its answers: Approvals, and a phone's Home. */
const approvalItem = a => `<div class="item"><div class="head"><span class="dot approval"></span><span class="t">${esc(a.title)}</span><span class="badge ${esc(a.agent)}">${esc(AGENT[a.agent]?.name ?? a.agent)}</span><span class="faint">${esc(base(a.cwd))} · waiting ${waitFor(a.since)}</span><span style="flex:1"></span>${riskBadge(a.risk)}</div>
          ${
            a.kind === 'ask'
              ? `${askCard(a)}<div class="acts"><span style="flex:1"></span><button class="btn" data-act="chat" data-arg="${esc(a.id)}">Open chat ›</button></div>`
              : `<div class="what">${esc(a.what)}</div>
          <div class="acts"><button class="btn good" data-act="approve" data-arg="${esc(a.id)}">✓ Approve</button><button class="btn danger" data-act="deny" data-arg="${esc(a.id)}">✕ Deny</button><span style="flex:1"></span><button class="btn" data-act="chat" data-arg="${esc(a.id)}">Open chat ›</button></div>`
          }</div>`;

function approvalsHtml() {
  const st = S.state;
  const cur = st?.chats.find(c => c.id === st.current);
  const all = st?.approvals ?? [];
  const items = S.scope === 'all' || !cur ? all : all.filter(a => a.cwd === cur.cwd);
  return `<div class="page"><h1 class="ph-hide">Approvals</h1><p class="lead">What your agents are asking for, from every chat: their permission prompts (answering types the agent's own key) and the questions they put to you through Chorus (your choice and note become your next message to that agent). You do not have to switch to the chat.</p>
    <div class="toolbar"><div class="seg"><button class="${S.scope === 'all' ? 'on' : ''}" data-act="scope" data-arg="all">All projects</button><button class="${S.scope === 'this' ? 'on' : ''}" data-act="scope" data-arg="this">This project</button></div><span class="grow"></span><span class="muted">${all.length + (window.choruspro?.needsCount?.() ?? 0)} waiting</span></div>
    ${proSlot('approvals', ` data-scope="${esc(S.scope)}" data-cwd="${esc(cur?.cwd ?? '')}"`)}
    ${window.choruspro ? '<div class="section-title" style="margin-top:4px">From chats</div>' : ''}
    <div class="card list">${items.length ? items.map(approvalItem).join('') : '<div class="empty">Nothing is waiting for you.</div>'}</div>
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
  // a phone: the list, and a record as its own step (‹ Back returns to the list)
  const step = S.size === 'phone' ? (S.view.rec ? 'record' : 'list') : '';
  if (step === 'record') m.sel = S.view.rec;
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
  if (step === 'record') return `<div class="page">${detail || '<div class="card empty">This chat is no longer in Memory.</div>'}</div>`;
  return `<div class="page" style="max-width:1100px"><h1 class="ph-hide">Memory</h1><p class="lead">Every chat Chorus recorded, in every project: what an agent gets from <span class="mono">get_handoff_context</span> when it continues one. Stored in <span class="mono">${esc(m.where)}</span>.</p>
    <div class="toolbar"><input id="mem-q" type="search" placeholder="Search titles, questions, answers, files…" value="${esc(m.q)}" data-input="mem-q" style="max-width:420px"><span class="grow"></span><span class="muted">${m.items.length} chat${m.items.length === 1 ? '' : 's'}</span></div>
    ${m.items.length ? `<div class="mem"><div class="card list rows">${rows}</div>${step === 'list' ? '' : detail}</div>` : `<div class="card empty">${m.q ? 'Nothing matches.' : 'Nothing recorded yet.'}</div>`}</div>`;
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
  if (!k) return '<div class="page"><h1 class="ph-hide">Skills</h1><p class="lead">Loading…</p></div>';
  return `<div class="page"><h1 class="ph-hide">Skills</h1><p class="lead">One library for Claude Code, Codex and Antigravity: a skill turned on here is linked into each agent's own skills folder when a chat starts. Library: <span class="mono">${esc(k.where)}</span></p>
    <div class="toolbar"><span class="grow"></span><button class="btn" data-act="sk-new">+ New skill</button></div>
    <div class="card list">${k.items.length ? k.items.map(s => `<div class="item skill"><input type="checkbox" class="switch" data-change="sk-toggle" data-arg="${esc(s.folder)}"${s.on ? ' checked' : ''} aria-label="${esc(s.name)} on or off"><div class="grow"><div style="font-weight:600">${esc(s.name)}</div><div class="muted" style="font-size:13px">${esc(s.description)}</div></div><button class="btn" data-act="sk-edit" data-arg="${esc(s.folder)}">Edit</button></div>`).join('') : '<div class="empty">No skills in the library yet.</div>'}</div>
    <div class="section-title">Found in the agents' own folders</div>
    <div class="card list">${k.found.length ? k.found.map(f => `<div class="item skill"><span class="badge mini ${esc(f.agent)}">${esc(AGENT[f.agent]?.letter ?? '·')}</span><div class="grow"><div style="font-weight:600">${esc(f.name)}</div><div class="muted mono">${esc(tilde(f.from))}</div></div><button class="btn" data-act="sk-import" data-arg="${esc(f.dir)}">Import</button></div>`).join('') : '<div class="empty">Nothing new to import.</div>'}</div></div>`;
}

/* ---------- the doctor (docs/doctor.md §6; looks and words: docs/mockups/desktop-doctor.html) ---------- */
// One doctor. The server's short check, pushed with the state (S.state.doctor), is the only status of the agents: the sidebar,
// the New chat cards, the Doctor button's dot, the first-launch screen and the Doctor page all read it through agentStatus, and
// the first-launch screen and the Doctor page draw the same rows (doctorRow). Startup, Run test, Check again, an install, a
// login, a detailed test and the window coming back to the front all end in a new check on the server, which every window gets.

const DR_STEPS = 7;
const DR_METHOD = { native: 'native installer', npm: 'npm', brew: 'Homebrew', other: 'installed by hand' };
/** What a failing detailed check means for the user (the failure banner). */
const DR_EFFECT = {
  envelope: "Chorus's note does not reach the agent, so it does not know where to save files for you or how to ask for approval",
  hello: "Chorus cannot read the agent's replies",
  shell: "Chorus cannot read the agent's commands and their output",
  transcript: `Chorus cannot find the transcript of an interactive chat, so its activity stays empty`,
  mcp: "the agent cannot reach Chorus's tools, so handoff and memory do not work",
  resume: 'a chat cannot be continued after Chorus restarts',
  approval: "Chorus cannot see the agent's permission prompts, so they do not reach Approvals",
};
const FR_TESTS = { envelope: "Starts a chat with Chorus's note", hello: "Reads the agent's replies", shell: 'Shows commands and their output', transcript: 'Saves chat history', mcp: 'Uses Chorus tools', resume: 'Resumes a chat', approval: 'Shows approval requests' };
const FR_IDS = Object.keys(FR_TESTS);
/** A login outside Chorus (in a terminal) shows when the window comes back to the front (recheckOnFocus); Check again stays for
 *  when it does not, or the window never lost focus. */
const LOGIN_HINT = 'Logged in from a terminal? It shows when you come back to Chorus, or Check again.';

/** The agents as the server's last short check saw them; null until the first one is done. */
const drAgents = () => S.state?.doctor?.agents ?? null;
const drChecking = () => !!S.state?.doctor?.checking;
const drAgent = agent => drAgents()?.find(a => a.agent === agent);

/** On a first launch the doctor screen opens at once and fills in when the check the server runs at start is done; after an
 *  update of Chorus or a CLI it opens with the result (docs/doctor.md §6.1). */
async function firstDoctor() {
  try {
    const { first } = await api('GET', '/api/doctor/first');
    if (first) (S.doctorWaits = true), doctorWhenReady();
    const d = await loadDoctor();
    // once per launch: a popup the user already closed stays closed when the details arrive late
    if ((first || d.due) && !S.doctorOpened) (S.doctorWaits = true), doctorWhenReady();
    else if ($('#doctor-pop')) drawDoctor();
    else renderDoctorDot();
  } catch {
    /* the app works without the doctor */
  }
}

/** First launch: the Welcome's choice (Community or Pro) comes first, then the Doctor (owner, 2026-11-09). While the plan is not
 *  known yet, or the Welcome or "Finish in your browser" is in front, or a Community first launch is about to show the Welcome,
 *  the Doctor waits; go() and the plan's status call this again. */
const welcomePending = () => (S.pro === undefined && !S.proFailed) || ['welcome', 'trying'].includes(S.view.name) || (community() && S.welcome === undefined && ['new', 'home'].includes(S.view.name));
function doctorWhenReady() {
  if (!S.doctorWaits || welcomePending()) return;
  S.doctorWaits = false;
  S.doctorOpened = true;
  openDoctorPopup();
}

/** What the Doctor shows besides the agents' status: Chorus's version, the latest releases, the detailed tests on file. */
async function loadDoctor() {
  S.doctor = await api('GET', '/api/doctor');
  return S.doctor;
}

/** Run test and Check again: a new short check on the server; its answer reaches every screen with the state. */
async function runShortTest() {
  S.doctor = await api('POST', '/api/doctor/check');
  S.docRan = true;
  drawDoctor();
}

/** The window came back (switched to, unhidden): the server checks again quietly, the statuses stay until the answer comes with
 *  the state. The server runs at most one every 10 s, so focus and visibility firing together cost one check. */
function recheckOnFocus() {
  if (document.visibilityState !== 'visible') return;
  waitSince = Date.now();
  api('POST', '/api/doctor/refresh').catch(() => {});
}
window.addEventListener('focus', recheckOnFocus);
document.addEventListener('visibilitychange', recheckOnFocus);

/** While an agent waits for the user (not installed, not logged in, a new version) and the window is visible, the server checks
 *  again every 30 s: a login on another screen shows even when Chorus never lost focus. It stops when all are Ready, the window is
 *  hidden, or after 10 min (the window coming back starts the 10 min again). */
const WAIT_EVERY = 30_000;
const WAIT_FOR = 10 * 60_000;
let waitSince = Date.now();
setInterval(() => {
  const waiting = (drAgents() ?? []).some(a => a.state !== 'ready');
  if (!waiting || document.visibilityState !== 'visible' || Date.now() - waitSince > WAIT_FOR) return;
  api('POST', '/api/doctor/refresh', { waiting: true }).catch(() => {});
}, WAIT_EVERY);

const drJob = (agent, action) => (S.docJobs[agent]?.action === action || (!action && S.docJobs[agent]) ? S.docJobs[agent] : null);
const drRunning = agent => !!S.docJobs[agent] && !S.docJobs[agent].done;
const drDeepRunning = () => Object.values(S.docJobs).find(j => j.action === 'deep' && !j.done);
const drFailed = a => {
  const j = drJob(a.agent, 'deep');
  return j && j.done && !j.ok ? j : null;
};
const drName = agent => drAgent(agent)?.name ?? AGENT[agent]?.name ?? agent;

/** One agent's status, the same on every screen: { kind, label, line, acts, busy }. `jobs` false leaves out the install, login
 *  and detailed test running from the Doctor (the sidebar and New chat say only what the agent is). */
function agentStatus(a, jobs = true) {
  const s = (kind, label, line = '', acts = [], busy = false) => ({ kind, label, line, acts, busy });
  const job = jobs ? S.docJobs[a?.agent] : null;
  const deep = jobs ? drJob(a?.agent, 'deep') : null;
  if (job && !job.done && job.action !== 'deep') return s('plain', job.action === 'login' ? 'Logging in…' : 'Installing…', '', [], true);
  if (!a?.state || drChecking()) return s('plain', 'Checking…', '', [], true);
  if (a.state === 'missing') {
    const line = a.install?.version ? 'Install the version Chorus is tested with, or add it later.' : `Installs its newest release (Chorus is tested with ${a.newestTested ?? 'other versions'}), or add it later.`;
    return s('warn', 'Not installed', line, [[`Install${a.install?.version ? ' ' + a.install.version : ''}`, 'doc-run', `${a.agent}:install`, true], ['Open page ↗', 'doc-open', a.agent]]);
  }
  if (a.state === 'needs-login') {
    // in a container Chorus runs the sign-in and the popup shows its link (signInPopup)
    if (job?.signIn && $('#signin-pop')) return s('plain', 'Signing in…', 'Finish in the sign-in page; the popup has the link.', [], true);
    if (job?.terminal) return s('warn', 'Not logged in', 'Log in in the Terminal window, then check again.', [['Check again', 'doc-recheck', a.agent, true]]);
    return s('warn', 'Not logged in', `Log in to use it here. ${LOGIN_HINT}`, [['Log in', 'doc-run', `${a.agent}:login`, true], ['Check again', 'doc-recheck', a.agent]]);
  }
  if (deep && !deep.done) return s('plain', `Detailed test · ${deep.results.length} of ${DR_STEPS}`, `Now: ${FR_TESTS[FR_IDS[deep.results.length]] ?? 'finishing'}`, [], true);
  if (deep?.done) {
    const rs = deep.report?.results ?? [];
    const pass = rs.filter(r => r.status === 'pass' || r.status === 'skip').length;
    if (pass === rs.length) return s('ok', `${pass} of ${rs.length} passed`, 'Works with Chorus.');
    const blocked = rs.find(r => r.status === 'blocked');
    if (blocked) return s('warn', `${pass} of ${rs.length} passed`, blocked.reason ?? 'Stopped: log in again, or the plan limit was reached.');
    if (a.testedInstall && a.version !== a.newestTested) return s('bad', `${pass} of ${rs.length} passed`, 'Install the version Chorus is tested with to fix it.', [[`Install ${a.newestTested}`, 'doc-run', `${a.agent}:tested`, true]]);
    return s('bad', `${pass} of ${rs.length} passed`, 'Chats still start; the failed part does not work yet.');
  }
  if (a.state === 'untested') return s('warn', 'New version', `Chorus is tested with ${a.newestTested ?? 'other versions'}; the detailed test checks that ${a.version} works too.`, jobs ? [['Run detailed test', 'doc-run', `${a.agent}:deep`]] : []);
  // in a container Chorus can't see whether agy is signed in: its Log in is always there
  const agyLogin = jobs && a.agent === 'agy' && S.state?.container ? [['Log in', 'doc-run', 'agy:login']] : [];
  return s('ok', 'Ready', a.login === 'yes' ? 'Logged in · a version Chorus is tested with.' : agyLogin.length ? 'A version Chorus is tested with. Chorus can\'t tell here whether it is signed in: Log in if a chat asks you to.' : 'A version Chorus is tested with.', agyLogin);
}

/* ---------- signing in from the page (Chorus in a container: docs/features/docker-box.md) ---------- */

/**
 * Chorus runs the CLI's sign-in and reads its link: open it in the tab opened on the click (a tab opened later is blocked as a
 * pop-up), and show the link again, Codex's one-time code, and a box for the code the sign-in page gives back.
 */
async function signInPopup(agent, j, tab) {
  $('#signin-pop')?.remove();
  const el = document.createElement('div');
  el.className = 'scrim';
  el.id = 'signin-pop';
  el.innerHTML = `<div class="dialog si-dialog" role="dialog" aria-label="Sign in to ${esc(drName(agent))}"><h2>Sign in to ${esc(drName(agent))}</h2><div class="body" id="si-body"><p class="muted"><span class="spin"></span> Getting the sign-in page…</p></div><div class="foot" id="si-foot"><button class="btn" data-act="si-close">Cancel</button></div></div>`;
  el.dataset.id = j.signIn;
  el.dataset.agent = agent;
  $('#dialogs').append(el);
  let opened = false;
  for (;;) {
    if (!el.isConnected) return tab?.close();
    const si = await api('GET', `/api/signin/${j.signIn}`).catch(err => ({ error: err.message }));
    if (!el.isConnected) return;
    if (si.error || si.state === 'failed') {
      tab?.close();
      $('#si-body').innerHTML = `<p>The sign-in stopped${si.error ? `: ${esc(si.error)}` : ''}.</p>${si.output ? `<pre class="si-out">${esc(si.output)}</pre>` : ''}<p class="muted">Or sign in from your computer's terminal:</p>${siCommand(j.hostCommand)}`;
      $('#si-foot').innerHTML = `<button class="btn" data-act="si-close">Close</button><button class="btn primary" data-act="doc-run" data-arg="${esc(agent)}:login">Try again</button>`;
      return;
    }
    if (si.state === 'done') {
      $('#si-body').innerHTML = `<p>✔ ${esc(drName(agent))} is signed in.</p>`;
      $('#si-foot').innerHTML = `<button class="btn primary" data-act="si-close" data-value="done">Done</button>`;
      return;
    }
    if (si.url && !opened) {
      opened = true;
      if (tab && !tab.closed) tab.location.href = si.url;
      else window.open(si.url, '_blank', 'noopener');
      drawSignIn(si, j);
    } else if (si.url && si.codeSent && !$('#si-body [data-sent]')) drawSignIn(si, j);
    await new Promise(r => setTimeout(r, 1000));
  }
}

const siCommand = cmd => (cmd ? `<div class="si-row"><code class="mono">${esc(cmd)}</code><button class="btn" data-act="doc-copy" data-arg="${esc(cmd)}">Copy</button></div>` : '');

function drawSignIn(si, j) {
  const link = `<p>The sign-in page opened in a new tab. Didn't open? <a href="${esc(si.url)}" target="_blank" rel="noopener">Open the sign-in page ↗</a></p>`;
  const code = si.userCode ? `<p>Enter this code there:</p><div class="si-row"><code class="mono si-code">${esc(si.userCode)}</code><button class="btn" data-act="doc-copy" data-arg="${esc(si.userCode)}">Copy</button></div><p class="muted">This window finishes by itself once you've entered it.</p>` : '';
  const back = si.codeBack && !si.codeSent ? `<p>${si.codeBack === 'required' ? 'After you approve, the page shows a code. Paste it here:' : 'If the page shows a code, paste it here:'}</p><div class="si-row"><input type="text" class="dlg-input" id="si-code" placeholder="Code from the sign-in page" autocomplete="off" spellcheck="false"><button class="btn primary" data-act="si-code">Sign in</button></div>` : '';
  const sent = si.codeSent ? `<p data-sent><span class="spin"></span> Code sent. Finishing the sign-in…</p>` : '';
  $('#si-body').innerHTML = link + code + back + sent + `<details class="si-more"><summary>Sign in from your computer's terminal instead</summary>${siCommand(j.hostCommand)}</details>`;
  // agy keeps running after it signs in, and what its page asks is not known yet: the user says when it's done
  $('#si-foot').innerHTML = `<button class="btn" data-act="si-close">Cancel</button>${si.agent === 'agy' ? '<button class="btn primary" data-act="si-close" data-value="done">I\'ve signed in</button>' : ''}`;
  $('#si-code')?.focus();
}

const agentPill = st => `<span class="badge ${st.kind}">${st.busy ? '<span class="spin"></span>' : st.kind === 'ok' ? '✔ ' : st.kind === 'warn' || st.kind === 'bad' ? '⚠ ' : ''}${esc(st.label)}</span>`;
/** The sidebar's mark: ✗ only when the agent cannot be used (not installed, not logged in, a failed test). */
const agentMark = (a, st) => (st.kind === 'plain' ? '…' : st.kind === 'bad' || a.state === 'missing' || a.state === 'needs-login' ? '✗' : '✓');

function drWhen(iso) {
  const d = new Date(iso);
  const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date().toDateString() ? `today ${t}` : `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}, ${t}`;
}

function drVersionLine(a) {
  const latest = S.doctor?.latest?.[a.agent];
  const suggested = a.newestTested;
  if (!suggested) return 'Chorus has no tested version of it yet';
  if (a.state === 'missing' && !a.install?.version) return `Installs its newest release · Chorus is tested up to <span class="mono">${esc(suggested)}</span> (${esc(a.agent)} cannot be pinned to a version)`;
  if (a.state === 'missing') return `Suggested <span class="mono">${esc(suggested)}</span> · the newest version Chorus is tested with`;
  const newer = latest && latest !== suggested ? ` · latest release <span class="mono">${esc(latest)}</span> <span class="faint">(not tested yet)</span>` : '';
  return a.version === suggested ? `Suggested <span class="mono">${esc(suggested)}</span> · up to date${newer}` : `Suggested <span class="mono">${esc(suggested)}</span> (tested)${newer}`;
}

function drChecks(list) {
  return list
    .map(([m, t, time = '', why]) => `<div class="dr-check"><span class="dr-m ${m}">${m === 'ok' ? '✔' : m === 'bad' ? '✖' : m === 'warn' ? '⚠' : m === 'run' ? '<span class="spin"></span>' : '○'}</span><span${m === 'wait' ? ' class="faint"' : ''}>${esc(t)}</span><span class="dr-time">${esc(time)}</span>${why ? `<span class="dr-why">${esc(why)}</span>` : ''}</div>`)
    .join('');
}

function drShort(a) {
  if (a.state === 'missing') return [['bad', 'Not found on PATH or in ~/.local/bin, /opt/homebrew/bin']];
  const out = [['ok', `Installed at ${tilde(a.bin)} (${DR_METHOD[a.method] ?? a.method})`]];
  if (a.coverage === 'tested') out.push(['ok', `Version ${a.version} is tested with Chorus`]);
  else if (a.coverage === 'same-minor') out.push(['ok', `Version ${a.version} is a patch of ${a.version.split('.').slice(0, 2).join('.')}, which Chorus is tested with`]);
  else out.push(['warn', a.version ? `Version ${a.version}: no ${a.version.split('.').slice(0, 2).join('.')} version is tested with Chorus yet (newest tested ${a.newestTested ?? 'none'})` : 'Version unknown']);
  if (a.login === 'yes') out.push(['ok', 'Logged in']);
  else if (a.login === 'no') out.push(['bad', 'Not logged in', '', a.agent === 'agy' ? 'agy logs in on its first start: run agy once in a terminal' : `${a.loginCommand.join(' ')} logs in`]);
  else out.push(['warn', 'Login could not be checked']);
  return out;
}

function cmpV(x, y) {
  const a = x.split(/[.-]/).map(Number);
  const b = y.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}

const DR_TITLES = ['The standing note reaches the model', 'A turn runs and is read: session id, reply, usage', 'A shell command and its output are read', "The CLI's own transcript is found and read", 'The per-session MCP server is reached', 'A chat resumes with its context', 'The permission prompt is recognised and approved'];
const drResult = r => [r.status === 'pass' ? 'ok' : r.status === 'fail' ? 'bad' : r.status === 'blocked' ? 'warn' : 'wait', r.title, `${(r.ms / 1000).toFixed(1)} s`, r.status === 'pass' ? '' : r.reason];

function drDetailed(a) {
  const job = drJob(a.agent, 'deep');
  if (job && !job.done) {
    const list = DR_TITLES.map((t, i) => (job.results[i] ? drResult(job.results[i]) : i === job.results.length ? ['run', t] : ['wait', t]));
    return ['running', list];
  }
  const r = job?.done ? { ...job.report, at: new Date().toISOString() } : S.doctor?.lastDeep?.[a.agent];
  if (!r?.results) return null;
  const pass = r.results.filter(x => x.status === 'pass').length;
  const head = `last run ${drWhen(r.at)} · ${pass} of ${r.results.length}${r.version && r.version !== a.version ? ` on ${r.version}` : ''}`;
  return [head, r.results.map(drResult)];
}

/** Each agent can be tested on its own, any time it is installed and logged in (about 2 min, a few short turns on its plan). */
const drTestButton = a =>
  frTestable(a) && !drRunning(a.agent) ? `<button class="btn dr-test1" data-act="doc-run" data-arg="${a.agent}:deep">${drJob(a.agent, 'deep') || S.doctor?.lastDeep?.[a.agent] ? 'Test again' : 'Run detailed test'}</button>` : '';

/** An agent's details behind "Show details": the short test's checks, the detailed test, the suggested version, the install. */
function drDetail(a) {
  const deep = drDetailed(a);
  return `<div class="dr-detail">
      <div class="dr-sub">${drVersionLine(a)}</div>
      <div class="dr-group"><h4>Short test <span>${esc(drChecking() ? 'running' : drWhenShort())}</span></h4>${drChecking() ? '' : drChecks(drShort(a))}</div>
      <div class="dr-group"><h4>Detailed test <span>${deep ? esc(deep[0]) : 'not run for this version'}</span>${drTestButton(a)}</h4>${deep ? drChecks(deep[1]) : '<div class="faint" style="font-size:13px">Chorus asks for it when a version is new to it.</div>'}</div>
      ${a.state !== 'missing' && a.testedInstall && a.version !== a.newestTested ? `<div class="dr-group"><h4>Suggested version</h4><div class="dr-cmd"><span>${esc(a.testedInstall)}</span><button class="btn" data-act="doc-run" data-arg="${a.agent}:tested">Install</button></div></div>` : ''}
      ${a.state === 'missing' && a.install ? `<div class="dr-group"><h4>Install</h4><div class="dr-cmd"><span>${esc(a.install.command)}</span><button class="btn" data-act="doc-copy" data-arg="${esc(a.install.command)}">Copy</button></div></div>` : ''}
    </div>`;
}

/** One agent on the first-launch screen and the Doctor page: its status, one line, its actions, the output of a running install
 *  or login, and its details. */
function doctorRow(a) {
  const st = agentStatus(a);
  const job = S.docJobs[a.agent];
  const deep = drJob(a.agent, 'deep');
  const open = S.docOpen.has(a.agent);
  const acts = st.acts.map(([label, act, arg, primary]) => `<button class="btn${primary ? ' primary' : ''}" data-act="${act}" data-arg="${esc(arg)}">${esc(label)}</button>`).join('');
  const bar = deep && !deep.done ? `<div class="fr-bar"><i style="width:${Math.round((deep.results.length / DR_STEPS) * 100)}%"></i></div>` : '';
  const busy = job && !job.done && job.action !== 'deep';
  const out = busy || (job?.done && !job.ok && job.action !== 'deep' && job.output) ? `<pre class="record dr-out">${esc((job.output || 'Starting…').slice(-1500))}</pre>` : '';
  const more = a.state ? `<button class="fr-more" data-act="doc-toggle" data-arg="${a.agent}" aria-expanded="${open}">${open ? '▾ Hide' : '▸ Show'} details</button>${open ? drDetail(a) : ''}` : '';
  return `<div class="fr-row${st.kind === 'warn' || st.kind === 'bad' ? ' warn' : ''}"><span class="badge mini ${a.agent}">${AGENT[a.agent].letter}</span>
    <span class="fr-name"><b>${esc(a.name)}</b>${a.version ? `<span class="mono muted">${esc(a.version)}</span>` : ''}</span>${agentPill(st)}
    ${st.line || acts ? `<div class="fr-line"><span>${esc(st.line)}</span>${acts}</div>` : ''}${bar}${out}${more}</div>`;
}

/** The rows of every agent; before the first check is done, each one is "Checking…". */
const doctorRows = () => `<div class="fr-rows">${(drAgents() ?? Object.keys(AGENT).map(agent => ({ agent, name: AGENT[agent].name }))).map(doctorRow).join('')}</div>`;

function drWhenShort() {
  const d = S.state?.doctor;
  if (!d?.at) return '';
  const fresh = Date.now() - new Date(d.at).getTime() < 60_000;
  return fresh ? `just now · ${(d.ms / 1000).toFixed(1)} s` : drWhen(d.at);
}

/** The one banner that matters most now: a failed detailed test, a version that needs one, agents that need the user, all fine. */
function drBanner() {
  const agents = drAgents();
  if (!agents || drChecking() || drDeepRunning()) return '';
  const failed = agents.map(a => [a, drFailed(a)]).find(([a, j]) => j && !S.docKept.has(a.agent));
  if (failed) {
    const [a, j] = failed;
    const fails = j.report.results.filter(r => r.status === 'fail');
    const effect = fails.map(f => DR_EFFECT[f.id] ?? f.title).join('; ');
    const fix = a.testedInstall && a.version !== a.newestTested ? ` ${a.name} ${a.newestTested} is tested and works. Installing it is optional.` : '';
    const acts = [a.testedInstall && a.version !== a.newestTested ? `<button class="btn primary" data-act="doc-run" data-arg="${a.agent}:tested">Install ${esc(a.name)} ${esc(a.newestTested)}</button>` : '', `<button class="btn" data-act="doc-keep" data-arg="${a.agent}">Keep ${esc(a.version)}</button>`, `<button class="btn" data-act="doc-report">Report issue</button>`].join('');
    return drBannerHtml('bad', `${a.name} ${a.version}: ${fails.length} of ${j.report.results.length} checks failed.`, `Chats still start; this part does not work: ${effect}.${fix}`, acts);
  }
  const fresh = agents.find(a => a.state === 'untested' && !S.docNotNow.has(a.agent) && !drJob(a.agent, 'deep'));
  if (fresh) {
    const text = `Chorus is tested with ${fresh.newestTested && fresh.version && cmpV(fresh.version, fresh.newestTested) < 0 ? `newer versions of ${fresh.name} (up to ${fresh.newestTested})` : `${fresh.name} up to ${fresh.newestTested ?? 'no version yet'}`}. A detailed test checks that ${fresh.version} works with Chorus: about 2 minutes and a few short model turns on your ${fresh.name} plan.`;
    return drBannerHtml('warn', `${fresh.name} ${fresh.version} is new to Chorus.`, text, `<button class="btn primary" data-act="doc-run" data-arg="${fresh.agent}:deep">Run detailed test</button><button class="btn" data-act="doc-notnow" data-arg="${fresh.agent}">Not now</button>`);
  }
  const need = agents.filter(a => a.state === 'missing' || a.state === 'needs-login').length;
  if (need) return drBannerHtml('warn', `${need} agent${need > 1 ? 's' : ''} need${need > 1 ? '' : 's'} you.`, 'Chorus works with any one of them; each one more is another agent to hand work to.');
  if (S.docRan && agents.every(a => a.state === 'ready')) return drBannerHtml('ok', `All ${agents.length} agents work with Chorus.`, 'Each one is on a version Chorus is tested with, and logged in.');
  return '';
}
const drBannerHtml = (kind, t, text, acts = '') => `<div class="dr-banner ${kind}"><div class="grow"><div class="dr-bt">${esc(t)}</div><div class="muted" style="font-size:13px">${esc(text)}</div></div>${acts ? `<div class="dr-bacts">${acts}</div>` : ''}</div>`;

function drRunLine() {
  const d = S.state?.doctor;
  const deep = drDeepRunning();
  const busy = drChecking() || !!deep;
  let when = '';
  if (drChecking()) when = `Checking ${Object.keys(AGENT).length} agents · no model calls`;
  else if (deep) when = `Detailed test of ${drName(deep.agent)} · ${deep.results.length} of ${DR_STEPS} · you can keep working`;
  else if (d?.at) {
    const done = Object.values(S.docJobs).filter(j => j.action === 'deep' && j.done).at(-1);
    const need = d.agents.filter(a => a.state !== 'ready').length;
    if (done && !S.docRan) when = `Detailed test of ${drName(done.agent)} finished · ${done.ok ? 'all passed' : `${done.report.results.filter(r => r.status === 'fail').length} problem`}`;
    else if (Date.now() - new Date(d.at).getTime() < 60_000) when = `Tested just now · ${(d.ms / 1000).toFixed(1)} s`;
    else when = `Last test: ${drWhen(d.at)} · ${need ? `${need} need${need > 1 ? '' : 's'} you` : 'all ready'}`;
  }
  return `<div class="dr-run"><button class="btn primary dr-big" data-act="doc-test"${busy ? ' disabled' : ''}>${busy ? '<span class="spin"></span> Testing…' : '▶ Run test'}</button><span class="dr-when">${esc(when)}</span><span class="grow"></span><button class="btn" data-act="doc-report" title="Send a report to the Chorus issues on GitHub; no test needed">Report issue</button></div>`;
}

/** Which Chorus this is: its version, the core's, how it was installed, and a newer release when the launch check found one. */
function drAppLine() {
  const c = S.doctor?.chorus;
  if (!c) return '';
  const update = S.state?.update;
  return `<div class="dr-app"><b>${esc(c.app.replace(/^chorus/, 'Chorus'))}</b><span class="muted">core ${esc(c.core)} · ${esc(c.install)}</span>${update ? `<button class="btn" data-act="update-open">Chorus ${esc(update.version)} is available</button>` : ''}</div>`;
}

function doctorHtml() {
  return `<div class="page"><h1 class="ph-hide">Doctor</h1><p class="lead">Your AI coding CLIs: are they installed, on a version Chorus is tested with, and logged in.</p>
    ${drAppLine()}${drRunLine()}${drBanner()}${doctorRows()}</div>`;
}

/* The first-launch doctor screen (docs/mockups/desktop-first-run.html): the short check, then the choice between the app (the
   default) and the detailed test of every agent that is installed and logged in, then how many tests each one passed. Its rows
   are the Doctor page's (doctorRow); the user goes on with what works. */
function openDoctorPopup() {
  S.fr = { phase: 'short' };
  if ($('#doctor-pop')) return drawDoctor();
  const el = document.createElement('div');
  el.className = 'scrim';
  el.id = 'doctor-pop';
  el.innerHTML = `<div class="dialog dr-dialog fr" role="dialog"><h2 id="fr-title"></h2><p class="fr-lead" id="fr-lead"></p><div class="fr-steps" id="fr-steps"></div><div class="body" id="dr-pop-body"></div><div class="foot" id="fr-foot"></div></div>`;
  $('#dialogs').append(el);
  drawDoctor();
}

/** Installed and logged in (or login unknown): the detailed test can run for it. */
const frTestable = a => a.state !== 'missing' && a.state !== 'needs-login';

function drawFirstRun() {
  const agents = drAgents();
  const fr = S.fr;
  const deepJobs = (agents ?? []).map(a => drJob(a.agent, 'deep')).filter(Boolean);
  if (fr.phase === 'deep' && deepJobs.length && deepJobs.every(j => j.done)) fr.phase = 'done';
  const phase = !agents ? 'check' : fr.phase;
  const testable = (agents ?? []).filter(frTestable);
  const ready = (agents ?? []).filter(a => a.state === 'ready' || a.state === 'untested');
  const [title, lead] = {
    check: ['Checking your agents', 'Chorus looks for Claude Code, Codex and Antigravity on this computer. No model calls, a few seconds.'],
    short: ['Your agents', `${ready.length} of ${agents?.length} ready to use. You can fix the rest now or later from Doctor.`],
    deep: ['Testing your agents', 'Each agent runs the same tests in a temporary folder. Your projects are not touched.'],
    done: ['Test results', 'You can start now with what works, and fix the rest any time from Doctor.'],
  }[phase];
  $('#fr-title').innerHTML = `${esc(title)}${S.doctor?.chorus ? `<span class="fr-ver">${esc(S.doctor.chorus.app.replace(/^chorus/, 'Chorus'))} · core ${esc(S.doctor.chorus.core)}</span>` : ''}`;
  $('#fr-lead').textContent = lead;
  const step = { check: 0, short: 0, deep: 1, done: 2 }[phase];
  $('#fr-steps').innerHTML = ['Short check', 'Detailed test', 'Ready'].map((t, i) => `<span class="${i < step || (phase === 'short' && i === 0) ? 'done' : i === step ? 'on' : ''}">${i < step || (phase === 'short' && i === 0) ? '✔ ' : ''}${t}</span>`).join('');
  $('#dr-pop-body').innerHTML = doctorRows();
  const left = deepJobs.filter(j => !j.done).length;
  $('#fr-foot').innerHTML = {
    check: `<span class="grow faint">Checking…</span><button class="btn" disabled>Continue</button>`,
    short: `<span class="grow faint">${testable.length ? `Detailed test: about 2 min per agent, a few short turns on your plans. Also in Doctor.` : 'Install or log in to an agent to use Chorus.'}</span>${testable.length ? '<button class="btn" data-act="fr-deep">Run detailed test</button>' : ''}<button class="btn primary" data-act="doc-continue">Skip, start using Chorus</button>`,
    deep: `<span class="grow faint">${left} running · the results also go to Doctor</span><button class="btn primary" data-act="doc-continue">Continue to the app</button>`,
    done: `<span class="grow"></span><button class="btn" data-act="doc-report">Report issue</button><button class="btn primary" data-act="doc-continue">Start using Chorus</button>`,
  }[phase];
}

/** Redraws every screen that shows the doctor: the first-launch screen, the Doctor page and the Doctor button's dot. */
function drawDoctor() {
  if ($('#doctor-pop') && S.fr) drawFirstRun();
  if (S.view.name === 'doctor') renderView();
  renderDoctorDot();
}

/** The Doctor button's dot: red on a problem, amber while testing or when an agent needs the user, green when all are ready. */
function renderDoctorDot() {
  const btn = document.querySelector('.side-foot button[data-act="doctor"]');
  const agents = drAgents();
  if (!btn || !agents) return;
  const st = agents.map(a => agentStatus(a));
  const bad = st.some(s => s.kind === 'bad');
  const warn = Object.values(S.docJobs).some(j => !j.done) || agents.some(a => a.state !== 'ready');
  btn.innerHTML = `<span class="dr-dot ${bad ? 'bad' : warn ? 'warn' : 'ok'}"></span>Doctor`;
}

function closeDoctorPopup() {
  clearTimeout(S.docAutoClose);
  $('#doctor-pop')?.remove();
  void api('POST', '/api/doctor/seen').catch(() => {});
}

/** Follows an install, login or detailed test for its output; the server checks the agents again before the job ends, so its
 *  result is already on every screen when it is done. */
async function pollDoctorJob(agent, id) {
  const j = await api('GET', `/api/doctor/${id}`).catch(() => null);
  if (!j) return;
  S.docJobs[agent] = j;
  if (j.done) {
    if (j.ok && j.action !== 'deep') delete S.docJobs[agent];
    toast(`${drName(agent)}: ${j.action === 'deep' ? (j.ok ? 'works with Chorus' : 'a check did not pass') : j.ok ? 'done' : 'the command failed'}`);
  }
  drawDoctor();
  if (!j.done) setTimeout(() => pollDoctorJob(agent, id), 1000);
}

/** Report issue (the Doctor page, the failed-test banner, the first-launch screen): works without a test run. The server adds a
 *  fresh short check, the detailed tests on file and what the app can tell; the user picks the kind, says what happened, and
 *  reads and edits everything before it is sent. Every report is filed as a user report with the lowest priority. */
async function reportIssue() {
  if ($('#doc-report-pop')) return;
  const el = document.createElement('div');
  el.className = 'scrim';
  el.id = 'doc-report-pop';
  el.innerHTML = `<div class="dialog dr-dialog" role="dialog"><h2>Report an issue</h2><div class="body"><p class="muted"><span class="spin"></span> Collecting what Chorus knows about this machine…</p></div></div>`;
  $('#dialogs').append(el);
  const client = {
    window: NATIVE ? 'native' : 'browser',
    agent: navigator.userAgent,
    screen: `${screen.width}×${screen.height}@${devicePixelRatio}`,
    size: `${innerWidth}×${innerHeight}`,
    language: navigator.language,
    view: S.view.name,
  };
  const r = await api('POST', '/api/doctor/issue', { client, errors: pageErrors }).catch(err => ({ error: err.message }));
  if (r.error) {
    el.remove();
    return toast(`Could not build the report: ${r.error}`);
  }
  const kinds = r.kinds.map(k => `<option value="${esc(k.id)}"${k.id === r.kind ? ' selected' : ''}>${esc(k.name)}</option>`).join('');
  el.querySelector('.dialog').innerHTML = `<h2>Report an issue</h2><div class="body">
      <p class="muted">This goes to github.com/chauvoluuhuong/chorus/issues. Emails, account ids, keys and your home path are taken out; read it and edit what you like before sending.</p>
      <label class="dr-label">Type<select class="dlg-input" id="doc-issue-kind">${kinds}</select></label>
      <label class="dr-label">Title<input type="text" class="dlg-input" id="doc-issue-title" value="${esc(r.title)}" placeholder="In a few words: what went wrong or what you need"></label>
      <label class="dr-label">What happened<textarea class="dr-issue short" id="doc-issue-what" placeholder="What you did, what you expected, what you saw instead"></textarea></label>
      <details class="dr-attach"><summary>Attached: the doctor's report and this machine (${r.details.split('\n').length} lines)</summary><textarea class="dr-issue" id="doc-issue-body" spellcheck="false">${esc(r.details)}</textarea></details>
    </div><div class="foot"><span class="grow faint">Filed as a user report</span><button class="btn" data-act="doc-issue-cancel">Cancel</button><button class="btn primary" data-act="doc-send">${S.doctor?.gh ? 'Create issue' : 'Open on GitHub'}</button></div>`;
  $('#doc-issue-title').focus();
}

/* ---------- a chat ---------- */

function renderChat() {
  const id = S.view.id;
  $('#view').innerHTML = `<div class="chat"><div class="chat-head" id="chat-head"></div>${proSlot('chat-actions', ` data-chat="${esc(id)}"`)}<div id="chat-banners"></div><div class="chat-tabs" id="chat-tabs" hidden></div>
    <div class="chat-body tab-chat" id="chat-body"><div class="term-wrap" id="term-slot"><div class="term-over" id="term-over" hidden></div></div><div class="drawer-scrim" data-act="drawer-close"></div><aside class="drawer" id="drawer" hidden></aside>${proSlot('chat-side', ` data-chat="${esc(id)}"`)}</div></div>`;
  $('#term-slot').prepend(termEl);
  fillSlots();
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

/** A phone's ⋯ for the chat in front: its details, and what the header holds on wider screens. */
function drawSheet() {
  $('#sheet')?.remove();
  const c = S.sheet === 'chat' && S.view.name === 'chat' ? S.state?.chats.find(x => x.id === S.view.id) : null;
  if (!c) return void (S.sheet = null);
  const el = document.createElement('div');
  el.id = 'sheet';
  el.className = 'sheet-wrap';
  el.innerHTML = `<div class="sheet" role="dialog" aria-label="This chat"><div class="grab"></div>
    <div class="sh-meta"><div><span class="badge ${esc(c.agent)}">${esc(AGENT[c.agent]?.name ?? c.agent)}</span> ${[c.model, c.effort].filter(Boolean).map(esc).join(' · ')}${c.skip ? ' <span class="badge warn">skip</span>' : ''}</div><div class="mono path">${esc(tilde(c.cwd))}</div>${meter(c.usage)}</div>
    <button data-act="handoff" data-arg="${esc(c.id)}"><span class="i">⇄</span>Hand off to another agent</button>
    <button data-act="drawer-to" data-arg="artifacts"><span class="i">▤</span>Artifacts${c.artifacts ? ` <span class="badge plain">${c.artifacts}</span>` : ''}</button>
    <button data-act="drawer-to" data-arg="activity"><span class="i">≋</span>Activity</button>
    <button data-act="drawer-to" data-arg="record"><span class="i">◫</span>Record</button>
    <button class="danger" data-act="delete" data-arg="${esc(c.id)}"><span class="i">🗑</span>Delete this chat</button></div>`;
  document.body.append(el);
}

function renderChatParts() {
  const c = S.state?.chats.find(x => x.id === S.view.id);
  const head = $('#chat-head');
  if (!c || !head) return;
  const d = S.detail[c.id];
  // the labels go on a tablet (icons stay, with the meter) and the buttons go into the ⋯ sheet on a phone
  head.innerHTML = `<span class="badge ${esc(c.agent)}">${esc(AGENT[c.agent]?.name ?? c.agent)}</span>
    <div class="meta"><span class="dot ${esc(c.state)}"></span><span>${esc(STATE_LABEL[c.state] ?? c.state)}</span>
      ${c.model || c.effort ? `<span class="model">· ${[c.model, c.effort].filter(Boolean).map(esc).join(' · ')}</span>` : ''}${c.skip ? '<span class="badge warn" title="started without permission prompts">skip</span>' : ''}${meter(c.usage)}
      <span class="mono faint path" title="${esc(c.cwd)}">‎${esc(tilde(c.cwd))}‎</span>${c.toast ? `<span class="badge ok">${esc(c.toast)}</span>` : ''}</div>
    <button class="btn" data-act="handoff" data-arg="${esc(c.id)}" title="Continue this chat with another agent" aria-label="Hand off">${S.size === 'desktop' ? '⇄ Hand off' : '⇄'}</button>
    <button class="btn${S.drawer === 'artifacts' ? ' on' : ''}" data-act="drawer" data-arg="artifacts" title="Artifacts" aria-label="Artifacts"><span class="ic-only">▤</span><span class="lbl">Artifacts</span>${c.artifacts ? ` <span class="badge plain">${c.artifacts}</span>` : ''}</button>
    <button class="btn${S.drawer === 'activity' ? ' on' : ''}" data-act="drawer" data-arg="activity" title="Activity" aria-label="Activity"><span class="ic-only">≋</span><span class="lbl">Activity</span></button>
    <button class="btn${S.drawer === 'record' ? ' on' : ''}" data-act="drawer" data-arg="record" title="Record" aria-label="Record"><span class="ic-only">◫</span><span class="lbl">Record</span></button>
    <button class="icon-btn" data-act="delete" data-arg="${esc(c.id)}" title="Delete this chat" aria-label="Delete this chat">🗑</button>`;
  // a phone: a task chat's panel is tabs beside the chat (Chat · Steps · Plan), one shown at a time
  const tabs = S.size === 'phone' ? window.choruspro?.sideTabs?.(c.id) : null;
  if (!tabs) S.chatTab = 'chat';
  const tabsEl = $('#chat-tabs');
  tabsEl.hidden = !tabs;
  tabsEl.innerHTML = tabs ? `<div class="seg" role="tablist">${[['chat', 'Chat'], ...tabs].map(([k, label]) => `<button class="${S.chatTab === k ? 'on' : ''}" data-act="chat-tab" data-arg="${esc(k)}" role="tab" aria-selected="${S.chatTab === k}">${esc(label)}</button>`).join('')}</div>` : '';
  $('#chat-body').className = `chat-body tab-${S.chatTab}`;
  const side = $('#view [data-pro-slot="chat-side"]');
  if (side) side.dataset.tab = S.size === 'phone' && S.chatTab !== 'chat' ? S.chatTab : '';
  fillSlots();
  let banners = '';
  for (const ask of S.state.approvals.filter(a => a.id === c.id)) {
    if (ask.kind === 'ask') banners += `<div class="banner ask card"><b>${esc(AGENT[c.agent]?.name ?? c.agent)} asks you</b><div class="ask-body">${askCard(ask)}</div></div>`;
    else banners += `<div class="banner ask"><b>${esc(AGENT[c.agent]?.name ?? c.agent)} asks</b><span class="what" title="${esc(ask.what)}">${esc(ask.what)}</span><button class="btn good" data-act="approve" data-arg="${esc(c.id)}">✓ Approve</button><button class="btn danger" data-act="deny" data-arg="${esc(c.id)}">✕ Deny</button></div>`;
  }
  if (d?.fromRecord) banners += `<div class="banner info"><span>${esc(d.fromRecord)} no longer had this chat's session, so Chorus continues it from its own record.</span></div>`;
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
  const NAMES = { artifacts: 'Artifacts', activity: 'Activity', record: 'Record' };
  // a phone: a bottom sheet with a grabber, and the three drawers as tabs in its head
  const seg = `<span class="seg drawer-seg">${Object.entries(NAMES).map(([k, n]) => `<button class="${S.drawer === k ? 'on' : ''}" data-act="drawer-to" data-arg="${k}">${n}</button>`).join('')}</span>`;
  const head = `<div class="grab"></div><div class="drawer-head"><span class="grow title">${NAMES[S.drawer]}</span>${seg}<button class="icon-btn" data-act="drawer" data-arg="${S.drawer}" title="Close" aria-label="Close">✕</button></div>`;
  if (!dd || dd.id !== c.id || dd.kind !== S.drawer) return head + '<div class="drawer-body"><div class="empty">Loading…</div></div>';
  const x = dd.data;
  if (S.drawer === 'artifacts') {
    const items = x.items.length
      ? x.items.map(a => `<div class="art"><div class="name">${esc(a.path)}</div><div class="faint" style="font-size:12px">v${a.versions.length} · ${esc(a.ago)}</div><div class="acts"><button class="btn primary" data-act="art-open" data-arg="${esc(a.path)}">Open</button><button class="btn" data-act="art-folder" data-arg="${esc(a.path)}">Show in folder</button><button class="btn" data-act="copy" data-arg="${esc(a.abs)}">Copy path</button></div></div>`).join('')
      : '<div class="empty">No artifacts yet. Files the agent writes into this chat\'s artifacts folder show up here and open in the browser, reloading while the agent edits them.</div>';
    const files = x.files.length ? `<div class="section-title" style="margin:16px 16px 6px">Files written by tools</div><div class="calls" style="padding:0 16px 16px">${x.files.map(f => `<div>${esc(tilde(f))}</div>`).join('')}</div>` : '';
    return head + `<div class="drawer-body"><div class="mono faint" style="padding:10px 16px;border-bottom:1px solid var(--line);overflow-wrap:anywhere">${esc(tilde(x.folder))}/</div>${items}${files}</div>`;
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


/* ---------- app updates: state comes from the single launch check. A button in the top bar opens this popover ---------- */
function renderUpdate(update) {
  const box = $('#app-update');
  if (!update) box.hidden = true;
  if (box.dataset.version === (update?.version ?? '')) return;
  box.dataset.version = update?.version ?? '';
  if (!update) { box.replaceChildren(); return; }
  box.innerHTML = `<div><strong>Chorus ${esc(update.version)} is available</strong><p>You have ${esc(update.currentVersion)}. Use the official installer to update Chorus, then restart the app.</p></div><div class="app-update-actions"><button class="btn" data-act="update-skip">Skip this version</button><button class="btn primary" data-act="update-open">Update Chorus</button></div>`;
}
function closeUpdate() {
  $('#app-update').hidden = true; renderChrome();
}

/* ---------- notifications: all reads are local, with no fetch-again or timer path ---------- */
function closeNews() {
  $('#news').hidden = true; S.newsDetail = null; renderChrome();
  document.querySelector('[data-act="news-toggle"]')?.focus();
}
async function loadNews() {
  S.news = await api('GET', '/api/notifications');
  if (!$('#news').hidden && !S.newsDetail) renderNews();
}
function renderNews() {
  const n = S.news;
  const status = n?.checking ? 'Checking at app startup…' : n?.offline ? 'Saved messages · check again next launch' : 'Checked when Chorus starts';
  $('#news').innerHTML = `<div class="news-head"><h2>From Chorus</h2><button class="icon-btn" data-act="news-close" aria-label="Close notifications">×</button></div>
    ${n?.items?.length ? n.items.map(item => `<button class="news-row${item.read ? '' : ' unread'}" data-act="news-open" data-arg="${esc(item.id)}"><strong>${item.read ? '' : '<span class="dot"></span>'}${esc(item.title)}</strong><small>${esc(new Date(item.publishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</small></button>`).join('') : `<div class="news-empty">${n?.checking ? 'Checking for announcements…' : 'No announcements yet.'}</div>`}
    <div class="news-footer"><span>${esc(status)}</span>${n?.unread ? '<button class="news-link" data-act="news-read-all">Mark all as read</button>' : ''}</div>
    <div class="news-footer"><span>Installation and notification-open counts</span><button class="news-link" data-act="news-privacy">Privacy</button></div>`;
}
async function openNews(id) {
  const response = await api('POST', `/api/notifications/${encodeURIComponent(id)}/open`, {}).catch(() => null);
  if (!response?.item) { toast('This message is no longer available'); return loadNews(); }
  if ($('#news').hidden) return;
  S.newsDetail = response.item; S.news = response.inbox;
  const box = $('#news'); box.replaceChildren();
  const head = document.createElement('div'); head.className = 'news-head';
  const heading = document.createElement('h2'); heading.textContent = 'From Chorus';
  const close = document.createElement('button'); close.className = 'icon-btn'; close.dataset.act = 'news-close'; close.setAttribute('aria-label', 'Close notifications'); close.textContent = '×'; head.append(heading, close);
  const backRow = document.createElement('div'); backRow.className = 'news-detail-head';
  const back = document.createElement('button'); back.className = 'news-link'; back.dataset.act = 'news-back'; back.textContent = '← All notifications'; backRow.append(back);
  const frame = document.createElement('iframe'); frame.className = 'news-content'; frame.title = response.item.title; frame.id = 'news-frame'; frame.referrerPolicy = 'no-referrer';
  // Opaque origin; only our nonce-authorized link forwarder can run. Publisher scripts and native APIs remain inaccessible.
  frame.setAttribute('sandbox', 'allow-scripts');
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const bridge = `document.addEventListener('click',function(e){const a=e.target.closest('a[href]');if(!a)return;e.preventDefault();if(e.isTrusted)parent.postMessage({type:'chorus-news-link',url:a.href},'*')})`;
  frame.srcdoc = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src https://storage.googleapis.com; base-uri 'none'; form-action 'none'"><style>:root{color-scheme:light dark}body{margin:0;background:light-dark(#fff,#2c2b29);color:light-dark(#141413,#f5f4ee);font:14px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}*{box-sizing:border-box}img{max-width:100%;height:auto}</style><script nonce="${nonce}">${bridge}</script>${response.item.html}`;
  box.append(head, backRow, frame);
}
window.addEventListener('message', event => {
  const frame = $('#news-frame');
  if (!frame || event.source !== frame.contentWindow || event.data?.type !== 'chorus-news-link' || typeof event.data.url !== 'string' || !S.newsDetail) return;
  void api('POST', '/api/notifications/link', { id: S.newsDetail.id, url: event.data.url }).then(r => r.error && toast(r.error));
});
document.addEventListener('click', event => { if (!$('#news').hidden && !event.target.closest('#news, [data-act="news-toggle"]')) closeNews(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#news').hidden) { event.preventDefault(); event.stopImmediatePropagation(); closeNews(); } }, true);

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
/* ---------- input ---------- */

/** Esc on a dialog, or a tap on the dim area around a phone's sheet: cancel it the way its own Cancel does. */
function dismissDialog(dlg, tap = false) {
  if (dlg.dataset.dialog) return void api('POST', `/api/dialogs/${dlg.dataset.dialog}`, { value: null }).then(() => dlg.remove());
  dlg.querySelector(`[data-x="cancel"], [data-act="br-cancel"]${tap ? ', [data-act="doc-issue-cancel"]' : ''}`)?.click();
}

document.addEventListener('click', async e => {
  // a phone's picker menu is a sheet: its dim area (the wrapper's ::before) closes it too
  if (S.ncMenu && (!e.target.closest('.nc-pk-wrap') || e.target.classList.contains('nc-pk-wrap'))) {
    S.ncMenu = null;
    if (!e.target.closest('[data-act]') || e.target.classList.contains('nc-pk-wrap')) return renderView();
  }
  // the ⋯ sheet: a tap on the dim area closes it, a row does its action and closes it
  if (e.target.id === 'sheet') {
    S.sheet = null;
    return drawSheet();
  }
  if (e.target.closest('#sheet [data-act]')) {
    S.sheet = null;
    drawSheet();
  }
  if (S.size === 'phone' && e.target.classList?.contains('scrim') && e.target.closest('#dialogs')) return dismissDialog(e.target, true);
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const arg = el.dataset.arg;
  if (el.tagName === 'A') e.preventDefault();
  switch (act) {
    case 'new':
      return go({ name: 'new' });
    case 'tab':
      // a place of the tab bar starts its own history: ‹ Back leads up to it, not across tabs
      S.history = [];
      return go({ name: arg }, false);
    case 'cl-filter':
      S.cl.filter = arg || 'all';
      S.cl.focus = false;
      if (S.view.name === 'chats') return renderView();
      S.history = [];
      return go({ name: 'chats' }, false);
    case 'cl-proj':
      S.cl.proj = arg;
      return renderView();
    case 'proj-open':
      // a project on Home: its Portal with the module, else its chats
      if (window.choruspro) return go({ name: 'pro', id: `portal~${encodeURIComponent(arg)}` });
      S.cl = { ...S.cl, proj: arg, filter: 'all', q: '' };
      S.history = [];
      return go({ name: 'chats' }, false);
    case 'chat-menu':
      S.sheet = 'chat';
      return drawSheet();
    case 'chat-tab':
      S.chatTab = arg;
      renderChatParts();
      return setTimeout(refit, 30);
    case 'menu-close':
      $('#app').classList.remove('side-open');
      return renderChrome();
    case 'new-in':
      return go({ name: 'new', folder: arg });
    case 'approvals':
    case 'memory':
    case 'skills':
    case 'doctor':
      return go({ name: act });
    case 'chat':
      return go({ name: 'chat', id: arg });
    case 'plan-welcome':
      return go({ name: 'welcome' });
    case 'plan-community':
      remember('welcome', 'community');
      S.welcome = 'community';
      return go(startView());
    case 'plan-try': {
      const r = await api('POST', '/api/pro/try').catch(err => ({ error: err.message }));
      if (r.error) return toast(r.error);
      return go({ name: 'trying' });
    }
    case 'plan-upgrade':
    case 'plan-buy':
      return upgrade();
    case 'plan-recheck':
      return recheck();
    case 'plan-later':
      S.bannerDay = new Date().toDateString();
      remember('banner', S.bannerDay);
      return drawPlanBanner();
    case 'unlock':
      return go({ name: 'unlock' });
    case 'pro-view':
      return go({ name: 'pro', id: arg });
    case 'pro-unlock':
      return void api('POST', '/api/pro/activate', { key: $('#pro-key').value.trim() }).then(onProStatus, e => toast(String(e.message)));
    case 'doc-continue':
      return closeDoctorPopup();
    case 'doc-test':
      return void runShortTest();
    case 'doc-recheck':
      delete S.docJobs[arg];
      return void runShortTest();
    case 'fr-deep': {
      S.fr.phase = 'deep';
      for (const a of (drAgents() ?? []).filter(frTestable)) {
        const j = await api('POST', '/api/doctor/run', { agent: a.agent, action: 'deep' }).catch(err => ({ error: err.message }));
        if (j.error) { toast(j.error); continue; }
        S.docJobs[a.agent] = j;
        void pollDoctorJob(a.agent, j.id);
      }
      return drawDoctor();
    }
    case 'doc-toggle':
      S.docOpen.has(arg) ? S.docOpen.delete(arg) : S.docOpen.add(arg);
      return drawDoctor();
    case 'doc-open':
      return void api('POST', '/api/doctor/open', { agent: arg });
    case 'si-code': {
      const pop = $('#signin-pop');
      const code = $('#si-code')?.value ?? '';
      const r = await api('POST', `/api/signin/${pop.dataset.id}/code`, { code }).catch(err => ({ error: err.message }));
      return r.error ? toast(r.error) : undefined;
    }
    case 'si-close': {
      const pop = $('#signin-pop');
      if (!pop) return;
      pop.remove();
      delete S.docJobs[pop.dataset.agent];
      await api('POST', `/api/signin/${pop.dataset.id}/close`, { done: el.dataset.value === 'done' }).catch(() => {});
      return drawDoctor();
    }
    case 'doc-copy':
      return void navigator.clipboard.writeText(arg).then(() => toast('Copied'));
    case 'doc-notnow':
      S.docNotNow.add(arg);
      return drawDoctor();
    case 'doc-keep':
      S.docKept.add(arg);
      return drawDoctor();
    case 'doc-run': {
      const [agent, action] = arg.split(':');
      // in a container the sign-in page opens in a new tab: opened now, on the click, or the browser blocks it as a pop-up
      const tab = action === 'login' && S.state?.container ? window.open('about:blank', '_blank') : null;
      const j = await api('POST', '/api/doctor/run', { agent, action }).catch(err => (toast(err.message), null));
      if (!j || j.error) return tab?.close(), j?.error && toast(j.error);
      if (j.signIn) {
        S.docJobs[agent] = j;
        void signInPopup(agent, j, tab);
        return drawDoctor();
      }
      S.docJobs[agent] = j;
      S.docOpen.add(agent);
      S.docRan = false;
      drawDoctor();
      return j.terminal ? undefined : void pollDoctorJob(agent, j.id);
    }
    case 'doc-report':
      return void reportIssue();
    case 'doc-issue-cancel':
      return el.closest('.scrim')?.remove();
    case 'doc-send': {
      const r = await api('POST', '/api/doctor/issue/send', { kind: $('#doc-issue-kind').value, summary: $('#doc-issue-title').value, what: $('#doc-issue-what').value, details: $('#doc-issue-body').value }).catch(err => ({ error: err.message }));
      el.closest('.scrim')?.remove();
      return toast(r.error ? `Not sent: ${r.error}` : r.via === 'gh' ? `Issue created: ${r.url}` : 'Opened GitHub; the report is on your clipboard: paste it as the description');
    }
    case 'update-toggle': $('#app-update').hidden = !$('#app-update').hidden; return renderChrome();
    case 'update-skip': closeUpdate(); return api('POST', '/api/updates/skip', {});
    case 'update-open': {
      closeUpdate();
      const result = await api('POST', '/api/updates/open', {});
      return toast(result.error || 'Update instructions opened in your browser. Run the installer, then restart Chorus.');
    }
    case 'news-toggle':
      if (!$('#news').hidden) return closeNews();
      $('#news').hidden = false; S.newsDetail = null; renderChrome();
      return loadNews();
    case 'news-close': return closeNews();
    case 'news-back': S.newsDetail = null; return loadNews();
    case 'news-open': return openNews(arg);
    case 'news-read-all': S.news = await api('POST', '/api/notifications/read-all', {}); return renderNews();
    case 'news-privacy': return api('POST', '/api/notifications/link', { url: 'https://chorus-cli.web.app/privacy' });
    case 'back':
      return back();
    case 'export': {
      // everything, in one .zip in Downloads: free for everyone (2.0 plan stage 11)
      if (S.exporting) return;
      S.exporting = true;
      renderChrome();
      if (S.view.name === 'more') renderView();
      try {
        const r = await api('POST', '/api/export');
        if (r.error) toast(r.error);
        else toast(`Exported ${r.chats} chat${r.chats === 1 ? '' : 's'} to ${r.file.split('/').pop()} in Downloads (${(r.bytes / 1e6).toFixed(r.bytes < 1e7 ? 1 : 0)} MB)`, { ms: 20000, buttons: '<button class="btn" data-act="export-reveal">Show in Finder</button>' });
      } catch (e) {
        toast(`Could not export: ${e.message}`);
      } finally {
        S.exporting = false;
        renderChrome();
        if (S.view.name === 'more') renderView();
      }
      return;
    }
    case 'export-reveal':
      return void api('POST', '/api/export/reveal').catch(() => {});
    case 'menu':
      // a narrow window, like a phone through the private link: the sidebar comes over the page
      $('#app').classList.toggle('side-open');
      return renderChrome();
    case 'sidebar':
      // narrower than a desktop the sidebar comes over the page: its ⇤ closes it
      if (S.size !== 'desktop') {
        $('#app').classList.remove('side-open');
        return renderChrome();
      }
      $('#app').classList.toggle('side-off');
      renderChrome();
  renderDoctorDot();
      return setTimeout(refit, 50);
    case 'fold':
      // the project's name opens its Portal; the caret only folds
      if (window.choruspro && !e.target.closest('.caret')) {
        S.folded.delete(arg);
        return go({ name: 'pro', id: `portal~${encodeURIComponent(arg)}` });
      }
      S.folded.has(arg) ? S.folded.delete(arg) : S.folded.add(arg);
      remember('folded', [...S.folded]);
      renderChrome();
      return S.view.name === 'chats' ? renderView() : undefined;
    case 'rm-project': {
      S.hidden[arg] = (S.state?.chats ?? []).filter(c => c.cwd === arg).map(c => c.id);
      remember('hidden', S.hidden);
      const open = S.view.name === 'chat' && S.state?.chats.find(c => c.id === S.view.id)?.cwd === arg;
      if (open) return go(startView());
      renderChrome();
      return S.view.name === 'chats' || S.view.name === 'home' ? renderView() : undefined;
    }
    case 'fold-open':
      S.folded.delete(arg);
      return renderChrome();
    case 'add-project':
      go({ name: 'new' });
      return pickFolder(S.state?.project ?? '~', dir => S.form && ((S.form.folder = dir), renderChrome(), renderView()));
    case 'handoff':
      if (window.choruspro?.handOff) return window.choruspro.handOff(arg, S.state?.chats.find(c => c.id === arg));
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
    case 'drawer-to':
    case 'drawer-close':
      // drawer-to: always that drawer (a phone's ⋯ sheet and the drawer's own tabs); drawer-close: the dim area around it
      S.drawer = act === 'drawer-close' ? null : act === 'drawer-to' || S.drawer !== arg ? arg : null;
      S.drawerData = null;
      remember('drawer', S.drawer ?? '');
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
    case 'nc-menu':
      S.ncMenu = S.ncMenu === arg ? null : arg;
      return renderView();
    case 'nc-skip':
      S.form.skip = arg === '1';
      S.ncMenu = null;
      return renderView();
    case 'pro-nc':
      window.choruspro?.newChatPick?.(arg);
      S.ncMenu = null;
      return renderView();
    case 'nc-agent':
      if (!S.form) return;
      S.form.agent = arg;
      S.form.model = 'default';
      S.form.effort = 'default';
      S.ncMenu = null;
      window.choruspro?.newChatPick?.('who:just');
      return renderView();
    case 'nc-folder':
      S.form.folder = arg;
      S.ncMenu = null;
      renderChrome(); // the sidebar marks the project the form starts in
      return renderView();
    case 'nc-start':
      return startChat();
    case 'browse':
      return pickFolder(S.form?.folder ?? '~', dir => S.form && ((S.form.folder = dir), renderChrome(), renderView()));
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
      // a phone: the record is its own step, so ‹ Back returns to the list
      if (S.size === 'phone') return go({ name: 'memory', rec: arg });
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
    case 'cl-q':
      S.cl.q = el.value;
      S.cl.focus = true;
      return renderView();
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
        return dismissDialog(dlg);
      }
      if (dlg.dataset.dialog && !e.target.closest('input')) {
        const key = e.key === 'Enter' ? '\r' : e.key;
        const b = dlg.querySelector(`[data-value="${CSS.escape(key)}"]`);
        if (b) {
          e.preventDefault();
          return b.click();
        }
      }
      if (e.key === 'Enter' && e.target.id === 'si-code') return void $('[data-act="si-code"]')?.click();
      if (e.key === 'Enter' && e.target.closest('.dlg-input') && dlg.dataset.dialog) {
        e.preventDefault();
        return dlg.querySelector('[data-act="dlg-ok"]')?.click();
      }
      return;
    }
    if (e.key === 'Escape' && $('#sheet')) {
      e.preventDefault();
      S.sheet = null;
      return drawSheet();
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
  if (name === 'pro' && a) return { name, id: a };
  if (['approvals', 'memory', 'skills', 'doctor', 'unlock', 'welcome', 'trying', 'paying', 'pro-paid', 'pro-started', 'pro-ended', 'home', 'chats', 'more'].includes(name)) return { name };
  return name === 'new' ? { name } : startView();
}

connect();
void api('GET', '/api/pro/status').then(onProStatus, () => {
  // no plan to read: no Welcome either, so the Doctor goes on as before
  S.proFailed = true;
  doctorWhenReady();
});
renderChrome();
go(fromHash(), false);
