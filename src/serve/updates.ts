// One public release-manifest read at launch. Downloading is always an explicit user action.
import fs from 'node:fs';
import path from 'node:path';
export const RELEASE_MANIFEST = 'https://chorus-cli.web.app/release.json';
const versionParts = (v: unknown): number[] | undefined => typeof v === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v) && v.split('.').every(n => Number.isSafeInteger(Number(n))) ? v.split('.').map(Number) : undefined;
export function newerVersion(candidate: unknown, current: string): boolean {
  const a = versionParts(candidate), b = versionParts(current); if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
export interface UpdateOptions { directory: string; version: string; platform?: string; arch?: string; request?: typeof fetch }
export class UpdateCheck {
  private o: UpdateOptions;
  private once?: Promise<void>;
  private controller = new AbortController();
  private release?: { version: string; url: string };
  private skipped?: string;
  private file: string;
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
      this.release = { version: data.version, url: artifact.url };
    } catch { /* Quiet until the next process launch. The app must work without this service. */ }
  }
  snapshot() { return this.release ? { currentVersion: this.o.version, version: this.release.version } : null; }
  downloadUrl() { return this.release?.url; }
  skip() {
    if (!this.release) return;
    const tmp = this.file + '.' + process.pid + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify({ skipped: this.release.version }), { mode: 0o600 }); fs.renameSync(tmp, this.file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    this.skipped = this.release.version; this.release = undefined;
  }
  close() { this.controller.abort(); }
}
