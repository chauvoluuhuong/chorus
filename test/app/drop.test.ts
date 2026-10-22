// Dropped files: the text a terminal sends for a drop, and copies into the chat's attachments folder (docs/phase5.md §8.3).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyInto, dropText, escapeLikeTerminal, freeName, safeName } from '../../src/core/drop.ts';

test('drop text: escaped like Terminal.app, a space after each path, bracketed paste when the agent asked for it', () => {
  // the probe pasted exactly this shape into Claude, Codex and agy (docs/integrations/file-drop.md)
  assert.equal(escapeLikeTerminal('/tmp/drop shot.png'), '/tmp/drop\\ shot.png');
  assert.equal(escapeLikeTerminal("/a/it's (v2) & more!.pdf"), "/a/it\\'s\\ \\(v2\\)\\ \\&\\ more\\!.pdf");
  assert.equal(escapeLikeTerminal('/plain/path.txt'), '/plain/path.txt');
  assert.equal(dropText(['/a b', '/c'], false), '/a\\ b /c ');
  assert.equal(dropText(['/a b'], true), '\x1b[200~/a\\ b \x1b[201~');
});

test('copies: a safe name, never over an existing file, from a path or from bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-drop-'));
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('..'), 'file');
  assert.equal(safeName('a\x07b.txt'), 'ab.txt');
  const src = path.join(dir, 'my spec.txt');
  fs.writeFileSync(src, 'v1');
  const into = path.join(dir, 'attachments');
  const one = copyInto(into, { path: src });
  assert.equal(one, path.join(into, 'my spec.txt'));
  assert.equal(fs.readFileSync(one, 'utf8'), 'v1');
  const two = copyInto(into, { path: src });
  assert.equal(path.basename(two), 'my spec (2).txt', 'a second file of the same name gets " (2)"');
  const bytes = copyInto(into, { name: 'shot.png', bytes: Buffer.from([1, 2, 3]) });
  assert.deepEqual([...fs.readFileSync(bytes)], [1, 2, 3]);
  assert.equal(freeName(into, 'shot.png'), 'shot (2).png');
});
