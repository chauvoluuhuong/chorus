import type { Adapter, Session } from '../types.ts';
import { commandTarget, addTool, addTurn, emptySession, findTool, jsonLines, oneLine } from './util.ts';

// agy tool parameter names (verified 1.4.0): run_command.CommandLine, view_file.AbsolutePath,
// write_to_file.TargetFile, call_mcp_tool.{ServerName,ToolName}
function target(name: string, p: Record<string, any> | undefined): string {
  if (!p) return '';
  if (name === 'call_mcp_tool') return unq(p.ToolName);
  const v = p.CommandLine ?? p.TargetFile ?? p.AbsolutePath ?? Object.values(p).find(x => typeof x === 'string');
  return name === 'run_command' ? commandTarget(unq(v)) : oneLine(unq(v), 160);
}

/** transcript.jsonl stores string args JSON-quoted: "\"echo hi\"" */
function unq(v: unknown): string {
  if (typeof v !== 'string') return v == null ? '' : String(v);
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      /* fall through */
    }
  }
  return v;
}

function toolName(name: string, p: Record<string, any> | undefined): string {
  return name === 'call_mcp_tool' ? `mcp:${unq(p?.ServerName)}` : name;
}

function stripWrapper(s: string): string {
  return s.replace(/^<USER_REQUEST>\n?/, '').replace(/\n?<\/USER_REQUEST>[\s\S]*$/, '').trim();
}

function resultStatus(out: string): 'ok' | 'failed' {
  const m = out.match(/exited with code (\d+)/);
  return m && m[1] !== '0' ? 'failed' : 'ok';
}

export const agy: Adapter = {
  agent: 'agy',

  parseStream(text, opts) {
    const s: Session = emptySession('agy');
    if (opts?.prompt) addTurn(s, 'user', opts.prompt);
    const deltas = new Map<number, string>();
    for (const e of jsonLines(text)) {
      if (e.event === 'init') {
        s.nativeSessionId = e.conversation_id;
        s.cwd = e.init?.cwd;
        s.model = e.init?.model ?? s.model;
      } else if (e.event === 'step_update') {
        const u = e.step_update ?? {};
        s.nativeSessionId ??= u.conversation_id;
        if (u.step_type === 'agent_response') {
          if (u.text_delta) deltas.set(u.step_index, (deltas.get(u.step_index) ?? '') + u.text_delta);
          if (u.state === 'DONE') addTurn(s, 'assistant', deltas.get(u.step_index) ?? '');
        } else if (u.step_type === 'tool') {
          const info = u.tool_info ?? {};
          const id = `${u.conversation_id}:${u.step_index}`;
          const call = findTool(s, id) ?? addTool(s, { id, tool: toolName(u.tool_name, info.parameters), target: target(u.tool_name, info.parameters), status: 'running' });
          if (u.state === 'DONE') {
            call.status = resultStatus(String(info.output ?? ''));
            call.result = oneLine(info.output);
            call.durationMs = u.duration_seconds ? Math.round(u.duration_seconds * 1000) : undefined;
          }
        }
      } else if (e.event === 'result') {
        const r = e.result ?? {};
        s.nativeSessionId ??= r.conversation_id;
        s.usage = {
          inputTokens: r.usage?.input_tokens ?? 0,
          outputTokens: r.usage?.output_tokens ?? 0,
          cacheReadTokens: r.usage?.cache_read_tokens ?? 0,
        };
      }
    }
    return s;
  },

  parseTranscript(text) {
    const s = emptySession('agy');
    let lastTool = undefined as ReturnType<typeof addTool> | undefined;
    for (const e of jsonLines(text)) {
      if (e.type === 'USER_INPUT') {
        addTurn(s, 'user', stripWrapper(String(e.content ?? '')), e.created_at);
      } else if (e.type === 'PLANNER_RESPONSE') {
        s.usage.inputTokens += e.input_tokens ?? 0;
        s.usage.outputTokens += e.output_tokens ?? 0;
        s.usage.cacheReadTokens += e.cache_read_tokens ?? 0;
        if (e.content) addTurn(s, 'assistant', String(e.content), e.created_at);
        for (const [i, c] of (e.tool_calls ?? []).entries()) {
          lastTool = addTool(s, {
            id: `${e.step_index}:${i}`,
            tool: toolName(c.name, c.args),
            target: target(c.name, c.args),
            status: 'running',
          });
        }
      } else if (e.type === 'GENERIC' && lastTool?.status === 'running') {
        const out = String(e.content ?? '');
        lastTool.status = resultStatus(out);
        lastTool.result = oneLine(out.replace(/^Created At:.*\nCompleted At:.*\n/, ''));
      }
    }
    return s;
  },
};
