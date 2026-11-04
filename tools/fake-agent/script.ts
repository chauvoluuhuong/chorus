// A scripted agent: steps that call given tools with given arguments, so the 2.0 runner can be tested with no model and no quota.
//   [{ "call": "action_done", "args": { "outcome": "pass", "summary": "ok" } }, { "write": { "path": "a.txt", "text": "hi" } },
//    { "wait": 200 }, { "say": "working" }, { "exit": 1 }]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';

export interface Step {
  call?: string;
  args?: Record<string, unknown>;
  write?: { path: string; text: string };
  wait?: number;
  say?: string;
  exit?: number;
}
export interface ScriptEvents {
  said(text: string): void;
  called(tool: string, args: Record<string, unknown>, text: string, failed: boolean): void;
}

export const readScript = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Step[];

/** Runs the steps in order. Returns the exit code a step asked for, or 0. */
export async function runScript(steps: Step[], mcp: { command: string; args: string[] }, on: ScriptEvents): Promise<number> {
  let client: Client | undefined;
  try {
    for (const s of steps) {
      if (s.wait) await new Promise(r => setTimeout(r, s.wait));
      if (s.say) on.said(s.say);
      if (s.write) {
        fs.mkdirSync(path.dirname(path.resolve(s.write.path)), { recursive: true });
        fs.writeFileSync(s.write.path, s.write.text);
      }
      if (s.call) {
        if (!client) {
          client = new Client({ name: 'fake-agent', version: '0.0.1' });
          await client.connect(new StdioClientTransport({ command: mcp.command, args: mcp.args }));
        }
        const r: any = await client.callTool({ name: s.call, arguments: s.args ?? {} });
        on.called(s.call, s.args ?? {}, r.content?.[0]?.text ?? '', !!r.isError);
      }
      if (s.exit !== undefined) return s.exit;
    }
    return 0;
  } finally {
    await client?.close();
  }
}
