// Approval cards (P4.6): recognise an agent's own permission prompt on its virtual screen and answer it with
// the key the prompt itself offers. Hooks cannot do this for all three CLIs (docs/integrations/approvals.md):
// Claude honours allow/deny/ask, agy only deny, Codex only deny.
import type { AgentId } from '../core/types.ts';

export interface PendingApproval {
  agent: AgentId;
  /** what the agent wants to do, as shown on its screen (command, file …) */
  what: string;
  /** the prompt's own question */
  question: string;
  keys: { approve: string; deny: string };
}

const KEYS = { approve: '\r', deny: '\x1b' };

interface Pattern {
  /** the line that identifies the prompt */
  question: RegExp;
  /** a line that must be on screen too (the options), so prose that merely mentions the words does not match */
  options: RegExp;
}

const PATTERNS: Record<AgentId, Pattern> = {
  claude: { question: /Do you want to (proceed|make this edit|create|run|allow)[^\n]*\?|Do you want to /, options: /❯?\s*1\.\s*Yes\b/ },
  codex: { question: /Would you like to (run|make|apply|allow)[^\n]*/i, options: /1\.\s*Yes,? proceed|Press enter to confirm or esc to cancel/ },
  agy: { question: /Run this command\?|Allow [^\n]*\?|Apply (these )?changes\?/, options: /1\.\s*Yes,/ },
};

/** Lines are the plain text of the agent's thread area (VirtualScreen.text()). */
export function detectApproval(agent: AgentId, lines: string[]): PendingApproval | undefined {
  const p = PATTERNS[agent];
  const qi = findLastIndex(lines, l => p.question.test(l));
  if (qi < 0) return undefined;
  // the options must sit right below the question
  const below = lines.slice(qi, qi + 9).join('\n');
  if (!p.options.test(below)) return undefined;
  // Codex prints the command after the question ("$ cmd", possibly wrapped); the others print it above
  const optIdx = lines.findIndex((l, i) => i > qi && p.options.test(l));
  const between = lines.slice(qi + 1, optIdx < 0 ? qi + 1 : optIdx).map(l => l.replace(/^[\s│┃|]+/, '').replace(/\s+$/, ''));
  const dollar = between.findIndex(l => l.startsWith('$ '));
  const fromBelow = dollar >= 0 ? between.slice(dollar).filter(Boolean).join(' ').replace(/^\$\s*/, '') : '';
  // Claude frames each request between a solid rule and the question: "Create file / calc.js / <preview>"
  let framed = '';
  if (agent === 'claude') {
    let start = qi - 1;
    while (start >= 0 && !/^[\s│┃|]*─{10,}/.test(lines[start])) start--;
    framed = lines
      .slice(start + 1, qi)
      .map(l => l.replace(/^[\s│┃|]+/, '').replace(/\s+$/, ''))
      .filter(l => l && !/^[╌─━┄\-]+$/.test(l) && !/^\d+(\s|$)/.test(l) && !/^(Hook |settings\.json)/.test(l))
      .slice(0, 3)
      .join(' · ');
  }
  // agy frames a file change as "Create file" / rule / "<path>  +5" / the code: say what it is, not the code
  let fileChange = '';
  if (agent === 'agy') {
    const head = findLastIndex(lines.slice(0, qi), l => /^\s*(Create|Edit|Delete|Overwrite|Write|Rename)\s+(a\s+)?files?\b/i.test(l));
    if (head >= 0) {
      const target = lines.slice(head + 1, qi).map(l => l.trim()).find(l => l && !/^[─━═┄\-]+$/.test(l));
      if (target) fileChange = `${lines[head].trim()} · ${target.replace(/\s+[+-]\d+(\s+[+-]\d+)?$/, '')}`;
    }
  }
  const what = fromBelow || framed || fileChange || lines
    .slice(Math.max(0, qi - 8), qi)
    .map(l => l.replace(/^[\s│┃|]+/, '').replace(/\s+$/, ''))
    .filter(l => l && !/^[─━═┄\-]+$/.test(l) && !/^(Run shell command|Reason:|Environment:|Hook |settings\.json)/.test(l))
    .slice(-4)
    .join(' ');
  return { agent, what: (what || '(see the thread)').replace(/\s+/g, ' '), question: lines[qi].trim(), keys: { ...KEYS } };
}

function findLastIndex<T>(a: T[], f: (x: T) => boolean): number {
  for (let i = a.length - 1; i >= 0; i--) if (f(a[i])) return i;
  return -1;
}
