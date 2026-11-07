// Tools of the optional module. `chorus mcp` is its own process per chat, so it asks the running `chorus serve` what exists and passes calls
// on. Nothing to ask, or nothing unlocked: no tools. The address and token are in <home>/serve.json (0600).
import fs from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

interface Listed {
  name: string;
  description: string;
  inputSchema: Parameters<typeof z.fromJSONSchema>[0];
}

function serveInfo(home: string): { url: string; mcpToken: string } | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'serve.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

export async function addProTools(server: McpServer, home: string, threadId: string | undefined, reply: (tool: string, text: string, isError?: boolean) => { content: { type: 'text'; text: string }[] }) {
  const info = serveInfo(home);
  if (!info) return;
  const headers = { authorization: `Bearer ${info.mcpToken}`, 'x-chorus': '1', 'content-type': 'application/json' };
  let tools: Listed[];
  try {
    // with no chat it is an AI app the user connected (Claude Desktop, Cursor…): it gets the app's tools instead (stage 7)
    const r = await fetch(`${info.url}/api/pro/mcp/tools${threadId ? '' : '?app=1'}`, { headers, signal: AbortSignal.timeout(2000) });
    if (!r.ok) return;
    tools = ((await r.json()) as { tools: Listed[] }).tools;
  } catch {
    return; // serve is gone (a chat outlived it): the chat keeps its usual tools
  }
  for (const t of tools) {
    server.registerTool(t.name, { description: t.description, inputSchema: z.fromJSONSchema(t.inputSchema) as z.ZodObject }, async (args: Record<string, unknown>) => {
      try {
        const r = await fetch(`${info.url}/api/pro/mcp/call`, { method: 'POST', headers, body: JSON.stringify({ name: t.name, args, threadId }), signal: AbortSignal.timeout(60_000) });
        const j = (await r.json()) as { text?: string; error?: string };
        return r.ok ? reply(t.name, j.text ?? '') : reply(t.name, j.error ?? 'This tool is not available right now.', true);
      } catch {
        return reply(t.name, 'Chorus is not running, so this tool is not available right now.', true);
      }
    });
  }
}
