import type { Adapter, Session } from '../types.ts';
import { commandTarget, addTool, addTurn, emptySession, findTool, jsonLines, oneLine } from './util.ts';

function target(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (name === 'Bash') return commandTarget(String(input.command ?? ''));
  if (input.file_path) return String(input.file_path);
  if (input.path) return String(input.path);
  if (input.pattern) return oneLine(input.pattern, 120);
  if (input.query) return oneLine(input.query, 120);
  const first = Object.values(input).find(v => typeof v === 'string');
  return first ? oneLine(first, 120) : '';
}

/** mcp__server__tool -> {tool: 'mcp:server', target: 'tool'} */
function splitMcp(name: string): { tool: string; target?: string } {
  const m = name.match(/^mcp__(.+?)__(.+)$/);
  return m ? { tool: `mcp:${m[1]}`, target: m[2] } : { tool: name };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return oneLine(content);
  if (Array.isArray(content)) {
    return oneLine(content.map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'tool_reference' ? `[${c.tool_name}]` : '')).join(' '));
  }
  return '';
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');
  return '';
}

function applyAssistant(s: Session, msg: any, ts?: string) {
  s.model ??= msg.model;
  for (const block of msg.content ?? []) {
    if (block.type === 'text') addTurn(s, 'assistant', block.text, ts);
    else if (block.type === 'tool_use') {
      if (!findTool(s, block.id)) {
        const m = splitMcp(block.name);
        addTool(s, { id: block.id, tool: m.tool, target: m.target ?? target(block.name, block.input), status: 'running' });
      }
    }
  }
}

function applyToolResults(s: Session, content: unknown) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type !== 'tool_result') continue;
    const call = findTool(s, block.tool_use_id);
    if (!call) continue;
    call.status = block.is_error ? 'failed' : 'ok';
    call.result = resultText(block.content);
  }
}

export const claude: Adapter = {
  agent: 'claude',

  parseStream(text, opts) {
    const s = emptySession('claude');
    if (opts?.prompt) addTurn(s, 'user', opts.prompt);
    for (const e of jsonLines(text)) {
      if (e.session_id) s.nativeSessionId ??= e.session_id;
      switch (e.type) {
        case 'system':
          if (e.subtype === 'init') {
            s.cwd = e.cwd;
            s.model = e.model ?? s.model;
            s.cliVersion = e.claude_code_version ?? s.cliVersion;
          }
          break;
        case 'assistant':
          applyAssistant(s, e.message, e.timestamp);
          break;
        case 'user':
          applyToolResults(s, e.message?.content);
          break;
        case 'rate_limit_event': {
          const w = e.rate_limit_info?.unifiedWindows ?? {};
          const util = Math.max(0, ...Object.values<any>(w).map(x => x?.utilization ?? 0));
          s.limit = { status: e.rate_limit_info?.status, utilization: util || undefined };
          break;
        }
        case 'result':
          s.usage.inputTokens = (e.usage?.input_tokens ?? 0) + (e.usage?.cache_creation_input_tokens ?? 0);
          s.usage.cacheReadTokens = e.usage?.cache_read_input_tokens ?? 0;
          s.usage.outputTokens = e.usage?.output_tokens ?? 0;
          s.usage.costUsd = e.total_cost_usd;
          break;
      }
    }
    return s;
  },

  parseTranscript(text) {
    const s = emptySession('claude');
    const perMessage = new Map<string, any>();
    for (const e of jsonLines(text)) {
      if (e.sessionId) s.nativeSessionId ??= e.sessionId;
      if (e.cwd) s.cwd ??= e.cwd;
      if (e.version) s.cliVersion ??= e.version;
      if (e.isSidechain) continue;
      if (e.type === 'user' && e.message) {
        const c = e.message.content;
        if (Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result')) applyToolResults(s, c);
        else if (!e.isMeta) addTurn(s, 'user', userText(c), e.timestamp);
      } else if (e.type === 'assistant' && e.message) {
        applyAssistant(s, e.message, e.timestamp);
        if (e.message.id) perMessage.set(e.message.id, e.message.usage);
      } else if (e.type === 'cost-state') {
        s.usage.costUsd = e.totalCostUSD;
      }
    }
    // one assistant message is written once per content block, with the same usage; count it once
    for (const u of perMessage.values()) {
      s.usage.inputTokens += (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
      s.usage.cacheReadTokens += u?.cache_read_input_tokens ?? 0;
      s.usage.outputTokens += u?.output_tokens ?? 0;
    }
    return s;
  },
};
