// One source of truth for skills, written out to where each CLI looks (docs/integrations/skills.md).
//
//   source:  <project>/.chorus/skills/<name>/SKILL.md (+ scripts/, references/ …)
//   claude:  <project>/.claude/skills/<name>
//   codex:   <project>/.agents/skills/<name>   (also read by agy)
//   agy:     <project>/.agents/skills/<name>
//
// Entries Chorus writes are symlinks into .chorus/skills (or copies carrying a marker file when
// symlinks are unavailable). Anything else in those folders is the user's and is never touched.

import fs from 'node:fs';
import path from 'node:path';
import type { AgentId } from './types.ts';

export const MARKER = '.chorus-managed';

/** Folder (relative to the project) each CLI loads project skills from. Codex and agy share one. */
export const TARGET_DIRS: Record<AgentId, string> = {
  claude: '.claude/skills',
  codex: '.agents/skills',
  agy: '.agents/skills',
};

export interface Skill {
  name: string;
  description: string;
  dir: string;
}

export interface SyncReport {
  linked: string[];
  updated: string[];
  removed: string[];
  /** skipped because a user-owned entry with the same name already exists */
  conflicts: string[];
}

export function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === '>-' || v === '>' || v === '|' || v === '|-') {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(' ');
    }
    out[kv[1]] = v.replace(/^["']|["']$/g, '');
  }
  return out;
}

export function sourceDir(project: string): string {
  return path.join(project, '.chorus', 'skills');
}

export function listSkills(project: string): Skill[] {
  const root = sourceDir(project);
  if (!fs.existsSync(root)) return [];
  const skills: Skill[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const fm = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    skills.push({ name: fm.name ?? entry.name, description: fm.description ?? '', dir: path.join(root, entry.name) });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(project: string, name: string): { skill: Skill; body: string } | undefined {
  const skill = listSkills(project).find(s => s.name === name);
  return skill ? { skill, body: fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8') } : undefined;
}

function isManaged(entry: string, src: string): boolean {
  try {
    const st = fs.lstatSync(entry);
    if (st.isSymbolicLink()) return path.resolve(fs.realpathSync(path.dirname(entry)), fs.readlinkSync(entry)).startsWith(src + path.sep);
    return st.isDirectory() && fs.existsSync(path.join(entry, MARKER));
  } catch {
    return false;
  }
}

function copyDir(from: string, to: string) {
  fs.cpSync(from, to, { recursive: true });
  fs.writeFileSync(path.join(to, MARKER), 'managed by chorus; edit .chorus/skills instead\n');
}

function exclude(project: string, rel: string[]) {
  const file = path.join(project, '.git', 'info', 'exclude');
  if (!fs.existsSync(path.dirname(file))) return;
  const have = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = rel.filter(r => !have.split('\n').includes(r));
  if (missing.length) fs.appendFileSync(file, (have.endsWith('\n') || !have ? '' : '\n') + missing.join('\n') + '\n');
}

export function syncSkills(project: string, opts: { agents?: AgentId[]; mode?: 'symlink' | 'copy' } = {}): SyncReport {
  const agents = opts.agents ?? (['claude', 'codex', 'agy'] as AgentId[]);
  fs.mkdirSync(sourceDir(project), { recursive: true });
  const src = fs.realpathSync(sourceDir(project));
  const skills = listSkills(project);
  const report: SyncReport = { linked: [], updated: [], removed: [], conflicts: [] };
  const dirs = [...new Set(agents.map(a => TARGET_DIRS[a]))];
  const excludes: string[] = [];

  for (const rel of dirs) {
    const targetRoot = path.join(project, rel);
    fs.mkdirSync(targetRoot, { recursive: true });
    const wanted = new Set(skills.map(s => path.basename(s.dir)));
    for (const skill of skills) {
      const name = path.basename(skill.dir);
      const entry = path.join(targetRoot, name);
      const exists = fs.existsSync(entry) || isLink(entry);
      if (exists && !isManaged(entry, src)) {
        report.conflicts.push(`${rel}/${name}`);
        continue;
      }
      if (exists) {
        fs.rmSync(entry, { recursive: true, force: true });
        report.updated.push(`${rel}/${name}`);
      } else report.linked.push(`${rel}/${name}`);
      if (opts.mode === 'copy') copyDir(skill.dir, entry);
      else {
        try {
          fs.symlinkSync(path.relative(targetRoot, skill.dir), entry, 'dir');
        } catch {
          copyDir(skill.dir, entry);
        }
      }
      excludes.push(`/${rel}/${name}`);
    }
    for (const entry of fs.readdirSync(targetRoot)) {
      if (wanted.has(entry)) continue;
      if (isManaged(path.join(targetRoot, entry), src)) {
        fs.rmSync(path.join(targetRoot, entry), { recursive: true, force: true });
        report.removed.push(`${rel}/${entry}`);
      }
    }
  }
  exclude(project, excludes);
  return report;
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
