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
