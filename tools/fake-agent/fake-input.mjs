#!/usr/bin/env node
// A fake CLI input box for the mail watchdog's tests (task #14), drawn the way Claude Code draws its own (typein-probe E): the input
// between two ─ rules, its first row starting ❯ and a no-break space, the others indented two spaces, a status row under it, and
// every sent message listed above as "SENT <text>". Keys as the probe saw them: Ctrl+U deletes one row (and the line break before
// an empty last row), Option+Enter (ESC CR) is a new line, Enter sends. FAKE_DIALOG=1 draws a permission question instead of the
// input, which takes every key.
const out = s => process.stdout.write(s);
const sent = [];
let draft = '';
const dialog = process.env.FAKE_DIALOG === '1';
const cols = () => process.stdout.columns || 120;
function draw() {
  const rule = '─'.repeat(cols());
  const rows = [];
  for (const s of sent.slice(-6)) rows.push(`SENT ${s.replace(/\n/g, ' / ')}`);
  rows.push('');
  if (dialog) {
    rows.push(rule, ' Bash command', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel · Tab to amend');
  } else {
    const lines = draft.split('\n');
    rows.push(rule);
    lines.forEach((l, i) => rows.push(i === 0 ? `❯ ${l || (draft ? '' : 'Try "refactor <filepath>"')}` : `  ${l}`));
    rows.push(rule, '  ⏸ manual mode on');
  }
  out(`\x1b[2J\x1b[H${rows.join('\r\n')}`);
}
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  if (dialog) return;
  for (let i = 0; i < d.length; i++) {
    const ch = d[i];
    if (ch === '\x1b' && d[i + 1] === '\r') {
      draft += '\n';
      i++;
    } else if (ch === '\x15') {
      const cut = draft.lastIndexOf('\n');
      if (cut < 0) draft = '';
      else if (cut === draft.length - 1) draft = draft.slice(0, -1);
      else draft = draft.slice(0, cut + 1);
    } else if (ch === '\r') {
      if (draft) sent.push(draft);
      draft = '';
    } else if (ch === '\x03') process.exit(0);
    else if (ch >= ' ') draft += ch;
  }
  draw();
});
process.stdout.on('resize', draw);
draw();
setInterval(() => {}, 1 << 30);
