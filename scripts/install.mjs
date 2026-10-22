#!/usr/bin/env node
// One command to use Chorus from anywhere: `chorus` on the PATH (npm link to this checkout) and, on macOS, the desktop
// app built and copied to /Applications (or ~/Applications when that is not writable), where `chorus desktop` and the
// Finder find it. The app starts the global `chorus serve`, so it always runs this checkout's code.
//
//   npm run install:global            CLI + desktop app
//   npm run install:global -- --no-app    CLI only
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const BUILT = path.join(DESKTOP, 'src-tauri/target/release/bundle/macos/Chorus.app');
const noApp = process.argv.includes('--no-app');

function run(cmd, args, cwd = ROOT) {
  console.log(`\n$ ${cmd} ${args.join(' ')}${cwd === ROOT ? '' : `   (in ${path.relative(ROOT, cwd)})`}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\nfailed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}
const has = cmd => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;

// 1. the CLI: dependencies, then `chorus` on the PATH pointing at this checkout
run('npm', ['install']);
run('npm', ['link']);

// 2. the desktop app (macOS; needs Rust to build the Tauri shell)
let installed = '';
if (noApp) console.log('\nskipping the desktop app (--no-app)');
else if (process.platform !== 'darwin') console.log('\nskipping the desktop app: only the macOS build is set up so far (docs/phase5.md §7)');
else if (!has('cargo')) console.log('\nskipping the desktop app: it needs Rust to build (https://rustup.rs), then run this again');
else {
  run('npm', ['install'], DESKTOP);
  run('npx', ['tauri', 'build', '--bundles', 'app'], path.join(DESKTOP, 'src-tauri'));
  const dest = canWrite('/Applications') ? '/Applications' : path.join(os.homedir(), 'Applications');
  fs.mkdirSync(dest, { recursive: true });
  installed = path.join(dest, 'Chorus.app');
  // quit a running copy first, or the old binary keeps running from the replaced bundle
  spawnSync('pkill', ['-f', path.join(installed, 'Contents/MacOS/')], { stdio: 'ignore' });
  fs.rmSync(installed, { recursive: true, force: true });
  run('ditto', [BUILT, installed]);
}

function canWrite(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const where = spawnSync('sh', ['-c', 'command -v chorus'], { encoding: 'utf8' }).stdout.trim();
console.log(`
Chorus is installed.
  chorus            the CLI app, from any folder${where ? `   (${where})` : ''}
  chorus desktop    the desktop window${installed ? `   (${installed}; also in Launchpad and Spotlight)` : ' (not built)'}
  chorus serve      the desktop page in your browser
All of them run this checkout (${ROOT}). After a git pull the CLI is current at once; run npm run install:global again when desktop/ changed.`);
