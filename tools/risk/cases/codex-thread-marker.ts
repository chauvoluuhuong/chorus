// R6c (TD-4): two interactive Codex chats in one folder, the first never gets a turn. When does each rollout appear, and does it carry
// the `This chat is Chorus thread t_…` line from developer_instructions before the first turn?
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { buildInteractive } from '../../../src/core/launch.ts';
import { codexCwd, newTranscripts } from '../../../src/core/discover.ts';
import { cleanEnv, cliVersion, save, tmpWorkspace, type Case } from '../lib.ts';
const require = createRequire(import.meta.url);
const pty = require('node-pty');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|[\x00-\x08\x0b-\x1f]/g, '');
/**
 * Keep the rollout's shape, drop what is the user's or Codex's own: the base prompt, account ids, and the developer/user context
 * items (skill lists, AGENTS.md, environment) other than the Chorus line and the typed prompt.
 */
const head = (text: string) =>
  text
    .split('\n')
    .filter(Boolean)
    .map(l => {
      let o: any;
      try {
        o = JSON.parse(l);
      } catch {
        return null; // a line still being written
      }
      const p = o.payload ?? {};
      if (o.type === 'session_meta') {
        if (p.base_instructions) p.base_instructions = { text: '<cut>' };
        for (const k of ['creator_user_id', 'creator_account_id']) if (k in p) p[k] = '<redacted>';
      }
      if (o.type === 'world_state') o.payload = '<cut>';
      if (o.type === 'response_item' && p.type === 'message' && (p.role === 'developer' || p.role === 'user'))
        p.content = (p.content ?? []).map((c: any) =>
          typeof c?.text === 'string' && !c.text.includes('Chorus thread') && !c.text.includes('BRAVO') ? { ...c, text: '<cut>' } : c,
        );
      return JSON.stringify(o);
    })
    .filter(Boolean)
    .join('\n') + '\n';

export default {
  id: 'codex-thread-marker',
  title: 'Codex rollout carries the Chorus thread id before the first turn',
  cost: 'cheap',
  async run(ctx) {
    if (!cliVersion('codex')) return { status: 'skip', summary: 'codex not installed', facts: {} };
    const ws = tmpWorkspace('marker');
    const since = Date.now();
    const ids = { a: 't_idle' + Math.random().toString(16).slice(2, 6), b: 't_busy' + Math.random().toString(16).slice(2, 6) };
    const spawn = (threadId: string, prompt?: string) => {
      const l = buildInteractive('codex', { cwd: ws, project: ws, threadId, prompt });
      const term = pty.spawn(l.bin, [...l.args, '-s', 'read-only', '-c', 'approval_policy="never"'], { name: 'xterm-256color', cols: 120, rows: 40, cwd: ws, env: { ...cleanEnv(), TERM: 'xterm-256color' } });
      const s = { term, screen: '' };
      term.onData((d: string) => (s.screen += d));
      return s;
    };
    const poke = (s: { term: any; screen: string }, n = { v: 0 }) =>
      setInterval(() => {
        if (n.v < 3 && /trust|Do you want|Yes, continue|Press enter/i.test(strip(s.screen).slice(-600))) {
          s.term.write('\r');
          n.v++;
        }
      }, 2000);
    const a = spawn(ids.a);
    const pa = poke(a);
    await sleep(3000);
    const b = spawn(ids.b, 'Reply with exactly this word and nothing else: BRAVO');
    const pb = poke(b);
    const snap = () =>
      newTranscripts('codex', since, new Set())
        .filter(c => codexCwd(c.file) === ws)
        .map(c => {
          const t = fs.readFileSync(c.file, 'utf8');
          return { id: c.id, birthMs: Math.round(c.birth - since), bytes: t.length, hasA: t.includes(`Chorus thread ${ids.a}.`), hasB: t.includes(`Chorus thread ${ids.b}.`), replied: /"BRAVO"|BRAVO"\}/.test(t) && t.includes('task_complete') };
        });
    const timeline: any[] = [];
    const deadline = Date.now() + 150_000;
    let doneAt = 0;
    let before = '';
    while (Date.now() < deadline) {
      await sleep(1000);
      const s = snap();
      // the busy chat's rollout as Chorus first sees it, before the marker
      const early = s.find(x => !x.hasA && !x.hasB);
      if (early && !before) before = fs.readFileSync(newTranscripts('codex', since, new Set()).find(c => c.id === early.id)!.file, 'utf8');
      timeline.push({ t: Date.now() - since, files: s });
      if (s.some(x => x.replied) && !doneAt) doneAt = Date.now();
      if (doneAt && Date.now() - doneAt > 15_000) break; // leave the idle chat 15 s more to write anything it would
    }
    clearInterval(pa);
    clearInterval(pb);
    const final = snap();
    for (const c of newTranscripts('codex', since, new Set()).filter(c => codexCwd(c.file) === ws)) {
      const t = fs.readFileSync(c.file, 'utf8');
      save(ctx, `rollout-${t.includes(ids.a) ? 'idle' : t.includes(ids.b) ? 'busy' : 'unmarked'}.jsonl`, head(t));
    }
    for (const s of [a, b]) {
      s.term.write('\x03');
      await sleep(600);
      s.term.write('\x03');
    }
    await sleep(1500);
    for (const s of [a, b]) try { s.term.kill(); } catch {}
    if (before) save(ctx, 'rollout-busy-before-marker.jsonl', head(before));
    save(ctx, 'screen-idle.txt', strip(a.screen).slice(-3000));
    save(ctx, 'screen-busy.txt', strip(b.screen).slice(-3000));
    save(ctx, 'timeline.json', { ids, timeline });
    const busy = final.find(x => x.hasB);
    const idle = final.find(x => x.hasA);
    const unmarked = final.filter(x => !x.hasA && !x.hasB);
    const firstSeenB = timeline.find(x => x.files.some((f: any) => f.hasB));
    return {
      status: busy && !unmarked.length ? 'pass' : 'risk',
      summary:
        `busy chat's rollout ${busy ? `found, marker present from ${firstSeenB?.t} ms (birth ${busy.birthMs} ms), replied: ${busy.replied}` : 'NOT found'}; ` +
        `idle chat (no turn) ${idle ? `has a rollout too (birth ${idle.birthMs} ms, ${idle.bytes} bytes)` : 'has NO rollout file'}; ` +
        `rollouts without a marker: ${unmarked.length}; files in cwd: ${final.length}`,
      facts: { ids, final, firstMarkerMs: firstSeenB?.t },
    };
  },
} satisfies Case;
