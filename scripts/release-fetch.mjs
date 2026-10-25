#!/usr/bin/env node
// Brings the downloads that the release workflow (.github/workflows/release.yml) attached to the GitHub Release
// v<version> into ../chorus-admin/site/dl/ (or CHORUS_SITE_DIR/dl), checks them against its SHA256SUMS and sets VERSION
// in site/install.sh: the same result as `npm run release:downloads`, without building here. Then `npm run deploy:site`.
//   node scripts/release-fetch.mjs [version]     (default: package.json's version; needs `gh` logged in)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const version = process.argv[2] ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const siteRoot = path.resolve(process.env.CHORUS_SITE_DIR ?? path.join(root, '../chorus-admin/site'));
if (!fs.existsSync(path.join(siteRoot, 'install.sh'))) throw new Error('Clone chorus-admin next to chorus, or set CHORUS_SITE_DIR to its site directory');
const out = path.join(siteRoot, 'dl');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
execFileSync('gh', ['release', 'download', `v${version}`, '--repo', 'chauvoluuhuong/chorus', '--dir', out], { stdio: 'inherit' });

const sums = fs.readFileSync(path.join(out, 'SHA256SUMS'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/));
for (const [want, name] of sums) {
  const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(out, name))).digest('hex');
  if (got !== want) throw new Error(`${name}: checksum mismatch`);
  console.log(`${name}  ${(fs.statSync(path.join(out, name)).size / 1048576).toFixed(1)} MB  ok`);
}
const sh = path.join(siteRoot, 'install.sh');
fs.writeFileSync(sh, fs.readFileSync(sh, 'utf8').replace(/^VERSION=".*"$/m, `VERSION="${version}"`));
console.log(`site/install.sh  VERSION=${version}`);
