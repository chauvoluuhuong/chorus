// TD-10: do the "skip permission prompts" flags work in the INTERACTIVE screen, and does any CLI ask to confirm them first?
// Starts each TUI with its flag in a PTY and reads the screen; no prompt is sent (no model call).
import { createRequire } from 'node:module';
import { SKIP_FLAG } from '../../../src/core/launch.ts';
import { cleanEnv, cliVersion, save, tmpWorkspace, type Case } from '../lib.ts';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

export default {
  id: 'skip-flags',
  title: 'Skip-permissions flags in the interactive screen',
  cost: 'free',
  async run(ctx) {
    const facts: Record<string, any> = {};
    for (const cli of ctx.agents) {
      const version = cliVersion(cli);
      if (!version) { facts[cli] = { skipped: 'not installed' }; continue; }
      const flag = SKIP_FLAG[cli as 'claude'];
      const ws = tmpWorkspace('skip-' + cli);
      const term = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
      const p = pty.spawn(cli, [flag], { name: 'xterm-256color', cols: 120, rows: 40, cwd: ws, env: cleanEnv() });
      p.onData((d: string) => term.write(d));
      let exited: number | null = null;
      p.onExit((e: { exitCode: number }) => (exited = e.exitCode));
      const read = () => {
        const b = term.buffer.active;
        const lines: string[] = [];
        for (let y = 0; y < 40; y++) lines.push(b.getLine(y)?.translateToString(true) ?? '');
        return lines.filter(l => l.trim()).join('\n');
      };
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
      const seen: string[] = [];
      for (let i = 0; i < 6; i++) {
        await sleep(2500);
        const sc = read();
        // folder-trust prompts come first in a fresh folder: accept them, then see what the flag itself does
        if (/trust (this|the contents)|Trust and continue|Yes, I trust/i.test(sc)) {
          seen.push(sc);
          if (cli === 'claude') { p.write('\x1b[A'); await sleep(300); }
          p.write('\r');
        }
      }
      const screen = read();
      save(ctx, `${cli}-screen.txt`, screen);
      save(ctx, `${cli}-trust-screens.txt`, seen.join('\n=====\n'));
      p.kill();
      facts[cli] = {
        version, flag, exitedEarly: exited,
        asksToConfirm: /(i accept|accept the risk|are you sure|no, exit)/i.test(screen),
        showsBypass: /(bypass|skip|danger|dangerously|no approval|never ask|full access|yolo)/i.test(screen),
        head: screen.split('\n').slice(0, 14).join('\n'),
      };
    }
    const rows = Object.entries(facts).filter(([, f]: any) => !f.skipped);
    return { status: 'risk', summary: rows.map(([c, f]: any) => `${c}: exitedEarly=${f.exitedEarly} confirm=${f.asksToConfirm} bypassShown=${f.showsBypass}`).join(' | '), facts };
  },
} satisfies Case;
