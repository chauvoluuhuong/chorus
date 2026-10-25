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
});
test('one manifest request per process; skip persists for that version but a later version is offered', async t => {
  const r = setup(t); let c = r.create(); await Promise.all([c.startup(), c.startup()]); assert.equal(r.calls(), 1);
  assert.deepEqual(c.snapshot(), { version: '1.0.7', currentVersion: '1.0.6' }); assert.match(c.downloadUrl()!, /Chorus-macOS-1.0.7.zip$/);
  c.skip(); assert.equal(c.snapshot(), null); assert.equal(c.downloadUrl(), undefined); await c.startup(); assert.equal(r.calls(), 1); c.close();
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
