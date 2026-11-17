// Sync skills (plan 2026-11-14, Stage 6): every skill Chorus can see, and which CLI has it.
//
//   sources:  the CLIs' home skills folders (always read), ~/.agents/skills (Codex reads it too), the project library
//             <project>/.chorus/skills, and every folder or single skill the user added (the skill_sources table)
//   a skill:  a folder with a SKILL.md; its identity is its real folder (fs.realpathSync)
//   sync:     one symlink <CLI home skills folder>/<skill folder name> → the real folder, made only on the user's click and
//             recorded in skill_links. This is the one thing Chorus ever writes into a CLI's home folder; it never removes
//             anything there it did not make, and never writes into ~/.agents/skills.
//
// The home folder is CHORUS_SKILLS_HOME (tests and proofs) or the user's home.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSkills, parseFrontmatter, sourceDir } from './skills.ts';
import type { Store } from './store.ts';

export type Cli = 'claude' | 'codex' | 'agy';
export const SYNC_CLIS: Cli[] = ['claude', 'codex', 'agy'];
/** Per skill and CLI: lives in that CLI's folder, linked there by Chorus, there but not Chorus's (never touched), or not there. */
export type SkillState = 'own' | 'sync' | 'there' | '';

/** The home skills folder of each CLI, relative to the home folder: where a sync puts its link. */
export const HOME_SKILLS: Record<Cli, string> = {
  claude: '.claude/skills',
  codex: '.codex/skills',
  agy: '.gemini/config/skills',
};
/** Codex also reads this one: a skill there counts as Codex having it. Chorus never writes here. */
export const SHARED_SKILLS = '.agents/skills';

export const skillsHome = () => process.env.CHORUS_SKILLS_HOME ?? os.homedir();
export const homeSkillsDir = (cli: Cli, home = skillsHome()) => path.join(home, HOME_SKILLS[cli]);
/**
 * The project folders each CLI reads skills from, relative to the project (docs/integrations/skills.md §1, all ✅): a skill there
 * counts as that CLI having it when it runs in that project. Chorus never writes here outside the project library's sync.
 */
export const PROJECT_SKILLS: Record<Cli, string[]> = {
  claude: ['.claude/skills'],
  codex: ['.agents/skills', '.codex/skills'],
  agy: ['.agents/skills', '.agent/skills'],
};
/** The folders that count as a CLI having a skill: its home folders and, for a project, that project's own folders. */
const cliDirs = (cli: Cli, home: string, folder?: string) => [
  ...(cli === 'codex' ? [homeSkillsDir(cli, home), path.join(home, SHARED_SKILLS)] : [homeSkillsDir(cli, home)]),
  ...(folder ? PROJECT_SKILLS[cli].map(d => path.join(folder, d)) : []),
];

export interface ScannedSkill {
  /** the real folder */
  dir: string;
  name: string;
  description: string;
  /** the source it was found through */
  source: string;
}

export interface SourceInfo {
  path: string;
  /** the path with ~ for the home folder (in a listing) */
  show?: string;
  kind: 'folder' | 'skill';
  count: number;
  reachable: boolean;
  /** always read; cannot be removed */
  fixed: boolean;
  /** the CLI whose home folder this is */
  cli?: Cli;
  /** a word for the fixed ones: "Claude Code", "this project's library" … */
  label?: string;
  /** the one skill's name (kind skill) */
  skill?: string;
}

export interface SkillRow {
  dir: string;
  name: string;
  description: string;
  /** the skill's parent folder, with ~ for the home folder */
  where: string;
  /** the folder name (the link's name) */
  folder: string;
  /** in this project's library: "Edit" works on it */
  library: boolean;
  state: Record<Cli, SkillState>;
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
};
const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isLink = (p: string) => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const exists = (p: string) => isLink(p) || fs.existsSync(p);
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep);

/** "~/x" for a path in the home folder. */
export function tilde(p: string, home = skillsHome()) {
  return inside(p, home) ? '~' + p.slice(home.length) : p;
}

function readSkillDir(dir: string, source: string): ScannedSkill | undefined {
  const r = real(dir);
  if (!r || !fs.existsSync(path.join(r, 'SKILL.md'))) return undefined;
  let fm: { name?: string; description?: string } = {};
  try {
    fm = parseFrontmatter(fs.readFileSync(path.join(r, 'SKILL.md'), 'utf8'));
  } catch {
    /* unreadable: listed by its folder name */
  }
  return { dir: r, name: fm.name || path.basename(dir), description: fm.description ?? '', source };
}

/** The skills directly inside a folder (its sub-folders that hold a SKILL.md; hidden ones such as .system left out). */
function readFolder(dir: string, source: string): ScannedSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(e => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())).flatMap(e => readSkillDir(path.join(dir, e.name), source) ?? []);
}

/**
 * Reads every source, stores what it found (the skills table), and returns it. A source that cannot be read is reported as not
 * reachable and stays stored.
 */
export function scanSkills(store: Store, project: string, home = skillsHome()): { skills: ScannedSkill[]; sources: SourceInfo[] } {
  const fixed: SourceInfo[] = SYNC_CLIS.map(cli => ({ path: homeSkillsDir(cli, home), kind: 'folder' as const, count: 0, reachable: false, fixed: true, cli, label: CLI_NAMES[cli] }));
  const shared = path.join(home, SHARED_SKILLS);
  if (isDir(shared)) fixed.push({ path: shared, kind: 'folder', count: 0, reachable: false, fixed: true, cli: 'codex', label: 'Codex (shared folder)' });
  const lib = sourceDir(project);
  if (isDir(lib)) fixed.push({ path: lib, kind: 'folder', count: 0, reachable: false, fixed: true, label: "this project's library" });
  const added: SourceInfo[] = store.skillSources().map(s => ({ path: s.path, kind: s.kind, count: 0, reachable: false, fixed: false }));

  const found = new Map<string, ScannedSkill>();
  for (const src of [...added, ...fixed]) {
    src.reachable = isDir(src.path);
    if (!src.reachable) continue;
    const list = src.kind === 'skill' ? [readSkillDir(src.path, src.path)].filter((s): s is ScannedSkill => !!s) : readFolder(src.path, src.path);
    src.count = list.length;
    if (src.kind === 'skill') src.skill = list[0]?.name;
    const srcReal = real(src.path) ?? src.path;
    for (const s of list) {
      const had = found.get(s.dir);
      // the source that holds the real folder wins over one that only links to it (a synced link in a CLI's home)
      if (!had || (src.kind === 'skill' ? s.dir === srcReal : path.dirname(s.dir) === srcReal)) found.set(s.dir, s);
    }
  }
  const skills = [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
  store.replaceSkills(skills);
  return { skills, sources: [...fixed, ...added] };
}

export const CLI_NAMES: Record<Cli, string> = { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity' };

/** What a CLI's folders hold: entry names and the real folders they lead to (read once per listing). */
export interface CliIndex {
  roots: string[];
  names: Set<string>;
  reals: Set<string>;
}
export function cliIndex(cli: Cli, home = skillsHome(), folder?: string): CliIndex {
  const idx: CliIndex = { roots: [], names: new Set(), reals: new Set() };
  for (const d of cliDirs(cli, home, folder)) {
    idx.roots.push(real(d) ?? d);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      idx.names.add(e);
      const r = real(path.join(d, e));
      if (r) idx.reals.add(r);
    }
  }
  return idx;
}

/** Whether a CLI has a skill, and how. */
export function skillState(skill: Pick<ScannedSkill, 'dir'>, cli: Cli, links: { dir: string; cli: string; path: string }[], home = skillsHome(), idx = cliIndex(cli, home)): SkillState {
  if (idx.roots.some(d => inside(skill.dir, d))) return 'own';
  const link = links.find(l => l.dir === skill.dir && l.cli === cli);
  if (link && isLink(link.path) && real(link.path) === skill.dir) return 'sync';
  // a link or copy of the same name, or a link of another name to the same folder: the user's, never touched
  if (idx.names.has(path.basename(skill.dir)) || idx.reals.has(skill.dir)) return 'there';
  return '';
}

/** GET skills/all: every skill with its state per CLI, and the sources. `folder`: the project a chat will run in (its own skill folders count). */
export function allSkills(store: Store, project: string, home = skillsHome(), folder: string = project): { skills: SkillRow[]; sources: SourceInfo[] } {
  const { skills, sources } = scanSkills(store, project, home);
  const links = store.skillLinks();
  const lib = real(sourceDir(project));
  const idx = Object.fromEntries(SYNC_CLIS.map(c => [c, cliIndex(c, home, folder)])) as Record<Cli, CliIndex>;
  const h = real(home) ?? home;
  return {
    skills: skills.map(s => ({
      dir: s.dir,
      name: s.name,
      description: s.description,
      where: tilde(path.dirname(s.dir), h),
      folder: path.basename(s.dir),
      library: !!lib && path.dirname(s.dir) === lib,
      state: Object.fromEntries(SYNC_CLIS.map(c => [c, skillState(s, c, links, home, idx[c])])) as Record<Cli, SkillState>,
    })),
    sources: sources.map(s => ({ ...s, show: tilde(s.path, inside(s.path, home) ? home : h) })),
  };
}

export type SyncResult = { ok: true; path: string } | { ok: false; error: string };

/** One link <CLI home skills folder>/<skill folder name> → the skill's real folder, recorded. Refuses to replace anything. */
export function syncSkill(store: Store, dir: string, cli: Cli, home = skillsHome()): SyncResult {
  const r = real(dir);
  if (!r || !fs.existsSync(path.join(r, 'SKILL.md'))) return { ok: false, error: `${dir} is not a skill folder` };
  const root = homeSkillsDir(cli, home);
  const to = path.join(root, path.basename(r));
  const state = skillState({ dir: r }, cli, store.skillLinks(), home);
  if (state === 'own' || state === 'there') return { ok: false, error: `${CLI_NAMES[cli]} already has ${path.basename(r)}` };
  if (state === 'sync') return { ok: true, path: to };
  if (exists(to)) {
    // the link Chorus made earlier is still there but points elsewhere now, or something of that name is the user's
    return { ok: false, error: `${tilde(to, home)} already exists; Chorus leaves it as it is` };
  }
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(r, to, 'dir');
  store.addSkillLink(r, cli, to);
  return { ok: true, path: to };
}

/** Removes the link only when Chorus recorded it and it still is a symlink to that folder; then forgets it. */
export function unsyncSkill(store: Store, dir: string, cli: Cli): SyncResult {
  const r = real(dir) ?? dir;
  const link = store.skillLinks().find(l => l.dir === r && l.cli === cli);
  if (!link) return { ok: false, error: 'Chorus did not link this skill there' };
  if (isLink(link.path) && real(link.path) === r) fs.unlinkSync(link.path);
  else if (exists(link.path)) {
    store.removeSkillLink(r, cli);
    return { ok: false, error: `${link.path} is no longer Chorus's link; it is left as it is` };
  }
  store.removeSkillLink(r, cli);
  return { ok: true, path: link.path };
}

/** POST skills/sources: a folder with a SKILL.md is one skill, any other folder is read for the skills in it. */
export function addSource(store: Store, p: string, project: string, home = skillsHome()): { ok: true; kind: 'folder' | 'skill' } | { ok: false; error: string } {
  const dir = path.resolve(p);
  if (!isDir(dir)) return { ok: false, error: `${p} is not a folder` };
  const fixed = [...SYNC_CLIS.map(c => homeSkillsDir(c, home)), path.join(home, SHARED_SKILLS), sourceDir(project)];
  if (fixed.some(f => (real(f) ?? f) === (real(dir) ?? dir))) return { ok: false, error: 'Chorus always reads this folder' };
  const kind = fs.existsSync(path.join(dir, 'SKILL.md')) ? 'skill' : 'folder';
  store.addSkillSource(dir, kind);
  return { ok: true, kind };
}

/** POST skills/sources/remove: the source goes, and the links Chorus made for its skills. No file is deleted. */
export function removeSource(store: Store, p: string): { ok: true; unsynced: number } | { ok: false; error: string } {
  const src = store.skillSources().find(s => s.path === p);
  if (!src) return { ok: false, error: 'not a source you added' };
  const srcReal = real(p) ?? p;
  const mine = new Set(store.storedSkills().filter(s => s.source === p || inside(s.dir, srcReal)).map(s => s.dir));
  let unsynced = 0;
  for (const l of store.skillLinks()) if (mine.has(l.dir) && unsyncSkill(store, l.dir, l.cli as Cli).ok) unsynced++;
  store.removeSkillSource(p);
  return { ok: true, unsynced };
}

/** The skills the chorus MCP tools offer: every stored skill, and the project library (so it works before any scan). */
export function knownSkills(store: Store, project: string): { name: string; description: string; dir: string }[] {
  const out = new Map<string, { name: string; description: string; dir: string }>();
  for (const s of listSkills(project)) out.set(s.name, { name: s.name, description: s.description, dir: s.dir });
  for (const s of store.storedSkills()) if (!out.has(s.name)) out.set(s.name, { name: s.name, description: s.description, dir: s.dir });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function readKnownSkill(store: Store, project: string, name: string): string | undefined {
  const s = knownSkills(store, project).find(x => x.name === name);
  try {
    return s && fs.readFileSync(path.join(s.dir, 'SKILL.md'), 'utf8');
  } catch {
    return undefined;
  }
}
