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

test('prose that only mentions a prompt is not an approval', () => {
  assert.equal(detectApproval('claude', ['I will ask: Do you want to proceed?', 'and then continue']), undefined);
  assert.equal(detectApproval('codex', ['Would you like to run the tests? sure']), undefined);
});
