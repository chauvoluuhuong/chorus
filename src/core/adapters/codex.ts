import type { Adapter } from '../types.ts';
import { commandTarget, addTool, addTurn, emptySession, findTool, jsonLines, oneLine, stripShellWrapper } from './util.ts';

function mcpResult(r: any): string {
  return oneLine((r?.content ?? []).map((c: any) => c?.text ?? '').join(' '));
}

export const codex: Adapter = {
  agent: 'codex',

  parseStream(text, opts) {
    const s = emptySession('codex');
    if (opts?.prompt) addTurn(s, 'user', opts.prompt);
    for (const e of jsonLines(text)) {
      if (e.type === 'thread.started') s.nativeSessionId = e.thread_id;
      else if (e.type === 'turn.completed') {
        const u = e.usage ?? {};
        s.usage.inputTokens += u.input_tokens ?? 0;
        s.usage.cacheReadTokens += u.cached_input_tokens ?? 0;
        s.usage.outputTokens += u.output_tokens ?? 0;
      } else if (e.type === 'item.started' || e.type === 'item.completed') {
        const it = e.item ?? {};
        const done = e.type === 'item.completed';
        if (it.type === 'agent_message' && done) addTurn(s, 'assistant', it.text);
        else if (it.type === 'command_execution') {
          const call = findTool(s, it.id) ?? addTool(s, { id: it.id, tool: 'shell', target: commandTarget(stripShellWrapper(it.command)), status: 'running' });
          if (done) {
            call.status = it.exit_code === 0 ? 'ok' : 'failed';
            call.result = oneLine(it.aggregated_output);
          }
        } else if (it.type === 'mcp_tool_call') {
          const call = findTool(s, it.id) ?? addTool(s, { id: it.id, tool: `mcp:${it.server}`, target: it.tool, status: 'running' });
          if (done) {
            call.status = it.status === 'completed' && !it.error ? 'ok' : 'failed';
            call.result = it.error ? oneLine(it.error.message) : mcpResult(it.result);
          }
        }
      }
    }
    return s;
  },

  parseTranscript(text) {
    const s = emptySession('codex');
    let model: string | undefined;
    for (const e of jsonLines(text)) {
      const p = e.payload ?? {};
      if (e.type === 'session_meta') {
        s.nativeSessionId = p.id;
        s.cwd = p.cwd;
        s.cliVersion = p.cli_version;
      } else if (e.type === 'turn_context') {
        model ??= p.model;
      } else if (e.type === 'event_msg' && p.type === 'task_started') {
        s.status = 'working';
      } else if (e.type === 'event_msg' && (p.type === 'task_complete' || p.type === 'turn_aborted')) {
        s.status = 'waiting';
      } else if (e.type === 'event_msg' && p.type === 'thread_settings_applied') {
        model ??= p.thread_settings?.model;
      } else if (e.type === 'event_msg' && p.type === 'item_completed') {
        const it = p.item ?? {};
        if (it.type === 'UserMessage') addTurn(s, 'user', (it.content ?? []).map((c: any) => c.text ?? '').join('\n'), e.timestamp);
        else if (it.type === 'AgentMessage') addTurn(s, 'assistant', (it.content ?? []).map((c: any) => c.text ?? '').join(''), e.timestamp);
        else if (it.type === 'CommandExecution') {
          addTool(s, {
            id: it.id,
            tool: 'shell',
            target: commandTarget(stripShellWrapper(it.command)),
            status: it.exit_code === 0 ? 'ok' : 'failed',
            result: oneLine(it.aggregated_output),
            durationMs: it.duration ? it.duration.secs * 1000 + it.duration.nanos / 1e6 : undefined,
          });
        } else if (it.type === 'McpToolCall') {
          addTool(s, {
            id: it.id,
            tool: `mcp:${it.server}`,
            target: it.tool,
            status: it.status === 'completed' ? 'ok' : 'failed',
            result: mcpResult(it.result),
          });
        }
      } else if (e.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
        const u = p.info.total_token_usage;
        s.usage = { inputTokens: u.input_tokens ?? 0, cacheReadTokens: u.cached_input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 };
        const prim = p.rate_limits?.primary;
        if (prim?.used_percent != null) s.limit = { utilization: prim.used_percent / 100 };
      }
    }
    s.model = model;
    return s;
  },
};
