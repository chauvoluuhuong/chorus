// `chorus doctor` in the terminal (docs/doctor.md §0–§3): the fast check, then only what a CLI needs: install it (its page
// opens first), sign in, or the deeper test for a version Chorus wasn't tested with. Every step that installs, signs in,
// spends model turns or sends something asks first; without a terminal nothing is asked and nothing is done.
//
//   chorus doctor [--deep claude,codex] [--json] [--yes]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { CLIS, stateLine, type AgentCheck, type DeepReport } from '@chauvoluuhuong/chorus-core/doctor';
import { check, DOCTOR_DIR, issue, markSeen, openUrl, runCommand, runDeep, sendIssue, versions } from '../core/doctor.ts';
import type { AgentId } from '../core/types.ts';

const tty = process.stdin.isTTY && process.stdout.isTTY;
const color = (n: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const [green, yellow, red, dim, bold] = [color(32), color(33), color(31), color(2), color(1)];
const MARK = { ready: green('✔'), missing: yellow('⚠'), 'needs-login': yellow('⚠'), untested: yellow('◆') };

export async function doctor(argv: string[]): Promise<number> {
  const yes = argv.includes('--yes');
  const deepArg = argv.includes('--deep') ? (argv[argv.indexOf('--deep') + 1] ?? '').split(',').filter(Boolean) as AgentId[] : [];
  let fast = await check();
  if (argv.includes('--json')) {
    console.log(JSON.stringify(fast, null, 2));
    return 0;
  }
  const v = versions();
  console.log(`\n${bold('Chorus doctor')} ${dim(`chorus ${v.chorus} · core ${v.core} · ${fast.platform} · Node ${fast.node.version} · ${(fast.ms / 1000).toFixed(1)} s`)}\n`);
  if (!fast.node.ok) console.log(`${red('✖')} Node ${fast.node.version}: Chorus needs Node 22.18 or later (https://nodejs.org, or brew install node)\n`);
  print(fast.agents);

  const rl = tty ? readline.createInterface({ input: process.stdin, output: process.stdout }) : undefined;
  const ask = async (q: string, dflt: boolean) => {
    if (!rl) return false;
    const a = (await rl.question(`${q} ${dflt ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    return a ? a.startsWith('y') : dflt;
  };

  try {
    // 1. missing CLIs: the page first, then the install the user agrees to
    for (const a of fast.agents.filter(a => a.state === 'missing')) {
      console.log(`\n${yellow('⚠')} ${bold(a.name)} is not installed. Chorus works with any one CLI; each one more adds handoff targets.`);
      console.log(`  Page:     ${a.page}`);
      console.log(`  Install:  ${a.install!.command}${a.install!.version ? dim(`   (${a.install!.version}, the newest version Chorus is tested with)`) : ''}`);
      if (!rl) continue;
      if (await ask(`  Open its page and install it now?`, false)) {
        openUrl(a.page);
        const code = await runCommand(a.install!.command, s => process.stdout.write(dim(s)));
        console.log(code === 0 ? `  ${green('✔')} installed` : `  ${red('✖')} the install command ended with ${code}`);
      }
    }
    // 2. sign-ins
    fast = await check();
    for (const a of fast.agents.filter(a => a.state === 'needs-login')) {
      console.log(`\n${yellow('⚠')} ${bold(a.name)} is installed but not signed in.`);
      if (await ask(`  Sign in now? (runs ${a.loginCommand.join(' ')})`, true)) await runCommand(a.loginCommand.join(' '), s => process.stdout.write(s));
    }
    fast = await check();
    // 3. untested versions: the deeper test, asked first (it spends turns on the user's plan)
    const deep: DeepReport[] = [];
    const untested = fast.agents.filter(a => a.state === 'untested' || deepArg.includes(a.agent));
    for (const a of untested) {
      if (a.state === 'untested') console.log(`\n${yellow('◆')} ${bold(a.name)} ${a.version} is new to Chorus (tested up to ${a.newestTested ?? 'none'}).`);
      const go = deepArg.includes(a.agent) || yes || (await ask(`  Test that it works with Chorus? About 1–3 min; a few short model turns on your ${a.name} plan.`, true));
      if (!go) continue;
      const run = await runDeep(a.agent, e => {
        if (e.type === 'scenario-end') {
          const r = e.result;
          const m = { pass: green('✔'), fail: red('✖'), skip: dim('–'), blocked: yellow('⚠') }[r.status];
          console.log(`  ${m} ${r.title.padEnd(50)} ${dim(`${(r.ms / 1000).toFixed(1)} s`)}${r.reason ? `  ${r.status === 'fail' ? red(r.reason) : dim(r.reason)}` : ''}`);
        }
      });
      deep.push(run.report);
      console.log(run.report.ok ? `  ${green('✔')} ${a.name} ${a.version} works with Chorus on this machine.` : `  ${red('✖')} Something does not work. Evidence: ${run.dir}`);
      if (!run.report.ok && a.testedInstall && a.version !== a.newestTested) {
        console.log(`  Chorus is tested with ${a.name} ${a.newestTested}. Optional, you can keep ${a.version}:\n    ${a.testedInstall}`);
        if (a.updatesItself) console.log(dim(`    ${a.updatesItself}`));
        if (await ask(`  Install ${a.newestTested} now?`, false)) await runCommand(a.testedInstall, s => process.stdout.write(dim(s)));
      }
    }
    // 4. something failed: an issue report, read before it is sent
    if (deep.some(d => !d.ok) && rl) {
      if (await ask(`\nCreate an issue report so this can be fixed? You see the whole report first.`, false)) {
        const { title, body } = issue(fast, deep);
        const file = path.join(DOCTOR_DIR(), 'issue.md');
        fs.mkdirSync(DOCTOR_DIR(), { recursive: true });
        fs.writeFileSync(file, body);
        console.log(`\n${bold(title)}\n${dim('─'.repeat(60))}\n${body}\n${dim('─'.repeat(60))}\n(also in ${file}; emails, account ids, keys and your home path are taken out)`);
        if (await ask(`Send it to github.com/chauvoluuhuong/chorus/issues?`, false)) {
          const r = sendIssue(title, fs.readFileSync(file, 'utf8'), file);
          console.log(r.error ? `${red('✖')} ${r.error}` : r.via === 'gh' ? `${green('✔')} ${r.url}` : `Opened the new-issue page; the report is on your clipboard (and in ${file}): paste it as the description.`);
        }
      }
    }
    fast = await check();
    markSeen(fast);
    const ready = fast.agents.filter(a => a.state === 'ready').length;
    console.log(`\n${ready ? green('✔') : yellow('⚠')} ${ready} of ${fast.agents.length} CLIs ready.${ready ? ' Continue with `chorus` (the app) or `chorus-cli` (in this terminal).' : ''}\n`);
    return ready ? 0 : 1;
  } finally {
    rl?.close();
  }
}

function print(agents: AgentCheck[]) {
  for (const a of agents) console.log(`  ${MARK[a.state]} ${a.name.padEnd(16)} ${a.state === 'ready' ? stateLine(a) : yellow(stateLine(a))}`);
}

export { CLIS };
