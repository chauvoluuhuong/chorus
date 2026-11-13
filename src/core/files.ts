// The files of a project folder, for the New chat form's "@" list (plan 2026-11-13, item 8): git's tracked files and its untracked
// ones that are not ignored; a plain walk without .git, node_modules and dot folders when the folder is not in git.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The most a walk looks at, so a home folder can't stall the list. */
const WALK_LIMIT = 20_000;

/** Every file under `folder`, relative, with "/" between parts. */
export function projectFiles(folder: string): string[] {
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: folder, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (git.status === 0) return [...new Set(git.stdout.split('\0').filter(Boolean))];
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= WALK_LIMIT) return;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(folder, '');
  return out;
}

/** The files whose path contains `q` (any part, any case), those whose name or path starts with it first, at most `max`. */
export function matchFiles(files: string[], q: string, max = 50): string[] {
  const s = q.toLowerCase();
  const starts = (f: string) => path.basename(f).toLowerCase().startsWith(s) || f.toLowerCase().startsWith(s);
  return files.filter(f => f.toLowerCase().includes(s)).sort((a, b) => Number(starts(b)) - Number(starts(a)) || a.length - b.length || a.localeCompare(b)).slice(0, max);
}
