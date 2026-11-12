// One public release-manifest read at launch. Updating is an explicit user action: Update Chorus runs the official installer (the
// same script as the website's command, from its fixed https address), then Restart Chorus relaunches the app on the new version.
// Opening the full installer instructions stays as the fallback.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export const RELEASE_MANIFEST = 'https://chorus-cli.web.app/release.json';
/** The official installer. Only a test option in code can point elsewhere (never the page, never a setting). */
export const INSTALLER = 'https://chorus-cli.web.app/install.sh';
const SCRUB_ENV = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID'];
const versionParts = (v: unknown): number[] | undefined => typeof v === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v) && v.split('.').every(n => Number.isSafeInteger(Number(n))) ? v.split('.').map(Number) : undefined;
/** A preview build (`install.sh --preview`) is 1.0.13-preview.N: it counts as before 1.0.13, so the production release of that
 *  version, or any later one, is offered to it. */
const PREVIEW = /^(.+)-preview\.\d+$/;
export function newerVersion(candidate: unknown, current: string): boolean {
  const preview = PREVIEW.exec(current);
  const a = versionParts(candidate), b = versionParts(preview ? preview[1] : current); if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return !!preview;
}
export interface UpdateOptions {
  directory: string; version: string; platform?: string; arch?: string; request?: typeof fetch;
  /** tests only: another installer address (https, or http on 127.0.0.1), more environment for it (CHORUS_DOWNLOADS and the
   *  temporary folders), and the processes Restart looks at instead of this server's parents */
  test?: { installer?: string; env?: Record<string, string>; app?: { pid: number; exe: string } | null; relaunch?: (args: string[]) => void };
}
export type InstallPhase = 'downloading' | 'installing' | 'ready' | 'failed';
export interface InstallState { phase: InstallPhase; pct: number; lines?: string[] }
/** Where this Chorus was installed (<root>/versions/<v>/app/src/serve): the installer updates that root, not another one. */
const INSTALL_ROOT = /^(.*)\/versions\/[^/]+\/app\/src\/serve$/.exec(import.meta.dirname)?.[1];
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export class UpdateCheck {
  private o: UpdateOptions;
  private once?: Promise<void>;
  private controller = new AbortController();
  private release?: { version: string; url: string };
  private skipped?: string;
  private file: string;
  private install_?: InstallState;
  private staged?: string;
  private listeners: (() => void)[] = [];
  constructor(o: UpdateOptions) {
    this.o = o; this.file = path.join(o.directory, 'updates.json');
    fs.mkdirSync(o.directory, { recursive: true, mode: 0o700 });
    try { const value = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (versionParts(value.skipped)) this.skipped = value.skipped; }
    catch (error: any) { if (error.code !== 'ENOENT') throw new Error('Update preference is unreadable; preserving it'); }
  }
  startup() { return this.once ??= this.check(); }
  private async check() {
    try {
      const response = await (this.o.request ?? fetch)(RELEASE_MANIFEST, { redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(8000)]) });
      if (!response.ok || !response.body) return;
      const chunks: Uint8Array[] = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; if (size > 64000) throw new Error('Manifest too large'); chunks.push(chunk); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!newerVersion(data.version, this.o.version) || this.skipped === data.version) return;
      const platform = this.o.platform ?? process.platform, arch = this.o.arch ?? process.arch;
      const artifact = data.downloads?.[`${platform}-${arch}`];
      if (!artifact || typeof artifact.url !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) return;
      const file = platform === 'darwin' && arch === 'arm64' ? `Chorus-macOS-${data.version}.zip` : platform === 'linux' && ['arm64', 'x64'].includes(arch) ? `chorus-linux-${arch}-${data.version}.tar.gz` : undefined;
      if (!file || artifact.url !== `https://chorus-cli.web.app/dl/${file}` || this.controller.signal.aborted) return;
      this.release = { version: data.version, url: 'https://chorus-cli.web.app/update' };
    } catch { /* Quiet until the next process launch. The app must work without this service. */ }
  }
  snapshot() { return this.release ? { currentVersion: this.o.version, version: this.release.version, ...(this.install_ ? { install: this.install_ } : {}) } : null; }
  /** Called when the install moves on (the server pushes its state). */
  onChange(fn: () => void) { this.listeners.push(fn); }
  private set(st: InstallState) { this.install_ = st; for (const fn of this.listeners) fn(); }

  /**
   * Update Chorus: fetch the official installer (fixed address, https only, no redirects) and run it with stdin closed and
   * CHORUS_NO_OPEN=1. It downloads the release, checks each file against SHA256SUMS and installs it. On macOS it puts Chorus.app
   * in a staging folder: the installer stops a running Chorus.app in the folder it installs to, and this one is still running;
   * Restart moves it into place. Phases: downloading (with the download's percent) → installing → ready, or failed with the
   * installer's last lines.
   */
  async install(): Promise<{ ok: true } | { error: string }> {
    if (!this.release) return { error: 'No update is available' };
    if (this.install_ && ['downloading', 'installing'].includes(this.install_.phase)) return { ok: true };
    const platform = this.o.platform ?? process.platform;
    this.set({ phase: 'downloading', pct: 0 });
    let script: string;
    try {
      script = await this.fetchInstaller();
    } catch (e) {
      this.set({ phase: 'failed', pct: 0, lines: [`Could not download the installer: ${(e as Error).message}`] });
      return { ok: true };
    }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-update-'));
    const file = path.join(work, 'install.sh');
    fs.writeFileSync(file, script, { mode: 0o700 });
    const env: Record<string, string> = { ...(process.env as Record<string, string>), CHORUS_NO_OPEN: '1', CHORUS_NO_MODIFY_PATH: '1' };
    for (const k of SCRUB_ENV) delete env[k];
    if (INSTALL_ROOT) env.CHORUS_INSTALL_DIR = INSTALL_ROOT;
    const stage = path.join(this.o.directory, 'app');
    if (platform === 'darwin') {
      fs.rmSync(stage, { recursive: true, force: true });
      fs.mkdirSync(stage, { recursive: true });
      env.CHORUS_APP_DIR = stage;
    }
    Object.assign(env, this.o.test?.env);
    const child = spawn('/bin/bash', [file], { cwd: os.homedir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    // the installer says "1/2  Installing …" before each part; curl draws its progress bar with \r: one download per part
    let parts = 1, downloads = 0, pct = 0;
    const lines: string[] = [];
    const take = (chunk: Buffer) => {
      for (const raw of chunk.toString('utf8').split(/[\r\n]+/)) {
        const line = raw.replace(ANSI, '').trimEnd();
        if (!line.trim()) continue;
        const step = /^\s*\d+\/(\d+)\s/.exec(line);
        if (step) parts = Number(step[1]);
        const bar = /^[#\s]*(\d{1,3}(?:\.\d)?)%$/.exec(line.trim());
        if (bar) {
          pct = Math.min(100, Number(bar[1]));
          if (pct >= 100) (downloads++, (pct = 0));
          const all = Math.min(100, Math.round(((downloads * 100 + pct) / parts)));
          if (downloads >= parts) this.set({ phase: 'installing', pct: 100 });
          else if (all !== this.install_?.pct) this.set({ phase: 'downloading', pct: all });
          continue;
        }
        lines.push(line);
        if (lines.length > 40) lines.shift();
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.once('error', e => lines.push(e.message));
    child.once('close', code => {
      fs.rmSync(work, { recursive: true, force: true });
      if (code === 0) {
        this.staged = platform === 'darwin' ? path.join(stage, 'Chorus.app') : undefined;
        this.set({ phase: 'ready', pct: 100 });
      } else {
        const said = lines.filter(l => !/^Chorus \d/.test(l.trim()));
        this.set({ phase: 'failed', pct: 0, lines: (said.length ? said : [`The installer stopped (exit ${code}).`]).slice(-6) });
      }
    });
    return { ok: true };
  }

  private async fetchInstaller(): Promise<string> {
    const address = this.o.test?.installer ?? INSTALLER;
    const u = new URL(address);
    if (u.protocol !== 'https:' && !(this.o.test?.installer && u.protocol === 'http:' && u.hostname === '127.0.0.1')) throw new Error('the installer address must be https');
    const response = await (this.o.request ?? fetch)(address, { redirect: 'error', signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 512_000) throw new Error('the installer is too large'); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.startsWith('#!')) throw new Error('that is not the installer');
    return text;
  }

  /**
   * Restart Chorus once the install is ready: a small detached script stops the app this server runs under (the server then stops
   * with it: its stdin closes), waits for both, moves the staged Chorus.app over the one in use (macOS), and opens the app again.
   * Without an app above this server (a browser tab on `chorus serve`) it says to quit and open Chorus again.
   */
  restart(): { ok: true } | { error: string } {
    if (this.install_?.phase !== 'ready') return { error: 'Nothing is installed yet' };
    const app = this.o.test && 'app' in this.o.test ? this.o.test.app : appAbove(process.pid);
    if (!app) return { error: 'Quit Chorus and open it again to use the new version.' };
    const mac = /^(.+\.app)\/Contents\/MacOS\//.exec(app.exe)?.[1];
    const root = INSTALL_ROOT ?? path.join(os.homedir(), '.chorus');
    const args = mac ? [String(app.pid), String(process.pid), mac, this.staged ?? '', ''] : [String(app.pid), String(process.pid), '', '', path.join(root, 'current/bin/chorus')];
    if (this.o.test?.relaunch) this.o.test.relaunch(args);
    else spawn('/bin/sh', ['-c', RELAUNCH, 'relaunch', ...args], { detached: true, stdio: 'ignore', cwd: os.homedir() }).unref();
    return { ok: true };
  }
  updateUrl() { return this.release?.url; }
  skip() {
    if (!this.release) return;
    const tmp = this.file + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify({ skipped: this.release.version }), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    this.skipped = this.release.version; this.release = undefined;
  }
  close() { this.controller.abort(); }
}

/**
 * The relaunch, detached from the server (it outlives it): $1 the app, $2 this server, $3 the Chorus.app in use and $4 the one the
 * installer staged (macOS), $5 the command that opens the window (Linux). Proven in a temporary install (plan 2026-11-12, step 7).
 */
export const RELAUNCH = `app=$1 serve=$2 bundle=$3 staged=$4 cmd=$5
kill -TERM "$app" 2>/dev/null
i=0
while { kill -0 "$app" 2>/dev/null || kill -0 "$serve" 2>/dev/null; } && [ $i -lt 150 ]; do sleep 0.1; i=$((i+1)); done
kill -0 "$app" 2>/dev/null && kill -KILL "$app" 2>/dev/null
if [ -n "$bundle" ]; then
  if [ -n "$staged" ] && [ -d "$staged" ]; then
    rm -rf "$bundle.old" && mv "$bundle" "$bundle.old" && mv "$staged" "$bundle" && rm -rf "$bundle.old"
  fi
  open "$bundle"
elif [ -n "$cmd" ]; then
  nohup "$cmd" desktop >/dev/null 2>&1 </dev/null &
fi
`;

/** The Chorus window this server runs under: its parent (the shell's login shell execs chorus), or a little higher. */
export function appAbove(pid: number): { pid: number; exe: string } | null {
  let p = pid;
  for (let i = 0; i < 4; i++) {
    const ppid = Number(spawnSync('ps', ['-o', 'ppid=', '-p', String(p)], { encoding: 'utf8' }).stdout.trim());
    if (!ppid || ppid <= 1) return null;
    let exe = '';
    try { exe = process.platform === 'linux' ? fs.readlinkSync(`/proc/${ppid}/exe`) : spawnSync('ps', ['-o', 'comm=', '-p', String(ppid)], { encoding: 'utf8' }).stdout.trim(); } catch { /* gone */ }
    if (/\.app\/Contents\/MacOS\/[^/]+$/.test(exe) && /\/Chorus[^/]*\.app\//.test(exe) || /\/desktop\/chorus-desktop$/.test(exe)) return { pid: ppid, exe };
    p = ppid;
  }
  return null;
}
