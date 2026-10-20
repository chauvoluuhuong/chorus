// Normalized shapes every adapter produces. Only what a feature needs (see docs/architecture.md §4).

export type AgentId = 'claude' | 'codex' | 'agy';

export interface Turn {
  seq: number;
  role: 'user' | 'assistant';
  text: string;
  ts?: string;
}

export interface ToolCall {
  id: string;
  /** seq of the last turn before this call */
  turnSeq: number;
  tool: string;
  /** short target: file path, command, or MCP tool */
  target: string;
  status: 'running' | 'ok' | 'failed';
  /** one-line result */
  result?: string;
  durationMs?: number;
  /** a short label after the target: "+12 −3" for an edit, "exit 1" for a failed command */
  note?: string;
  /** failed calls only: the output, first and last lines, at most ~2 KB */
  detail?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd?: number;
}

export interface LimitReading {
  /** 0..1 utilization of the tightest window we saw */
  utilization?: number;
  resetsAt?: string;
  status?: string;
}

export interface Session {
  agent: AgentId;
  nativeSessionId?: string;
  cwd?: string;
  model?: string;
  cliVersion?: string;
  turns: Turn[];
  toolCalls: ToolCall[];
  usage: Usage;
  limit?: LimitReading;
  /** what the agent is doing right now, from the stream/transcript: a turn in progress or finished */
  status?: 'working' | 'waiting';
}

export interface Adapter {
  agent: AgentId;
  /** Parse a headless stdout capture (claude stream-json, codex exec --json, agy stream-json). */
  parseStream(text: string, opts?: { prompt?: string }): Session;
  /** Parse the CLI's own transcript file (works for interactive sessions). */
  parseTranscript(text: string): Session;
}
