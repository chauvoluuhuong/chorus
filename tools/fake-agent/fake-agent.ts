#!/usr/bin/env node
// Fake AI CLI for L2 tests. Behaves like `codex exec --json` (event shapes copied from
// fixtures/codex/0.163.0): connects to the Chorus MCP server it is told about, calls tools,
// writes an artifact, and prints JSONL events. `--limit` simulates a plan-limit stop.
//
//   fake-agent.ts --mcp-command <bin> --mcp-args '<json array>' [--call tool[,tool]] [--artifact path] [--limit] "<prompt>"
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const prompt = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--') || a === argv.at(-1)).at(-1) ?? '';
const emit = (o: unknown) => console.log(JSON.stringify(o));
let n = 0;
const id = () => `item_${n++}`;

emit({ type: 'thread.started', thread_id: 'fake-' + Date.now() });
emit({ type: 'turn.started' });

if (argv.includes('--limit')) {
  emit({ type: 'error', message: 'usage limit reached, try again later' });
  emit({ type: 'turn.failed', error: { message: 'usage limit reached' } });
  process.exit(1);
}

let answer = 'done';
const tools = (opt('call') ?? '').split(',').filter(Boolean);
if (tools.length) {
  const client = new Client({ name: 'fake-agent', version: '0.0.1' });
  await client.connect(new StdioClientTransport({ command: opt('mcp-command')!, args: JSON.parse(opt('mcp-args') ?? '[]') }));
  for (const tool of tools) {
    const item = { id: id(), type: 'mcp_tool_call', server: 'chorus', tool, arguments: {} as Record<string, unknown> };
    emit({ type: 'item.started', item: { ...item, result: null, error: null, status: 'in_progress' } });
    const r: any = await client.callTool({ name: tool, arguments: {} });
    emit({ type: 'item.completed', item: { ...item, result: { content: r.content }, error: r.isError ? { message: r.content?.[0]?.text } : null, status: r.isError ? 'failed' : 'completed' } });
    answer = r.content?.[0]?.text ?? answer;
  }
  await client.close();
}

const artifact = opt('artifact');
if (artifact) {
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.writeFileSync(artifact, `# artifact\nprompt: ${prompt}\n`);
  const command = ['/bin/zsh', '-lc', `printf x > ${artifact}`];
  emit({ type: 'item.started', item: { id: id(), type: 'command_execution', command: command.join(' '), aggregated_output: '', exit_code: null, status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: `item_${n - 1}`, type: 'command_execution', command: command.join(' '), aggregated_output: '', exit_code: 0, status: 'completed' } });
}
emit({ type: 'item.completed', item: { id: id(), type: 'agent_message', text: answer.slice(0, 4000) } });
emit({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 } });
