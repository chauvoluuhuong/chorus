#!/usr/bin/env node
// Writes the files the one-command installer (site/install.sh) downloads, into site/dl/ (not in git;
// Firebase Hosting publishes it with the page):
//   chorus-cli-<version>.tgz        the chorus command (`npm pack`; package.json "files" picks what goes in)
//   Chorus-macOS-<version>.zip      Chorus.app from desktop/ (built first when missing)
// and sets VERSION in site/install.sh to package.json's version. Then `npm run deploy:site` publishes them.
//   node scripts/release-downloads.mjs [--rebuild-app]
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, 'site', 'dl');
const app = path.join(root, 'desktop/src-tauri/target/release/bundle/macos/Chorus.app');
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Node does not strip types from files under node_modules, so the package ships JavaScript: src/**/*.ts
// becomes src/**/*.js in the same layout (paths built from import.meta.dirname stay right), and every
// relative ".ts" specifier becomes ".js". The page's static files (src/desktop) are copied as they are.
const stage = fs.mkdtempSync(path.join(out, '.stage-'));
const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : [path.join(d, e.name)]));
const src = files(path.join(root, 'src'));
await esbuild.build({ entryPoints: src.filter((f) => f.endsWith('.ts')), outdir: path.join(stage, 'src'), outbase: path.join(root, 'src'), format: 'esm', platform: 'node', target: 'node22', logLevel: 'warning' });
for (const f of src.filter((f) => !f.endsWith('.ts'))) fs.cpSync(f, path.join(stage, path.relative(root, f)));
for (const f of files(path.join(stage, 'src')).filter((f) => f.endsWith('.js') && !f.includes('/desktop/'))) {
  const js = fs.readFileSync(f, 'utf8')
    .replace(/(["'`])(\.{1,2}\/[^"'`\n]*?)\.ts\1/g, '$1$2.js$1')
    .replaceAll("'src/cli/index.ts'", "'src/cli/index.js'");
  fs.writeFileSync(f, js);
}
fs.cpSync(path.join(root, 'scripts/fix-pty.mjs'), path.join(stage, 'scripts/fix-pty.mjs'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
pkg.bin = { chorus: 'src/cli/index.js', 'chorus-cli': 'src/cli/index.js' };
pkg.scripts = { postinstall: pkg.scripts.postinstall };
pkg.files = ['src', 'scripts'];
delete pkg.devDependencies;
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
fs.chmodSync(path.join(stage, 'src/cli/index.js'), 0o755);

const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', out], stage))[0];
const tgz = path.join(out, `chorus-cli-${version}.tgz`);
fs.renameSync(path.join(out, packed.filename), tgz);
fs.rmSync(stage, { recursive: true, force: true });

if (process.argv.includes('--rebuild-app') || !fs.existsSync(app)) run('npm', ['run', 'build'], path.join(root, 'desktop'));
const zip = path.join(out, `Chorus-macOS-${version}.zip`);
run('ditto', ['-c', '-k', '--keepParent', app, zip]);

const sh = path.join(root, 'site', 'install.sh');
fs.writeFileSync(sh, fs.readFileSync(sh, 'utf8').replace(/^VERSION=".*"$/m, `VERSION="${version}"`));

for (const f of [tgz, zip]) console.log(`${path.relative(root, f)}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB  sha256 ${sha(f)}`);
console.log(`site/install.sh  VERSION=${version}`);
