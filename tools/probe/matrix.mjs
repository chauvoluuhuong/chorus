#!/usr/bin/env node
// Version matrix: probe several versions of one CLI and record, per version, what works with Chorus.
//
//   node tools/probe/matrix.mjs <claude|codex|agy> <version,…|installed> [--force] [--only probe|approval] [--no-docs]
//
// For each version:
//   1. the binary: `installed` is the one on PATH; a version number is installed pinned (clis.mjs), beside the user's own
//   2. capture: probe.mjs (hello, mcp, shell, artifact, resume, envelope) and approval-probe.mjs (the CLI's own permission
//      prompt in the TUI, answered with Enter) write fixtures/<cli>/<version>/<scenario>/; a scenario already captured
//      is kept unless --force, so committed fixtures don't change under the other tests
//   3. Chorus against the capture: the version's tests in test/contract/adapters.test.ts (adapters, approval detector)
//   4. fixtures/<cli>/<version>/matrix.json, then docs/integrations/versions.md is rewritten from every matrix.json
//
// Claude runs on haiku. Each version costs about 8 model turns (agy: mind its small plan quota).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, installedVersion, PINNED_ENV } from './clis.mjs';

const HERE = import.meta.dirname;
const REPO = path.resolve(HERE, '../..');
const FIX = path.join(REPO, 'fixtures');
const DOC = path.join(REPO, 'docs', 'integrations', 'versions.md');
export const SCENARIOS = ['hello', 'mcp', 'shell', 'artifact', 'resume', 'envelope'];
const APPROVAL = 'approval-ask-nohook-enter';

const argv = process.argv.slice(2);
const [cli, versionArg] = argv;
const has = f => argv.includes(`--${f}`);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : undefined;

const env = { ...process.env, ...PINNED_ENV };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID']) delete env[k];
const slug = v => (v.match(/\d+\.\d+\.\d+[\w.-]*/) ?? [v])[0];
const done = (v, s) => fs.existsSync(path.join(FIX, cli, v, s, 'result.json'));

function runVersion(v) {
  let approvalAttempts;
  const pinned = v !== 'installed';
  const bin = pinned ? install(cli, v) : spawnSync('which', [cli], { encoding: 'utf8' }).stdout.trim();
  const reported = installedVersion(bin);
  if (!reported) throw new Error(`${bin} --version failed`);
  const version = slug(reported);
  console.log(`\n== ${cli} ${version} (${pinned ? 'pinned' : 'on PATH'}: ${bin.replace(os.homedir(), '~')})`);

  if (only !== 'approval') {
    const todo = SCENARIOS.filter(s => has('force') || !done(version, s));
    if (todo.length) {
      const model = cli === 'claude' ? ['--model', 'haiku'] : [];
      spawnSync(process.execPath, [path.join(HERE, 'probe.mjs'), cli, '--bin', bin, '--scenario', todo.join(','), ...model], { cwd: REPO, env, stdio: 'inherit' });
    } else console.log('  probe scenarios already captured (--force to redo)');
  }
  if (only !== 'probe') {
    if (has('force') || !done(version, APPROVAL)) {
      // --manual: Claude 2.1.302+ starts in auto mode and would not ask; it pins manual mode in the probe's workspace only
      const a = ['ask', '--nohook', '--manual', '--keys', JSON.stringify(['\r']), '--tag', 'nohook-enter', '--bin', bin, '--wait', '120'];
      // Codex asks only when the model requests escalation, and sometimes it doesn't (docs/integrations/approvals.md, gotcha 1)
      for (let i = 1; i <= 3; i++) {
        spawnSync(process.execPath, [path.join(HERE, 'approval-probe.mjs'), cli, ...a], { cwd: REPO, env, stdio: 'inherit' });
        approvalAttempts = i;
        if (JSON.parse(fs.readFileSync(path.join(FIX, cli, version, APPROVAL, 'result.json'), 'utf8')).promptSeenAndKeysSent) break;
      }
    } else console.log('  approval already captured (--force to redo)');
  }

  const t = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=^${cli} ${version.replace(/\./g, '\\.')}: `, 'test/contract/adapters.test.ts'], { cwd: REPO, encoding: 'utf8' });
  const chorus = [...t.stdout.matchAll(/^\s*(ok|not ok) \d+ - (.+?)(?: # (SKIP).*)?$/gm)]
    .filter(m => m[2].startsWith(`${cli} ${version}: `))
    .map(m => ({ test: m[2].slice(`${cli} ${version}: `.length), result: m[3] ? 'skip' : m[1] === 'ok' ? 'pass' : 'fail' }));

  const read = s => (done(version, s) ? JSON.parse(fs.readFileSync(path.join(FIX, cli, version, s, 'result.json'), 'utf8')) : undefined);
  const capture = Object.fromEntries(SCENARIOS.map(s => {
    const r = read(s);
    return [s, r ? { passed: r.passed, failed: r.checks.filter(c => !c.ok).map(c => c.name), date: r.date, platform: r.platform } : null];
  }));
  const ap = read(APPROVAL);
  capture.approval = ap ? { passed: !!(ap.promptSeenAndKeysSent && ap.fileCreated), failed: [!ap.promptSeenAndKeysSent && 'prompt not seen', !ap.fileCreated && 'file not created after Enter'].filter(Boolean), ...(approvalAttempts > 1 ? { attempts: approvalAttempts } : {}) } : null;
  const m = {
    cli,
    version,
    reported,
    install: pinned ? `npm ${(cli === 'claude' ? '@anthropic-ai/claude-code' : '@openai/codex')}@${v} (pinned)` : `on PATH (${bin.replace(os.homedir(), '~')})`,
    date: new Date().toISOString(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    capture,
    chorus,
  };
  m.verdict = verdict(m);
  fs.writeFileSync(path.join(FIX, cli, version, 'matrix.json'), JSON.stringify(m, null, 2) + '\n');
  console.log(`  ${cli} ${version}: ${m.verdict}`);
}

/** tested: every capture and every Chorus test passed; works: all ran, something non-core failed; broken: a core capture failed */
function verdict(m) {
  const caps = Object.values(m.capture);
  if (caps.some(c => !c)) return 'incomplete';
  const fails = m.chorus.filter(c => c.result === 'fail').length + caps.filter(c => !c.passed).length;
  if (!fails) return 'tested';
  return ['hello', 'shell', 'resume'].some(s => !m.capture[s].passed) ? 'broken' : 'partial';
}

const MARK = { tested: '✅ tested', partial: '⚠ partial', broken: '❌ broken', incomplete: '… incomplete' };
const cell = c => (!c ? '–' : c.passed ? (c.attempts ? `✔ (try ${c.attempts})` : '✔') : `✖ ${c.failed.join('; ')}`);

export function writeDoc() {
  const rows = { claude: [], codex: [], agy: [] };
  for (const a of Object.keys(rows)) {
    const d = path.join(FIX, a);
    for (const v of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      const f = path.join(d, v, 'matrix.json');
      if (fs.existsSync(f)) rows[a].push(JSON.parse(fs.readFileSync(f, 'utf8')));
    }
    rows[a].sort((x, y) => cmp(y.version, x.version));
  }
  const out = ['<!-- generated by tools/probe/matrix.mjs from fixtures/<cli>/<version>/matrix.json; do not edit by hand -->', ''];
  for (const [a, list] of Object.entries(rows)) {
    out.push(`### ${{ claude: 'Claude Code', codex: 'Codex', agy: 'agy' }[a]}`, '');
    if (!list.length) {
      out.push('No version probed with the matrix yet.', '');
      continue;
    }
    out.push(`| Version | Verdict | ${[...SCENARIOS, 'approval'].join(' | ')} | Chorus tests | Installed as | Run | Evidence |`);
    out.push(`|${'---|'.repeat(SCENARIOS.length + 7)}`);
    for (const m of list) {
      const pass = m.chorus.filter(c => c.result === 'pass').length;
      const ran = m.chorus.filter(c => c.result !== 'skip').length;
      const failed = m.chorus.filter(c => c.result === 'fail').map(c => c.test);
      out.push(`| ${m.version} | ${MARK[m.verdict]} | ${[...SCENARIOS, 'approval'].map(s => cell(m.capture[s])).join(' | ')} | ${pass}/${ran}${failed.length ? ` (✖ ${failed.join('; ')})` : ''} | ${m.install} | ${m.date.slice(0, 10)} | [fixtures/${a}/${m.version}/](../../fixtures/${a}/${m.version}/) |`);
    }
    out.push('');
  }
  const doc = fs.readFileSync(DOC, 'utf8');
  const start = doc.indexOf('<!-- matrix:start -->');
  const end = doc.indexOf('<!-- matrix:end -->');
  fs.writeFileSync(DOC, `${doc.slice(0, start + '<!-- matrix:start -->'.length)}\n${out.join('\n')}\n${doc.slice(end)}`);
  console.log(`\nwrote ${path.relative(REPO, DOC)}`);
}

function cmp(a, b) {
  const x = a.split(/[.-]/).map(Number);
  const y = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!['claude', 'codex', 'agy'].includes(cli) || (!versionArg && !has('docs-only'))) {
    console.error('usage: node tools/probe/matrix.mjs <claude|codex|agy> <version,…|installed> [--force] [--only probe|approval] [--no-docs]\n       node tools/probe/matrix.mjs <cli> --docs-only');
    process.exit(2);
  }
  if (cli === 'agy' && versionArg && versionArg !== 'installed') {
    console.error('agy updates itself and has no versioned package: only `installed` can be probed');
    process.exit(2);
  }
  for (const v of versionArg && !has('docs-only') ? versionArg.split(',') : []) {
    try {
      runVersion(v);
    } catch (e) {
      console.error(`  ${cli} ${v}: ${e.message}`);
    }
  }
  if (!has('no-docs')) writeDoc();
}
