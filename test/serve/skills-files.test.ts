import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expandSkillMentions } from '../../src/core/skills.ts';
import { matchFiles } from '../../src/core/files.ts';

test('expandSkillMentions: each /name of a known skill, at the start of a word, becomes the load line; others stay', () => {
  const S = ['brand-style', 'csv.export'];
  assert.equal(expandSkillMentions('/brand-style', S), 'Use the Chorus skill "brand-style" (load it with the chorus get_skill tool).');
  assert.equal(expandSkillMentions('Use /brand-style, then /csv.export.', S), 'Use Use the Chorus skill "brand-style" (load it with the chorus get_skill tool)., then Use the Chorus skill "csv.export" (load it with the chorus get_skill tool)..');
  assert.equal(expandSkillMentions('see src/brand-style and a/brand-style /other /usr/bin', S), 'see src/brand-style and a/brand-style /other /usr/bin');
  assert.equal(expandSkillMentions('@src/x.ts /brand-style\n/nope', S), '@src/x.ts Use the Chorus skill "brand-style" (load it with the chorus get_skill tool).\n/nope');
});

test('matchFiles: any part of the path, any case; names that start with it first; at most 50', () => {
  const files = ['src/pages/orders.tsx', 'tests/orders.spec.ts', 'src/api/export.ts', 'README.md'];
  assert.deepEqual(matchFiles(files, 'ORD'), ['src/pages/orders.tsx', 'tests/orders.spec.ts']);
  assert.deepEqual(matchFiles(files, 'export'), ['src/api/export.ts']);
  assert.deepEqual(matchFiles(files, 'api/'), ['src/api/export.ts']);
  assert.equal(matchFiles(Array.from({ length: 80 }, (_, i) => `f${i}.ts`), 'f').length, 50);
});
