import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capOutput, editNote, exitNote, maskSecrets } from '../../src/core/adapters/util.ts';
import { errorPreview } from '../../src/app/screens.ts';

test('maskSecrets hides authorization values, key=value pairs and token shapes, and leaves the rest', () => {
  assert.equal(maskSecrets('curl -H "Authorization: Bearer abc123def456ghi789" api.shop/prices'), 'curl -H "Authorization: Bearer ••••" api.shop/prices');
  assert.match(maskSecrets('STRIPE_API_KEY=sk_live_abcdefghijklmnop1234 npm run x'), /STRIPE_API_KEY=••••/);
  assert.equal(maskSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), '••••');
  assert.equal(maskSecrets('npm run build'), 'npm run build');
});

test('capOutput keeps the first and last lines and says how much was cut', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const out = capOutput(text);
  assert.match(out, /^line 0\n/);
  assert.match(out, /line 99/);
  assert.match(out, /… 80 lines omitted …/);
  assert.equal(capOutput('one\ntwo'), 'one\ntwo');
  assert.match(capOutput('x'.repeat(5000)), /\[truncated, 5000 bytes total\]$/);
});

test('editNote counts lines for edits and writes, never content; exitNote reads the exit code', () => {
  assert.equal(editNote('Edit', { old_string: 'a\nb\nc', new_string: 'a\nb\nc\nd\ne' }), '+5 −3');
  assert.equal(editNote('Write', { content: 'a\nb' }), '+2');
  assert.equal(editNote('Read', { file_path: 'x' }), undefined);
  assert.equal(exitNote('Exit code 1\nboom'), 'exit 1');
  assert.equal(exitNote('fine'), undefined);
});

test('errorPreview picks the error-looking lines (else the last ones) and counts what is hidden', () => {
  const p = errorPreview(['> build', 'pricing.ts:41  error TS2322: Type', 'CakeBuilder.tsx:88  error TS2339: Property', 'other.ts:9  error TS1', 'done'].join('\n'));
  assert.equal(p.lines.length, 2);
  assert.match(p.lines[0], /pricing\.ts:41/);
  assert.equal(p.hidden, 3);
  assert.deepEqual(errorPreview('a\nb\nc').lines, ['b', 'c']);
});
