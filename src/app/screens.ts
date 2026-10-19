// The full-area screens of the mockup (docs/mockups/chorus-cli.html): New chat, Approvals, Memory, Skills.
// Pure: state in, pane lines out, plus small key reducers, so each screen is testable without a terminal or a process.
// Clickable pieces carry hit ids (compositor.ts): buttons are chips, links are underlined, list rows are whole rows.
import { agentStyle, BTN, BTN_BAD, BTN_OK, LINK, T, type PaneLine, type RichLine, type Seg } from './compositor.ts';
import type { Risk } from './risk.ts';

const AGENTS = ['claude', 'codex', 'agy'] as const;
type Agent = (typeof AGENTS)[number];
const join = (...p: (string | undefined | false)[]) => p.filter(Boolean).join(';');
const SEL = join('1', T.fg, T.bgSel);
const home = (p: string) => p.replace(process.env.HOME ?? '\0', '~');

/** A key hint that is also a button: the same chip teaches the shortcut and takes the click. */
export const chip = (key: string, label: string, hit = ''): Seg[] => [[` ${key}`, join(T.chorus, T.bgSel), hit], [` ${label} `, join(T.fg, T.bgSel), hit]];
/** The bottom row: one chip per key ("⏎ start"), two cells apart, like the mockup's F-key bar. */
export const hints = (...parts: Seg[][]): RichLine => parts.flatMap((p, i) => (i ? ([['  ']] as Seg[]).concat(p) : p));

/* ---------- New chat ---------- */

export interface NewChatForm {
  agent: number;
  model: number;
  /** index into the effort list of the chosen agent and model (0 = default) */
  effort: number;
  folder: string;
  skip: boolean;
  /** a handoff: the folder is the source chat's and cannot be changed; the title names the chat that is continued */
  from?: { title: string };
  /** 0 agent, 1 model, 2 effort, 3 project, 4 permissions, 5 start */
  focus: number;
  error: string;
}
const FIELDS = 6;

export interface NewChatInfo {
  /** model list for an agent (first is "default") */
  models(agent: Agent): string[];
  /** effort levels for an agent and model (first is "default") */
  efforts(agent: Agent, model: string): string[];
  /** short plan text under each agent: "5h 62%", "quota ok" … */
  quota: Partial<Record<Agent, { text: string; level: 'ok' | 'warn' | 'err' | 'dim' }>>;
  recent: string[];
  skipFlag: Record<Agent, string>;
}

export const newChatForm = (preset: { agent?: string; model?: string; effort?: string; folder: string; models: (a: Agent) => string[]; efforts: (a: Agent, model: string) => string[] }): NewChatForm => {
  const agent = Math.max(0, AGENTS.indexOf((preset.agent ?? 'claude') as Agent));
  const model = Math.max(0, preset.models(AGENTS[agent]).indexOf(preset.model ?? 'default'));
  const effort = Math.max(0, preset.efforts(AGENTS[agent], preset.models(AGENTS[agent])[model]).indexOf(preset.effort ?? 'default'));
  return { agent, model, effort, folder: preset.folder, skip: false, focus: FIELDS - 1, error: '' };
};

export function newChatLines(f: NewChatForm, info: NewChatInfo): PaneLine[] {
  const label = (n: number, text: string): Seg => [text.padEnd(11), f.focus === n ? join('1', T.chorus) : T.dim];
  const under = '           '; // the values column, under the chips
  const chipText = (text: string, on: boolean, hit: string, color?: string): Seg => [on ? ` ${text} ` : ` ${text} `, on ? join('1', color ?? T.fg, T.bgSel) : join(color ?? T.fg), hit];
  const agent = AGENTS[f.agent];
  const quotaStyle = { ok: T.ok, warn: T.warn, err: T.err, dim: T.dim };
  const models = info.models(agent);
  const efforts = info.efforts(agent, models[f.model] ?? 'default');
  const out: PaneLine[] = [
    [[f.from ? `Continue "${f.from.title}" in a new chat` : 'New chat', join('1', T.chorus)]],
    '',
    [label(0, 'Agent'), ...AGENTS.flatMap((a, i): Seg[] => [chipText(a, i === f.agent, `agent:${i}`, agentStyle(a)), ['    ']])],
    // what is left of each agent's plan, under its chip; nothing known = no limit hit yet
    [[under], ...AGENTS.flatMap((a): Seg[] => {
      const q = info.quota[a];
      return [[(q?.text ?? 'quota ok').padEnd(a.length + 6), q ? quotaStyle[q.level] : T.ok]];
    })],
    '',
    [label(1, 'Model'), ...models.slice(0, 8).flatMap((m, i): Seg[] => [chipText(m, i === f.model, `model:${i}`), [' ']])],
    '',
    [label(2, 'Effort'), ...efforts.flatMap((e, i): Seg[] => [chipText(e, i === f.effort, `effort:${i}`), [' ']]), ['  how hard the model thinks', T.dim]],
    '',
    f.from ? [label(3, 'Project'), [home(f.folder), T.dim], ['  same folder as the chat it continues', T.dim]] : f.focus === 3 ? [label(3, 'Project'), [home(f.folder), T.fg, 'folder'], ['▌', T.chorus]] : [label(3, 'Project'), [home(f.folder) + ' ▾', LINK, 'folder']],
    f.from ? '' : info.recent.length
      ? [[under], ['recent: ', T.dim], ...info.recent.slice(0, 3).flatMap((r, i): Seg[] => [[home(r), T.dim, `recent:${i}`], ['  ']]), ['· or type any folder', T.dim]]
      : [[under], ['type any folder', T.dim]],
    '',
    [label(4, 'Permissions'), [' '], [f.skip ? '[x]' : '[ ]', f.skip ? T.warn : T.fg, 'skip'], [' Skip permission prompts', T.fg, 'skip'], ['  ' + info.skipFlag[agent], T.dim]],
    f.skip
      ? [[under + 'The agent runs every command and edit without asking.', T.warn]]
      : [[under + 'off: the agent asks, and Chorus shows it in the approvals inbox', T.dim]],
    ...(f.skip ? [[[under + 'Nothing reaches the approvals inbox for this chat.', T.warn]] as Seg[]] : ['']),
    '',
    // the main button is filled with the brand colour, like the mockup's (⏎ starts from any field)
    [[' ⏎ Start chat ', join('1', T.fgBrand, T.bgBrand), 'start']],
  ];
  if (f.error) out.push('', [['  ! ' + f.error, T.err]]);
  return out;
}

export const NEW_CHAT_HINT: RichLine = hints(chip('⏎', 'start', 'start'), chip('tab', 'next field', 'next'), chip('←/→', 'change'), chip('space', 'tick'));

/** Keys of the form. Returns what the caller must do. Printable keys edit the folder only while it has the focus. */
export function newChatKey(f: NewChatForm, key: string, info: Pick<NewChatInfo, 'models' | 'efforts'>): 'start' | 'cancel' | undefined {
  f.error = '';
  if (key === '\x1b') return 'cancel';
  if (key === '\r' || key === '\n') return 'start';
  if (key === '\t' || key === '\x1b[B') f.focus = (f.focus + 1) % FIELDS;
  else if (key === '\x1b[Z' || key === '\x1b[A') f.focus = (f.focus + FIELDS - 1) % FIELDS;
  else if (f.focus === 0 && (key === '\x1b[C' || key === '\x1b[D')) {
    f.agent = (f.agent + (key === '\x1b[C' ? 1 : 2)) % 3;
    f.model = 0; // the model list depends on the agent, and the effort list on the model
    f.effort = 0;
  } else if (f.focus === 1 && (key === '\x1b[C' || key === '\x1b[D')) {
    const n = info.models(AGENTS[f.agent]).length;
    f.model = (f.model + (key === '\x1b[C' ? 1 : n - 1)) % Math.max(1, n);
    f.effort = Math.min(f.effort, info.efforts(AGENTS[f.agent], info.models(AGENTS[f.agent])[f.model]).length - 1);
  } else if (f.focus === 2 && (key === '\x1b[C' || key === '\x1b[D')) {
    const n = info.efforts(AGENTS[f.agent], info.models(AGENTS[f.agent])[f.model]).length;
    f.effort = (f.effort + (key === '\x1b[C' ? 1 : n - 1)) % Math.max(1, n);
  } else if (f.focus === 4 && key === ' ') f.skip = !f.skip;
  else if (f.focus === 3 && !f.from) {
    if (key === '\x7f' || key === '\b') f.folder = f.folder.slice(0, -1);
    else if (key === '\x15') f.folder = '';
    else if (key.length >= 1 && key >= ' ' && !key.startsWith('\x1b')) f.folder += key;
  }
  return undefined;
}

/** A click on one of the form's regions. Returns what the caller must do. */
export function newChatHit(f: NewChatForm, id: string, info: NewChatInfo): 'start' | 'cancel' | undefined {
  f.error = '';
  if (id === 'start') return 'start';
  if (id === 'back') return 'cancel';
  if (id === 'next') f.focus = (f.focus + 1) % FIELDS;
  else if (id.startsWith('agent:')) {
    f.agent = Number(id.slice(6));
    f.model = 0;
    f.effort = 0;
    f.focus = 0;
  } else if (id.startsWith('model:')) {
    f.model = Number(id.slice(6));
    f.effort = Math.min(f.effort, info.efforts(AGENTS[f.agent], info.models(AGENTS[f.agent])[f.model]).length - 1);
    f.focus = 1;
  } else if (id.startsWith('effort:')) {
    f.effort = Number(id.slice(7));
    f.focus = 2;
  } else if (id === 'folder') f.focus = 3;
  else if (id.startsWith('recent:') && !f.from) {
    f.folder = info.recent[Number(id.slice(7))] ?? f.folder;
    f.focus = 3;
  } else if (id === 'skip') {
    f.skip = !f.skip;
    f.focus = 4;
  }
  return undefined;
}

/* ---------- Approvals inbox ---------- */

export interface ApprovalItem {
  id: string;
  title: string;
  agent: string;
  /** seconds since the request appeared */
  waiting: number;
  /** what the agent wants to do, e.g. "Bash command · … · npm install stripe" */
  what: string;
  risk: Risk;
}

export interface Decided {
  decision: 'approved' | 'denied';
  what: string;
  agent: string;
  time: string;
}

const riskStyle = { err: T.err, warn: T.warn, dim: T.dim };
/** "Bash command" → "Run command", "Create file" → "Write file": what the request does, in the inbox's words */
const kindLabel = (k: string) => (/^(Bash|Run shell|Command)/i.test(k) ? 'Run command' : /file/i.test(k) ? k.replace(/^(Create|Overwrite)/, 'Write') : k);
/** the short form for the decided list: "Bash npm test", "Write cake.html" */
const shortKind = (k: string) => (/^(Bash|Run shell|Command)/i.test(k) ? 'Bash' : k.split(' ')[0].replace(/^(Create|Overwrite)$/, 'Write'));
/** Middle ellipsis: a long command keeps its start and its end (the file name) and still leaves room for the risk tag. */
const short = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.ceil((n - 1) / 2))}…${s.slice(s.length - Math.floor((n - 1) / 2))}`);
const waitText = (s: number) => (s < 60 ? `${Math.max(1, Math.floor(s))}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`);

export type ApprovalScope = 'this' | 'all';

export function approvalLines(items: ApprovalItem[], sel: number, decided: Decided[], scope: ApprovalScope = 'all'): PaneLine[] {
  const chip = (on: boolean, text: string, hit: string): Seg => [` ${text} `, on ? join('1', T.fg, T.bgSel) : T.dim, hit];
  const out: PaneLine[] = [[['Approvals', join('1', T.chorus)], [`  ·  ${items.length} waiting`], ['                    '], chip(scope === 'this', scope === 'this' ? 'this project ▾' : 'this project', 'scope:this'), ['  '], chip(scope === 'all', 'all projects', 'scope:all')], ''];
  if (!items.length) out.push([['Nothing is waiting for you.', T.dim]], '');
  items.forEach((a, i) => {
    const on = i === sel;
    // after 1 minute the wait turns amber: the agent is idle while it waits
    out.push({ line: [[on ? '▸ ' : '  ', T.chorus], [a.title, join('1', T.fg)], ['  '], [a.agent, agentStyle(a.agent)], ['  '], [`waiting ${waitText(a.waiting)}`, a.waiting > 60 ? T.warn : T.dim]], hit: `row:${a.id}`, sel: on });
    // "Run command:  npm install stripe   [installs a package]": the kind, then the command or the file
    const parts = a.what.split(' · ');
    const kind = parts.length > 1 ? kindLabel(parts[0]) : '';
    out.push({ line: [['    '], ...(kind ? ([[`${kind}:  `, T.dim]] as Seg[]) : []), [short(home(parts[parts.length - 1]), 52 - kind.length), T.warn], ['   '], [`[${a.risk.label}]`, riskStyle[a.risk.level]]], hit: `row:${a.id}`, sel: on });
    out.push([['  '], [' y', join(T.ok, T.bgOk), `approve:${a.id}`], [' Approve ', join(T.fg, T.bgOk), `approve:${a.id}`], ['  '], [' x', join(T.err, T.bgErr), `deny:${a.id}`], [' Deny ', join(T.fg, T.bgErr), `deny:${a.id}`], ['  '], [' ⏎', join(T.chorus, T.bgSel), `open:${a.id}`], [' Open chat ', join(T.fg, T.bgSel), `open:${a.id}`]], '');
  });
  out.push([['Decided today', T.dim]]);
  if (!decided.length) out.push([['  nothing yet', T.dim]]);
  for (const d of decided.slice(0, 6)) {
    const parts = d.what.split(' · ');
    const what = `${parts.length > 1 ? shortKind(parts[0]) + ' ' : ''}${home(parts[parts.length - 1])}`;
    out.push([['  '], d.decision === 'approved' ? ['✓ approved', T.ok] : ['✗ denied  ', T.err], ['  '], [short(what, 32).padEnd(34)], [d.agent.padEnd(9), agentStyle(d.agent)], [d.time, T.dim]]);
  }
  return out;
}

export const APPROVALS_HINT: RichLine = hints(chip('↑↓', 'select'), chip('y', 'approve', 'approve'), chip('x', 'deny', 'deny'), chip('⏎', 'open chat', 'open'), chip('esc', 'back', 'back'));

/* ---------- Memory ---------- */

export interface MemoryItem {
  id: string;
  title: string;
  child: boolean;
  project: string;
  agent: string;
  turns: number;
  ago: string;
  asked: string;
  last: string;
  files: string;
}

export function memoryLines(items: MemoryItem[], sel: number, where: string, search?: { query: string; typing: boolean }): PaneLine[] {
  const right: Seg[] = search?.typing || search?.query ? [['/ ', T.chorus], [`${search.query}${search.typing ? '▌' : ''}`, T.fg]] : [[where, T.dim], ['   '], ['/ search', T.dim, 'search']];
  const out: PaneLine[] = [[['Memory', join('1', T.chorus)], [`  ·  all projects`], ['      '], ...right], ''];
  if (!items.length) out.push([[search?.query ? `Nothing matches "${search.query}".` : 'No chats recorded yet.', T.dim]]);
  items.forEach((m, i) => {
    const t = (m.child ? '↳ ' : '') + m.title;
    out.push({ line: [[i === sel ? '▸ ' : '  ', T.chorus], [(t.length > 22 ? t.slice(0, 21) + '…' : t).padEnd(23), T.fg], [(m.project.length > 10 ? m.project.slice(0, 9) + '…' : m.project).padEnd(11), T.dim], [m.agent.padEnd(8), agentStyle(m.agent)], [`${m.turns} turns`.padEnd(10)], [m.ago, T.dim]], hit: `row:${m.id}`, sel: i === sel });
  });
  const cur = items[sel];
  if (cur) {
    out.push('', [[cur.title, join('1', T.fg)]]);
    out.push([['  asked   ', T.dim], [cur.asked.slice(0, 90)]], [['  last    ', T.dim], [cur.last.slice(0, 90)]], [['  files   ', T.dim], [cur.files.slice(0, 90) || '—']]);
  }
  return out;
}

export const MEMORY_HINT: RichLine = hints(chip('⏎', 'open chat', 'open'), chip('h', 'continue with another agent', 'handoff'), chip('/', 'search', 'search'), chip('esc', 'back', 'back'));

/* ---------- Skills ---------- */

export interface SkillItem {
  folder: string;
  name: string;
  description: string;
  on: boolean;
}
export interface FoundItem {
  name: string;
  from: string;
  agent: string;
  dir: string;
}

export function skillLines(items: SkillItem[], found: FoundItem[], sel: number, where: string): PaneLine[] {
  const out: PaneLine[] = [[['Skills', join('1', T.chorus)], ['  ·  one library'], [`             ${where}`, T.dim]], ''];
  if (!items.length) out.push([['The library is empty. Put a skill (a folder with SKILL.md) in it, or import one below.', T.dim]]);
  else out.push([['      NAME             WHAT IT DOES                          ', T.dim], ['claude ', T.claude], ['codex ', T.codex], ['agy', T.agy]]);
  items.forEach((s, i) => {
    const desc = s.description.length > 36 ? s.description.slice(0, 35) + '…' : s.description;
    out.push({ line: [[i === sel ? '▸ ' : '  ', T.chorus], s.on ? ['[on] ', T.ok] : ['[off]', T.dim], [' '], [s.name.padEnd(17).slice(0, 17), T.fg], [desc.padEnd(38), T.dim], ...(s.on ? ([['✓      ✓     ✓', T.ok]] as Seg[]) : ([['—      —     —', T.dim]] as Seg[]))], hit: `row:${s.folder}`, sel: i === sel });
  });
  out.push('', [['Found in the agents\' own folders', T.dim]]);
  if (!found.length) out.push([['  nothing to import', T.dim]]);
  for (const f of found.slice(0, 8)) out.push([['  '], [f.name.padEnd(17).slice(0, 17)], [f.from.padEnd(21), T.dim], [`${f.agent === 'shared' ? 'codex agy' : f.agent} only`.padEnd(18), f.agent === 'shared' ? T.codex : agentStyle(f.agent)], ['import ›', LINK, `import:${f.dir}`]]);
  out.push('', [['Reach  ', T.dim], ['[x]', T.ok], [' every project you open in Chorus']], [['       '], ['[ ] also when you run claude, codex or agy without Chorus  (later, TD-1)', T.dim]]);
  return out;
}

export const SKILLS_HINT: RichLine = hints(chip('⏎', 'on/off', 'toggle'), chip('e', 'edit', 'edit'), chip('n', 'new', 'new'), chip('i', 'import', 'import'), chip('esc', 'back', 'back'));

/* ---------- Artifacts ---------- */

export const ARTIFACTS_HINT: RichLine = hints(chip('↑↓', 'select'), chip('⏎ / click', 'open', 'open'), chip('f', 'show in folder', 'folder'), chip('p', 'copy path', 'copy'), chip('v', 'versions', 'versions'), chip('esc', 'back', 'back'));
