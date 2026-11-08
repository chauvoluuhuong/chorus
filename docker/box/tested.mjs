#!/usr/bin/env node
// The newest tested version of each AI CLI, from chorus-core's src/tested.json, as Docker build arguments:
//   node docker/box/tested.mjs <path to tested.json>   →  CLAUDE_VERSION=2.1.310 CODEX_VERSION=0.164.0 AGY_VERSION=1.4.5
//   --build-args: the same as `--build-arg X=Y …` for `docker build $(…)`
// A version listed under "breaks" is skipped. The box ships exactly these, with their auto-update off (docker/box/Dockerfile).
import fs from 'node:fs';

const file = process.argv.slice(2).find(a => !a.startsWith('--'));
const asArgs = process.argv.includes('--build-args');
if (!file) {
  console.error('usage: node docker/box/tested.mjs <tested.json>');
  process.exit(2);
}
const { versions, breaks = {} } = JSON.parse(fs.readFileSync(file, 'utf8'));
const cmp = (a, b) => {
  const x = a.split(/[.-]/).map(Number), y = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
const newest = cli => {
  const broken = new Set((breaks[cli] ?? []).map(b => (typeof b === 'string' ? b : b.version)));
  const ok = (versions[cli] ?? []).map(v => v.version).filter(v => !broken.has(v)).sort(cmp);
  if (!ok.length) throw new Error(`no tested version of ${cli} in ${file}`);
  return ok.at(-1);
};
const pairs = [`CLAUDE_VERSION=${newest('claude')}`, `CODEX_VERSION=${newest('codex')}`, `AGY_VERSION=${newest('agy')}`];
console.log(asArgs ? pairs.map(p => `--build-arg ${p}`).join(' ') : pairs.join(' '));
