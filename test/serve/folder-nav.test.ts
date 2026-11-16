// Chorus's folder dialog by keyboard: type to jump (case, accents, a longer prefix, the same letter again, the pause, no match)
// and the sort (name, created, both directions, a folder with no birth time).
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a page module, plain JavaScript
import { fold, nextSort, sortFolders, typeJump } from '../../src/desktop/folder-nav.js';

const NAMES = ['apps', 'Ảnh', 'Documents', 'Downloads', 'đồ án', 'Desktop', '2026 taxes'];

function keys(times: number[]) {
  let i = 0;
  return typeJump({ timeout: 800, now: () => times[Math.min(i++, times.length - 1)] });
}

test('fold: no case, no accents, đ is d', () => {
  assert.equal(fold('Ảnh'), 'anh');
  assert.equal(fold('Tài liệu'), 'tai lieu');
  assert.equal(fold('Đồ án'), 'do an');
  assert.equal(fold('DOCUMENTS'), 'documents');
});

test('type to jump: the first name starting with the letter, case and accents aside', () => {
  const j = keys([0]);
  assert.equal(j.press('D', NAMES, -1), 2, 'D → Documents');
  const k = keys([0]);
  assert.equal(k.press('2', NAMES, -1), 6, 'a digit works too');
});

test('type to jump: letters within 800 ms build a prefix; after a pause it starts again', () => {
  const j = keys([0, 300, 600, 2000]);
  assert.equal(j.press('d', NAMES, -1), 2, 'd → Documents');
  assert.equal(j.press('o', NAMES, 2), 2, 'do → Documents');
  assert.equal(j.press('w', NAMES, 2), 3, 'dow → Downloads');
  assert.equal(j.press('a', NAMES, 3), 0, 'after the pause, a alone → apps');
  // đồ án is reached with a plain d: "do " is its prefix
  const k = keys([0, 100, 200, 300]);
  k.press('d', NAMES, -1);
  k.press('o', NAMES, 2);
  assert.equal(k.press(' ', NAMES, 2), 4, '"do " → đồ án');
});

test('type to jump: the same letter again moves to the next one, and wraps round', () => {
  const j = keys([0, 100, 200, 300, 400]);
  assert.equal(j.press('d', NAMES, -1), 2, 'Documents');
  assert.equal(j.press('d', NAMES, 2), 3, 'Downloads');
  assert.equal(j.press('d', NAMES, 3), 4, 'đồ án (an accented d counts)');
  assert.equal(j.press('d', NAMES, 4), 5, 'Desktop');
  assert.equal(j.press('d', NAMES, 5), 2, 'wraps round to Documents');
  const a = keys([0, 100]);
  assert.equal(a.press('a', NAMES, -1), 0, 'apps');
  assert.equal(a.press('a', NAMES, 0), 1, 'Ảnh: the accent aside');
});

test('type to jump: no match keeps the selection', () => {
  const j = keys([0, 100]);
  assert.equal(j.press('z', NAMES, 3), 3);
  assert.equal(j.press('q', [], -1), -1, 'an empty folder');
});

test('sort: by name A→Z and Z→A, by created newest first and oldest first; a folder without a birth time uses its change time', () => {
  // the route gives `created` from birthtime, or mtime where the file system keeps no birth time (tested in serve.test.ts)
  const items = [
    { name: 'beta', created: 3000 },
    { name: 'Alpha', created: 1000 },
    { name: 'gamma', created: 2000 },
    { name: 'folder 10', created: 2000 },
    { name: 'folder 9', created: 2000 },
  ];
  const names = (s: object) => sortFolders(items, s).map((x: { name: string }) => x.name);
  assert.deepEqual(names({ by: 'name', dir: 'asc' }), ['Alpha', 'beta', 'folder 9', 'folder 10', 'gamma'], 'case aside, numbers in order');
  assert.deepEqual(names({ by: 'name', dir: 'desc' }), ['gamma', 'folder 10', 'folder 9', 'beta', 'Alpha']);
  assert.deepEqual(names({ by: 'created', dir: 'desc' }), ['beta', 'folder 9', 'folder 10', 'gamma', 'Alpha'], 'newest first; a tie by name');
  assert.deepEqual(names({ by: 'created', dir: 'asc' }), ['Alpha', 'folder 9', 'folder 10', 'gamma', 'beta']);
});

test('sort control: a click on the active sort flips it; the other one starts at its default', () => {
  assert.deepEqual(nextSort({ by: 'name', dir: 'asc' }, 'name'), { by: 'name', dir: 'desc' });
  assert.deepEqual(nextSort({ by: 'name', dir: 'asc' }, 'created'), { by: 'created', dir: 'desc' });
  assert.deepEqual(nextSort({ by: 'created', dir: 'desc' }, 'created'), { by: 'created', dir: 'asc' });
  assert.deepEqual(nextSort(undefined, 'name'), { by: 'name', dir: 'asc' });
});
