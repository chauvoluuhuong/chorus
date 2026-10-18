// R6b: does agy leave the Chorus thread id anywhere Chorus can read it (so a transcript can be matched to its thread)?
import fs from 'node:fs';
import path from 'node:path';
import { buildHeadless, homes } from '../../../src/core/launch.ts';
import { cliVersion, runCli, save, tmpWorkspace, type Case } from '../lib.ts';

function walk(d: string, out: string[] = []) {
  for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
    const p = path.join(d, e.name);
    e.isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

export default {
  id: 'agy-thread-id',
  title: 'Is the Chorus thread id readable from an agy session?',
  cost: 'cheap',
  async run(ctx) {
    if (!cliVersion('agy')) return { status: 'skip', summary: 'agy not installed', facts: {} };
    const project = tmpWorkspace('agyid');
    const threadId = 't_risk' + Math.random().toString(16).slice(2, 6);
    const since = Date.now();
    const l = buildHeadless('agy', { prompt: 'Reply with the single word OK.', cwd: project, project, threadId });
    const logFile = path.join(project, 'agy-thread.log');
    const r = await runCli(l.bin, [...l.args, '--log-file', logFile], l.cwd, 180_000);
    const brain = path.join(homes.agy(), 'brain');
    const newBrain = fs.existsSync(brain) ? fs.readdirSync(brain).filter(d => fs.statSync(path.join(brain, d)).birthtimeMs >= since - 1000) : [];
    const logText = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const logHasSessionId = newBrain.length === 1 && logText.includes(newBrain[0]);
    save(ctx, 'agy-thread.log', logText.slice(0, 20000));
    save(ctx, 'agy-stdout.txt', r.stdout);
    const root = homes.agy();
    const touched = walk(root).filter(f => { try { return fs.statSync(f).mtimeMs >= since - 1000 && fs.statSync(f).size < 20_000_000; } catch { return false; } });
    const hits = touched.filter(f => { try { return fs.readFileSync(f, 'utf8').includes(threadId); } catch { return false; } });
    const brainHits = hits.filter(f => f.includes(`${path.sep}brain${path.sep}`));
    save(ctx, 'agy-files.json', { threadId, touched: touched.map(f => path.relative(root, f)), hits: hits.map(f => path.relative(root, f)) });
    return {
      status: brainHits.length || logHasSessionId ? 'pass' : 'risk',
      summary: `per-thread --log-file ${logText ? 'written (' + logText.length + ' bytes)' : 'EMPTY'}, names the new session id: ${logHasSessionId}; `+`thread id ${hits.length ? 'found in ' + hits.map(f => path.relative(root, f)).join(', ') : 'NOT found in any file agy touched'}; ${touched.length} files touched; exit ${r.code}`,
      facts: { logHasSessionId, logBytes: logText.length, newBrain, threadId, hits: hits.map(f => path.relative(root, f)), brainHits: brainHits.length, touched: touched.length, exit: r.code },
    };
  },
} satisfies Case;
