// The Chat view (plan 2026-11-22 chat-view, mockup @workspace/mockups/chat-view.html, docs/features/chat-view.md): a chat drawn from
// the turns Chorus captures from its CLI's transcript, beside the agent's own terminal (the Terminal view). One session, two views: the CLI keeps running in its
// PTY; this view never attaches to it. It loads a page of turns with one short row per tool call (GET chats/:id/turns), then gets only
// what is new over the websocket (`cv`), and fetches a call's full input and output only when the user taps its row.
//
// app.js owns the page; this module owns what is inside the view's element: the conversation, the folded tool calls, the cards, the
// detail sheet, the full-screen viewer, and the message box (a phone: with its key row; wider: Enter sends, the keys sit in the box). It talks to the page through `h` (below).
import { mdFull } from './md.js';
import { composing } from './box-keys.js';
import { drawDiagrams as diagrams } from './mermaid.js';
import { artLabel, cardSum, fileSquare, OPEN_ICON } from './file-viewer.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Chorus's own tools drawn as cards, not rows (src/serve/chatview.ts CARD_TOOLS). */
const CARD_TOOLS = new Set(['start_subthread', 'start_thread', 'show_artifact', 'request_approval', 'ask_main_thread']);
/** The row's mark per kind (mockup scene 2). */
const MARK = { command: '$', read: '≡', search: '⌕', edit: '✎', write: '+', web: '↗', mcp: '◈', other: '•' };
/** The folded line's words per kind: verb, one, many (chorus-core KIND_WORDS). */
const WORDS = { command: ['ran', 'command', 'commands'], read: ['read', 'file', 'files'], search: ['searched', 'time', 'times'], edit: ['edited', 'file', 'files'], write: ['wrote', 'file', 'files'], web: ['fetched', 'page', 'pages'], mcp: ['called', 'tool', 'tools'], other: ['used', 'tool', 'tools'] };
/** The running call's line: "Running npm test", "Editing src/app.js". */
const LIVE = { command: 'Running', read: 'Reading', search: 'Searching', edit: 'Editing', write: 'Writing', web: 'Fetching', mcp: 'Calling', other: 'Using' };
/** The detail sheet's title and its two labels per kind (mockup scene 2). */
const SHEET = {
  command: ['Ran a command', 'Command', 'Output'],
  read: ['Read a file', 'File', 'What it read'],
  search: ['Searched the code', 'Pattern', 'Matches'],
  edit: ['Edited a file', 'File', 'Change'],
  write: ['Wrote a file', 'File', 'Content'],
  web: ['Fetched a page', 'Address', 'What came back'],
  mcp: ['Called a tool', 'Asked', 'Answer'],
  other: ['Used a tool', 'Given', 'Answer'],
};
const I = {
  raw: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="3.5" width="15" height="13" rx="2.5"/><path d="M6 8l2.5 2L6 12M10.5 12.5H14"/></svg>',
  chat: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5.5A2.5 2.5 0 015.5 3h9A2.5 2.5 0 0117 5.5v6a2.5 2.5 0 01-2.5 2.5H9l-4 3v-3.2A2.5 2.5 0 013 11.5z"/></svg>',
  art: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 2.5h6.5L15.5 6.5v11h-10.5z"/><path d="M11.5 2.5v4h4"/></svg>',
};
export const CV_ICONS = I;

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const base = p => String(p ?? '').split('/').pop();
const isChorus = c => c.tool === 'mcp:chorus';
const isCard = c => isChorus(c) && CARD_TOOLS.has(c.target);

/** "Ran 1 command, read 2 files, edited 1 file", three kinds at most then "2 more"; failed calls named apart. */
export function foldedText(calls) {
  const by = new Map();
  for (const c of calls) by.set(c.kind, (by.get(c.kind) ?? 0) + 1);
  const parts = [...by].map(([k, n]) => `${WORDS[k][0]} ${plural(n, WORDS[k][1], WORDS[k][2])}`);
  let s = parts.slice(0, 3).join(', ');
  const rest = [...by].slice(3).reduce((a, [, n]) => a + n, 0);
  if (rest) s += `, ${rest} more`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** What a row says about the call: "Read src/app.js", the command itself, "Chorus · read_mail". Escaped HTML. */
export function rowWhat(c) {
  const t = `<code>${esc(c.target)}</code>`;
  switch (c.kind) {
    case 'command': return t;
    case 'read': return `Read ${t}`;
    case 'search': return `Search ${t}`;
    case 'edit': return `Edit ${t}`;
    case 'write': return `Write ${t}`;
    case 'web': return `Fetch ${t}`;
    case 'mcp': return `${esc(isChorus(c) ? 'Chorus' : c.tool.replace(/^mcp:/, ''))} · ${t}`;
    default: return `${esc(c.tool)}${c.target ? ` ${t}` : ''}`;
  }
}

/** The word on a row's right: red for a failure, "+12 −3" coloured, ✓ for a command that ran with nothing more to say. */
export function rowWord(c) {
  if (c.status === 'running') return '<span class="r"><span class="spin"></span></span>';
  if (c.status === 'failed') return `<span class="r bad">${esc(c.word && c.word !== 'failed' ? c.word : 'failed')}</span>`;
  const m = /^\+(\d+)(?: −(\d+))?$/.exec(c.word ?? '');
  if (m) return `<span class="r"><span class="p">+${m[1]}</span>${m[2] ? ` <span class="m">−${m[2]}</span>` : ''}</span>`;
  if (c.word) return `<span class="r">${esc(c.word)}</span>`;
  return c.kind === 'command' || c.kind === 'mcp' ? '<span class="r ok">✓</span>' : '<span class="r"></span>';
}

/** A user's message as they typed it: a skill Chorus spelled out for the CLI (expandSkillMentions) shows as `/name` again. */
/** Inline code in a reply that names a file: no spaces, not a link or an option, a name with an extension (`a/b.html`, `~/x.md`). */
export const isFilePath = t =>
  t.length > 2 && t.length < 400 && !/\s|^[a-z][\w+.-]*:\/\/|^-|[<>|*?"'`$]/i.test(t) && /(^|\/)[^/]+\.[A-Za-z0-9]{1,8}$/.test(t) && !/^\d+(\.\d+)+$/.test(t);
export const asTyped = text => String(text ?? '').replace(/Use the Chorus skill "([\w.-]+)" \(load it with the chorus get_skill tool\)\./g, '/$1');

const ago = (iso, now = Date.now()) => {
  const t = Date.parse(iso ?? '');
  if (!t) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};
const clock = s => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);

/** One page of the conversation into the chat's data: turns by seq, calls by id, cards replaced (the server sends them all). */
export function merge(d, part, { older = false } = {}) {
  for (const t of part.turns ?? []) d.turns.set(t.seq, t);
  for (const c of part.calls ?? []) d.calls.set(c.id, c);
  if (part.cards) d.cards = older ? [...part.cards.filter(c => !d.cards.some(x => x.type === c.type && x.id === c.id && x.at === c.at)), ...d.cards] : part.cards;
  if (older || d.from == null) {
    if (part.from != null) d.from = Math.min(d.from ?? part.from, part.from);
    if (part.more != null) d.more = part.more;
  }
  return d;
}

/**
 * The view, in order: before the first turn the "Started by" line; then per turn its bubble, the run of calls after it (one folded
 * line, Chorus's own card tools left out), then the cards placed after it. Cards with no place go last.
 */
export function items(d) {
  const turns = [...d.turns.values()].sort((a, b) => a.seq - b.seq);
  const calls = [...d.calls.values()];
  const runs = new Map();
  for (const c of calls) if (!isCard(c)) (runs.get(c.seq) ?? runs.set(c.seq, []).get(c.seq)).push(c);
  const cardsAt = new Map();
  const lastSeq = turns.length ? turns[turns.length - 1].seq : 0;
  for (const c of d.cards ?? []) {
    if (c.type === 'startedBy') continue;
    const k = c.seq == null || c.seq > lastSeq ? lastSeq : Math.max(c.seq, d.from && c.seq < d.from ? -1 : c.seq);
    if (k < 0) continue;
    (cardsAt.get(k) ?? cardsAt.set(k, []).get(k)).push(c);
  }
  const out = [];
  const started = (d.cards ?? []).find(c => c.type === 'startedBy');
  if (started && !d.more) out.push({ type: 'startedBy', card: started });
  const after = seq => {
    const run = runs.get(seq);
    if (run?.length) out.push({ type: 'run', seq, calls: run });
    const cards = cardsAt.get(seq) ?? [];
    // sub threads placed together share one card (mockup scene 3)
    const subs = cards.filter(c => c.type === 'sub');
    if (subs.length > 1) out.push({ type: 'subs', cards: subs });
    for (const c of cards) if (!(c.type === 'sub' && subs.length > 1)) out.push({ type: 'card', card: c });
  };
  if (!d.more) after(0);
  for (const t of turns) {
    out.push({ type: 'turn', turn: t });
    after(t.seq);
  }
  return out;
}

/** The view for one chat. `h` is the page: see makeChatView's callers in app.js. */
export function makeChatView(h) {
  const data = new Map();
  const open = new Set();
  let cur = null;
  let timer = null;
  /** keeps a reader at the bottom when the stream gets shorter (mount) */
  let follow = null;
  let pending = null;
  let picker = null;
  let notice = null;

  const chatOf = id => h.chats().find(c => c.id === id);
  const dataOf = id => data.get(id) ?? data.set(id, { turns: new Map(), calls: new Map(), cards: [], from: null, more: false, loaded: false }).get(id);

  async function load(id, before) {
    const d = dataOf(id);
    const r = await h.api('GET', `/api/chats/${encodeURIComponent(id)}/turns${before ? `?before=${before}` : ''}`);
    merge(d, r, { older: !!before });
    if (r.nativeCommands) d.nativeCommands = r.nativeCommands;
    if (!before) d.more = r.more;
    d.loaded = true;
    return r;
  }

  /* ---------- drawing ---------- */

  function runHtml(it, last, working) {
    const key = `${cur.id}:${it.seq}`;
    const failed = it.calls.filter(c => c.status === 'failed').length;
    const running = it.calls.filter(c => c.status === 'running');
    const done = it.calls.filter(c => c.status !== 'running');
    const isOpen = open.has(key);
    const bad = failed ? ` · <span class="bad">${failed} failed</span>` : '';
    const label = isOpen ? `${plural(it.calls.length, 'tool call', 'tool calls')}${bad}` : `${done.length ? esc(foldedText(done)) : esc(foldedText(it.calls))}${bad}`;
    let html = done.length || isOpen ? `<button class="cv-tools" data-cv="fold" data-key="${esc(key)}" aria-expanded="${isOpen}"><span class="chev">${isOpen ? '▾' : '▸'}</span><span>${label}</span></button>` : '';
    if (isOpen) html += `<div class="cv-tl">${it.calls.map(c => `<button class="cv-t${cur.sel === c.id ? ' sel' : ''}" data-cv="call" data-call="${esc(c.id)}"><span class="k">${MARK[c.kind] ?? '•'}</span><span class="w">${rowWhat(c)}</span>${rowWord(c)}</button>`).join('')}</div>`;
    // the running call shows by itself, under the last reply (mockup scene 1)
    if (running.length && last && working && !isOpen) {
      const c = running[running.length - 1];
      html += `<div class="cv-live"><span class="spin"></span>${LIVE[c.kind] ?? 'Using'} <code>${esc(c.kind === 'mcp' ? c.target : c.target)}</code></div>`;
    }
    return html;
  }

  function stateOf(id) {
    const c = chatOf(id);
    return c ? c.state : 'parked';
  }
  const dot = st => (st === 'busy' || st === 'starting' ? 'working' : st === 'idle' ? 'waiting' : st === 'approval' ? 'waiting' : st === 'ended' ? 'stopped' : 'done');

  function subHtml(c) {
    const live = chatOf(c.id);
    const st = live?.state ?? c.state;
    const reported = c.status === 'stopped' || c.status === 'ended' || !!c.report;
    const word = c.status === 'working' || st === 'busy' ? `working · ${ago(c.started)}` : reported ? `reported${c.started ? ` · ${ago(c.started)}` : ''}` : c.status;
    const agentCls = c.agent === 'claude' ? ' claude' : c.agent === 'agy' ? ' agy' : '';
    const html = `<div class="cv-card sub${agentCls}"><div class="hd">↳ SUB THREAD<span class="sp"></span><span class="badge ${esc(c.agent)}">${esc(h.agentName(c.agent))}</span></div><div class="ti">${esc(c.title)}</div>${c.report && reported ? `<div class="q">${esc(c.report)}</div>` : ''}<div class="st"><span class="dot ${st === 'busy' || c.status === 'working' ? 'working' : reported ? 'done' : dot(st)}"></span>${esc(word)}<button class="go" data-cv="open" data-arg="${esc(c.id)}">Open ›</button></div></div>`;
    return html + askHtml(c);
  }

  /** A question from a sub thread (ask_main_thread): a card of its own (mockup scene 3). */
  function askHtml(c) {
    if (!c.question) return '';
    const agentCls = c.agent === 'claude' ? ' claude' : c.agent === 'agy' ? ' agy' : '';
    return `<div class="cv-card sub${agentCls}"><div class="hd">↳ SUB THREAD ASKS<span class="sp"></span><span class="badge ${esc(c.agent)}">${esc(h.agentName(c.agent))}</span></div><div class="q">${esc(c.question)}</div><div class="st">the main chat answers it<button class="go" data-cv="open" data-arg="${esc(c.id)}">Open ›</button></div></div>`;
  }

  function cardHtml(c) {
    if (c.type === 'sub') return subHtml(c);
    if (c.type === 'chat') {
      const st = chatOf(c.id)?.state ?? c.state;
      return `<div class="cv-card new"><div class="hd">＋ NEW CHAT<span class="sp"></span><span class="badge ${esc(c.agent)}">${esc(h.agentName(c.agent))}</span></div><div class="ti">${esc(c.title)}</div><div class="note">${c.teammate ? `${esc(c.teammate)} · ` : ''}runs on its own and does not report back here</div><div class="st"><span class="dot ${dot(st)}"></span>${esc(h.stateWord(st))}<button class="go" data-cv="open" data-arg="${esc(c.id)}">Open chat ›</button></div></div>`;
    }
    if (c.type === 'mail') {
      // a sub thread's report opens the sub thread; other mail opens the chat it came from
      const to = c.sub?.id ?? (c.fromId && chatOf(c.fromId) ? c.fromId : null);
      const words = c.sub ? `<b>Report from sub thread</b> · ${esc(c.sub.title)}` : `<b>Mail from ${esc(c.from)}</b>${c.subject ? ` · ${esc(c.subject)}` : ''}`;
      return to ? `<button class="cv-sys" data-cv="open" data-arg="${esc(to)}"><span class="ic">✉</span><span class="t">${words}</span><span class="x">Open</span></button>` : `<div class="cv-sys"><span class="ic">✉</span><span class="t">${words}</span></div>`;
    }
    if (c.type === 'artifact') {
      // one ↗ Open, and a click anywhere on the card does the same (plan 2026-11-25, scene 1): openFile decides where it opens. The
      // mini preview and the summary are read only where this page may read the file (the Mac, or a file inside the project)
      const canRead = !c.link && (c.open || h.onMac);
      const pv = c.kind === 'html' && canRead ? `<div class="pv" data-cv-pv="${c.id}"></div>` : '';
      // the line under the title: the markdown's size in words, a diagram, the HTML's live note, the size of a file that is not text
      // (and that Chorus can't show it), else its name
      const sum = c.link
        ? 'a link'
        : c.kind === 'markdown' && canRead
          ? `<span class="sum" data-cv-sum="${c.id}">${esc(base(c.target))}</span>`
          : c.kind === 'mermaid'
            ? 'a diagram'
            : c.kind === 'html' && canRead
              ? 'updates while the agent edits it'
              : ['file', 'image', 'pdf'].includes(c.kind)
                ? `<span class="sum" data-cv-size="${c.id}">${c.kind === 'file' && c.fileType ? `Chorus can't show ${esc(c.fileType)} files` : esc(base(c.target))}</span>`
                : `<span class="sum">${esc(base(c.target))}</span>`;
      const where = c.link ? c.target : c.rel ?? h.tilde(c.target);
      return `<div class="cv-card art" data-cv="art" data-arg="${c.id}"><div class="hd">${c.link ? 'LINK' : 'FILE'}<span class="sp"></span>${c.link ? '' : esc(artLabel(c))}</div>${pv}<div class="top2">${fileSquare(c.target, { link: c.link })}<div class="tt"><div class="ti">${esc(c.title)}</div><div class="fn">${esc(where)}</div></div></div><div class="st">${sum}<button class="go" data-cv="art" data-arg="${c.id}">${OPEN_ICON}Open</button></div></div>`;
    }
    return '';
  }

  function subsHtml(cards) {
    return `<div class="cv-card"><div class="hd">↳ ${cards.length} SUB THREADS</div>${cards.map(c => {
      const st = chatOf(c.id)?.state ?? c.state;
      const reported = c.status === 'stopped' || c.status === 'ended' || !!c.report;
      const word = c.status === 'working' || st === 'busy' ? `working · ${ago(c.started)}` : c.status === 'stopped' && !c.report ? 'stopped' : reported ? 'reported' : c.status;
      return `<button class="mini" data-cv="open" data-arg="${esc(c.id)}"><span class="dot ${st === 'busy' || c.status === 'working' ? 'working' : c.status === 'stopped' && !c.report ? 'stopped' : 'done'}"></span><span class="nm">${esc(c.title)}</span><span class="badge ${esc(c.agent)}">${esc(h.agentName(c.agent))}</span><span class="s">${esc(word)}</span></button>`;
    }).join('')}</div>${cards.map(askHtml).join('')}`;
  }

  function streamHtml() {
    const d = dataOf(cur.id);
    const c = chatOf(cur.id);
    const working = c?.state === 'busy' || c?.state === 'starting';
    const list = items(d);
    const lastRun = [...list].reverse().find(x => x.type === 'run');
    const lastTurnAt = list.findLastIndex?.(x => x.type === 'turn') ?? -1;
    let html = d.more ? '<div class="cv-more"><span class="spin"></span>Earlier messages</div>' : '';
    if (!d.loaded) return '<div class="cv-empty"><span class="spin"></span>Loading the conversation…</div>';
    if (!list.length && !pending) html += `<div class="cv-empty">${c?.state === 'busy' || c?.state === 'starting' ? 'The agent is starting.' : 'Nothing said yet.'}</div>`;
    let day = '';
    let spoke = '';
    const who = h.speaker(c);
    const dayOf = t => {
      const dd = t.ts ? new Date(t.ts) : null;
      return dd && !isNaN(dd) ? dd : null;
    };
    const dayLabel = dd => {
      const days = Math.round((new Date(new Date().toDateString()) - new Date(dd.toDateString())) / 86400000);
      return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : dd.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(dd.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
    };
    const turnHtml = t => {
      let out = '';
      const dd = dayOf(t);
      if (dd && dd.toDateString() !== day) {
        out += `<div class="cv-day"><span>${esc(dayLabel(dd))}</span></div>`;
        day = dd.toDateString();
      }
      if (t.note) {
        if (t.note.kind === 'answer' || t.note.kind === 'stopped') spoke = 'user';
        return out + noteHtml(t, c);
      }
      if (t.role === 'user') {
        spoke = 'user';
        return out + `<div class="cv-u">${esc(asTyped(t.text))}</div>`;
      }
      // who is speaking, above the first reply after the user spoke (and at the top of what is loaded)
      if (spoke !== 'agent') out += `<div class="cv-who"><span class="dot ${esc(who.agent)}"></span><b>${esc(who.name)}</b>${dd ? `<span>${esc(dd.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }))}</span>` : ''}</div>`;
      spoke = 'agent';
      return out + `<div class="cv-a">${mdFull(t.text)}</div>`;
    };
    const isJob = x => x?.type === 'turn' && x.turn.note?.kind === 'job';
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.type === 'turn') {
        // three or more background jobs reporting one after another, with nothing between them: one line
        let n = i;
        while (isJob(list[n])) n++;
        if (n - i >= 3) {
          const key = `${cur.id}:j${it.turn.seq}`;
          const isOpen = open.has(key);
          html += `<button class="cv-sys" data-cv="fold" data-key="${esc(key)}" aria-expanded="${isOpen}"><span class="ic">⏱</span><span class="t"><b>${n - i} background jobs reported</b></span><span class="x">${isOpen ? 'Hide' : 'Show'}</span></button>`;
          if (isOpen) for (let k = i; k < n; k++) html += turnHtml(list[k].turn);
          i = n - 1;
        } else html += turnHtml(it.turn);
      } else if (it.type === 'run') html += runHtml(it, it === lastRun && i > lastTurnAt - 1, working);
      else if (it.type === 'subs') html += subsHtml(it.cards);
      else if (it.type === 'startedBy') {
        const s = it.card;
        html += `<button class="cv-sys go-row" data-cv="open" data-arg="${esc(s.id)}"><span class="ic">↗</span><span class="t">Started by <b>${esc(s.title)}</b> · ${s.skip ? 'Skip permissions' : 'Ask before acting'}</span><span class="x">Open</span></button>`;
      } else html += cardHtml(it.card);
    }
    if (pending) html += `<div class="cv-u pending">${esc(pending.text)}</div>`;
    if (notice) html += `<div class="cv-sys warn"><span>⌨</span><span>${esc(notice.text)}</span>${notice.raw ? '<button class="btn sm" data-cv="raw">Open Terminal</button>' : ''}</div>`;
    return html;
  }

  /** A "user" turn that is not a message the user typed (src/serve/chatview.ts noteOf): one quiet line, opened by a click. */
  function noteHtml(t, c) {
    const n = t.note;
    if (n.kind === 'answer') return `<div class="cv-sys right"><span class="t">✓ You answered the card: <b>${esc(n.sub ?? '')}</b></span></div>`;
    if (n.kind === 'stopped') return `<div class="cv-sys right"><span class="t">You stopped ${esc(h.agentName(c?.agent))}</span></div>`;
    const key = `${cur.id}:n${t.seq}`;
    const isOpen = open.has(key);
    const d = dataOf(cur.id);
    const full = d.full?.get(t.seq);
    const body = isOpen ? `<div class="cv-open"><pre>${esc(full?.text ?? t.text)}${t.long && !full ? '…' : ''}</pre>${full?.capped ? '<div class="note">Cut here: it is longer than Chorus shows.</div>' : ''}</div>` : '';
    if (n.kind === 'compact') return `<div class="cv-cut"><span>${esc(h.agentName(c?.agent))} shortened the conversation here · <button data-cv="note" data-seq="${t.seq}" aria-expanded="${isOpen}">${isOpen ? 'Hide its summary' : 'Read its summary'}</button></span></div>${body}`;
    const [ic, head] = n.kind === 'job' ? ['⏱', n.head ?? 'Background job reported'] : n.kind === 'brief' ? ['≡', "Chorus's instructions for this chat"] : ['◈', 'Chorus'];
    return `<button class="cv-sys" data-cv="note" data-seq="${t.seq}" aria-expanded="${isOpen}"><span class="ic">${ic}</span><span class="t"><b>${esc(head)}</b>${n.sub ? ` · ${esc(n.sub)}` : ''}</span><span class="x">${isOpen ? 'Hide' : 'Show'}</span></button>${body}`;
  }

  /** Opens or closes a quiet line; a long one's whole text is read then, once. */
  async function toggleNote(seq) {
    const id = cur.id;
    const key = `${id}:n${seq}`;
    if (open.has(key)) {
      open.delete(key);
      return draw({ keep: 'none' });
    }
    open.add(key);
    draw({ keep: 'none' });
    const d = dataOf(id);
    const t = d.turns.get(seq);
    if (!t?.long || d.full?.has(seq)) return;
    try {
      const r = await h.api('GET', `/api/chats/${encodeURIComponent(id)}/turns/${seq}`);
      if (r?.text != null) (d.full ??= new Map()).set(seq, r);
    } catch {
      /* the first part stays */
    }
    if (cur?.id === id) draw({ keep: 'none' });
  }

  function footHtml(c) {
    const phone = h.size() === 'phone';
    const working = c?.state === 'busy' || c?.state === 'starting';
    const watch = c?.sub && !c.sub.unlocked;
    const stop = working && h.canStop(c?.agent) ? '<button class="cv-stop" data-cv="stop">Stop</button>' : '';
    const work = working ? `<div class="cv-work"><span class="spin"></span><span data-cv-clock>${esc(workText(c))}</span>${phone || watch ? stop : ''}</div>` : '';
    const wide = phone ? '' : ' wide';
    if (watch) return `<div class="cv-foot${wide}"><div class="cv-fcol">${work}<div class="cv-watch"><span>👁 <b>Watch only.</b> Tell its main chat what you want.</span><button class="btn sm" data-act="sub-lock" data-arg="${esc(c.id)}" data-on="1">Unlock</button></div></div></div>`;
    const name = h.agentName(c?.agent);
    // a tablet and a desktop (owner, 2026-11-23: "in that chat view the user still able to chat like what you did on mobile"): the
    // same box on the conversation's column; Enter sends, Shift+Enter is a new line, and "/", "@", ⇧Tab and Stop sit inside it.
    // While the CLI shows a menu of its own the box waits: the answer is given in the Terminal view (the banner above).
    if (!phone) {
      const menu = h.menuShown(c);
      const off = menu ? ' disabled' : '';
      return `<div class="cv-foot wide"><div class="cv-fcol">${work}<div class="cv-box${menu ? ' off' : ''}"><textarea class="cv-in" data-input rows="1" placeholder="${menu ? 'Answer in Terminal first' : `Message ${esc(name)}`}" aria-label="Message ${esc(name)}"${off}></textarea><div class="cv-bar"><button class="cv-kb" data-cv="ins" data-arg="/" title="Skills and commands"${off}>/</button><button class="cv-kb" data-cv="ins" data-arg="@" title="Files of the chat's folder"${off}>@</button><button class="cv-kb" data-cv="key" data-arg="shift-tab" title="Changes ${esc(name)}'s mode, like Shift+Tab in the terminal">⇧Tab</button><span class="cv-hint">Enter to send · Shift+Enter for a new line</span>${stop}<button class="cv-send" data-cv="send"${off}>Send</button></div></div></div></div>`;
    }
    return `<div class="cv-foot">${work}<div class="cv-box"><textarea class="cv-in" data-input rows="1" placeholder="Message ${esc(name)}" aria-label="Message ${esc(name)}" enterkeyhint="send"></textarea><button class="cv-send" data-cv="send" aria-label="Send">↑</button></div><div class="cv-keys"><button data-cv="ins" data-arg="/">/</button><button data-cv="ins" data-arg="@">@</button><button data-cv="key" data-arg="esc">Esc</button><button data-cv="key" data-arg="shift-tab">⇧Tab</button></div></div>`;
  }

  function workText(c) {
    const d = c ? dataOf(c.id) : null;
    const lastUser = d ? [...d.turns.values()].filter(t => t.role === 'user' && (!t.note || t.note.kind === 'answer')).sort((a, b) => b.seq - a.seq)[0] : null;
    const t = Date.parse(lastUser?.ts ?? '');
    return t ? `Working · ${clock(Math.max(0, Math.round((Date.now() - t) / 1000)))}` : 'Working';
  }

  /** Draws the stream again, keeping the reader where they were (at the bottom only when they were there). */
  function draw({ keep = 'auto' } = {}) {
    if (!cur?.el?.isConnected) return;
    const s = cur.el.querySelector('.cv-stream');
    const atBottom = s.scrollHeight - s.scrollTop - s.clientHeight < 40;
    const fromBottom = s.scrollHeight - s.scrollTop;
    s.innerHTML = `<div class="cv-col">${streamHtml()}</div>`;
    if (keep === 'bottom' || (keep === 'auto' && (atBottom || cur.stick))) s.scrollTop = s.scrollHeight;
    else if (keep === 'older') s.scrollTop = s.scrollHeight - fromBottom;
    drawDiagrams(s);
    watchPreviews(s);
    linkPaths(s);
  }

  /**
   * A file path the agent writes in its reply (`site/hero.html`, `/Users/me/x/notes.md`) opens the file viewer when tapped (phone e2e,
   * 2026-11-25: the Planner named the file its task made, and the phone had no way to see it). Only inline code that looks like a file
   * (a name with an extension, no spaces, not a link); the server decides what may be shown, remotely only inside the chat's project.
   */
  function linkPaths(root) {
    for (const c of root.querySelectorAll('.cv-a code')) {
      if (c.closest('pre') || c.dataset.cv) continue;
      const t = c.textContent.trim();
      if (!isFilePath(t)) continue;
      c.dataset.cv = 'path';
      c.dataset.arg = t;
      c.classList.add('cv-path');
      c.setAttribute('role', 'button');
      c.setAttribute('tabindex', '0');
      c.title = 'Open this file';
    }
  }

  function drawFoot() {
    if (!cur?.el?.isConnected) return;
    const c = chatOf(cur.id);
    const f = cur.el.querySelector('.cv-footwrap');
    const key = JSON.stringify([h.size(), c?.state, c?.sub?.unlocked ?? null, !!c?.sub, h.canStop(c?.agent), h.size() !== 'phone' && h.menuShown(c)]);
    if (f.dataset.k === key) return;
    // the box keeps what is typed in it across redraws
    const box = f.querySelector('.cv-in');
    const text = box?.value ?? '';
    const focus = box && document.activeElement === box;
    f.dataset.k = key;
    picker?.destroy();
    picker = null;
    f.innerHTML = footHtml(c);
    const nbox = f.querySelector('.cv-in');
    if (nbox) {
      nbox.value = text;
      grow(nbox);
      picker = h.picker(nbox, c);
      // the chat's state changed while you type: the box is the same text, and an open "/" or "@" list opens again at the caret
      if (focus) {
        nbox.focus();
        picker.refresh();
      }
    }
  }

  const grow = el => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, h.size() === 'phone' ? 140 : 200)}px`;
  };

  /* ---------- mermaid: the library is Chorus's own file, loaded once a reply has a diagram (mermaid.js, shared with the file viewer) ---------- */

  const drawDiagrams = root => diagrams(root, { url: h.mermaidUrl, foot: '<div class="ft">mermaid<button data-cv="dia">Full screen</button></div>' });

  /* ---------- artifact previews: a sandboxed frame from the existing route, only once the card is in view ---------- */

  let seen = null;
  const sums = new Map();
  function watchPreviews(root) {
    seen?.disconnect();
    seen = new IntersectionObserver(es => {
      for (const e of es) {
        if (!e.isIntersecting) continue;
        seen.unobserve(e.target);
        const id = e.target.dataset.cvPv ?? e.target.dataset.cvSum ?? e.target.dataset.cvSize;
        const url = `/api/chats/${encodeURIComponent(cur.id)}/reported/${encodeURIComponent(id)}`;
        // a card's line is asked once per version of the chat's files, not again on every redraw of the stream
        const key = `${cur.id}:${id}:${chatOf(cur.id)?.artifactsRev ?? ''}`;
        const put = t => t && (sums.set(key, t), (e.target.textContent = t));
        if (!e.target.dataset.cvPv && sums.has(key)) {
          e.target.textContent = sums.get(key);
          continue;
        }
        // a file that is not text: its size, and for one the viewer can't show, that it can't ("6.2 MB · Chorus can't show Keynote
        // files"); the view answer for these reads no content (a stat)
        if (e.target.dataset.cvSize)
          h.api('GET', `/api/chats/${encodeURIComponent(cur.id)}/files/view?r=${encodeURIComponent(id)}`)
            .then(v => put(cardSum(v)))
            .catch(() => {});
        else if (e.target.dataset.cvPv) e.target.innerHTML = `<iframe src="${esc(url)}" sandbox="" loading="lazy" title="Preview" tabindex="-1"></iframe>`;
        else
          fetch(url, { credentials: 'same-origin' })
            .then(r => (r.ok ? r.text() : ''))
            .then(t => {
              if (!t) return;
              const heads = (t.match(/^#{1,6}\s/gm) ?? []).length;
              const words = t.split(/\s+/).filter(Boolean).length;
              put(`${plural(heads, 'heading', 'headings')} · ${plural(words, 'word', 'words')}`);
            })
            .catch(() => {});
      }
    }, { root: root, rootMargin: '200px' });
    for (const el of root.querySelectorAll('[data-cv-pv], [data-cv-sum], [data-cv-size]')) seen.observe(el);
  }

  /* ---------- the detail sheet and the full-screen viewer ---------- */

  function closeSheet() {
    document.querySelector('.cv-sheet-wrap')?.remove();
    if (cur) cur.sel = null;
    cur?.el.querySelectorAll('.cv-t.sel').forEach(x => x.classList.remove('sel'));
  }

  function colourDiff(text, kind) {
    const e = esc(text);
    if (kind !== 'edit' && kind !== 'write') return e;
    return e.split('\n').map(l => (l.startsWith('- ') ? `<span class="x">${l}</span>` : l.startsWith('+ ') ? `<span class="g">${l}</span>` : l)).join('\n');
  }

  async function showCall(callId, full = false) {
    const c = dataOf(cur.id).calls.get(callId);
    if (!c) return;
    cur.sel = callId;
    cur.el.querySelectorAll('.cv-t').forEach(x => x.classList.toggle('sel', x.dataset.call === callId));
    const [title, l1, l2] = SHEET[c.kind] ?? SHEET.other;
    const head = c.kind === 'mcp' ? `${isChorus(c) ? 'Chorus' : c.tool.replace(/^mcp:/, '')} · ${c.target}` : title;
    const meta = [c.ms != null ? `${Math.max(1, Math.round(c.ms / 1000))} s` : '', c.word ?? (c.status === 'running' ? 'running' : c.status === 'failed' ? 'failed' : '')].filter(Boolean).join(' · ');
    let wrap = document.querySelector('.cv-sheet-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'cv-sheet-wrap';
      document.body.append(wrap);
      wrap.addEventListener('click', e => (e.target === wrap || e.target.closest('[data-x="close"]')) && closeSheet());
      wrap.addEventListener('click', e => e.target.closest('[data-x="all"]') && void showCall(cur.sel, true));
    }
    wrap.innerHTML = `<div class="cv-sheet" role="dialog" aria-label="${esc(head)}"><div class="grab"></div><h3>${esc(head)}</h3><div class="meta">${esc(meta)}</div><div class="cv-sheet-body"><div class="spin"></div></div></div>`;
    let r;
    try {
      r = await h.api('GET', `/api/chats/${encodeURIComponent(cur.id)}/calls/${encodeURIComponent(callId)}${full ? '?full=1' : ''}`);
    } catch (e) {
      r = { error: e.message };
    }
    if (!wrap.isConnected || cur?.sel !== callId) return;
    const body = wrap.querySelector('.cv-sheet-body');
    if (r.error) return void (body.innerHTML = `<div class="muted">${esc(r.error)}</div><div class="bt"><button class="btn" data-x="close">Close</button></div>`);
    body.innerHTML = `<div class="lbl">${esc(l1)}</div><pre>${esc(r.input || c.target)}</pre><div class="lbl">${esc(l2)}</div><pre>${colourDiff(r.output || '(nothing came back)', r.kind ?? c.kind)}${r.capped ? '\n<span class="d">… cut at 256 KB</span>' : ''}</pre><div class="bt">${r.cut && !full ? '<button class="btn" data-x="all">Show all</button>' : ''}<button class="btn" data-x="close">Close</button></div>`;
  }

  function viewer(title, sub, inner) {
    document.querySelector('.cv-full')?.remove();
    const el = document.createElement('div');
    el.className = 'cv-full';
    el.innerHTML = `<div class="cv-full-top"><button class="pv-back" data-x="back" aria-label="Back">‹</button><div class="t"><b>${esc(title)}</b><span>${esc(sub)}</span></div></div><div class="cv-full-body">${inner}</div>`;
    el.addEventListener('click', e => {
      const x = e.target.closest('[data-x]')?.dataset.x;
      if (x === 'back') el.remove();
    });
    document.body.append(el);
    return el;
  }

  /** A file card's Open (or a click on the card): the file viewer decides where it opens (file-viewer.js openFile). */
  function openArtifact(rid) {
    const a = dataOf(cur.id).cards.find(c => c.type === 'artifact' && String(c.id) === String(rid));
    if (a) h.openFile({ chat: cur.id, r: a.id, title: a.title, link: a.link, target: a.target });
  }

  /* ---------- sending ---------- */

  async function sendBox() {
    const box = cur?.el.querySelector('.cv-in');
    const text = box?.value.trim();
    if (!box || !text || pending) return;
    const id = cur.id;
    pending = { text, since: Date.now() };
    notice = null;
    box.value = '';
    grow(box);
    picker?.close();
    draw({ keep: 'bottom' });
    let r;
    try {
      r = await h.api('POST', `/api/chats/${encodeURIComponent(id)}/say`, { text });
    } catch (e) {
      r = { error: e.message };
    }
    if (cur?.id !== id) return void (pending = null);
    if (r.error || r.result !== 'sent') {
      // not sent: the text goes back in the box, with what happened in plain words
      pending = null;
      const b = cur.el.querySelector('.cv-in');
      if (b && !b.value) {
        b.value = text;
        grow(b);
      }
      notice = { text: r.error ?? r.message ?? 'Not sent.', raw: r.result === 'ended' || r.result === 'held' };
      draw({ keep: 'bottom' });
      return;
    }
    // the user turn arrives from the transcript; the pending bubble goes then (or after 20 s, if the CLI never writes it)
    setTimeout(() => {
      if (pending?.text === text) {
        pending = null;
        draw();
      }
    }, 20_000);
  }

  function insert(ch) {
    const box = cur?.el.querySelector('.cv-in');
    if (!box) return;
    const at = box.selectionStart ?? box.value.length;
    const pre = box.value.slice(0, at);
    const add = (pre && !/\s$/.test(pre) ? ' ' : '') + ch;
    box.value = pre + add + box.value.slice(box.selectionEnd ?? at);
    box.focus();
    box.setSelectionRange(at + add.length, at + add.length);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* ---------- events ---------- */

  function onClick(e) {
    const b = e.target.closest('[data-cv]');
    if (!b || !cur) return;
    const what = b.dataset.cv;
    if (what === 'fold') {
      const k = b.dataset.key;
      open.has(k) ? open.delete(k) : open.add(k);
      draw({ keep: 'none' });
    } else if (what === 'call') void showCall(b.dataset.call);
    else if (what === 'note') void toggleNote(Number(b.dataset.seq));
    else if (what === 'open') h.openChat(b.dataset.arg);
    else if (what === 'art') openArtifact(b.dataset.arg);
    else if (what === 'path') h.openFile({ chat: cur.id, f: b.dataset.arg, title: b.dataset.arg.split('/').pop() });
    else if (what === 'raw') h.toRaw();
    else if (what === 'send') void sendBox();
    else if (what === 'ins') insert(b.dataset.arg);
    else if (what === 'key' || what === 'stop') void h.api('POST', `/api/chats/${encodeURIComponent(cur.id)}/key`, { key: what === 'stop' ? 'esc' : b.dataset.arg }).catch(() => {});
    else if (what === 'dia') {
      const svg = b.closest('.cv-dia')?.querySelector('svg')?.outerHTML;
      if (svg) viewer('Diagram', 'mermaid', `<div class="cv-dia-full">${svg}</div>`);
    }
  }

  function onScroll(e) {
    const s = e.target;
    // the reader is at the bottom (or near it): the view keeps following what comes in, also when the box below grows
    if (cur) cur.stick = s.scrollHeight - s.scrollTop - s.clientHeight < 40;
    const d = cur && dataOf(cur.id);
    if (!d?.more || cur.loadingOlder || s.scrollTop > 80) return;
    cur.loadingOlder = true;
    const id = cur.id;
    void load(id, d.from)
      .then(() => cur?.id === id && draw({ keep: 'older' }))
      .catch(() => {})
      .finally(() => cur && (cur.loadingOlder = false));
  }

  /* ---------- the page's side ---------- */

  return {
    /** Shows chat `id` in `el` (the chat column's view slot). The first page is fetched once; later it only gets what is new. */
    async mount(el, id) {
      if (cur?.id !== id) {
        closeSheet();
        pending = null;
        notice = null;
      }
      cur = { id, el, sel: null, stick: true };
      el.innerHTML = `<div class="cv-banner" hidden></div><div class="cv-stream" role="log" aria-live="polite"></div><div class="cv-footwrap"></div>`;
      el.addEventListener('click', onClick);
      const stream = el.querySelector('.cv-stream');
      stream.addEventListener('scroll', onScroll, { passive: true });
      // the stream gets shorter when the box grows ("Working" and Stop appear above it, a long message wraps): a reader who was at the
      // bottom stays there, so the running call's line ("Running sleep 10") is not left behind the box (phone e2e, 2026-11-26)
      follow?.disconnect();
      follow = new ResizeObserver(() => {
        if (cur?.el === el && cur.stick) stream.scrollTop = stream.scrollHeight;
      });
      follow.observe(stream);
      el.addEventListener('input', e => e.target.classList?.contains('cv-in') && grow(e.target));
      el.addEventListener('keydown', e => {
        // a hardware keyboard: Enter sends, Shift+Enter is a new line; never mid-word (an input method building a word)
        if (!e.target.classList?.contains('cv-in') || composing(e) || e.key !== 'Enter' || e.shiftKey || picker?.isOpen()) return;
        if (h.size() === 'phone' && matchMedia('(hover: none), (pointer: coarse)').matches) return;
        e.preventDefault();
        void sendBox();
      });
      drawFoot();
      // wider than a phone the box takes the keys at once, as the terminal does in the Terminal view (a phone's keyboard would
      // cover the conversation, so there it waits for a tap)
      if (h.size() !== 'phone') el.querySelector('.cv-in:not([disabled])')?.focus({ preventScroll: true });
      const d = dataOf(id);
      draw({ keep: 'bottom' });
      if (!d.loaded) {
        try {
          await load(id);
        } catch {
          /* the page shows an error line */
        }
      }
      if (cur?.id !== id) return;
      draw({ keep: 'bottom' });
      const last = Math.max(0, ...dataOf(id).turns.keys());
      h.send({ t: 'cv', id, seq: last });
      clearInterval(timer);
      timer = setInterval(() => {
        const n = cur?.el.querySelector('[data-cv-clock]');
        if (n) n.textContent = workText(chatOf(cur.id));
      }, 1000);
    },
    /** The view is gone (the Terminal view, another chat, another screen): the server stops sending. */
    unmount() {
      if (!cur) return;
      h.send({ t: 'cv' });
      clearInterval(timer);
      picker?.destroy();
      picker = null;
      seen?.disconnect();
      closeSheet();
      document.querySelector('.cv-full')?.remove();
      cur = null;
    },
    /** The page's state changed (the chat's state, a sub thread's): the cards and the bottom follow. */
    refresh() {
      if (!cur?.el?.isConnected) return;
      drawFoot();
      const c = chatOf(cur.id);
      const k = JSON.stringify([c?.state, (dataOf(cur.id).cards ?? []).map(x => chatOf(x.id)?.state)]);
      if (cur.k !== k) {
        cur.k = k;
        draw();
      }
      const banner = cur.el.querySelector('.cv-banner');
      const menu = h.menuShown(c);
      banner.hidden = !menu;
      if (menu && !banner.innerHTML) banner.innerHTML = `<span>${esc(h.agentName(c?.agent))} is showing a menu on its own screen.</span><button class="btn sm" data-cv="raw">Open Terminal</button>`;
      if (!menu) banner.innerHTML = '';
    },
    /** A websocket message: `cv` is what is new for the chat this view shows. */
    onMessage(m) {
      if (m.t !== 'cv' || !m.id) return false;
      const d = dataOf(m.id);
      if (!d.loaded) return true;
      merge(d, m);
      if (pending && (m.turns ?? []).some(t => t.role === 'user' && !t.note)) pending = null;
      if (cur?.id === m.id) draw();
      return true;
    },
    shows: id => cur?.id === id,
    /** The agent's own commands for the "/" list: they come with the chat's first page (GET turns). */
    nativeCommands: id => data.get(id)?.nativeCommands ?? [],
    /** The chat this view shows now, if any. */
    shown: () => cur?.id,
    /** Forget a chat's data (it was deleted). */
    drop(id) {
      data.delete(id);
    },
  };
}
