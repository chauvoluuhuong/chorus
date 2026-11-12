// The Doctor popup opens by itself only when the short check did not pass (owner, 2026-11-12; docs/doctor.md §6.1).
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a page module, plain JavaScript
import { shortCheckPassed } from '../../src/desktop/doctor-popup.js';

const agent = (agent: string, state: string) => ({ agent, state });

test('the short check passed: every installed agent can be used, a version new to Chorus too (not installed does not count): no popup', () => {
  assert.equal(shortCheckPassed({ agents: [agent('claude', 'ready'), agent('codex', 'ready'), agent('agy', 'ready')] }), true);
  assert.equal(shortCheckPassed({ agents: [agent('claude', 'ready'), agent('codex', 'missing'), agent('agy', 'missing')] }), true);
  // "3 of 3 ready to use" with one version new to Chorus: the detailed test is only suggested, so nothing opens (owner, 2026-11-13)
  assert.equal(shortCheckPassed({ agents: [agent('claude', 'ready'), agent('codex', 'ready'), agent('agy', 'untested')] }), true);
  assert.equal(shortCheckPassed({ agents: [agent('agy', 'untested')] }), true);
});

test('the short check did not pass: an agent needs login or failed its check, or none can be used: the popup opens', () => {
  assert.equal(shortCheckPassed({ agents: [agent('claude', 'ready'), agent('codex', 'needs-login')] }), false);
  assert.equal(shortCheckPassed({ agents: [agent('agy', 'untested'), agent('codex', 'needs-login')] }), false);
  assert.equal(shortCheckPassed({ agents: [agent('claude', 'missing'), agent('codex', 'missing'), agent('agy', 'missing')] }), false);
  assert.equal(shortCheckPassed({ agents: [agent('claude', 'failed')] }), false, 'a failed check needs you');
});

test('no answer yet: nothing is decided (and nothing opens) while the short check runs', () => {
  assert.equal(shortCheckPassed(null), null);
  assert.equal(shortCheckPassed({ checking: true, agents: null }), null);
  assert.equal(shortCheckPassed({ checking: true, agents: [agent('claude', 'ready')] }), null);
});
