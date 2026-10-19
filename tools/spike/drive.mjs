// Drives mux.ts inside an outer PTY and prints what the user would see (virtual screen of the outer terminal).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const outer = new Terminal({ cols: 130, rows: 36, allowProposedApi: true });
const p = pty.spawn(process.execPath, ['tools/spike/mux.ts', 'codex', 'agy'], { name: 'xterm-256color', cols: 130, rows: 36, cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' } });
p.onData(d => outer.write(d));
const dump = label => {
  const b = outer.buffer.active;
  const lines = [];
  for (let y = 0; y < 36; y++) lines.push(b.getLine(y).translateToString(true));
  console.log(`\n===== ${label} =====\n` + lines.filter(l => l.trim()).join('\n'));
};
const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(9000);
dump('both threads started, thread 1 (codex) in front');
p.write('\x00'); await wait(300); p.write('2'); await wait(6000);
dump('after ctrl+space 2 (agy in front)');
p.write('\x00'); await wait(300); p.write('1'); await wait(2500);
dump('back to codex (state kept, no restart)');
console.log('\nmux RSS MB ≈', Math.round(process.memoryUsage().rss / 1e6), '(this driver only)');
p.write('\x00'); await wait(300); p.write('q'); await wait(500);
process.exit(0);
