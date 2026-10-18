// R3: prompt wording is version-specific (approvals.md gotcha 4). Which installed versions have prompt fixtures?
import fs from 'node:fs';
import path from 'node:path';
import { cliVersion, type Case } from '../lib.ts';

export default {
  id: 'approval-drift',
  title: 'Installed CLI versions vs. approval-prompt fixtures',
  cost: 'free',
  async run(ctx) {
    const facts: Record<string, any> = {};
    let stale = 0;
    for (const cli of ['claude', 'codex', 'agy']) {
      const v = cliVersion(cli);
      const dir = path.resolve('fixtures', cli);
      const versions = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      const withPrompt = versions.filter(x => fs.readdirSync(path.join(dir, x)).some(n => n.startsWith('approval')));
      const covered = !!v && withPrompt.includes(v);
      if (!covered) stale++;
      facts[cli] = { installed: v ?? null, fixtureVersionsWithPrompts: withPrompt, covered };
    }
    return { status: stale ? 'risk' : 'pass', summary: `${stale} of 3 CLIs run a version without an approval-prompt fixture`, facts };
  },
} satisfies Case;
