import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { detectLimit } from '../../src/app/limits.ts';

const screen = fs.readFileSync(path.resolve(import.meta.dirname, '../../fixtures/agy/1.4.1/quota/screen.txt'), 'utf8').split('\n');

test('agy: the real quota-exhausted screen is recognised, with the reset time', () => {
  const hit = detectLimit('agy', screen);
  assert.ok(hit);
  assert.equal(hit.resets, '147h16m18s');
  assert.match(hit.message, /^Individual quota reached/);
});

test('a normal agy screen and other agents are not limit hits', () => {
  assert.equal(detectLimit('agy', ['> hello', 'Generating...']), undefined);
  assert.equal(detectLimit('claude', screen), undefined);
});
