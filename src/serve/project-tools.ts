// The model's project tools (task #11 step 8), answered in `chorus serve`: get_project (what the calling chat's project has, never a
// value), propose_project_change (checks the changes, then ONE card for the user), and the text an answered proposal sends back.
// A variable's value is typed by the user on the card and goes only to ProjectSettings.setVariable: never into a request row, an
// answer, a log, an event or a reply built here.
import os from 'node:os';
import path from 'node:path';
import { NOTE_MAX, badName, type ProjectSettings } from '../core/projects.ts';
import type { Store, ThreadRow } from '../core/store.ts';
import type { ProjectRuntime } from './project-runtime.ts';

export const CHANGE_KINDS = ['set_note', 'add_folder', 'create_folder', 'remove_folder', 'set_variable', 'remove_variable'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface ProposedChange {
  kind: ChangeKind;
  path?: string;
  name?: string;
  note?: string;
  why: string;
  /** set_variable: a value the model suggests, only one that is not secret (the user may type over it) */
  suggested_value?: string;
}

/** What a propose_project_change card carries (requests.proposal): names, paths and reasons, never a value the user typed. */
export interface Proposal {
  project: string;
  changes: ProposedChange[];
  reason?: string;
  /** propose_new_project: the card creates the project (its main folder too with `create`) */
  kind?: 'new_project';
  create?: boolean;
  /** the name the card shows: the folder's name, or "This computer" */
  name?: string;
}

export const APPROVE_RESTART = 'Approve and restart this chat';
export const APPROVE = 'Approve';
export const DECLINE = 'Decline';
export const CREATE = 'Create';
export const CREATE_OPEN = 'Create and open New chat there';

/** "This computer" (~/.chorus/computer, or any …/.chorus/computer): a place for chats that belong to no project. */
export const isComputer = (dir: string) => /\/\.chorus\/computer$/.test(path.resolve(dir));
/** What a card or a reply calls a project: its folder's name, or "This computer". */
export const placeName = (dir: string) => (isComputer(dir) ? 'This computer' : path.basename(path.resolve(dir)) || dir);

export const tilde = (p: string) => {
  const h = os.homedir();
  return p === h ? '~' : p.startsWith(h + path.sep) ? `~${p.slice(h.length)}` : p;
};
const expandHome = (p: string) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

/** Changes no CLI gets live: they need the chat to restart (the third option on the card). */
export const needsRestart = (changes: ProposedChange[]) => changes.some(c => c.kind === 'remove_folder' || c.kind === 'set_variable' || c.kind === 'remove_variable');

/**
 * Checks a proposal with ProjectSettings' own rules before any card is made: every change has its why, folders are absolute (a
 * leading ~ is expanded) and allowed, a created folder's parent exists, names are valid, nothing is named twice. All errors at once.
 */
export function checkProposal(settings: ProjectSettings, folder: string, raw: unknown): { changes: ProposedChange[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 15) return { error: 'Give 1 to 15 changes.' };
  const rec = settings.get(folder);
  const errors: string[] = [];
  const out: ProposedChange[] = [];
  const seen = new Set<string>();
  raw.forEach((x, i) => {
    const c = (x ?? {}) as Record<string, unknown>;
    const kind = c.kind as ChangeKind;
    const at = `change ${i + 1} (${String(c.kind ?? '?')})`;
    const err = (m: string) => void errors.push(`${at}: ${m}`);
    if (!CHANGE_KINDS.includes(kind)) return err(`kind must be one of ${CHANGE_KINDS.join(', ')}`);
    const why = typeof c.why === 'string' ? c.why.replace(/\s+/g, ' ').trim() : '';
    if (!why) return err('every change needs its own why: one line saying what it is for');
    if (why.length > 500) return err('why is too long: at most 500 characters');
    if (kind === 'set_note') {
      if (typeof c.note !== 'string' || !c.note.trim()) return err('set_note needs the note: what the project is and how its folders relate');
      if (c.note.length > NOTE_MAX) return err(`the note is too long: ${c.note.length} characters, at most ${NOTE_MAX}`);
      if (seen.has('note')) return err('the note is set twice');
      seen.add('note');
      return void out.push({ kind, note: c.note.trim(), why });
    }
    if (kind === 'add_folder' || kind === 'create_folder' || kind === 'remove_folder') {
      if (typeof c.path !== 'string' || !c.path.trim()) return err('it needs the folder\'s absolute path');
      const p = expandHome(c.path.trim());
      if (!path.isAbsolute(p)) return err(`the folder must be an absolute path: ${c.path}`);
      const d = path.resolve(p);
      if (seen.has(`dir:${d}`)) return err(`${tilde(d)} is named twice`);
      seen.add(`dir:${d}`);
      const listed = rec.folders.some(f => f.path === d);
      if (kind === 'remove_folder') {
        if (!listed) return err(`${tilde(d)} is not a working folder of this project`);
      } else {
        if (listed) return err(`${tilde(d)} is already a working folder of this project`);
        const bad = settings.checkFolder(folder, d, { create: kind === 'create_folder' });
        if (bad) return err(kind === 'add_folder' && / does not exist$/.test(bad) ? `${bad}: to make a new folder use create_folder` : bad);
      }
      return void out.push({ kind, path: d, why });
    }
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (seen.has(`var:${name}`)) return err(`${name} is named twice`);
    seen.add(`var:${name}`);
    if (kind === 'remove_variable') {
      if (!rec.variables.some(v => v.name === name)) return err(`${name || '(no name)'} is not a variable of this project`);
      return void out.push({ kind, name, why });
    }
    const bad = badName(name);
    if (bad) return err(bad);
    if (c.suggested_value !== undefined && (typeof c.suggested_value !== 'string' || c.suggested_value.length > 500)) return err('suggested_value must be text of at most 500 characters');
    return void out.push({ kind, name, why, ...(typeof c.suggested_value === 'string' && c.suggested_value ? { suggested_value: c.suggested_value } : {}) });
  });
  return errors.length ? { error: `Nothing was proposed. Fix these and call propose_project_change again:\n- ${errors.join('\n- ')}` } : { changes: out };
}

/**
 * propose_new_project's arguments checked before any card: the main folder (ProjectSettings.checkNewProject: not /, home, Chorus's
 * own folders or an existing project), the note, and the folders and variables with checkProposal's own rules. All errors at once.
 */
export function checkNewProject(settings: ProjectSettings, raw: Record<string, unknown>, hasChat: (dir: string) => boolean): { proposal: Proposal } | { error: string } {
  const errors: string[] = [];
  const f = typeof raw.folder === 'string' ? expandHome(raw.folder.trim()) : '';
  const create = raw.create === true;
  const folder = f && path.isAbsolute(f) ? path.resolve(f) : '';
  if (!folder) errors.push(`folder: the project's main folder must be an absolute path${raw.folder ? `: ${String(raw.folder)}` : ''}`);
  else {
    const bad = settings.checkNewProject(folder, { create, hasChat: hasChat(folder) });
    if (bad) errors.push(`folder: ${bad}`);
  }
  const why = typeof raw.why === 'string' ? raw.why.replace(/\s+/g, ' ').trim() : '';
  if (!why) errors.push('why: say in one or two lines why the user wants this project');
  else if (why.length > 1000) errors.push('why is too long: at most 1000 characters');
  const changes: unknown[] = [];
  if (typeof raw.note !== 'string' || !raw.note.trim()) errors.push('note: give the description: what the project is and how its folders relate');
  else changes.push({ kind: 'set_note', note: raw.note, why: 'the description of the new project' });
  const folders = raw.folders ?? [];
  const variables = raw.variables ?? [];
  if (!Array.isArray(folders) || folders.length > 12) errors.push('folders: a list of at most 12 folders');
  else for (const x of folders) { const o = (x ?? {}) as Record<string, unknown>; changes.push({ kind: o.create === true ? 'create_folder' : 'add_folder', path: o.path, why: o.why }); }
  if (!Array.isArray(variables) || variables.length > 12) errors.push('variables: a list of at most 12 variables');
  else for (const x of variables) { const o = (x ?? {}) as Record<string, unknown>; changes.push({ kind: 'set_variable', name: o.name, why: o.why, suggested_value: o.suggested_value }); }
  let checked: ProposedChange[] = [];
  if (folder && changes.length) {
    const ok = checkProposal(settings, folder, changes);
    if ('error' in ok) errors.push(...ok.error.split('\n- ').slice(1).map(e => e.replace(/^change (\d+) \((\w+)\)/, (_m, _n, k) => (k === 'set_note' ? 'note' : k === 'set_variable' ? 'variable' : 'folder')).replace(/: to make a new folder use create_folder$/, ': set create on it to make it')));
    else checked = ok.changes;
  }
  if (errors.length) return { error: `Nothing was proposed. Fix these and call propose_new_project again:\n- ${errors.join('\n- ')}` };
  return { proposal: { kind: 'new_project', project: folder, create, name: placeName(folder), changes: checked, reason: why } };
}

/** The new-project card: its question, what it makes, and Create / Create and open New chat there / Decline. */
export function newProjectCard(p: Proposal): { question: string; details: string; options: string[] } {
  const name = path.basename(p.project) || p.project;
  const details = [
    ...(p.reason ? [p.reason, ''] : []),
    `- Project folder \`${tilde(p.project)}\`${p.create ? ' (Chorus creates it)' : ''}`,
    ...p.changes.map(c => `- ${lineOf(c)}${c.kind === 'set_note' ? '' : `: "${c.why}"`}`),
    '',
    'Nothing is made until you choose.',
  ].join('\n');
  return { question: `Create project "${name}"?`, details, options: [CREATE, CREATE_OPEN, DECLINE] };
}

const lineOf = (c: ProposedChange) => {
  switch (c.kind) {
    case 'set_note': return `Set the project's description: "${c.note}"`;
    case 'add_folder': return `Add the working folder \`${tilde(c.path!)}\``;
    case 'create_folder': return `Create the folder \`${tilde(c.path!)}\` and add it`;
    case 'remove_folder': return `Remove the working folder \`${tilde(c.path!)}\` (it stays on disk)`;
    case 'set_variable': return `Set the variable \`${c.name}\` (you type the value)`;
    case 'remove_variable': return `Remove the variable \`${c.name}\``;
  }
};

/** The card: one question, the changes with their why, and the options (folders and the note need no restart: Approve / Decline). */
export function proposalCard(project: string, changes: ProposedChange[], reason?: string): { question: string; details: string; options: string[] } {
  const name = placeName(project);
  const one = changes.length === 1 ? changes[0] : undefined;
  const question = !one
    ? `Set up "${name}": ${changes.length} changes?`
    : one.kind === 'set_note' ? `Set the description of "${name}"?`
    : one.kind === 'add_folder' ? `Add a working folder to "${name}"?`
    : one.kind === 'create_folder' ? `Create a folder and add it to "${name}"?`
    : one.kind === 'remove_folder' ? `Remove a working folder from "${name}"?`
    : one.kind === 'set_variable' ? `Set ${one.name} for "${name}"?`
    : `Remove ${one.name} from "${name}"?`;
  const details = [
    ...(reason?.trim() ? [reason.trim(), ''] : []),
    ...changes.map(c => `- ${lineOf(c)}: "${c.why}"`),
    '',
    'Every chat in this project gets these. Nothing changes until you choose.',
  ].join('\n');
  return { question, details, options: needsRestart(changes) ? [APPROVE_RESTART, APPROVE, DECLINE] : [APPROVE, DECLINE] };
}

export function parseProposal(r: { proposal?: string | null } | undefined): Proposal | undefined {
  if (!r?.proposal) return undefined;
  try {
    const p = JSON.parse(r.proposal) as Proposal;
    return p && Array.isArray(p.changes) && typeof p.project === 'string' ? p : undefined;
  } catch {
    return undefined;
  }
}

/* ---------- get_project ---------- */

export interface GetProjectDeps {
  store: Store;
  settings: ProjectSettings;
  runtime: ProjectRuntime;
  /** ids of the chats whose CLI runs now */
  running(): Set<string>;
  /** the paid module's counts and open tasks: undefined / none without Pro */
  counts(project: string): Promise<{ tasks: number; open: number } | undefined>;
  tasks(project: string): Promise<{ number: number; title: string; state: string }[]>;
}

/** get_project: the calling chat's own project, with enough to work and to set it up. Names only: no value is ever read here. */
export async function getProject(d: GetProjectDeps, t: ThreadRow) {
  const folder = path.resolve(t.project ?? t.cwd);
  const s = d.settings;
  const rec = s.get(folder);
  const has = d.runtime.chatHas(t.id);
  const running = d.running();
  const chats = d.store.listThreads().filter(x => path.resolve(x.project ?? x.cwd) === folder).sort((a, b) => (String(b.updated ?? '') > String(a.updated ?? '') ? 1 : String(b.updated ?? '') < String(a.updated ?? '') ? -1 : 0));
  const ids = chats.map(c => c.id);
  const artifacts = ids.length ? (d.store.db.prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE thread_id IN (${ids.map(() => '?').join(',')})`).get(...ids) as { n: number }).n : 0;
  const working_folders = rec.folders.map(f => {
    const live = s.describeFolder(f.path);
    return { path: f.path, why: f.why, added_by: f.by, added_at: f.at, created: !!f.created, exists: live.exists && live.is_dir, git: live.git, in_this_chat: !!has?.folders.includes(f.path) };
  });
  const withValue = new Set(Object.keys(s.env(folder)));
  const variables = rec.variables.map(v => ({ name: v.name, why: v.why, added_by: v.by, added_at: v.at, in_this_chat: !!has?.variables.includes(v.name) }));
  const missing = {
    folders: working_folders.filter(f => f.exists && !f.in_this_chat).map(f => f.path),
    variables: variables.filter(v => withValue.has(v.name) && !v.in_this_chat).map(v => v.name),
  };
  const pending = d.runtime.restartPending(t.id);
  const lacking = missing.folders.length + missing.variables.length > 0;
  const suggested_folders = isComputer(folder) ? [] : s.suggestFolders(folder);
  const counts = await d.counts(folder);
  const last = chats[0]?.updated ?? null;
  const name = placeName(folder);
  const computer = isComputer(folder);
  const setupBits = [!rec.note && 'no description', suggested_folders.length && `${suggested_folders.length} likely folder${suggested_folders.length > 1 ? 's' : ''} not added yet`].filter(Boolean);
  return {
    name,
    folder,
    is_project: !computer,
    ...(computer ? { place: 'This computer' } : {}),
    note: rec.note,
    note_by: rec.note_by,
    git: s.describeFolder(folder).git,
    working_folders,
    variables,
    suggested_folders,
    this_chat: {
      id: t.id,
      title: t.title,
      agent: t.agent,
      missing,
      restart_pending: pending,
      how_to_get_missing: !lacking ? 'nothing is missing' : pending ? 'nothing to do: this chat restarts with them when this turn ends (conversation kept)' : 'call reload_project_settings; this chat restarts with them when this turn ends (conversation kept)',
    },
    chats: {
      total: chats.length,
      running: ids.filter(id => running.has(id)).length,
      list: chats.slice(0, 20).map(c => ({ id: c.id, title: c.title, agent: c.agent, state: running.has(c.id) ? c.state : 'stopped' })),
    },
    ...(counts ? { tasks: { total: counts.tasks, open: counts.open, list: await d.tasks(folder) } } : {}),
    artifacts,
    last_activity: last,
    ...(computer ? { setup_hint: 'This chat is in This computer, not a project. To set up a project, use propose_new_project.' } : setupBits.length ? { setup_hint: `This project has ${setupBits.join(' and ')}: set it up with one propose_project_change call.` } : {}),
    how_to_change: computer ? 'propose_new_project to make a project; propose_project_change changes This computer itself' : 'propose_project_change (the user approves on one card)',
  };
}

/* ---------- the answer ---------- */

export type AskerResult = 'live' | 'has' | 'restart' | 'stale' | 'later' | undefined;

/** What one applied change says in the answer the chat reads (never a value). */
export function appliedLine(c: ProposedChange, asker: AskerResult): string {
  const where = asker === 'live' ? ' (added to this chat now)' : asker === 'has' ? ' (this chat has it)' : asker === 'later' ? ' (added to this chat as soon as it is idle)' : asker === 'restart' ? ' (this chat gets it when it restarts at the end of this turn)' : '';
  switch (c.kind) {
    case 'set_note': return 'description set';
    case 'add_folder': return `added folder ${tilde(c.path!)}${where}`;
    case 'create_folder': return `created and added folder ${tilde(c.path!)}${where}`;
    case 'remove_folder': return `removed folder ${tilde(c.path!)} (it stays on disk)`;
    case 'set_variable': return `set ${c.name} (value hidden)`;
    case 'remove_variable': return `removed ${c.name}`;
  }
}
