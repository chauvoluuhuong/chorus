// A project's working environment (task #11): the extra folders and the environment variables every chat started in the project gets,
// and a note on what the project is. It is the one record of them: the launch reads it (src/serve/pro.ts ChatLaunch), get_project
// reads it, the project's page writes it.
//   <root>/projects.json     folders, variable NAMES, the note, with who added each and why (no values)
//   <root>/project-env.json  the variables' VALUES, mode 0600; read only by env() for a launch. Never logged, exported or returned.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface FolderEntry {
  path: string;
  /** the reason the model gave in its proposal, or what the user typed in "What is it for?" (may be empty) */
  why: string;
  /** "you", or "<chat title> (<agent>)" */
  by: string;
  by_thread?: string;
  at: string;
  /** the approval request that allowed it */
  approval?: string;
  /** Chorus made this folder (an approved "create_folder" proposal) */
  created?: true;
}

export interface VariableEntry {
  name: string;
  why: string;
  by: string;
  by_thread?: string;
  at: string;
  approval?: string;
}

export interface ProjectRecord {
  note: string;
  note_by: string;
  note_at: string;
  folders: FolderEntry[];
  variables: VariableEntry[];
  /** a project made by an approved propose_new_project card: it is a project before its first chat */
  registered?: true;
  registered_at?: string;
  registered_by?: string;
  registered_by_thread?: string;
  registered_approval?: string;
  /** goes up on every change */
  version: number;
  changed_at: string;
}

export interface Origin {
  why?: string;
  by?: string;
  by_thread?: string;
  approval?: string;
}

export const NOTE_MAX = 2000;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TERM', 'PWD', 'TMPDIR', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CLAUDECODE', 'CLAUDE_PID']);
const RESERVED_PREFIX = ['CHORUS_', 'CLAUDE_CODE_', 'DYLD_', 'LD_'];

/** Why this variable name can't be used, or undefined when it can. */
export function badName(name: string): string | undefined {
  if (typeof name !== 'string' || !NAME.test(name)) return `"${name}" is not a variable name: use letters, digits and _, not starting with a digit`;
  if (RESERVED.has(name) || RESERVED_PREFIX.some(p => name.startsWith(p))) return `${name} is reserved: Chorus or the CLI sets it`;
  return undefined;
}

const now = () => new Date().toISOString();
const empty = (): ProjectRecord => ({ note: '', note_by: '', note_at: '', folders: [], variables: [], version: 0, changed_at: '' });

export class ProjectSettings {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private get file() {
    return path.join(this.root, 'projects.json');
  }

  private get envFile() {
    return path.join(this.root, 'project-env.json');
  }

  private readAll(): Record<string, ProjectRecord> {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }

  private writeAll(all: Record<string, ProjectRecord>) {
    fs.mkdirSync(this.root, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
    fs.renameSync(tmp, this.file);
  }

  private readEnv(): Record<string, Record<string, string>> {
    try {
      const j = JSON.parse(fs.readFileSync(this.envFile, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }

  /** Written to a 0600 temp file, then renamed over the old one; an existing file with other modes is set to 0600 first. */
  private writeEnv(all: Record<string, Record<string, string>>) {
    fs.mkdirSync(this.root, { recursive: true });
    try {
      if ((fs.statSync(this.envFile).mode & 0o777) !== 0o600) fs.chmodSync(this.envFile, 0o600);
    } catch { /* not there yet */ }
    const tmp = `${this.envFile}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(all, null, 2) + '\n');
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.envFile);
  }

  private change(folder: string, fn: (r: ProjectRecord) => void): ProjectRecord {
    const key = path.resolve(folder);
    const all = this.readAll();
    const r = { ...empty(), ...all[key] };
    fn(r);
    r.version = (r.version ?? 0) + 1;
    r.changed_at = now();
    all[key] = r;
    this.writeAll(all);
    return r;
  }

  /** Every project that has a record. */
  list(): string[] {
    return Object.keys(this.readAll());
  }

  /** The projects made by register() (they show before their first chat). */
  registered(): string[] {
    return Object.entries(this.readAll()).filter(([, r]) => r?.registered).map(([k]) => k);
  }

  /**
   * Why `folder` can't become a NEW project, or undefined. Not `/`, the home folder, anything in Chorus's own folders (~/.chorus and
   * the store root) or This computer; not a folder that already is a project (a record with settings, or `hasChat`). `create`: it
   * must not exist yet and its parent must; otherwise it must be an existing folder.
   */
  checkNewProject(folder: string, o: { create?: boolean; hasChat?: boolean } = {}): string | undefined {
    if (typeof folder !== 'string' || !folder || !path.isAbsolute(folder)) return `the project folder must be an absolute path: ${folder}`;
    const d = path.resolve(folder);
    const home = path.resolve(os.homedir());
    if (d === '/' || d === home) return `${d} is too wide for a project: pick a folder inside it`;
    const inside = (root: string) => d === root || d.startsWith(root + path.sep);
    if (inside(path.join(home, '.chorus')) || inside(path.resolve(this.root)) || /\/\.chorus(\/|$)/.test(d)) return `${d} is inside Chorus's own folders: pick a folder of your own`;
    const r = this.readAll()[d];
    if (o.hasChat || (r && (r.registered || r.note || r.folders?.length || r.variables?.length))) return `${d} is already a project: to change it, call propose_project_change from a chat in that project`;
    if (o.create) {
      if (fs.existsSync(d)) return `${d} already exists: leave out create to use it as it is`;
      if (!isDir(path.dirname(d))) return `the parent folder ${path.dirname(d)} does not exist`;
      return undefined;
    }
    if (!fs.existsSync(d)) return `${d} does not exist: set create to make it`;
    if (!isDir(d)) return `${d} is not a folder`;
    return undefined;
  }

  /** Makes `folder` a project with no chat yet (an approved propose_new_project). With `create`, makes exactly that one folder first. */
  register(folder: string, o: Origin & { create?: boolean; hasChat?: boolean } = {}): ProjectRecord {
    const err = this.checkNewProject(folder, o);
    if (err) throw new Error(err);
    const d = path.resolve(folder);
    if (o.create) fs.mkdirSync(d);
    return this.change(d, r => {
      r.registered = true;
      r.registered_at = now();
      r.registered_by = o.by ?? 'you';
      if (o.by_thread) r.registered_by_thread = o.by_thread;
      if (o.approval) r.registered_approval = o.approval;
    });
  }

  /** The project's record (an empty one, version 0, when it has none). */
  get(folder: string): ProjectRecord {
    return { ...empty(), ...this.readAll()[path.resolve(folder)] };
  }

  setNote(folder: string, text: string, by = 'you'): ProjectRecord {
    if (typeof text !== 'string') throw new Error('the note must be text');
    if (text.length > NOTE_MAX) throw new Error(`the note is too long: ${text.length} characters, at most ${NOTE_MAX}`);
    return this.change(folder, r => {
      r.note = text.trim();
      r.note_by = by;
      r.note_at = now();
    });
  }

  /** Why `dir` can't be a working folder of `folder`, or undefined. `create`: it must not exist yet and its parent must. */
  checkFolder(folder: string, dir: string, o: { create?: boolean } = {}): string | undefined {
    if (typeof dir !== 'string' || !dir || !path.isAbsolute(dir)) return `the folder must be an absolute path: ${dir}`;
    const d = path.resolve(dir);
    if (d === '/' || d === path.resolve(os.homedir())) return `${d} is too wide: pick a folder inside it`;
    if (d === path.resolve(folder)) return `${d} is the project folder itself`;
    if (o.create) {
      if (fs.existsSync(d)) return `${d} already exists`;
      const parent = path.dirname(d);
      if (!isDir(parent)) return `the parent folder ${parent} does not exist`;
      return undefined;
    }
    if (!fs.existsSync(d)) return `${d} does not exist`;
    if (!isDir(d)) return `${d} is not a folder`;
    return undefined;
  }

  /**
   * Adds a working folder. With `create` (an approved "create_folder" proposal) Chorus makes exactly that one folder first, never its
   * parents. Adding one already in the list changes nothing and returns the record as it is.
   */
  addFolder(folder: string, dir: string, o: Origin & { create?: boolean } = {}): ProjectRecord {
    const err = this.checkFolder(folder, dir, o);
    if (err) throw new Error(err);
    const d = path.resolve(dir);
    const cur = this.get(folder);
    if (cur.folders.some(f => f.path === d)) return cur;
    if (o.create) fs.mkdirSync(d);
    return this.change(folder, r => {
      r.folders = [...r.folders, { path: d, why: o.why ?? '', by: o.by ?? 'you', ...(o.by_thread ? { by_thread: o.by_thread } : {}), at: now(), ...(o.approval ? { approval: o.approval } : {}), ...(o.create ? { created: true as const } : {}) }];
    });
  }

  /** Removes it from the list. The folder itself stays on disk, also one Chorus made. */
  removeFolder(folder: string, dir: string): ProjectRecord {
    const d = path.resolve(dir);
    if (!this.get(folder).folders.some(f => f.path === d)) throw new Error(`${d} is not a working folder of this project`);
    return this.change(folder, r => {
      r.folders = r.folders.filter(f => f.path !== d);
    });
  }

  setVariable(folder: string, name: string, value: string, o: Origin = {}): ProjectRecord {
    const err = badName(name);
    if (err) throw new Error(err);
    if (typeof value !== 'string') throw new Error('the value must be text');
    const key = path.resolve(folder);
    const env = this.readEnv();
    env[key] = { ...env[key], [name]: value };
    this.writeEnv(env);
    return this.change(folder, r => {
      const entry: VariableEntry = { name, why: o.why ?? '', by: o.by ?? 'you', ...(o.by_thread ? { by_thread: o.by_thread } : {}), at: now(), ...(o.approval ? { approval: o.approval } : {}) };
      const i = r.variables.findIndex(v => v.name === name);
      r.variables = i < 0 ? [...r.variables, entry] : r.variables.map((v, j) => (j === i ? entry : v));
    });
  }

  removeVariable(folder: string, name: string): ProjectRecord {
    const key = path.resolve(folder);
    if (!this.get(key).variables.some(v => v.name === name)) throw new Error(`${name} is not a variable of this project`);
    const env = this.readEnv();
    if (env[key]) {
      delete env[key][name];
      if (!Object.keys(env[key]).length) delete env[key];
      this.writeEnv(env);
    }
    return this.change(folder, r => {
      r.variables = r.variables.filter(v => v.name !== name);
    });
  }

  /** The working folders that still exist, for a launch. */
  addDirs(folder: string): string[] {
    return this.get(folder).folders.map(f => f.path).filter(isDir);
  }

  /** The variables' values, ONLY for a launch's process environment. Names without a value are left out. */
  env(folder: string): Record<string, string> {
    const r = this.get(folder);
    const vals = this.readEnv()[path.resolve(folder)] ?? {};
    const out: Record<string, string> = {};
    for (const v of r.variables) if (typeof vals[v.name] === 'string' && !badName(v.name)) out[v.name] = vals[v.name];
    return out;
  }

  /** Drops everything kept for the project, its registration too (delete). No folder on disk is touched. */
  forget(folder: string) {
    const key = path.resolve(folder);
    const all = this.readAll();
    if (key in all) {
      delete all[key];
      this.writeAll(all);
    }
    const env = this.readEnv();
    if (key in env) {
      delete env[key];
      this.writeEnv(env);
    }
  }

  /** What is at `dir` now, read live (get_project and the page; never stored). */
  describeFolder(dir: string): { exists: boolean; is_dir: boolean; git: { branch: string | null; remote_url: string | null } | null } {
    const exists = fs.existsSync(dir);
    const is_dir = exists && isDir(dir);
    if (!is_dir) return { exists, is_dir, git: null };
    const git = (args: string[]) => {
      try {
        return execFileSync('git', ['-C', dir, ...args], { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim() || null;
      } catch {
        return null;
      }
    };
    const inside = git(['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') return { exists, is_dir, git: null };
    return { exists, is_dir, git: { branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) ?? git(['symbolic-ref', '--short', '-q', 'HEAD']), remote_url: git(['remote', 'get-url', 'origin']) } };
  }

  /**
   * Up to 10 folders the project probably needs and does not have yet, each with a one-line why. Read-only and fast: package.json
   * `file:`/`link:` dependencies, go.mod `replace … => ../x`, Cargo.toml `path = "../x"`, `../x` paths and sibling repo names in
   * AGENTS.md / CLAUDE.md / README.md, and siblings sharing the project's name prefix. Only existing folders.
   */
  suggestFolders(folder: string): { path: string; why: string }[] {
    const proj = path.resolve(folder);
    const parent = path.dirname(proj);
    const have = new Set([proj, ...this.get(proj).folders.map(f => f.path)]);
    const out: { path: string; why: string }[] = [];
    const add = (rel: string, why: string) => {
      if (out.length >= 10) return;
      const d = path.resolve(proj, rel);
      if (have.has(d) || out.some(o => o.path === d) || d === '/' || d === path.resolve(os.homedir()) || !isDir(d)) return;
      out.push({ path: d, why });
    };
    const read = (f: string) => {
      try {
        const p = path.join(proj, f);
        return fs.statSync(p).size < 1_000_000 ? fs.readFileSync(p, 'utf8') : '';
      } catch {
        return '';
      }
    };
    // package.json
    try {
      const pkg = JSON.parse(read('package.json') || '{}');
      for (const k of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const [name, spec] of Object.entries((pkg?.[k] ?? {}) as Record<string, unknown>)) {
          const m = typeof spec === 'string' ? /^(file|link):(.+)$/.exec(spec) : null;
          if (m) add(m[2], `package.json depends on ${m[1]}:${m[2]} (${name})`);
        }
      }
    } catch { /* not JSON */ }
    // go.mod
    for (const m of read('go.mod').matchAll(/replace\s+\S+(?:\s+\S+)?\s+=>\s+(\.\.?\/\S+)/g)) add(m[1], `go.mod replaces a module with ${m[1]}`);
    // Cargo.toml
    for (const m of read('Cargo.toml').matchAll(/path\s*=\s*"(\.\.?\/[^"]+)"/g)) add(m[1], `Cargo.toml has a path dependency on ${m[1]}`);
    // the project's own docs
    let siblings: string[] = [];
    try {
      siblings = fs.readdirSync(parent, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
    } catch { /* unreadable */ }
    for (const doc of ['AGENTS.md', 'CLAUDE.md', 'README.md']) {
      const text = read(doc);
      if (!text) continue;
      for (const m of text.matchAll(/(?:^|[\s`'"(\[])(\.\.\/[A-Za-z0-9._-]+)/g)) add(m[1], `${doc} mentions ${m[1]}`);
      for (const name of siblings) {
        if (name === path.basename(proj) || name.length < 3) continue;
        const re = new RegExp(`(^|[^A-Za-z0-9_./-])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_-]|$)`);
        if (re.test(text)) add(path.join('..', name), `${doc} names ${name}, which is beside the project`);
      }
    }
    // name prefix siblings: chorus → chorus-core, chorus-workspace
    const base = path.basename(proj);
    for (const name of siblings.sort()) {
      if (name !== base && (name.startsWith(`${base}-`) || name.startsWith(`${base}_`))) add(path.join('..', name), `beside the project and named like it (${base}…)`);
    }
    return out;
  }
}

function isDir(p: string) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
