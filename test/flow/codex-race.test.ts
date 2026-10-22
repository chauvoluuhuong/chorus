// L2 (TD-4): two Codex chats in one folder, the first never sends a turn. Codex writes no rollout for it, so the only new rollout in
// that folder is the second chat's; each Tailer must still end on its own transcript (replayed from the real 0.163.0 capture).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Tailer } from '../../src/app/tailer.ts';
import { Store } from '../../src/core/store.ts';

const RUN = path.resolve(import.meta.dirname, '../../fixtures/risks/codex-thread-marker/2026-10-22T01-31-46-678Z');
const FIX_THREAD = 't_busy9b85';
const read = (f: string) => fs.readFileSync(path.join(RUN, f), 'utf8');

// a private Codex home: discovery scans $CODEX_HOME/sessions
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-codex-home-'));
process.env.CODEX_HOME = codexHome;
const day = path.join(codexHome, 'sessions/2026/10/22');
fs.mkdirSync(day, { recursive: true });

/** the captured rollout, re-labelled for one of our threads and one native id (fixture cwd and ids swapped in) */
const rollout = (text: string, threadId: string, nativeId: string, cwd: string) =>
  text.replaceAll(FIX_THREAD, threadId).replaceAll('01a1613c-6650-7980-902c-459326a9547e', nativeId).replace(/"cwd":"[^"]*"/g, `"cwd":${JSON.stringify(cwd)}`);
const file = (nativeId: string) => path.join(day, `rollout-2026-10-22T08-31-52-${nativeId}.jsonl`);

test('two Codex chats in one folder: the one that never sends a turn does not take the other chat\'s rollout', () => {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-race-')));
  const store = new Store(proj);
  const claimed = new Set<string>();
  store.createThread({ id: 't_idle0001', title: 'codex 1', agent: 'codex', cwd: proj });
  store.createThread({ id: 't_busy0002', title: 'codex 2', agent: 'codex', cwd: proj });
  // the idle chat was opened first, so its tailer polls first: the old "first unclaimed rollout in this cwd" rule gave it B's file
  const a = new Tailer({ store, threadId: 't_idle0001', agent: 'codex', cwd: proj, claimed });
  const b = new Tailer({ store, threadId: 't_busy0002', agent: 'codex', cwd: proj, claimed });

  // B's rollout as Codex first writes it: session_meta + task_started, no marker yet. Nobody may claim it.
  const idB = '01a1613c-0000-7000-8000-00000000000b';
  fs.writeFileSync(file(idB), rollout(read('rollout-busy-before-marker.jsonl'), 't_busy0002', idB, proj));
  a.poll();
  b.poll();
  assert.equal(a.file, undefined);
  assert.equal(b.file, undefined, 'no marker yet: leave unlinked and retry, never guess');

  // B's first turn lands (developer message with the marker, the prompt, the reply)
  fs.writeFileSync(file(idB), rollout(read('rollout-busy.jsonl'), 't_busy0002', idB, proj));
  a.poll();
  b.poll();
  assert.equal(a.file, undefined, 'the idle chat has no rollout of its own and must stay unlinked');
  assert.equal(store.getThread('t_idle0001')!.native_session_id, null);
  assert.equal(store.getTurns('t_idle0001').length, 0);
  assert.equal(b.file, file(idB));
  assert.equal(store.getThread('t_busy0002')!.native_session_id, idB);
  assert.equal(store.getTurns('t_busy0002').at(-1)?.text, 'BRAVO');

  // much later the idle chat gets its first turn: it finds its own rollout, not B's
  const idA = '01a1613c-0000-7000-8000-00000000000a';
  fs.writeFileSync(file(idA), rollout(read('rollout-busy.jsonl'), 't_idle0001', idA, proj).replaceAll('BRAVO', 'ALPHA'));
  a.poll();
  assert.equal(a.file, file(idA));
  assert.equal(store.getThread('t_idle0001')!.native_session_id, idA);
  assert.equal(store.getTurns('t_idle0001').at(-1)?.text, 'ALPHA');
  assert.equal(store.getTurns('t_busy0002').at(-1)?.text, 'BRAVO');
  a.stop();
  b.stop();
  store.close();
});

test('two Codex chats started together: rollouts born in the opposite order still go to the right threads', () => {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-race-')));
  const store = new Store(proj);
  const claimed = new Set<string>();
  store.createThread({ id: 't_first001', title: 'codex 1', agent: 'codex', cwd: proj });
  store.createThread({ id: 't_secnd002', title: 'codex 2', agent: 'codex', cwd: proj });
  const first = new Tailer({ store, threadId: 't_first001', agent: 'codex', cwd: proj, claimed });
  const second = new Tailer({ store, threadId: 't_secnd002', agent: 'codex', cwd: proj, claimed });
  // the second launched is born first (docs/risks/session-race.md: 2/2 trials)
  const id2 = '01a1613c-0000-7000-8000-000000000002';
  const id1 = '01a1613c-0000-7000-8000-000000000001';
  fs.writeFileSync(file(id2), rollout(read('rollout-busy.jsonl'), 't_secnd002', id2, proj).replaceAll('BRAVO', 'SECOND'));
  fs.writeFileSync(file(id1), rollout(read('rollout-busy.jsonl'), 't_first001', id1, proj).replaceAll('BRAVO', 'FIRST'));
  first.poll();
  second.poll();
  assert.equal(store.getTurns('t_first001').at(-1)?.text, 'FIRST');
  assert.equal(store.getTurns('t_secnd002').at(-1)?.text, 'SECOND');
  first.stop();
  second.stop();
  store.close();
});
