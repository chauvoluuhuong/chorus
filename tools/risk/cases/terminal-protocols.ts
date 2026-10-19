// R2: what terminal modes do the real TUIs ask for? (mouse and kitty keyboard are "not forwarded" today.)
import { createRequire } from 'node:module';
import { cleanEnv, cliVersion, save, tmpWorkspace, type Case } from '../lib.ts';
const require = createRequire(import.meta.url);
const pty = require('node-pty');

const MODES: Record<string, RegExp> = {
  'mouse-1000': /\x1b\[\?1000h/, 'mouse-1002': /\x1b\[\?1002h/, 'mouse-1003': /\x1b\[\?1003h/, 'mouse-sgr-1006': /\x1b\[\?1006h/,
  'bracketed-paste-2004': /\x1b\[\?2004h/, 'focus-events-1004': /\x1b\[\?1004h/, 'sync-output-2026': /\x1b\[\?2026h/,
  'kitty-keyboard-push': /\x1b\[>\d*u/, 'kitty-keyboard-query': /\x1b\[\?u/, 'modifyOtherKeys': /\x1b\[>4;\d+m/,
  'alt-screen-1049': /\x1b\[\?1049h/, 'osc52-clipboard': /\x1b\]52;/, 'osc8-hyperlink': /\x1b\]8;/, 'osc-title': /\x1b\][02];/,
};

export default {
  id: 'terminal-protocols',
  title: 'Terminal modes each TUI requests (mouse, kitty keyboard, paste, focus)',
  cost: 'free',
  async run(ctx) {
    const facts: Record<string, any> = {};
    for (const cli of ctx.agents) {
      const version = cliVersion(cli);
      if (!version) { facts[cli] = { skipped: 'not installed' }; continue; }
      const ws = tmpWorkspace('tp-' + cli);
      let raw = '';
      const p = pty.spawn(cli, [], { name: 'xterm-256color', cols: 110, rows: 32, cwd: ws, env: cleanEnv() });
      p.onData((d: string) => (raw += d));
      await new Promise(r => setTimeout(r, 9000)); // startup only, no prompt is sent: no model call
      p.kill();
      const seen = Object.entries(MODES).filter(([, re]) => re.test(raw)).map(([k]) => k);
      save(ctx, `${cli}-startup-raw.txt`, raw.replace(/\x1b/g, '\\e').slice(0, 20000));
      facts[cli] = { version, bytes: raw.length, seen };
    }
    const lines = Object.entries(facts).map(([c, f]: any) => `${c}: ${f.skipped ?? (f.seen.join(', ') || 'none')}`);
    return { status: 'risk', summary: lines.join(' | '), facts };
  },
} satisfies Case;
