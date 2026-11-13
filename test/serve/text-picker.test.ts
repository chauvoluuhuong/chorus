// The text picker on its own (src/desktop/text-picker.js): a trigger at the start of a word opens its source; picking puts the
// item's text in; a trigger that is off is plain text and asks nothing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a page module, plain JavaScript
import { applyPick, findToken, MAX_ITEMS, rank } from '../../src/desktop/text-picker.js';

let folder = '';
let asked = 0;
const skills = { chars: ['/'], label: 'Skills', query: /[\w.-]*/, items: async () => [], insert: (x: any) => `/${x.key}` };
const files = { chars: ['@', '＠'], label: 'Files', query: /[\w.\/-]*/, enabled: () => !!folder, items: async () => (asked++, []), insert: (x: any) => `@${x.key}` };
const T = [skills, files];

test('a trigger at the start of a word, with what is typed after it; not inside a word', () => {
  assert.deepEqual(pick(findToken('Use /bra', 8, T)), { char: '/', query: 'bra', start: 4, label: 'Skills' });
  assert.equal(findToken('see a/b', 7, T), null, 'a slash inside a word is a path');
  assert.equal(findToken('Use /src/x', 10, T), null, 'a slash list does not take a path');
  assert.deepEqual(pick(findToken('/', 1, T)), { char: '/', query: '', start: 0, label: 'Skills' });
  assert.equal(findToken('Use /bra and more', 17, T), null, 'only the word the caret is in');
});

test('@ lists files only once a project folder is chosen: before that it is plain text and asks nothing', () => {
  folder = '';
  asked = 0;
  assert.equal(findToken('start from @src', 15, T), null);
  assert.equal(asked, 0, 'no source asked, so no request');
  folder = '/p/cake-shop';
  assert.deepEqual(pick(findToken('start from @src/pa', 18, T)), { char: '@', query: 'src/pa', start: 11, label: 'Files' });
  assert.deepEqual(pick(findToken('＠RE', 3, T)), { char: '＠', query: 'RE', start: 0, label: 'Files' });
});

test('rank: any part matches, those that start with it first, at most 50; applyPick replaces the word and adds a space', () => {
  const items = [{ key: 'gift-cards', main: '/gift-cards' }, { key: 'brand-style', main: '/brand-style' }, { key: 'csv-export', main: '/csv-export' }];
  assert.deepEqual(rank(items, 'st').map((x: any) => x.key), ['brand-style']);
  assert.deepEqual(rank(items, 'C').map((x: any) => x.key), ['csv-export', 'gift-cards']);
  assert.equal(rank(Array.from({ length: 70 }, (_, i) => ({ key: `k${i}` })), 'k').length, MAX_ITEMS);
  assert.deepEqual(applyPick('Use /bra please', 4, 8, '/brand-style'), { text: 'Use /brand-style  please', caret: 17 });
  assert.deepEqual(applyPick('@src', 0, 4, '@src/pages/orders.tsx'), { text: '@src/pages/orders.tsx ', caret: 22 });
});

function pick(t: any) {
  return t && { char: t.char, query: t.query, start: t.start, label: t.trigger.label };
}
