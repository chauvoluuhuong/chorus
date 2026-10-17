// node-pty's prebuilt spawn-helper can lose its executable bit when installed, which makes every
// spawn fail with "posix_spawnp failed" (seen on macOS with node-pty 1.1.0).
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../node_modules/node-pty/prebuilds');
if (fs.existsSync(root)) {
  for (const d of fs.readdirSync(root)) {
    const f = path.join(root, d, 'spawn-helper');
    if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
  }
}
