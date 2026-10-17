#!/usr/bin/env node
// Fake interactive TUI for app tests: runs inside a PTY and behaves like an agent screen.
//   READY <name>, colored line, line-based echo ("got: <line>"), SIZE on resize, DSR query/reply,
//   "alt" enters the alternate screen, "paste?" reports bracketed paste, "q" exits.
const name = process.argv[2] ?? 'fake';
const out = s => process.stdout.write(s);
out(`READY ${name}\r\n`);
out('\x1b[1;31mred bold\x1b[0m \x1b[38;5;33mblue\x1b[0m wide:漢字 \r\n');
out('\x1b[?2004h'); // ask for bracketed paste, like real agents do
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
let buf = '';
const size = () => `${process.stdout.columns}x${process.stdout.rows}`;
process.stdout.on('resize', () => out(`SIZE ${size()}\r\n`));
out(`SIZE ${size()}\r\n`);
process.stdin.on('data', d => {
  // terminal replies to our DSR query arrive as \x1b[<row>;<col>R
  const m = d.match(/\x1b\[(\d+);(\d+)R/);
  if (m) { out(`CPR ${m[1]};${m[2]}\r\n`); d = d.replace(m[0], ''); }
  if (d.includes('\x1b[200~')) out(`PASTE ${JSON.stringify(d.replace(/\x1b\[20[01]~/g, ''))}\r\n`);
  else buf += d;
  let i;
  while ((i = buf.search(/[\r\n]/)) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line === 'q') process.exit(0);
    else if (line === 'alt') out('\x1b[?1049h\x1b[2J\x1b[HALT SCREEN\r\n');
    else if (line === 'dsr') out('\x1b[6n');
    else out(`got: ${JSON.stringify(line)}\r\n`);
  }
});
