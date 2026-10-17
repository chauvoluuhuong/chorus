import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { activityCmd, artifactsCmd, doctorCmd, memoryCmd, showCmd, threadsCmd, traceCmd } from '../../src/cli/commands.ts';
import { captureStream } from '../../src/core/capture.ts';
import { Store } from '../../src/core/store.ts';

const FIX = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '../../fixtures', p), 'utf8');

function seeded() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-cmd-'));
  const store = new Store(proj);
  store.createThread({ id: 't_a', title: 'fix bug', agent: 'claude', cwd: proj });
  captureStream(store, 't_a', FIX('claude/2.1.301/shell/stdout.jsonl'), 'run echo');
  store.createThread({ id: 't_b', title: 'continue', agent: 'codex', cwd: proj, parent_thread_id: 't_a' });
  fs.mkdirSync(store.artifactsDir('t_a'), { recursive: true });
  fs.writeFileSync(path.join(store.artifactsDir('t_a'), 'notes.md'), '# notes');
  store.scanArtifacts('t_a');
  store.logMcpCall('t_b', 'get_handoff_context');
  return { store, proj };
}

test('threads, show, memory, artifacts and activity describe the store', () => {
  const { store } = seeded();
  assert.match(threadsCmd(store), /t_a\s+claude\s+waiting\s+-\s+fix bug/);
  assert.match(threadsCmd(store), /t_b\s+codex\s+waiting\s+t_a\s+continue/);
  const show = showCmd(store, 't_a');
  assert.match(show, /continued by: t_b \(codex\)/);
  assert.match(show, /\[2\] assistant: chorus-probe-42/);
  assert.match(show, /✓ Bash echo chorus-probe/);
  assert.match(memoryCmd(store, 't_a'), /# Handoff from Chorus thread "fix bug"/);
  assert.match(artifactsCmd(store), /t_a\t[0-9a-f]{12}\t.*notes\.md/);
  assert.match(activityCmd(store), /t_b\s+codex\s+0\s+0\s+1/);
  assert.match(showCmd(store, 'nope'), /unknown thread/);
});

test('trace compares the transcript with what was parsed', () => {
  const { store } = seeded();
  const t = path.join(os.tmpdir(), 'trace-' + Date.now() + '.jsonl');
  fs.writeFileSync(t, FIX('claude/2.1.284/shell/home-changes/projects/' + fs.readdirSync(path.join(import.meta.dirname, '../../fixtures/claude/2.1.284/shell/home-changes/projects'))[0] + '/' + fs.readdirSync(path.join(import.meta.dirname, '../../fixtures/claude/2.1.284/shell/home-changes/projects', fs.readdirSync(path.join(import.meta.dirname, '../../fixtures/claude/2.1.284/shell/home-changes/projects'))[0]))[0]));
  store.updateThread('t_a', { transcript_path: t });
  const out = traceCmd(store, 't_a');
  assert.match(out, /transcript lines: \d+\s+→ parsed turns: 2, tool calls: 1, status: waiting/);
  assert.match(out, /raw {2}\{/);
  assert.match(out, /MCP calls from this thread: none/);
});

test('doctor reports Node and the three CLIs', () => {
  const out = doctorCmd(os.tmpdir());
  assert.match(out, /^chorus doctor/);
  for (const a of ['claude', 'codex', 'agy']) assert.match(out, new RegExp(`${a}\\s+(\\d|not installed)`));
});
