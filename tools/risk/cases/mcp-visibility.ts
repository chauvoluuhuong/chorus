// R4b: does each CLI actually show the model the tools of an attached MCP server (Codex made no memory calls; was it blind?)
import fs from 'node:fs';
import path from 'node:path';
import { cliVersion, runCli, save, tmpWorkspace, type Case } from '../lib.ts';

const SERVER = path.resolve(import.meta.dirname, '../memory-mcp.mjs');
const q = (s: string) => JSON.stringify(s);
const ASK = 'List the exact names of any tools you have from an MCP server named chorus. Reply with only the names, comma separated, or NONE.';

export default {
  id: 'mcp-visibility',
  title: 'Does the model see the Chorus MCP tools?',
  cost: 'cheap',
  async run(ctx) {
    const facts: Record<string, any> = {};
    for (const cli of ctx.agents) {
      if (!cliVersion(cli)) { facts[cli] = { skipped: 'not installed' }; continue; }
      const ws = tmpWorkspace('vis-' + cli);
      const dir = tmpWorkspace('visd-' + cli);
      const server = { command: process.execPath, args: [SERVER, '--store', path.join(dir, 'm.json'), '--log', path.join(dir, 'c.jsonl')] };
      let args: string[];
      if (cli === 'claude') args = ['-p', ASK, '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { chorus: server } }), '--allowedTools', 'mcp__chorus__remember,mcp__chorus__recall,mcp__chorus__list_memory'];
      else if (cli === 'codex') args = ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-c', `mcp_servers.chorus.command=${q(server.command)}`, '-c', `mcp_servers.chorus.args=[${server.args.map(q).join(',')}]`, '-c', 'mcp_servers.chorus.default_tools_approval_mode="approve"', ASK];
      else {
        fs.mkdirSync(path.join(ws, '.agents'), { recursive: true });
        fs.writeFileSync(path.join(ws, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { chorus: server } }));
        args = ['-p', ASK, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
      }
      const r = await runCli(cli, args, ws);
      save(ctx, `${cli}.txt`, r.stdout + '\n--stderr--\n' + r.stderr);
      const text = r.stdout;
      const names = ['remember', 'recall', 'list_memory'].filter(n => new RegExp(n).test(text.split('\n').filter(l => !/"type":"system"/.test(l)).join('\n')));
      facts[cli] = { namesMentioned: names, exit: r.code };
    }
    const rows = Object.entries(facts).filter(([, f]: any) => !f.skipped);
    const blind = rows.filter(([, f]: any) => f.namesMentioned.length === 0).map(([c]) => c);
    return { status: blind.length ? 'risk' : 'pass', summary: rows.map(([c, f]: any) => `${c}: ${f.namesMentioned.join(',') || 'none'}`).join(' | '), facts };
  },
} satisfies Case;
