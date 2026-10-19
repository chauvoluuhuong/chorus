#!/usr/bin/env node
// P4.8 packaging spike: build the chorus app as one executable (Node single-executable application).
//
//   node tools/packaging/build-sea.mjs [--node /path/to/official/node] [--out dist/sea]
//
// Needs an official Node build with SEA support (Homebrew's node has it disabled; `npm i node@26` in a scratch
// dir gives one). esbuild bundles src/cli/index.ts to one ESM file; node-pty is a native addon that cannot live
// inside the binary, so it ships next to it in node_modules/node-pty (loaded through createRequire).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : d);
const node = opt('node', process.execPath);
const out = path.resolve(opt('out', path.join(ROOT, 'dist/sea')));
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const run = (cmd, a, o = {}) => {
  const r = spawnSync(cmd, a, { stdio: 'inherit', ...o });
  if (r.status !== 0) throw new Error(`${cmd} ${a.join(' ')} failed (${r.status})`);
};

// 1. bundle
const { build } = await import('esbuild');
await build({
  entryPoints: [path.join(ROOT, 'src/cli/index.ts')],
  outfile: path.join(out, 'chorus.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['node-pty'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
console.log('bundle:', (fs.statSync(path.join(out, 'chorus.mjs')).size / 1e6).toFixed(1), 'MB');

// 2. single executable
fs.writeFileSync(path.join(out, 'sea-config.json'), JSON.stringify({ main: path.join(out, 'chorus.mjs'), mainFormat: 'module', output: path.join(out, 'chorus'), disableExperimentalSEAWarning: true }));
run(node, ['--build-sea', path.join(out, 'sea-config.json')]);
if (process.platform === 'darwin') run('codesign', ['--force', '--sign', '-', path.join(out, 'chorus')]); // injected binaries are killed by macOS until re-signed

// 3. node-pty next to the binary (prebuilds for this platform only)
const src = path.join(ROOT, 'node_modules/node-pty');
const dst = path.join(out, 'node_modules/node-pty');
fs.mkdirSync(dst, { recursive: true });
fs.cpSync(path.join(src, 'lib'), path.join(dst, 'lib'), { recursive: true });
fs.copyFileSync(path.join(src, 'package.json'), path.join(dst, 'package.json'));
const plat = `${process.platform}-${process.arch}`;
if (fs.existsSync(path.join(src, 'prebuilds', plat))) fs.cpSync(path.join(src, 'prebuilds', plat), path.join(dst, 'prebuilds', plat), { recursive: true });
if (fs.existsSync(path.join(src, 'build'))) fs.cpSync(path.join(src, 'build'), path.join(dst, 'build'), { recursive: true });
for (const f of fs.readdirSync(path.join(dst, 'prebuilds', plat), { withFileTypes: true })) if (f.name === 'spawn-helper') fs.chmodSync(path.join(dst, 'prebuilds', plat, f.name), 0o755);
const size = fs.statSync(path.join(out, 'chorus')).size;
console.log(`built ${path.join(out, 'chorus')} (${(size / 1e6).toFixed(0)} MB) + node_modules/node-pty`);
