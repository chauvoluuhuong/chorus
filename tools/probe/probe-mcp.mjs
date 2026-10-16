#!/usr/bin/env node
// Minimal stdio MCP server used by the capability probe.
// It logs every JSON-RPC message it receives so we can see exactly how each
// AI CLI talks to an MCP server (handshake, protocol version, tool-call _meta).
//
// Usage: node probe-mcp.mjs --log <file> --thread <id>
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const arg = name => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const logFile = arg('--log');
const threadId = arg('--thread') ?? null;

const log = entry => {
  if (!logFile) return;
  appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
};
const send = msg => {
  log({ dir: 'out', msg });
  process.stdout.write(JSON.stringify(msg) + '\n');
};

const TOOLS = [
  {
    name: 'probe_get_context',
    description:
      'Returns the Chorus thread id for this session and a secret word. Call it when asked for the secret word.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

log({ dir: 'start', argv, env_CHORUS_THREAD_ID: process.env.CHORUS_THREAD_ID ?? null, pid: process.pid });

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log({ dir: 'in-unparsed', line });
    return;
  }
  log({ dir: 'in', msg });
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'chorus-probe', version: '0.0.1' },
          instructions: 'Chorus capability probe server.',
        },
      });
      break;
    case 'ping':
      send({ jsonrpc: '2.0', id, result: {} });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      break;
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                thread_from_argv: threadId,
                thread_from_env: process.env.CHORUS_THREAD_ID ?? null,
                secret_word: 'pineapple',
              }),
            },
          ],
        },
      });
      break;
    default:
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
