import type { Session, ToolCall, Turn, AgentId } from '../types.ts';

export function emptySession(agent: AgentId): Session {
  return { agent, turns: [], toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
}

export function* jsonLines(text: string): Generator<Record<string, any>> {
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      yield JSON.parse(t);
    } catch {
      // a partially written last line while tailing; ignore
    }
  }
}

export function oneLine(s: unknown, max = 200): string {
  const t = (typeof s === 'string' ? s : JSON.stringify(s ?? '')).replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

export function addTurn(s: Session, role: Turn['role'], text: string, ts?: string): Turn | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const turn: Turn = { seq: s.turns.length + 1, role, text: t, ts };
  s.turns.push(turn);
  return turn;
}

export function addTool(s: Session, call: Omit<ToolCall, 'turnSeq'>): ToolCall {
  const c: ToolCall = { ...call, turnSeq: s.turns.length };
  s.toolCalls.push(c);
  return c;
}

export function findTool(s: Session, id: string): ToolCall | undefined {
  return s.toolCalls.find(c => c.id === id);
}

/** `/bin/zsh -lc 'cmd'` -> `cmd` */
export function stripShellWrapper(cmd: string | string[]): string {
  const parts = Array.isArray(cmd) ? cmd : null;
  if (parts && parts.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(parts[0]) && /^-\w*c$/.test(parts[1])) return parts[2];
  if (typeof cmd === 'string') {
    const m = cmd.match(/^\S*\/?(?:ba|z|da)?sh\s+-\w*c\s+(['"])([\s\S]*)\1$/);
    if (m) return m[2];
    return cmd;
  }
  return parts ? parts.join(' ') : '';
}

export function sessionFiles(s: Session): string[] {
  const files = new Set<string>();
  for (const c of s.toolCalls) {
    if (/^(Write|Edit|MultiEdit|NotebookEdit|write_to_file|replace_file_content|apply_patch|file_change)$/.test(c.tool) && c.target) files.add(c.target);
  }
  return [...files];
}

/** One-line view of a shell command: heredoc bodies are collapsed so the part that matters stays. */
export function commandTarget(cmd: string, max = 400): string {
  const collapsed = cmd.replace(/<<-?\s*(['"]?)(\w+)\1\n[\s\S]*?\n\s*\2(?=\s|$)/g, '<<$2 …$2');
  return oneLine(collapsed, max);
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, // API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWTs
];

/** Masks what looks like a secret before it is stored: Authorization/Bearer values, KEY=value, known token shapes. */
export function maskSecrets(s: string): string {
  let t = s
    .replace(/(authorization:\s*(?:bearer|basic|token)?\s*)[^\s"']+/gi, '$1••••')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1••••')
    .replace(/((?:api[_-]?key|secret|token|password|passwd|pwd)[A-Z_]*\s*[=:]\s*)(?!••••)[^\s"',;]+/gi, '$1••••');
  for (const re of SECRET_PATTERNS) t = t.replace(re, '••••');
  return t;
}

/** The first and last lines of an output, at most `maxBytes`: a build's cause is on top, its summary at the end. */
export function capOutput(text: string, maxBytes = 2048, keep = 10): string {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let out = lines.length > keep * 2 ? [...lines.slice(0, keep), `… ${lines.length - keep * 2} lines omitted …`, ...lines.slice(-keep)].join('\n') : lines.join('\n');
  if (Buffer.byteLength(out) > maxBytes) out = out.slice(0, maxBytes - 1) + '…';
  const total = Buffer.byteLength(text);
  return total > maxBytes ? `${out}\n[truncated, ${total > 10240 ? Math.round(total / 1024) + ' KB' : total + ' bytes'} total]` : out;
}

const lineCount = (s: unknown) => (typeof s === 'string' && s ? s.split('\n').length : 0);

/** "+12 −3" for an edit (old and new text), "+48" for a write; never the content. */
export function editNote(name: string, input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  if (name === 'Write') return lineCount(input.content) ? `+${lineCount(input.content)}` : undefined;
  const pairs = name === 'MultiEdit' && Array.isArray(input.edits) ? input.edits : name === 'Edit' ? [input] : [];
  if (!pairs.length) return undefined;
  let add = 0;
  let del = 0;
  for (const e of pairs) {
    add += lineCount(e.new_string);
    del += lineCount(e.old_string);
  }
  return del ? `+${add} −${del}` : `+${add}`;
}

/** "exit 1" from a Claude Bash error ("Exit code 1\n…"). */
export function exitNote(text: string): string | undefined {
  const m = text.match(/^\s*Exit code (\d+)/i);
  return m ? `exit ${m[1]}` : undefined;
}
