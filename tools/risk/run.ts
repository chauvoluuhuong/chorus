#!/usr/bin/env node
// Risk harness: node tools/risk/run.ts <case|free|cheap|all> [--agents claude,codex,agy]
// Evidence goes to fixtures/risks/<case>/<timestamp>/ and a one-line summary is printed per case.
import fs from 'node:fs';
import path from 'node:path';
import type { Case } from './lib.ts';

const args = process.argv.slice(2);
const want = args.find(a => !a.startsWith('--')) ?? 'free';
const agents = (args[args.indexOf('--agents') + 1] && args.includes('--agents') ? args[args.indexOf('--agents') + 1] : 'claude,codex,agy').split(',');
const dir = path.resolve(import.meta.dirname, 'cases');
const cases: Case[] = [];
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.ts')).sort()) cases.push((await import(path.join(dir, f))).default);
const pick = cases.filter(c => want === 'all' || want === c.id || want === c.cost);
if (!pick.length) { console.error(`no case "${want}". Cases: ${cases.map(c => `${c.id} (${c.cost})`).join(', ')}`); process.exit(2); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
for (const c of pick) {
  const out = path.resolve('fixtures/risks', c.id, stamp);
  process.stdout.write(`▶ ${c.id} [${c.cost}] ${c.title}\n`);
  try {
    const r = await c.run({ out, agents, log: s => console.log('  ' + s) });
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ id: c.id, ...r, at: stamp }, null, 2));
    console.log(`  ${r.status.toUpperCase()}: ${r.summary}`);
  } catch (e: any) {
    console.log(`  ERROR: ${e?.stack ?? e}`);
  }
}
