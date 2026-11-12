import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { UpdateCheck, newerVersion, RELEASE_MANIFEST } from '../../src/serve/updates.ts';
const release = (version = '1.0.7', url = `https://chorus-cli.web.app/dl/Chorus-macOS-${version}.zip`) => ({ version, downloads: { 'darwin-arm64': { url, sha256: 'a'.repeat(64) } } });
function setup(t: any) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-updates-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let value: any = release(), offline = false, calls = 0;
  const create = (platform = 'darwin', arch = 'arm64') => new UpdateCheck({ directory, version: '1.0.6', platform, arch, request: (async (url, opts) => { calls++; assert.equal(String(url), RELEASE_MANIFEST); assert.equal(opts?.redirect, 'error'); if (offline) throw new Error('offline'); return Response.json(value); }) as typeof fetch });
  return { create, set: (v: any) => { value = v; }, fail: () => { offline = true; }, calls: () => calls };
}
test('release comparison is numeric and accepts stable versions only', () => {
  assert.equal(newerVersion('1.0.10', '1.0.9'), true); assert.equal(newerVersion('2.0.0', '1.99.99'), true);
  for (const v of ['1.0.6', '1.0.5', '1.0.7-beta', '1.2', '01.0.7', 'bad']) assert.equal(newerVersion(v, '1.0.6'), false);
  // a preview of 1.0.13 is offered 1.0.13 and later, never 1.0.12 or another preview
  assert.equal(newerVersion('1.0.13', '1.0.13-preview.42'), true); assert.equal(newerVersion('1.1.0', '1.0.13-preview.42'), true);
  for (const v of ['1.0.12', '1.0.13-preview.43']) assert.equal(newerVersion(v, '1.0.13-preview.42'), false);
});
test('one manifest request per process; skip persists for that version but a later version is offered', async t => {
  const r = setup(t); let c = r.create(); await Promise.all([c.startup(), c.startup()]); assert.equal(r.calls(), 1);
  assert.deepEqual(c.snapshot(), { version: '1.0.7', currentVersion: '1.0.6' }); assert.equal(c.updateUrl(), 'https://chorus-cli.web.app/update');
  c.skip(); assert.equal(c.snapshot(), null); assert.equal(c.updateUrl(), undefined); await c.startup(); assert.equal(r.calls(), 1); c.close();
  c = r.create(); await c.startup(); assert.equal(c.snapshot(), null); c.close();
  r.set(release('1.0.8')); c = r.create(); await c.startup(); assert.equal(c.snapshot()?.version, '1.0.8'); c.close();
});
test('offline checks do not retry, and manifests cannot inject an external download or unsupported platform', async t => {
  const r = setup(t); r.fail(); const c = r.create(); await c.startup(); await c.startup(); assert.equal(r.calls(), 1); assert.equal(c.snapshot(), null); c.close();
  const good = setup(t);
  for (const value of [release('1.0.7', 'https://evil.example/payload.zip'), release('1.0.5'), { version: '1.0.7', downloads: {} }, { ...release(), version: '<script>' }]) {
    good.set(value); const invalid = good.create(); await invalid.startup(); assert.equal(invalid.snapshot(), null); invalid.close();
  }
  good.set(release()); const unsupported = good.create('win32', 'x64'); await unsupported.startup(); assert.equal(unsupported.snapshot(), null); unsupported.close();
});

/* ---------- Update Chorus in the app: the official installer, then Restart (plan 2026-11-12) ---------- */
// A fake installer and download server: the script downloads one or two files with curl's progress bar, like install.sh, from
// CHORUS_DOWNLOADS, and writes what it was given into the folder the test reads.
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { RELAUNCH, INSTALLER } from '../../src/serve/updates.ts';

const FAKE_INSTALLER = (fail = false) => `#!/bin/bash
set -euo pipefail
out="$CHORUS_TEST_OUT"
{ echo "NO_OPEN=$CHORUS_NO_OPEN"; echo "APP_DIR=\${CHORUS_APP_DIR:-}"; echo "CLAUDECODE=\${CLAUDECODE:-}"; if read -r -t 1 x; then echo "STDIN=open"; else echo "STDIN=closed"; fi; } > "$out/env"
echo ""; echo "Chorus 9.9.9"; echo ""
echo "1/2  Installing the chorus command (darwin-arm64)…"
curl -fSL --progress-bar "$CHORUS_DOWNLOADS/pkg.tar.gz" -o "$out/pkg.tar.gz"
echo "2/2  Installing Chorus.app…"
${fail ? 'echo "curl: (28) Failed to connect to github.com port 443 after 30002 ms" >&2; echo "✗ Could not download app.zip" >&2; exit 1' : 'curl -fSL --progress-bar "$CHORUS_DOWNLOADS/app.zip" -o "$out/app.zip"; mkdir -p "$CHORUS_APP_DIR/Chorus.app"; echo "✓ Chorus is installed: $CHORUS_APP_DIR/Chorus.app"'}
`;

async function downloads(t: any, script: string) {
  const big = Buffer.alloc(2_000_000, 7);
  const server = http.createServer((req, res) => {
    if (req.url === '/install.sh') return void res.end(script);
    if (req.url === '/moved.sh') return void (res.writeHead(302, { location: '/install.sh' }), res.end());
    if (req.url === '/pkg.tar.gz' || req.url === '/app.zip') return void res.end(big);
    res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
async function installing(t: any, o: { fail?: boolean; path?: string; installer?: string } = {}) {
  const base = await downloads(t, FAKE_INSTALLER(o.fail));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-updates-')), out = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-install-out-'));
  t.after(() => { fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true }); });
  const relaunched: string[][] = [];
  const request = (async (url: any, opts: any) => (String(url) === RELEASE_MANIFEST ? Response.json(release('9.9.9')) : fetch(url, opts))) as typeof fetch;
  const c = new UpdateCheck({ directory, version: '1.0.6', platform: 'darwin', arch: 'arm64', request, test: { installer: o.installer ?? `${base}${o.path ?? '/install.sh'}`, env: { CHORUS_DOWNLOADS: base, CHORUS_TEST_OUT: out }, app: { pid: 4242, exe: '/tmp/x/Chorus.app/Contents/MacOS/chorus-desktop' }, relaunch: a => relaunched.push(a) } });
  t.after(() => c.close());
  await c.startup();
  const phases: string[] = [];
  const done = new Promise<void>(r => c.onChange(() => { const st = c.snapshot()?.install; if (st && phases.at(-1) !== st.phase) phases.push(st.phase); if (st && ['ready', 'failed'].includes(st.phase)) r(); }));
  return { c, directory, out, phases, done, relaunched };
}

test('Update Chorus runs the official installer: closed stdin, CHORUS_NO_OPEN, Chorus.app staged; downloading → installing → ready; Restart relaunches', async t => {
  assert.equal(INSTALLER, 'https://chorus-cli.web.app/install.sh');
  const r = await installing(t);
  assert.deepEqual(r.c.restart(), { error: 'Nothing is installed yet' });
  process.env.CLAUDECODE = '1';
  t.after(() => delete process.env.CLAUDECODE);
  assert.deepEqual(await r.c.install(), { ok: true });
  assert.deepEqual(await r.c.install(), { ok: true }, 'a second click while it runs starts nothing');
  await r.done;
  assert.deepEqual(r.phases, ['downloading', 'installing', 'ready']);
  const env = fs.readFileSync(path.join(r.out, 'env'), 'utf8');
  assert.match(env, /NO_OPEN=1/);
  assert.match(env, /STDIN=closed/);
  assert.match(env, /CLAUDECODE=\n/, "a parent Claude Code session's variables are removed");
  const stage = path.join(r.directory, 'app');
  assert.match(env, new RegExp(`APP_DIR=${stage}\n`), 'Chorus.app goes to a staging folder: the installer stops a Chorus.app running where it installs');
  assert.deepEqual(r.c.snapshot()?.install, { phase: 'ready', pct: 100 });
  assert.deepEqual(r.c.restart(), { ok: true });
  assert.deepEqual(r.relaunched, [['4242', String(process.pid), '/tmp/x/Chorus.app', path.join(stage, 'Chorus.app'), '']]);
});

test('Update Chorus reads the installer as it wrote it: a progress bar split between two reads, stdout and stderr in order', async t => {
  // the second part of the bar comes in a later read; the step line (stdout) and the error (stderr) keep their order
  const script = `#!/bin/bash
echo "1/2  Installing the chorus command (darwin-arm64)…"
printf '\\r######## 100' >&2; sleep 0.3; printf '.0%%\\n' >&2
echo "2/2  Installing Chorus.app…"
printf '\\r######## 100.0%%\\n' >&2
echo "first"; echo "second" >&2; echo "third"; exit 3
`;
  const base = await downloads(t, script);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-updates-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const request = (async (url: any, opts: any) => (String(url) === RELEASE_MANIFEST ? Response.json(release('9.9.9')) : fetch(url, opts))) as typeof fetch;
  const c = new UpdateCheck({ directory, version: '1.0.6', platform: 'darwin', arch: 'arm64', request, test: { installer: `${base}/install.sh` } });
  t.after(() => c.close());
  await c.startup();
  const phases: string[] = [];
  const done = new Promise<void>(r => c.onChange(() => { const st = c.snapshot()!.install!; if (phases.at(-1) !== st.phase) phases.push(st.phase); if (st.phase === 'failed') r(); }));
  await c.install();
  await done;
  assert.deepEqual(phases, ['downloading', 'installing', 'failed'], 'both downloads were counted');
  assert.deepEqual(c.snapshot()!.install!.lines!.slice(-4), ['2/2  Installing Chorus.app…', 'first', 'second', 'third']);
});

test('Update Chorus: a failed installer shows its last lines; Try again runs it again', async t => {
  const r = await installing(t, { fail: true });
  await r.c.install();
  await r.done;
  assert.equal(r.phases.at(-1), 'failed');
  const lines = r.c.snapshot()?.install?.lines ?? [];
  assert.deepEqual(lines.slice(-2), ['curl: (28) Failed to connect to github.com port 443 after 30002 ms', '✗ Could not download app.zip']);
  assert.ok(!lines.some(l => /%/.test(l)), 'no progress bars in the error');
  assert.deepEqual(r.c.restart(), { error: 'Nothing is installed yet' });
  const again = new Promise<void>(res => r.c.onChange(() => r.c.snapshot()?.install?.phase === 'failed' && res()));
  assert.deepEqual(await r.c.install(), { ok: true });
  assert.equal(r.c.snapshot()?.install?.phase, 'downloading');
  await again;
});

test('Update Chorus: the installer comes from an https address without redirects; nothing runs otherwise, and nothing without an update', async t => {
  const moved = await installing(t, { path: '/moved.sh' });
  await moved.c.install();
  await moved.done;
  assert.equal(moved.phases.at(-1), 'failed');
  assert.match(moved.c.snapshot()!.install!.lines![0], /Could not download the installer/);
  assert.equal(fs.existsSync(path.join(moved.out, 'env')), false, 'a redirect is not followed');
  const plain = await installing(t, { installer: 'http://example.com/install.sh' });
  await plain.c.install();
  await plain.done;
  assert.match(plain.c.snapshot()!.install!.lines![0], /must be https/);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-updates-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const none = new UpdateCheck({ directory, version: '9.9.9', request: (async () => Response.json(release('1.0.0'))) as typeof fetch });
  await none.startup();
  assert.deepEqual(await none.install(), { error: 'No update is available' });
  none.close();
});

test('Restart without a Chorus window above the server (a browser tab on chorus serve) asks to quit and open Chorus again', async t => {
  const r = await installing(t);
  (r.c as any).o.test.app = null;
  await r.c.install();
  await r.done;
  assert.deepEqual(r.c.restart(), { error: 'Quit Chorus and open it again to use the new version.' });
});

test('the relaunch script waits for the app and the server to stop, then opens the window again (Linux: chorus desktop)', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-relaunch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cmd = path.join(dir, 'chorus');
  fs.writeFileSync(cmd, `#!/bin/sh\necho "$@" > "${dir}/opened"\n`, { mode: 0o755 });
  const { spawn } = await import('node:child_process');
  const app = spawn('sleep', ['30']), serve = spawn('sleep', ['30']);
  // the server stops by itself once the app is gone (its stdin closes): here a moment after
  app.once('exit', () => setTimeout(() => serve.kill(), 300));
  const t0 = Date.now();
  const script = spawn('/bin/sh', ['-c', RELAUNCH, 'relaunch', String(app.pid), String(serve.pid), '', '', cmd], { stdio: 'ignore' });
  assert.equal(await new Promise(r => script.once('exit', r)), 0);
  assert.ok(Date.now() - t0 < 10_000, 'it did not wait for its time-out');
  for (let i = 0; i < 40 && !fs.existsSync(path.join(dir, 'opened')); i++) await new Promise(x => setTimeout(x, 50));
  assert.equal(fs.readFileSync(path.join(dir, 'opened'), 'utf8').trim(), 'desktop');
  assert.ok(Date.now() - t0 >= 250, 'it waited for the server');
  assert.equal(app.exitCode !== null || app.signalCode !== null, true);
});

// The real installer (chorus-admin's site/install.sh, when that checkout sits next to this one) against a fake release on
// 127.0.0.1, into temporary folders: never ~/.chorus or /Applications.
const REAL_INSTALLER = path.resolve(import.meta.dirname, '../../../chorus-admin/site/install.sh');
test('Update Chorus with the real install.sh and a fake release: the command and Chorus.app are installed, the app staged', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' || !fs.existsSync(REAL_INSTALLER) ? 'needs macOS on Apple silicon and ../chorus-admin' : false }, async t => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-real-install-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const script = fs.readFileSync(REAL_INSTALLER, 'utf8');
  const v = /^VERSION="([^"]+)"/m.exec(script)![1];
  const rel = path.join(tmp, 'rel'), build = path.join(tmp, 'build');
  fs.mkdirSync(path.join(build, `chorus-${v}/bin`), { recursive: true });
  fs.mkdirSync(path.join(build, 'Chorus.app/Contents/MacOS'), { recursive: true });
  fs.mkdirSync(rel);
  fs.writeFileSync(path.join(build, `chorus-${v}/bin/chorus`), '#!/bin/sh\necho chorus\n', { mode: 0o755 });
  fs.writeFileSync(path.join(build, `chorus-${v}/payload`), Buffer.alloc(3_000_000, 1));
  fs.writeFileSync(path.join(build, 'Chorus.app/Contents/MacOS/chorus-desktop'), '#!/bin/sh\n', { mode: 0o755 });
  const sh = (cmd: string) => { const r = spawnSync('/bin/sh', ['-c', cmd], { cwd: tmp, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  sh(`tar -czf rel/chorus-darwin-arm64-${v}.tar.gz -C build chorus-${v} && (cd build && ditto -c -k --keepParent Chorus.app ../rel/Chorus-macOS-${v}.zip) && (cd rel && shasum -a 256 *.tar.gz *.zip > SHA256SUMS)`);
  const server = http.createServer((req, res) => {
    if (req.url === '/install.sh') return void res.end(script);
    const f = path.join(rel, path.basename(req.url ?? ''));
    if (fs.existsSync(f)) return void res.end(fs.readFileSync(f));
    res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const directory = path.join(tmp, 'updates');
  const request = (async (url: any, opts: any) => (String(url) === RELEASE_MANIFEST ? Response.json(release('99.0.0')) : fetch(url, opts))) as typeof fetch;
  const c = new UpdateCheck({ directory, version: '1.0.6', request, test: { installer: `${base}/install.sh`, env: { CHORUS_DOWNLOADS: base, CHORUS_INSTALL_DIR: path.join(tmp, 'root'), CHORUS_BIN_DIR: path.join(tmp, 'bin') } } });
  t.after(() => c.close());
  await c.startup();
  const phases: string[] = [];
  const done = new Promise<void>(r => c.onChange(() => { const st = c.snapshot()?.install; if (st && phases.at(-1) !== st.phase) phases.push(st.phase); if (st && ['ready', 'failed'].includes(st.phase)) r(); }));
  await c.install();
  await done;
  assert.deepEqual(phases, ['downloading', 'installing', 'ready'], JSON.stringify(c.snapshot()?.install));
  assert.equal(fs.readlinkSync(path.join(tmp, 'root/current')), `versions/${v}`);
  assert.ok(fs.existsSync(path.join(directory, 'app/Chorus.app/Contents/MacOS/chorus-desktop')), 'Chorus.app staged');
  assert.equal(fs.readlinkSync(path.join(tmp, 'bin/chorus')), path.join(tmp, 'root/current/bin/chorus'));
});
