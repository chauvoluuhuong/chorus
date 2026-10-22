// L1: which Chorus thread a real Codex 0.163.0 rollout belongs to (TD-4), read from the captured rollouts in fixtures/risks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { codexThreadId } from '../../src/core/discover.ts';

const RUN = path.resolve(import.meta.dirname, '../../fixtures/risks/codex-thread-marker/2026-10-22T01-31-46-678Z');
const read = (f: string) => fs.readFileSync(path.join(RUN, f), 'utf8');

test('codex 0.163.0: the rollout names its Chorus thread in the developer message', () => {
  assert.equal(codexThreadId(read('rollout-busy.jsonl')), 't_busy9b85');
});

test('codex 0.163.0: before the first turn the rollout has no marker yet (session_meta, task_started)', () => {
  assert.equal(codexThreadId(read('rollout-busy-before-marker.jsonl')), undefined);
});

test('codex 0.163.0: a rollout without developer_instructions (plain TUI run) has no thread', () => {
  const plain = fs.readFileSync(path.resolve(import.meta.dirname, '../../fixtures/codex/0.163.0/pty/transcript.jsonl'), 'utf8');
  assert.equal(codexThreadId(plain), undefined);
});

test('codex: the marker counts only in a developer message, not when a user pastes it', () => {
  const busy = read('rollout-busy.jsonl').split('\n');
  const dev = busy.findIndex(l => l.includes('"role":"developer"') && l.includes('Chorus thread'));
  const pasted = busy[dev].replace('"role":"developer"', '"role":"user"');
  assert.equal(codexThreadId([busy[0], pasted].join('\n')), undefined);
  // and a half-written last line is skipped, not an error
  assert.equal(codexThreadId(busy[0] + '\n' + busy[dev].slice(0, 200)), undefined);
});
