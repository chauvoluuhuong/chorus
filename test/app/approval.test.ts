import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { detectApproval } from '../../src/app/approval.ts';
import type { AgentId } from '../../src/core/types.ts';

const FIX = path.resolve(import.meta.dirname, '../../fixtures');
const screen = (agent: string, v: string, name: string) => fs.readFileSync(path.join(FIX, agent, v, name, 'prompt-screen.txt'), 'utf8').split('\n');

const cases: [AgentId, string][] = [['claude', '2.1.284'], ['codex', '0.163.0'], ['agy', '1.4.0']];

for (const [agent, v] of cases) {
  test(`${agent}: the real permission prompt is recognised with the command it wants to run`, () => {
    const a = detectApproval(agent, screen(agent, v, 'approval-ask-nohook-enter'));
    assert.ok(a, 'prompt detected');
    assert.match(a.what, /touch .*approval-probe-file\.txt/);
    assert.equal(a.keys.approve, '\r');
    assert.equal(a.keys.deny, '\x1b');
  });

  test(`${agent}: the same screen after the answer (no prompt) is not an approval`, () => {
    const after = fs.readFileSync(path.join(FIX, agent, v, 'approval-ask-nohook-enter', 'screen.txt'), 'utf8').split('\n');
    assert.equal(detectApproval(agent, after), undefined);
  });
}

test('claude 2.1.302 (manual mode, hook asks): the prompt is recognised', () => {
  const a = detectApproval('claude', screen('claude', '2.1.302', 'approval-ask-manual-enter'));
  assert.ok(a, 'prompt detected');
  assert.match(a.what, /touch/);
  assert.equal(a.keys.approve, '\r');
  assert.equal(a.keys.deny, '\x1b');
});

test('claude 2.1.303 (no hook, launched in manual mode): the command is kept, the auto-mode tip is not', () => {
  const a = detectApproval('claude', screen('claude', '2.1.303', 'approval-manual-noflag'));
  assert.ok(a, 'prompt detected');
  assert.equal(a.what, 'Bash command · Fetch example.com and print the HTTP status code · curl -s -o /dev/null -w "%{http_code}" https://example.com');
  assert.equal(a.question, 'Do you want to proceed?');
});

test('claude 2.1.303: a file request says the kind and the file, not the boxed preview', () => {
  const a = detectApproval('claude', screen('claude', '2.1.303', 'approval-file-create'));
  assert.ok(a, 'prompt detected');
  assert.equal(a.what, 'Create file · cake.html');
  assert.equal(a.question, 'Do you want to create cake.html?');
  // a preview longer than the screen pushes the "Create file" header off it: the question still names the file
  const long = detectApproval('claude', screen('claude', '2.1.303', 'approval-file-long'));
  assert.equal(long?.what, 'Create file · cake.html');
});

test('prose that only mentions a prompt is not an approval', () => {
  assert.equal(detectApproval('claude', ['I will ask: Do you want to proceed?', 'and then continue']), undefined);
  assert.equal(detectApproval('codex', ['Would you like to run the tests? sure']), undefined);
});

test('agy: a file change shows what is being written (file and kind), not the code', () => {
  const lines = fs.readFileSync(path.join(FIX, 'agy', '1.4.2', 'approval-file', 'prompt-screen.txt'), 'utf8').split('\n');
  const a = detectApproval('agy', lines);
  assert.ok(a, 'prompt detected');
  assert.equal(a.what, 'Create file · /tmp/chorus-proof-nkh0uy/calc.js');
  assert.equal(a.question, 'Allow creation of this file?');
  assert.deepEqual(a.keys, { approve: '\r', deny: '\x1b' });
});

test('agy: a command request is the command after "Requesting permission for:", not the lines around it', () => {
  const a = detectApproval('agy', screen('agy', '1.4.0', 'approval-ask-nohook-enter'));
  assert.match(a!.what, /^mkdir -p \S+ && touch \S+approval-probe-file\.txt$/);
  const one = detectApproval('agy', ['● Ran (ls -la /x/mcp) (ctrl+o to expand)', 'Command', '─'.repeat(20), 'Requesting permission for: ls -la /x/mcp', 'Run this command?', '> 1. Yes, run command', '  4. No, cancel']);
  assert.equal(one?.what, 'ls -la /x/mcp');
});
