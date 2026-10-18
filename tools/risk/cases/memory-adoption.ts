// R4: will an agent save and use memory by itself? A stand-in memory MCP server is attached the way Chorus attaches its own
// (MCP instructions for Claude/agy, developer_instructions for Codex). The prompts never mention the tools.
import fs from 'node:fs';
import path from 'node:path';
import { adapters } from '../../../src/core/adapters/index.ts';
import { cliVersion, runCli, save, tmpWorkspace, type Case } from '../lib.ts';

const SERVER = path.resolve(import.meta.dirname, '../memory-mcp.mjs');
const NOTE = 'Chorus shared memory is available. When the user states a lasting preference, rule, decision or fact (about themselves or their projects), save it with `remember`. Before answering a question that could depend on an earlier preference or decision, check `recall`.';
const A = 'For later: in all my projects I use pnpm, never npm, and two-space indentation. Just reply OK.';
const B = 'I am about to add a dependency to this project. Which command should I run?';
const q = (s: string) => JSON.stringify(s);

function args(cli: string, ws: string, prompt: string, store: string, log: string) {
  const server = { command: process.execPath, args: [SERVER, '--store', store, '--log', log] };
  if (cli === 'claude')
    return ['-p', prompt, '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: { chorus: server } }), '--allowedTools', 'mcp__chorus__remember,mcp__chorus__recall,mcp__chorus__list_memory'];
  if (cli === 'codex')
    return ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-c', `mcp_servers.chorus.command=${q(server.command)}`, '-c', `mcp_servers.chorus.args=[${server.args.map(q).join(',')}]`, '-c', 'mcp_servers.chorus.default_tools_approval_mode="approve"', '-c', `developer_instructions=${q(NOTE)}`, '-c', 'approval_policy="never"', prompt];
  fs.mkdirSync(path.join(ws, '.agents'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.agents', 'mcp_config.json'), JSON.stringify({ mcpServers: { chorus: server } }));
  return ['-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions'];
}

const calls = (log: string) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);

/** Last assistant message only: raw stdout also holds command text such as `pnpm-lock.yaml`. */
function finalAnswer(cli: string, stdout: string) {
  const t = adapters[cli as 'claude'].parseStream(stdout).turns.filter(x => x.role === 'assistant');
  return t.at(-1)?.text ?? '';
}

export default {
  id: 'memory-adoption',
  title: 'Do agents call remember / recall on their own?',
  cost: 'cheap',
  async run(ctx) {
    const facts: Record<string, any> = {};
    for (const cli of ctx.agents) {
      if (!cliVersion(cli)) { facts[cli] = { skipped: 'not installed' }; continue; }
      const dir = tmpWorkspace('mem-' + cli);
      const store = path.join(dir, 'memory.json');
      const log = path.join(dir, 'calls.jsonl');
      const wsA = tmpWorkspace('memA-' + cli), wsB = tmpWorkspace('memB-' + cli);
      const ra = await runCli(cli, args(cli, wsA, A, store, log), wsA);
      const afterA = calls(log).map(c => c.tool);
      const rb = await runCli(cli, args(cli, wsB, B, store, log), wsB);
      const afterB = calls(log).map(c => c.tool).slice(afterA.length);
      save(ctx, `${cli}-A.txt`, ra.stdout + '\n--stderr--\n' + ra.stderr);
      save(ctx, `${cli}-B.txt`, rb.stdout + '\n--stderr--\n' + rb.stderr);
      save(ctx, `${cli}-calls.json`, { afterA, afterB, memory: fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, 'utf8')) : [] });
      facts[cli] = {
        savedByItself: afterA.includes('remember'),
        recalledByItself: afterB.some(t => t === 'recall' || t === 'list_memory'),
        usedMemory: afterB.some(t => t === 'recall' || t === 'list_memory') && /pnpm/i.test(finalAnswer(cli, rb.stdout)),
        answerMentionsPnpm: /pnpm/i.test(finalAnswer(cli, rb.stdout)),
        finalAnswer: finalAnswer(cli, rb.stdout).slice(0, 300),
        callsInA: afterA, callsInB: afterB, msA: ra.ms, msB: rb.ms,
      };
    }
    const rows = Object.entries(facts).filter(([, f]: any) => !f.skipped);
    const ok = rows.every(([, f]: any) => f.savedByItself && f.usedMemory);
    return { status: rows.length ? (ok ? 'pass' : 'risk') : 'skip', summary: rows.map(([c, f]: any) => `${c}: saved=${f.savedByItself} recalled=${f.recalledByItself} usedMemory=${f.usedMemory}`).join(' | '), facts };
  },
} satisfies Case;
