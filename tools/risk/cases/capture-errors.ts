// R5: capture gaps. Force the error paths and a Codex file edit, save the raw output as fixture candidates and show what
// today's adapters make of them (an error that parses to "nothing" is the gap).
import fs from 'node:fs';
import path from 'node:path';
import { adapters } from '../../../src/core/adapters/index.ts';
import { cliVersion, runCli, save, tmpWorkspace, type Case } from '../lib.ts';

const BAD = 'chorus-no-such-model';
const runs: Record<string, { name: string; args: string[] }[]> = {
  claude: [{ name: 'bad-model', args: ['-p', 'say hi', '--model', BAD, '--output-format', 'stream-json', '--verbose'] }],
  codex: [
    { name: 'bad-model', args: ['exec', '--json', '--skip-git-repo-check', '-m', BAD, 'say hi'] },
    { name: 'file-change', args: ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'approval_policy="never"', '-c', 'model_reasoning_summary="detailed"', 'Create a file note.txt containing the word hello, using a patch edit (not a shell command). Then reply done.'] },
  ],
  agy: [{ name: 'bad-model', args: ['-p', 'say hi', '--model', BAD, '--output-format', 'stream-json', '--dangerously-skip-permissions'] }],
};

export default {
  id: 'capture-errors',
  title: 'Error and edit events the adapters do not capture yet',
  cost: 'cheap',
  async run(ctx) {
    const facts: Record<string, any> = {};
    for (const cli of ctx.agents) {
      if (!cliVersion(cli)) { facts[cli] = { skipped: 'not installed' }; continue; }
      facts[cli] = { version: cliVersion(cli) };
      for (const r of runs[cli]) {
        const ws = tmpWorkspace(`err-${cli}`);
        const out = await runCli(cli, r.args, ws, 180_000);
        save(ctx, `${cli}-${r.name}.stdout.jsonl`, out.stdout);
        save(ctx, `${cli}-${r.name}.stderr.txt`, out.stderr);
        let parsed: any;
        try {
          const s = adapters[cli as 'claude'].parseStream(out.stdout);
          parsed = { turns: s.turns.length, toolCalls: s.toolCalls.map(c => `${c.tool}:${c.target.slice(0, 40)}:${c.status}`), limit: s.limit ?? null };
        } catch (e: any) { parsed = { threw: String(e.message).slice(0, 200) }; }
        const types = new Set<string>();
        for (const l of out.stdout.split('\n')) { try { const j = JSON.parse(l); types.add(j.type + (j.item?.type ? '/' + j.item.type : '') + (j.subtype ? '/' + j.subtype : '')); } catch {} }
        facts[cli][r.name] = {
          exit: out.code, timedOut: out.timedOut, ms: out.ms, eventTypes: [...types], stderrHead: out.stderr.slice(0, 300),
          adapterSees: parsed,
          fileCreated: r.name === 'file-change' ? fs.existsSync(path.join(ws, 'note.txt')) : undefined,
        };
      }
    }
    const rows = Object.entries(facts).filter(([, f]: any) => !f.skipped);
    return { status: rows.length ? 'risk' : 'skip', summary: rows.map(([c, f]: any) => `${c}: ` + Object.entries(f).filter(([k]) => k !== 'version').map(([k, v]: any) => `${k} exit=${v.exit} events=[${v.eventTypes.join(',')}]`).join('; ')).join(' | '), facts };
  },
} satisfies Case;
