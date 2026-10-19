// New chat "Effort": do the effort flags show up in the interactive screen of each CLI? Starts each TUI with a non-default effort
// in a PTY and reads the screen (no prompt is sent: no model call).
import { createRequire } from 'node:module';
import { cleanEnv, cliVersion, save, tmpWorkspace, type Case } from '../lib.ts';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const RUNS: Record<string, { args: string[]; value: string }> = {
  claude: { args: ['--effort', 'low'], value: 'low' },
  codex: { args: ['-c', 'model_reasoning_effort="high"'], value: 'high' },
  agy: { args: ['--effort', 'low'], value: 'low' },
};

export default {
  id: 'effort-flags',
  title: 'Effort flags in the interactive screen',
  cost: 'free',
  async run(ctx) {
    const facts: Record<string, any> = {};
    for (const cli of ctx.agents) {
      if (!cliVersion(cli)) { facts[cli] = { skipped: 'not installed' }; continue; }
      const ws = tmpWorkspace('eff-' + cli);
      const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
      const p = pty.spawn(cli, RUNS[cli].args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: ws, env: cleanEnv() });
      p.onData((d: string) => term.write(d));
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
      const read = () => {
        const b = term.buffer.active;
        const l: string[] = [];
        for (let y = 0; y < 40; y++) l.push(b.getLine(y)?.translateToString(true) ?? '');
        return l.filter(x => x.trim()).join('\n');
      };
      for (let i = 0; i < 6; i++) {
        await sleep(2500);
        if (/trust (this|the contents)|Trust and continue|Yes, I trust/i.test(read())) {
          if (cli === 'claude') { p.write('\x1b[A'); await sleep(300); }
          p.write('\r');
        }
      }
      const screen = read();
      save(ctx, `${cli}-screen.txt`, screen);
      p.kill();
      const line = screen.split('\n').find(l => new RegExp(`\\b${RUNS[cli].value}\\b`, 'i').test(l) && /effort|reason|model|gpt|gemini|claude|·/i.test(l));
      facts[cli] = { version: cliVersion(cli), args: RUNS[cli].args, shows: !!line, line: line?.trim().slice(0, 160) };
    }
    const rows = Object.entries(facts).filter(([, f]: any) => !f.skipped);
    return { status: rows.every(([, f]: any) => f.shows) ? 'pass' : 'risk', summary: rows.map(([c, f]: any) => `${c}: ${f.shows ? 'shown' : 'NOT shown'} (${f.line ?? '-'})`).join(' | '), facts };
  },
} satisfies Case;
