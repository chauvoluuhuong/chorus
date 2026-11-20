// Task #16 (2026-11-20): the desktop page hands the paid module a live `chats` getter in choruspro.init, so a task's sidebar dot can
// pulse while any of its chats works. The init argument is cut out of src/desktop/app.js and evaluated against a stub scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/desktop/app.js'), 'utf8');

/** The object literal passed to window.choruspro?.init?.(…), as source text. */
function initArg(): string {
  const start = src.indexOf('window.choruspro?.init?.(');
  assert.ok(start >= 0, 'the page calls choruspro.init');
  let i = src.indexOf('{', start), depth = 0;
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(from, i + 1);
}

/** The init argument, with S the given page state and every other name a stub function. */
function evalInit(S: unknown): Record<string, unknown> {
  const scope = new Proxy({} as Record<string, unknown>, { has: () => true, get: (_t, k) => (k === 'S' ? S : k === Symbol.unscopables ? undefined : () => {}) });
  // eslint-disable-next-line no-new-func
  return new Function('scope', `with (scope) { return (${initArg()}); }`)(scope);
}

test('choruspro.init gets a chats getter that returns the live chat list', () => {
  const S = { state: { chats: [{ id: 't_1', state: 'busy' }] } };
  const h = evalInit(S);
  assert.equal(typeof h.chats, 'function');
  assert.deepEqual((h.chats as () => unknown)(), [{ id: 't_1', state: 'busy' }]);
  // live: a later state is what it returns, not a copy taken at init
  S.state = { chats: [{ id: 't_2', state: 'idle', sub: { parent: 't_1' } }] } as never;
  assert.deepEqual((h.chats as () => unknown)(), [{ id: 't_2', state: 'idle', sub: { parent: 't_1' } }]);
});

test('before the first state the getter returns an empty list', () => {
  assert.deepEqual((evalInit({}).chats as () => unknown)(), []);
});
