// An agent that ran out of plan quota says so on its own screen (and Chorus can then offer a handoff).
import type { AgentId } from '../core/types.ts';

export interface LimitHit {
  agent: AgentId;
  /** how the agent says it resets, as shown ("147h16m18s", "18:00" …) */
  resets?: string;
  message: string;
}

const PATTERNS: Partial<Record<AgentId, { start: RegExp; resets: RegExp }>> = {
  // verified: agy 1.4.1 ("Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 147h16m18s.")
  agy: { start: /Individual quota reached/, resets: /Resets in\s+(\S+?)\.?(?:\s|$)/ },
  // Claude and Codex limit messages are not captured yet (docs/integrations/*.md); their plan usage comes from the transcripts
};

/** The message can wrap onto the next lines of a narrow thread area, so read it as one piece of text. */
export function detectLimit(agent: AgentId, lines: string[]): LimitHit | undefined {
  const p = PATTERNS[agent];
  if (!p) return undefined;
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (p.start.test(lines[i])) { at = i; break; }
  if (at < 0) return undefined;
  const message = lines.slice(at, at + 3).join(' ').replace(/\s+/g, ' ').trim().replace(/^⚠\s*/, '');
  return { agent, resets: message.match(p.resets)?.[1], message };
}
