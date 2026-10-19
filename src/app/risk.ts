// A risk tag for what an agent asks to do, from a fixed list of patterns (docs/mockups/chorus-cli.html, "Approvals inbox").
// Deliberately dumb and visible: it only makes the dangerous request stand out, it never blocks anything.
import path from 'node:path';

export interface Risk {
  label: string;
  /** err = destructive or hard to undo, warn = changes the machine or the project, dim = ordinary edit */
  level: 'err' | 'warn' | 'dim';
}

const RULES: [RegExp, Risk][] = [
  [/\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+|--recursive|--force)/, { label: 'deletes files', level: 'err' }],
  [/\bgit\s+push\b.*(--force\b|-f\b|--force-with-lease)/, { label: 'force push', level: 'err' }],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)/, { label: 'discards work', level: 'err' }],
  [/\b(drop\s+(table|database)|truncate\s+table|migrate|prisma\s+migrate|db:reset)\b/i, { label: 'changes the database', level: 'err' }],
  [/\bsudo\b/, { label: 'runs as admin', level: 'err' }],
  [/\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, { label: 'runs a download', level: 'err' }],
  [/\b(chmod|chown)\s+-R\b/, { label: 'changes permissions', level: 'warn' }],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bcargo\s+(add|install)\b|\bgo\s+(get|install)\b/, { label: 'installs a package', level: 'warn' }],
  [/\bgit\s+push\b/, { label: 'pushes commits', level: 'warn' }],
  [/\b(docker|kubectl|terraform)\b/, { label: 'infrastructure', level: 'warn' }],
];

/** `what` is the text the approval detector extracted ("Bash command · … · npm install stripe"). `cwd` lets us spot writes outside the folder. */
export function riskOf(what: string, cwd?: string): Risk {
  for (const [re, risk] of RULES) if (re.test(what)) return risk;
  if (cwd) {
    // an absolute path in the request that is not inside the working folder
    for (const m of what.matchAll(/(?:^|[\s"'=])((?:\/|~\/)[\w.\-/~]+)/g)) {
      const p = m[1].replace(/^~/, process.env.HOME ?? '~');
      if (p.length > 2 && !p.startsWith(cwd + path.sep) && p !== cwd && !/^\/(dev\/null|tmp|private\/tmp)\b/.test(p)) return { label: 'writes outside the folder', level: 'warn' };
    }
  }
  if (/\b(create|write|edit|update|patch)\b.*\b(file)?\b/i.test(what) && /\.\w{1,6}\b/.test(what)) return { label: 'edits a file', level: 'dim' };
  return { label: 'runs a command', level: 'dim' };
}
