// Share (owner, 2026-11-18): the one line a chat's Share button copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error: a page module, plain JavaScript
import { shareLine, shareProject } from '../../src/desktop/share-line.js';

const computer = '/Users/you/.chorus/computer';

test('a main chat: its id, the project folder name and its title', () => {
  assert.equal(shareLine({ id: 't_568328d4', cwd: '/Users/you/chorus', title: 'Planner · Projects' }, { computer }), 'Chorus thread t_568328d4 · chorus › Planner · Projects');
});

test('a sub thread: the title its sidebar row shows; thread.project wins over cwd', () => {
  const sub = { id: 't_sub1', cwd: '/Users/you/chorus/.claude/worktrees/x', project: '/Users/you/chorus/', title: 'Review the diff', sub: { parent: 't_568328d4' } };
  assert.equal(shareLine(sub, { computer }), 'Chorus thread t_sub1 · chorus › Review the diff');
});

test('a renamed chat: the current title, never a full path or the first message', () => {
  const line = shareLine({ id: 't_r', cwd: '/Users/you/chorus-core', title: '  Board lanes\n stretch ' }, { computer });
  assert.equal(line, 'Chorus thread t_r · chorus-core › Board lanes stretch');
  assert.doesNotMatch(line, /\/Users\//);
});

test('This computer, and a task chat named as its row under the task', () => {
  assert.equal(shareProject({ cwd: `${computer}/` }, computer), 'This computer');
  assert.equal(shareLine({ id: 't_c', cwd: computer, title: 'hello' }, { computer }), 'Chorus thread t_c · This computer › hello');
  const pro = { chatPath: (id: string) => (id === 't_w' ? { taskId: 'k1', label: 'Projects', part: 'Step 13 · Board lanes' } : null) };
  assert.equal(shareLine({ id: 't_w', cwd: '/Users/you/chorus', title: 'You are claude-worker-1. Read…' }, { computer, pro }), 'Chorus thread t_w · chorus › Step 13 · Board lanes');
  assert.equal(shareLine({ id: 't_x', cwd: '/Users/you/chorus', title: 'plain' }, { computer, pro: { chatPath: () => { throw new Error('old'); } } }), 'Chorus thread t_x · chorus › plain');
});
