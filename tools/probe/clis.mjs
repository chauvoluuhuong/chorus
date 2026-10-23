#!/usr/bin/env node
// Pinned CLI versions for the version matrix (tools/probe/matrix.mjs, docs/integrations/versions.md).
//
//   node tools/probe/clis.mjs install <claude|codex> <version>   prints the binary path
//   node tools/probe/clis.mjs list
//
// Each version gets its own npm prefix under ~/.cache/chorus/clis/<cli>/<version>/, so the user's own install (native,
// Homebrew or npm global) is never touched and several versions sit side by side. agy can't be pinned: it updates itself
// and has no versioned package, so only the version on PATH can be probed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.join(os.homedir(), '.cache', 'chorus', 'clis');
export const PACKAGES = { claude: '@anthropic-ai/claude-code', codex: '@openai/codex' };

// A pinned Claude Code must not update itself (an npm install would update the user's global one); the user's settings
// are left alone (rule 4), the variable is set for the probe's child processes only.
export const PINNED_ENV = { DISABLE_AUTOUPDATER: '1' };

export const pinnedBin = (cli, version) => path.join(ROOT, cli, version, 'node_modules', '.bin', cli);

export function install(cli, version) {
  if (!PACKAGES[cli]) throw new Error(`${cli} can't be pinned (only ${Object.keys(PACKAGES).join(', ')})`);
  const bin = pinnedBin(cli, version);
  if (fs.existsSync(bin) && installedVersion(bin)?.includes(version)) return bin;
  const prefix = path.join(ROOT, cli, version);
  fs.mkdirSync(prefix, { recursive: true });
  const r = spawnSync('npm', ['install', '--prefix', prefix, '--no-fund', '--no-audit', '--loglevel=error', `${PACKAGES[cli]}@${version}`], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`npm install ${PACKAGES[cli]}@${version} failed (${r.status})`);
  const got = installedVersion(bin);
  if (!got?.includes(version)) throw new Error(`${bin} reports "${got}", not ${version}`);
  return bin;
}

export function installedVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', env: { ...process.env, ...PINNED_ENV } });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : undefined;
}

export function list() {
  const out = [];
  for (const cli of fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : []) {
    for (const v of fs.readdirSync(path.join(ROOT, cli))) if (fs.existsSync(pinnedBin(cli, v))) out.push({ cli, version: v, bin: pinnedBin(cli, v) });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, cli, version] = process.argv.slice(2);
  if (cmd === 'install' && cli && version) console.log(install(cli, version));
  else if (cmd === 'list') for (const x of list()) console.log(`${x.cli.padEnd(7)} ${x.version.padEnd(10)} ${x.bin}`);
  else {
    console.error('usage: node tools/probe/clis.mjs install <claude|codex> <version> | list');
    process.exit(2);
  }
}
