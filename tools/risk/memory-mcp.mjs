#!/usr/bin/env node
// Stand-in for the future Chorus memory tools (remember / recall / list_memory), used only by the memory-adoption case.
// node memory-mcp.mjs --store <json file> --log <jsonl file>
import fs from 'node:fs';
import { createInterface } from 'node:readline';
const a = process.argv.slice(2);
const arg = n => a[a.indexOf(n) + 1];
const store = arg('--store'), logf = arg('--log');
const log = e => fs.appendFileSync(logf, JSON.stringify({ ts: Date.now(), ...e }) + '\n');
const load = () => { try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch { return []; } };
const INSTRUCTIONS = 'Chorus shared memory is available. When the user states a lasting preference, rule, decision or fact (about themselves or their projects), save it with `remember`. Before answering a question that could depend on an earlier preference or decision, check `recall`.';
const tools = [
  { name: 'remember', description: 'Save a lasting preference, rule, decision or fact so every future chat in any project can use it.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, scope: { type: 'string', enum: ['global', 'project'] } }, required: ['text'] } },
  { name: 'recall', description: 'Search saved memory for entries relevant to a question.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'list_memory', description: 'List every saved memory entry.', inputSchema: { type: 'object', properties: {} } },
];
const send = m => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  const { id, method, params } = m;
  if (id == null) return;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'chorus-memory', version: '0.0.1' }, instructions: INSTRUCTIONS } });
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;
    log({ tool: name, args });
    let text = 'ok';
    const mem = load();
    if (name === 'remember') { mem.push({ text: args.text, scope: args.scope ?? 'global' }); fs.writeFileSync(store, JSON.stringify(mem)); text = 'saved'; }
    else text = JSON.stringify(mem.length ? mem : 'no memory yet');
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  }
  send({ jsonrpc: '2.0', id, result: {} });
});
