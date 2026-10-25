#!/usr/bin/env node
// Writes installer downloads into ../chorus-admin/site/dl/ (or CHORUS_SITE_DIR/dl), not in git;
// Firebase Hosting publishes it with the page):
//   chorus-cli-<version>.tgz        the chorus command (`npm pack`; package.json "files" picks what goes in), with the
//                                   private @chauvoluuhuong/chorus-core inside it as a bundled dependency
//   chorus-<os>-<arch>-<version>.tar.gz   the chorus command with its own Node.js and node-pty already built (macOS arm64,
//                                   Linux arm64 and x64): what site/install.sh installs, so the user needs no Node, npm or compiler.
//                                   The Linux ones are built in Docker (Debian 11, glibc 2.31); needs a running Docker.
//   Chorus-macOS-<version>.zip      Chorus.app from desktop/ (built first when missing)
//   SHA256SUMS                      checksums of the files above, which install.sh verifies
// and sets VERSION in site/install.sh to package.json's version. Then `npm run deploy:site` delegates publication to chorus-admin.
//   node scripts/release-downloads.mjs [--rebuild-app] [--targets darwin-arm64,linux-arm64,linux-x64]
//   (CHORUS_APP=<path to Chorus.app> to use another build)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const siteRoot = path.resolve(process.env.CHORUS_SITE_DIR ?? path.join(root, '../chorus-admin/site'));
if (!fs.existsSync(path.join(siteRoot, 'install.sh'))) throw new Error('Clone chorus-admin next to chorus, or set CHORUS_SITE_DIR to its site directory');
const out = path.join(siteRoot, 'dl');
const app = process.env.CHORUS_APP ?? path.join(root, 'desktop/src-tauri/target/release/bundle/macos/Chorus.app');
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
pkg.bin = { chorus: 'src/cli/index.js' };
pkg.scripts = { postinstall: pkg.scripts.postinstall };
pkg.files = ['src', 'scripts'];
delete pkg.devDependencies;
// chorus-core is private (docs/chorus-core.md §5): its built package goes inside the tarball, so the user's npm installs it
// with Chorus and needs no login. It is built and checked (dist/ only) from the checkout next to this one.
const coreDir = fs.realpathSync(path.join(root, 'node_modules/@chauvoluuhuong/chorus-core'));
run('npm', ['run', 'build'], coreDir);
run('npm', ['run', 'check:pack'], coreDir);
const corePacked = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', stage], coreDir))[0];
const coreTo = path.join(stage, 'node_modules/@chauvoluuhuong/chorus-core');
fs.mkdirSync(coreTo, { recursive: true });
run('tar', ['-xzf', path.join(stage, corePacked.filename), '-C', coreTo, '--strip-components', '1']);
fs.rmSync(path.join(stage, corePacked.filename));
pkg.dependencies['@chauvoluuhuong/chorus-core'] = corePacked.version;
pkg.bundleDependencies = ['@chauvoluuhuong/chorus-core'];
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
fs.chmodSync(path.join(stage, 'src/cli/index.js'), 0o755);

const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', out], stage))[0];
const tgz = path.join(out, `chorus-cli-${version}.tgz`);
fs.renameSync(path.join(out, packed.filename), tgz);

// ---- the bundles: the same staged package + a Node.js binary + dependencies installed on the target platform ----
const TARGETS = { 'darwin-arm64': 'darwin-arm64', 'linux-arm64': 'linux-arm64', 'linux-x64': 'linux-x64' };
const wanted = (process.argv.find((a) => a.startsWith('--targets='))?.slice(10) ?? Object.keys(TARGETS).join(',')).split(',').filter(Boolean);
const cache = path.join(root, 'node_modules/.cache/chorus-release');
fs.mkdirSync(cache, { recursive: true });
const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
const nodeVersion = (await (await fetch('https://nodejs.org/dist/index.json')).json()).find((v) => v.version.startsWith('v22.') && v.lts).version;
const sums = (await get(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`)).toString();
async function nodeTarball(target) {
  const name = `node-${nodeVersion}-${target}.tar.xz`;
  const file = path.join(cache, name);
  const want = sums.split('\n').find((l) => l.endsWith(`  ${name}`))?.split(' ')[0];
  if (!want) throw new Error(`no checksum for ${name}`);
  if (!fs.existsSync(file) || sha(file) !== want) {
    fs.writeFileSync(file, await get(`https://nodejs.org/dist/${nodeVersion}/${name}`));
    if (sha(file) !== want) throw new Error(`${name}: checksum mismatch`);
  }
  return file;
}
// bin/chorus finds its own folder through symlinks (the command is linked into ~/.local/bin), then runs the Node inside it
const LAUNCHER = `#!/bin/sh
# Chorus: runs the bundled Node.js on the bundled app. Nothing here depends on a Node.js installed on this computer.
self="$0"
while [ -h "$self" ]; do
  dir="$(cd "$(dirname "$self")" && pwd)"
  self="$(readlink "$self")"
  case "$self" in /*) ;; *) self="$dir/$self" ;; esac
done
here="$(cd "$(dirname "$self")/.." && pwd)"
exec "$here/runtime/node" --disable-warning=ExperimentalWarning "$here/app/src/cli/index.js" "$@"
`;
const bundles = [];
for (const target of wanted) {
  if (!TARGETS[target]) throw new Error(`unknown target ${target}`);
  const [os, arch] = target.split('-');
  const work = fs.mkdtempSync(path.join(out, '.bundle-'));
  const top = path.join(work, 'chorus');
  fs.mkdirSync(path.join(top, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(top, 'runtime'));
  fs.cpSync(stage, path.join(top, 'app'), { recursive: true });
  fs.rmSync(path.join(top, 'app', path.basename(tgz)), { force: true });
  fs.writeFileSync(path.join(top, 'bin/chorus'), LAUNCHER, { mode: 0o755 });
  const xz = await nodeTarball(target);
  const ex = path.join(work, 'node-x');
  fs.mkdirSync(ex);
  run('tar', ['-xJf', xz, '-C', ex, '--strip-components', '1']);
  fs.copyFileSync(path.join(ex, 'bin/node'), path.join(top, 'runtime/node'));
  fs.chmodSync(path.join(top, 'runtime/node'), 0o755);
  fs.copyFileSync(path.join(ex, 'LICENSE'), path.join(top, 'runtime/LICENSE-node'));
  const app = path.join(top, 'app');
  console.log(`bundle ${target}: installing dependencies for ${target}…`);
  if (os === 'darwin' && process.platform === 'darwin' && process.arch === arch) {
    run('npm', ['install', '--omit=dev', '--no-fund', '--no-audit', '--loglevel=error'], app);
  } else if (os === 'linux') {
    // Debian 11 (glibc 2.31; its package archive, as 11 is no longer on the main mirrors) so the compiled node-pty runs on Ubuntu 20.04+, Debian 11+, Fedora, Arch…; the target's own Node does the npm install
    const platform = arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
    run('docker', ['run', '--rm', '--platform', platform, '-v', `${ex}:/node:ro`, '-v', `${app}:/app`, '-w', '/app', 'debian:11-slim', 'bash', '-c',
      "set -e; sed -i 's|deb.debian.org|archive.debian.org|g; /bullseye-updates/d' /etc/apt/sources.list; apt-get -o Acquire::Check-Valid-Until=false update -qq >/dev/null; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3 make g++ >/dev/null; export PATH=/node/bin:$PATH; npm install --omit=dev --no-fund --no-audit --loglevel=error"]);
  } else {
    throw new Error(`cannot build ${target} on ${process.platform}-${process.arch}`);
  }
  // keep only what runs on this target
  const nm = path.join(app, 'node_modules');
  const pre = path.join(nm, 'node-pty/prebuilds');
  if (fs.existsSync(pre)) for (const d of fs.readdirSync(pre)) if (d !== target) fs.rmSync(path.join(pre, d), { recursive: true, force: true });
  for (const d of ['src', 'deps', 'scripts', 'third_party', 'typings']) fs.rmSync(path.join(nm, 'node-pty', d), { recursive: true, force: true });
  fs.rmSync(path.join(nm, 'node-pty/build/Release/obj.target'), { recursive: true, force: true });
  fs.rmSync(path.join(nm, '.package-lock.json'), { force: true });
  const file = path.join(out, `chorus-${target}-${version}.tar.gz`);
  run('tar', ['--no-xattrs', '-czf', file, '-C', work, 'chorus']); // no macOS extended attributes: GNU tar warns about each one
  fs.rmSync(work, { recursive: true, force: true });
  bundles.push(file);
}
fs.rmSync(stage, { recursive: true, force: true });

if (process.argv.includes('--rebuild-app') || !fs.existsSync(app)) run('npm', ['run', 'build'], path.join(root, 'desktop'));
const zip = path.join(out, `Chorus-macOS-${version}.zip`);
run('ditto', ['-c', '-k', '--keepParent', app, zip]);

const sh = path.join(siteRoot, 'install.sh');
fs.writeFileSync(sh, fs.readFileSync(sh, 'utf8').replace(/^VERSION=".*"$/m, `VERSION="${version}"`));

const all = [tgz, zip, ...bundles];
fs.writeFileSync(path.join(out, 'SHA256SUMS'), all.map((f) => `${sha(f)}  ${path.basename(f)}`).join('\n') + '\n');
// The public manifest is deployed with the exact archives/checksums, so clients need no GitHub/API polling.
const downloads = {};
for (const target of ['darwin-arm64', 'linux-arm64', 'linux-x64']) {
  const artifact = target === 'darwin-arm64' ? zip : bundles.find(f => path.basename(f) === `chorus-${target}-${version}.tar.gz`);
  if (artifact) downloads[target] = { url: `https://chorus-cli.web.app/dl/${path.basename(artifact)}`, sha256: sha(artifact) };
}
fs.writeFileSync(path.join(siteRoot, 'release.json'), JSON.stringify({ version, downloads }, null, 2) + '\n');
for (const f of all) console.log(`${path.relative(root, f)}  ${(fs.statSync(f).size / 1048576).toFixed(1)} MB  sha256 ${sha(f)}`);
console.log(`site/install.sh  VERSION=${version}`);
