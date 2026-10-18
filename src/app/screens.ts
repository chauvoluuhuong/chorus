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
export const chip = (key: string, label: string, hit: string): Seg[] => [[` ${key} `, BTN, hit], [` ${label}`, T.fg, hit]];
const hints = (...parts: Seg[][]): RichLine => parts.flatMap((p, i) => (i ? ([['   ']] as Seg[]).concat(p) : p));

/* ---------- New chat ---------- */

export interface NewChatForm {
  agent: number;
  model: number;
  folder: string;
  skip: boolean;
  /** 0 agent, 1 model, 2 project, 3 permissions, 4 start */
  focus: number;
  error: string;
}

export interface NewChatInfo {
  /** model list for an agent (first is "default") */
  models(agent: Agent): string[];
  /** short plan text under each agent: "5h 62%", "quota ok" … */
  quota: Partial<Record<Agent, { text: string; level: 'ok' | 'warn' | 'err' | 'dim' }>>;
  recent: string[];
  skipFlag: Record<Agent, string>;
}

export const newChatForm = (preset: { agent?: string; model?: string; folder: string; models: (a: Agent) => string[] }): NewChatForm => {
  const agent = Math.max(0, AGENTS.indexOf((preset.agent ?? 'claude') as Agent));
  return { agent, model: Math.max(0, preset.models(AGENTS[agent]).indexOf(preset.model ?? 'default')), folder: preset.folder, skip: false, focus: 4, error: '' };
};

export function newChatLines(f: NewChatForm, info: NewChatInfo): PaneLine[] {
  const label = (n: number, text: string): Seg => [text.padEnd(13), f.focus === n ? join('1', T.chorus) : T.dim];
  const chipText = (text: string, on: boolean, hit: string, color?: string): Seg => [on ? ` ${text} ` : ` ${text} `, on ? join('1', color ?? T.fg, T.bgSel) : join(color ?? T.fg), hit];
  const agent = AGENTS[f.agent];
  const quotaStyle = { ok: T.ok, warn: T.warn, err: T.err, dim: T.dim };
  const models = info.models(agent);
  const out: PaneLine[] = [
    [['New chat', join('1', T.chorus)]],
    '',
    [label(0, 'Agent'), ...AGENTS.flatMap((a, i): Seg[] => [chipText(a, i === f.agent, `agent:${i}`, agentStyle(a)), ['  ']])],
    [['             '], ...AGENTS.flatMap((a): Seg[] => {
      const q = info.quota[a];
      return [[(q?.text ?? '').padEnd(a.length + 4), q ? quotaStyle[q.level] : T.dim]];
    })],
    '',
    [label(1, 'Model'), ...models.slice(0, 8).flatMap((m, i): Seg[] => [chipText(m, i === f.model, `model:${i}`), [' ']])],
    '',
    { line: [label(2, 'Project'), [home(f.folder), f.focus === 2 ? T.fg : LINK, 'folder'], f.focus === 2 ? ['▌', T.chorus] : ['  ▾', T.dim]], hit: 'folder' },
    [['             '], ['recent: ', T.dim], ...info.recent.slice(0, 3).flatMap((r, i): Seg[] => [[home(r), LINK, `recent:${i}`], ['  ']]), ['· or type any folder', T.dim]],
    '',
    { line: [label(3, 'Permissions'), [f.skip ? '[x]' : '[ ]', f.skip ? T.warn : T.fg, 'skip'], [' Skip permission prompts', T.fg, 'skip'], ['  ' + info.skipFlag[agent], T.dim]], hit: 'skip' },
    f.skip
      ? [['             The agent runs every command and edit without asking.', T.warn]]
      : [['             off: the agent asks, and Chorus shows it in the approvals inbox', T.dim]],
    ...(f.skip ? [[['             Nothing reaches the approvals inbox for this chat.', T.warn]] as Seg[]] : []),
    '',
    [['             '], [' ⏎ Start chat ', f.focus === 4 ? join('1', T.fgBrand, T.bgBrand) : BTN, 'start']],
  ];
  if (f.error) out.push('', [['  ! ' + f.error, T.err]]);
  return out;
}

export const NEW_CHAT_HINT: RichLine = hints(chip('⏎', 'start', 'start'), chip('tab', 'next field', 'next'), [[' ←/→ ', BTN], [' change']], [[' space ', BTN], [' tick']], chip('esc', 'back', 'back'));

/** Keys of the form. Returns what the caller must do. Printable keys edit the folder only while it has the focus. */
export function newChatKey(f: NewChatForm, key: string, info: Pick<NewChatInfo, 'models'>): 'start' | 'cancel' | undefined {
  f.error = '';
  if (key === '\x1b') return 'cancel';
  if (key === '\r' || key === '\n') return 'start';
  if (key === '\t' || key === '\x1b[B') f.focus = (f.focus + 1) % 5;
  else if (key === '\x1b[Z' || key === '\x1b[A') f.focus = (f.focus + 4) % 5;
  else if (f.focus === 0 && (key === '\x1b[C' || key === '\x1b[D')) {
    f.agent = (f.agent + (key === '\x1b[C' ? 1 : 2)) % 3;
    f.model = 0; // the model list depends on the agent
  } else if (f.focus === 1 && (key === '\x1b[C' || key === '\x1b[D')) {
    const n = info.models(AGENTS[f.agent]).length;
    f.model = (f.model + (key === '\x1b[C' ? 1 : n - 1)) % Math.max(1, n);
  } else if (f.focus === 3 && key === ' ') f.skip = !f.skip;
  else if (f.focus === 2) {
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
  if (id === 'next') f.focus = (f.focus + 1) % 5;
  else if (id.startsWith('agent:')) {
    f.agent = Number(id.slice(6));
    f.model = 0;
    f.focus = 0;
  } else if (id.startsWith('model:')) {
    f.model = Number(id.slice(6));
    f.focus = 1;
  } else if (id === 'folder') f.focus = 2;
  else if (id.startsWith('recent:')) {
    f.folder = info.recent[Number(id.slice(7))] ?? f.folder;
    f.focus = 2;
  } else if (id === 'skip') {
    f.skip = !f.skip;
    f.focus = 3;
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
/** Middle ellipsis: a long command keeps its start and its end (the file name) and still leaves room for the risk tag. */
const short = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, Math.ceil((n - 1) / 2))}…${s.slice(s.length - Math.floor((n - 1) / 2))}`);
const waitText = (s: number) => (s < 60 ? `${Math.max(1, Math.floor(s))}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`);

export function approvalLines(items: ApprovalItem[], sel: number, decided: Decided[]): PaneLine[] {
  const out: PaneLine[] = [[['Approvals', join('1', T.chorus)], [`  ·  ${items.length} waiting`, T.dim]], ''];
  if (!items.length) out.push([['Nothing is waiting for you.', T.dim]], '');
  items.forEach((a, i) => {
    const on = i === sel;
    // after 1 minute the wait turns amber: the agent is idle while it waits
    out.push({ line: [[on ? '▸ ' : '  ', T.chorus], [a.title, join('1', T.fg)], ['  '], [a.agent, agentStyle(a.agent)], ['  '], [`waiting ${waitText(a.waiting)}`, a.waiting > 60 ? T.warn : T.dim]], hit: `row:${a.id}`, sel: on });
    out.push({ line: [['    '], [short(home(a.what.split(' · ').slice(-1)[0]), 52), T.warn], ['   '], [`[${a.risk.label}]`, riskStyle[a.risk.level]]], hit: `row:${a.id}`, sel: on });
    out.push([['    '], [' y Approve ', BTN_OK, `approve:${a.id}`], [' '], [' x Deny ', BTN_BAD, `deny:${a.id}`], [' '], [' ⏎ Open chat ', BTN, `open:${a.id}`]], '');
  });
  out.push([['Decided', T.dim]]);
  if (!decided.length) out.push([['  nothing yet', T.dim]]);
  for (const d of decided.slice(0, 6)) out.push([['  '], d.decision === 'approved' ? ['✓ approved', T.ok] : ['✗ denied  ', T.err], ['  '], [short(home(d.what.split(' · ').slice(-1)[0]), 44).padEnd(46)], [d.agent.padEnd(8), agentStyle(d.agent)], [d.time, T.dim]]);
  return out;
}

export const APPROVALS_HINT: RichLine = hints([[' ↑↓ ', BTN], [' select']], chip('y', 'approve', 'approve'), chip('x', 'deny', 'deny'), chip('⏎', 'open chat', 'open'), chip('esc', 'back', 'back'));

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

export function memoryLines(items: MemoryItem[], sel: number, where: string): PaneLine[] {
  const out: PaneLine[] = [[['Memory', join('1', T.chorus)], [`  ·  all projects`, T.dim], [`      ${where}`, T.dim]], ''];
  if (!items.length) out.push([['No chats recorded yet.', T.dim]]);
  items.forEach((m, i) => {
    const t = (m.child ? '↳ ' : '') + m.title;
    out.push({ line: [[i === sel ? '▸ ' : '  ', T.chorus], [(t.length > 24 ? t.slice(0, 23) + '…' : t).padEnd(25), T.fg], [(m.project.length > 13 ? m.project.slice(0, 12) + '…' : m.project).padEnd(15), T.dim], [m.agent.padEnd(8), agentStyle(m.agent)], [`${m.turns} turns`.padEnd(10)], [m.ago, T.dim]], hit: `row:${m.id}`, sel: i === sel });
  });
  const cur = items[sel];
  if (cur) {
    out.push('', [[`  ${cur.title}`, join('1', T.fg)]]);
    out.push([['    asked  ', T.dim], [cur.asked.slice(0, 90)]], [['    last   ', T.dim], [cur.last.slice(0, 90)]], [['    files  ', T.dim], [cur.files.slice(0, 90) || '—']]);
  }
  return out;
}

export const MEMORY_HINT: RichLine = hints(chip('⏎', 'open chat', 'open'), chip('h', 'continue with another agent', 'handoff'), chip('esc', 'back', 'back'));

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
  const out: PaneLine[] = [[['Skills', join('1', T.chorus)], ['  ·  one library', T.dim], [`      ${where}`, T.dim]], ''];
  if (!items.length) out.push([['The library is empty. Put a skill (a folder with SKILL.md) in it, or import one below.', T.dim]]);
  else out.push([['      NAME             WHAT IT DOES                          ', T.dim], ['claude ', T.claude], ['codex ', T.codex], ['agy', T.agy]]);
  items.forEach((s, i) => {
    const desc = s.description.length > 36 ? s.description.slice(0, 35) + '…' : s.description;
    out.push({ line: [[i === sel ? '▸ ' : '  ', T.chorus], s.on ? ['[on] ', T.ok] : ['[off]', T.dim], [' '], [s.name.padEnd(17).slice(0, 17), T.fg], [desc.padEnd(38), T.dim], ...(s.on ? ([['✓      ✓     ✓', T.ok]] as Seg[]) : ([['—      —     —', T.dim]] as Seg[]))], hit: `row:${s.folder}`, sel: i === sel });
  });
  out.push('', [['Found in the agents\' own folders', T.dim]]);
  if (!found.length) out.push([['  nothing to import', T.dim]]);
  for (const f of found.slice(0, 8)) out.push([['  '], [f.name.padEnd(18).slice(0, 18)], [f.from.padEnd(20), T.dim], [(f.agent === 'shared' ? 'codex agy' : f.agent).padEnd(11), f.agent === 'shared' ? T.codex : agentStyle(f.agent)], ['import ›', LINK, `import:${f.dir}`]]);
  out.push('', [['Reach  ', T.dim], ['[x]', T.ok], [' every project you open in Chorus']], [['       '], ['[ ] also when you run claude, codex or agy without Chorus  (later, TD-1)', T.dim]]);
  return out;
}

export const SKILLS_HINT: RichLine = hints(chip('⏎', 'on/off', 'toggle'), chip('i', 'import', 'import'), chip('esc', 'back', 'back'));
