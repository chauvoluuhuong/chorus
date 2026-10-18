// Opening a file or a link for the user (docs/mockups/chorus-cli.html, "Artifacts" and "Open fails: choose how").
// The system command is tried first; when it is missing or fails the user picks another way, remembered per project in
// <project>/.chorus/open.json (never in a global config, rule 4).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type OpenMode = 'default' | 'copy' | 'folder' | 'custom' | 'show';
export interface OpenConfig {
  mode: OpenMode;
  /** for mode "custom": {url} and {path} are replaced */
  command?: string;
}
export interface OpenTarget {
  /** the preview link, when the file is served */
  url?: string;
  path: string;
}
export interface OpenResult {
  ok: boolean;
  error?: string;
  /** what the user should see when nothing was started (mode "show"): the link or the path */
  shown?: string;
}
/** How Chorus opens things; tests replace it. */
export type Opener = (cfg: OpenConfig, target: OpenTarget) => Promise<OpenResult>;

const file = (project: string) => path.join(project, '.chorus', 'open.json');

export function readOpenConfig(project: string): OpenConfig {
  try {
    const c = JSON.parse(fs.readFileSync(file(project), 'utf8'));
    if (['default', 'copy', 'folder', 'custom', 'show'].includes(c.mode)) return c;
  } catch {
    /* none yet: the system default */
  }
  return { mode: 'default' };
}

export function writeOpenConfig(project: string, cfg: OpenConfig) {
  fs.mkdirSync(path.dirname(file(project)), { recursive: true });
  fs.writeFileSync(file(project), JSON.stringify(cfg, null, 2));
}

/** Runs a command and waits briefly: "command not found" or a non-zero exit is a failure; still running after a moment is fine (a browser). */
function run(bin: string, args: string[], opts: { shell?: boolean; stdin?: string; waitMs?: number } = {}): Promise<OpenResult> {
  return new Promise(resolve => {
    let done = false;
    const finish = (r: OpenResult) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    try {
      const c = spawn(bin, args, { stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'ignore', 'pipe'], shell: opts.shell, detached: true });
      let err = '';
      c.stderr?.on('data', d => (err += d));
      c.stdin?.on('error', () => {});
      if (opts.stdin !== undefined) c.stdin?.end(opts.stdin);
      c.on('error', e => finish({ ok: false, error: /ENOENT/.test(String(e)) ? `${bin}: command not found` : String(e.message) }));
      c.on('exit', code => finish(code === 0 ? { ok: true } : { ok: false, error: (err.trim().split('\n')[0] || `${bin} exited with ${code}`).slice(0, 120) }));
      setTimeout(() => {
        c.unref();
        finish({ ok: true });
      }, opts.waitMs ?? 1500);
    } catch (e) {
      finish({ ok: false, error: String((e as Error).message) });
    }
  });
}

const clip = () =>
  process.platform === 'darwin' ? { bin: 'pbcopy', args: [] as string[] } : process.platform === 'win32' ? { bin: 'clip', args: [] as string[] } : { bin: 'xclip', args: ['-selection', 'clipboard'] };

export const defaultOpener: Opener = async (cfg, t) => {
  const what = t.url ?? t.path;
  switch (cfg.mode) {
    case 'show':
      return { ok: true, shown: what };
    case 'copy': {
      const c = clip();
      const r = await run(c.bin, c.args, { stdin: what, waitMs: 800 });
      return r.ok ? { ok: true, shown: what } : r;
    }
    case 'folder':
      if (process.platform === 'darwin') return run('open', ['-R', t.path]);
      if (process.platform === 'win32') return run('explorer', [`/select,${t.path}`]);
      return run('xdg-open', [path.dirname(t.path)]);
    case 'custom': {
      if (!cfg.command) return { ok: false, error: 'no command set' };
      const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
      return run(cfg.command.replaceAll('{url}', q(t.url ?? t.path)).replaceAll('{path}', q(t.path)), [], { shell: true });
    }
    default:
      if (process.platform === 'darwin') return run('open', [what]);
      if (process.platform === 'win32') return run('cmd', ['/c', 'start', '""', what]);
      return run(process.env.WSL_DISTRO_NAME ? 'wslview' : 'xdg-open', [what]);
  }
};
