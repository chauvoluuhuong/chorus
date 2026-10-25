// site/release.json: the version and, per platform, the download and its checksum, read by the app at startup
// (src/serve/updates.ts). Written next to install.sh by release-downloads.mjs and release-fetch.mjs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function writeManifest(siteRoot, dlDir, version) {
  const name = { 'darwin-arm64': `Chorus-macOS-${version}.zip`, 'linux-arm64': `chorus-linux-arm64-${version}.tar.gz`, 'linux-x64': `chorus-linux-x64-${version}.tar.gz` };
  const downloads = {};
  for (const [target, file] of Object.entries(name)) {
    const f = path.join(dlDir, file);
    if (fs.existsSync(f)) downloads[target] = { url: `https://chorus-cli.web.app/dl/${file}`, sha256: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') };
  }
  fs.writeFileSync(path.join(siteRoot, 'release.json'), JSON.stringify({ version, downloads }, null, 2) + '\n');
}
