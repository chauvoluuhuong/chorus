// R6: Codex/agy choose their own session ids; Chorus finds the transcript by birth time (discover.ts). Start two Codex runs in the
// same folder in the same second and see whether discovery can still tell them apart.
import fs from 'node:fs';
import { newTranscripts, codexCwd } from '../../../src/core/discover.ts';
import { cliVersion, runCli, save, tmpWorkspace, type Case } from '../lib.ts';

const args = (m: string) => ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', `Reply with exactly this word and nothing else: ${m}`];

export default {
  id: 'session-race',
  title: 'Two threads start in the same second in one folder',
  cost: 'cheap',
  async run(ctx) {
    if (!cliVersion('codex')) return { status: 'skip', summary: 'codex not installed', facts: {} };
    const ws = tmpWorkspace('race');
    const trials: any[] = [];
    for (let i = 0; i < 2; i++) {
      const since = Date.now();
      const [a, b] = await Promise.all([runCli('codex', args(`ALPHA${i}`), ws, 180_000), runCli('codex', args(`BRAVO${i}`), ws, 180_000)]);
      const found = newTranscripts('codex', since, new Set()).filter(c => codexCwd(c.file) === ws);
      const info = found.map(c => {
        const text = fs.readFileSync(c.file, 'utf8');
        return { id: c.id, birth: c.birth - since, marker: /ALPHA\d/.exec(text)?.[0] ?? /BRAVO\d/.exec(text)?.[0] ?? null, sameCwd: codexCwd(c.file) === ws };
      });
      const launchOrderMatchesBirth = info[0]?.marker?.startsWith('ALPHA') ?? null;
      trials.push({ n: i, found: info.length, birthsMs: info.map(x => x.birth), markers: info.map(x => x.marker), firstBornIsFirstLaunched: launchOrderMatchesBirth, aOk: a.code === 0, bOk: b.code === 0 });
    }
    save(ctx, 'trials.json', trials);
    const ambiguous = trials.some(t => t.found === 2 && t.firstBornIsFirstLaunched === false);
    const spread = trials.flatMap(t => t.birthsMs.slice(1).map((x: number, i: number) => x - t.birthsMs[i]));
    return { status: 'risk', summary: `cwd cannot separate the two threads (both rollouts share it); ${trials.filter(t => t.found === 2).length}/${trials.length} trials found both files; birth-order ${ambiguous ? 'DID' : 'did not'} disagree with launch order; birth gap ${spread.join(', ')} ms`, facts: { trials } };
  },
} satisfies Case;
