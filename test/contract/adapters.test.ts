// L1 contract tests: adapters parse REAL captured CLI output (fixtures/) into the normalized shape.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { adapters } from '../../src/core/adapters/index.ts';
import type { AgentId, Session } from '../../src/core/types.ts';

const ROOT = path.resolve(import.meta.dirname, '../../fixtures');
const VERSION: Record<AgentId, string> = { claude: '2.1.301', codex: '0.163.0', agy: '1.4.0' };
const PROMPTS = {
  shell: 'Use your shell / terminal tool to run exactly this command: echo chorus-probe-$((6*7)) Then reply with the command output only.',
};

function dir(agent: AgentId, scenario: string) {
  return path.join(ROOT, agent, VERSION[agent], scenario);
}
function read(file: string) {
  return fs.readFileSync(file, 'utf8');
}
function findFiles(root: string, match: RegExp): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (match.test(p)) out.push(p);
    }
  };
  walk(root);
  return out;
}
function transcript(agent: AgentId, scenario: string, which = 0): string {
  const re = { claude: /projects\/.*\.jsonl$/, codex: /sessions\/.*\.jsonl$/, agy: /logs\/transcript\.jsonl$/ }[agent];
  return read(findFiles(path.join(dir(agent, scenario), 'home-changes'), re).sort()[which]);
}
function stream(agent: AgentId, scenario: string, file = 'stdout.jsonl') {
  return read(path.join(dir(agent, scenario), file));
}

const agents: AgentId[] = ['claude', 'codex', 'agy'];

for (const agent of agents) {
  const a = adapters[agent];

  test(`${agent}: hello (stream) has one assistant turn, a session id and usage`, () => {
    const s = a.parseStream(stream(agent, 'hello'), { prompt: 'p' });
    assert.ok(s.nativeSessionId, 'session id');
    assert.equal(s.turns.at(-1)?.role, 'assistant');
    assert.match(s.turns.at(-1)!.text, /got it/i);
    assert.ok(s.usage.outputTokens > 0, 'output tokens');
  });

  test(`${agent}: shell (stream) records the command and its output`, () => {
    const s = a.parseStream(stream(agent, 'shell'), { prompt: PROMPTS.shell });
    const call = s.toolCalls.find(c => c.target.includes('echo chorus-probe'));
    assert.ok(call, 'tool call with the command');
    assert.equal(call.status, 'ok');
    assert.match(call.result ?? '', /chorus-probe-42/);
    assert.match(s.turns.at(-1)!.text, /chorus-probe-42/);
  });

  test(`${agent}: shell (transcript) matches the stream`, () => {
    const s = a.parseTranscript(transcript(agent, 'shell'));
    assert.equal(s.turns[0].role, 'user');
    assert.match(s.turns[0].text, /echo chorus-probe/);
    const call = s.toolCalls.find(c => c.target.includes('echo chorus-probe'));
    assert.ok(call, 'tool call in transcript');
    assert.equal(call.status, 'ok');
    assert.match(call.result ?? '', /chorus-probe-42/);
    assert.match(s.turns.at(-1)!.text, /chorus-probe-42/);
    assert.ok(s.usage.outputTokens > 0);
  });

  test(`${agent}: mcp call is a tool call to the chorus server and returns the secret`, () => {
    const s: Session = a.parseStream(stream(agent, 'mcp'));
    const call = s.toolCalls.find(c => c.tool === 'mcp:chorus' && c.target === 'probe_get_context');
    assert.ok(call, 'mcp tool call');
    assert.equal(call.status, 'ok');
    assert.match(call.result ?? '', /pineapple/);
  });

  test(`${agent}: resume keeps the session id and the second turn is parsed`, () => {
    const one = a.parseStream(stream(agent, 'resume', 'stdout.1.jsonl'));
    const two = a.parseStream(stream(agent, 'resume', 'stdout.2.jsonl'));
    assert.ok(one.nativeSessionId);
    assert.equal(two.nativeSessionId, one.nativeSessionId);
    assert.match(two.turns.at(-1)!.text, /mango/i);
  });
}

test('claude: transcript records the Bash artifact write (not only Write tool)', () => {
  const s = adapters.claude.parseTranscript(transcript('claude', 'artifact'));
  assert.ok(s.toolCalls.some(c => c.tool === 'Bash' && c.target.includes('.chorus/artifacts/probe/hello.md')));
});
test('codex: artifact write shows up as a shell command', () => {
  const s = adapters.codex.parseStream(stream('codex', 'artifact'));
  assert.ok(s.toolCalls.some(c => c.target.includes('.chorus/artifacts/probe/hello.md')));
});
test('agy: artifact write is a write_to_file tool call', () => {
  const s = adapters.agy.parseStream(stream('agy', 'artifact'));
  assert.ok(s.toolCalls.some(c => c.tool === 'write_to_file' && c.target.endsWith('.chorus/artifacts/probe/hello.md')));
});
test('claude: stream reports a plan-limit reading', () => {
  const s = adapters.claude.parseStream(stream('claude', 'hello'));
  assert.ok(s.limit?.utilization !== undefined);
});

test('shell targets collapse heredoc bodies but keep what follows', async () => {
  const { commandTarget } = await import('../../src/core/adapters/util.ts');
  const t = commandTarget("cat > a.js <<'EOF'\nline1\nline2\nEOF\nnode --test");
  assert.equal(t, 'cat > a.js <<EOF …EOF node --test');
});

// Interactive sessions: the transcript read while the TUI was still running (tools/probe/pty-probe.mjs)
for (const agent of ['codex', 'agy'] as AgentId[]) {
  test(`${agent}: transcript of a live interactive session parses (user turn, tool call, usage)`, () => {
    const s = adapters[agent].parseTranscript(read(path.join(dir(agent, 'pty'), 'transcript.jsonl')));
    assert.equal(s.turns[0].role, 'user');
    assert.match(s.turns[0].text, /pty-probe/);
    const call = s.toolCalls.find(c => c.target.includes('pty-probe'));
    assert.ok(call, 'tool call visible while the session is running');
    assert.match(call.result ?? '', /pty-probe-42/);
  });
}

test('versionWarning warns only for versions newer than verified', async () => {
  const { versionWarning } = await import('../../src/core/adapters/index.ts');
  assert.equal(versionWarning('codex', '0.163.0'), undefined);
  assert.equal(versionWarning('codex', '0.9.0'), undefined);
  assert.match(versionWarning('agy', '1.4.1')!, /newer than the last verified 1\.4\.0/);
  assert.equal(versionWarning('agy', undefined), undefined);
});
