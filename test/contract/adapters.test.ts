// L1 contract tests: adapters parse REAL captured CLI output (fixtures/) into the normalized shape.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { adapters } from '../../src/core/adapters/index.ts';
import type { AgentId, Session } from '../../src/core/types.ts';

const ROOT = path.resolve(import.meta.dirname, '../../fixtures');
// every committed fixture version is tested (claude: cloud capture 2.1.301 and Mac capture 2.1.284)
const VERSIONS: Record<AgentId, string[]> = { claude: ['2.1.301', '2.1.284'], codex: ['0.163.0'], agy: ['1.4.0'] };
const SHELL_PROMPT = 'Use your shell / terminal tool to run exactly this command: echo chorus-probe-$((6*7)) Then reply with the command output only.';

const dir = (agent: AgentId, v: string, scenario: string) => path.join(ROOT, agent, v, scenario);
const read = (file: string) => fs.readFileSync(file, 'utf8');
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
function transcript(agent: AgentId, v: string, scenario: string): string {
  const re = { claude: /projects\/.*\.jsonl$/, codex: /sessions\/.*\.jsonl$/, agy: /logs\/transcript\.jsonl$/ }[agent];
  return read(findFiles(path.join(dir(agent, v, scenario), 'home-changes'), re).sort()[0]);
}
const stream = (agent: AgentId, v: string, scenario: string, file = 'stdout.jsonl') => read(path.join(dir(agent, v, scenario), file));

for (const agent of Object.keys(VERSIONS) as AgentId[]) {
  const a = adapters[agent];
  for (const v of VERSIONS[agent]) {
    const name = (t: string) => `${agent} ${v}: ${t}`;

    test(name('hello (stream) has an assistant turn, a session id and usage'), () => {
      const s = a.parseStream(stream(agent, v, 'hello'), { prompt: 'p' });
      assert.ok(s.nativeSessionId, 'session id');
      assert.equal(s.turns.at(-1)?.role, 'assistant');
      assert.match(s.turns.at(-1)!.text, /got it/i);
      assert.ok(s.usage.outputTokens > 0, 'output tokens');
    });

    test(name('shell (stream) records the command and its output'), () => {
      const s = a.parseStream(stream(agent, v, 'shell'), { prompt: SHELL_PROMPT });
      const call = s.toolCalls.find(c => c.target.includes('echo chorus-probe'));
      assert.ok(call, 'tool call with the command');
      assert.equal(call.status, 'ok');
      assert.match(call.result ?? '', /chorus-probe-42/);
      assert.match(s.turns.at(-1)!.text, /chorus-probe-42/);
    });

    test(name('shell (transcript) matches the stream'), () => {
      const s = a.parseTranscript(transcript(agent, v, 'shell'));
      assert.equal(s.turns[0].role, 'user');
      assert.match(s.turns[0].text, /echo chorus-probe/);
      const call = s.toolCalls.find(c => c.target.includes('echo chorus-probe'));
      assert.ok(call, 'tool call in transcript');
      assert.equal(call.status, 'ok');
      assert.match(call.result ?? '', /chorus-probe-42/);
      assert.match(s.turns.at(-1)!.text, /chorus-probe-42/);
      assert.ok(s.usage.outputTokens > 0);
    });

    test(name('mcp call is a tool call to the chorus server and returns the secret'), () => {
      const s: Session = a.parseStream(stream(agent, v, 'mcp'));
      const call = s.toolCalls.find(c => c.tool === 'mcp:chorus' && c.target === 'probe_get_context');
      assert.ok(call, 'mcp tool call');
      assert.equal(call.status, 'ok');
      assert.match(call.result ?? '', /pineapple/);
    });

    test(name('resume keeps the session id and the second turn is parsed'), () => {
      const one = a.parseStream(stream(agent, v, 'resume', 'stdout.1.jsonl'));
      const two = a.parseStream(stream(agent, v, 'resume', 'stdout.2.jsonl'));
      assert.ok(one.nativeSessionId);
      assert.equal(two.nativeSessionId, one.nativeSessionId);
      assert.match(two.turns.at(-1)!.text, /mango/i);
    });

    test(name('artifact write is visible as a tool call'), () => {
      const s = a.parseStream(stream(agent, v, 'artifact'));
      assert.ok(s.toolCalls.some(c => c.target.endsWith('.chorus/artifacts/probe/hello.md') || c.target.includes('.chorus/artifacts/probe/hello.md')), JSON.stringify(s.toolCalls.map(c => c.target)));
    });

    test(name('stream reports a plan-limit reading'), { skip: agent !== 'claude' }, () => {
      assert.ok(a.parseStream(stream(agent, v, 'hello')).limit?.utilization !== undefined);
    });

    // Interactive sessions: the transcript read while the TUI was still running (tools/probe/pty-probe.mjs)
    const ptyFile = path.join(dir(agent, v, 'pty'), 'transcript.jsonl');
    test(name('live interactive transcript parses (user turn, tool call, result)'), { skip: !fs.existsSync(ptyFile) }, () => {
      const s = a.parseTranscript(read(ptyFile));
      assert.equal(s.turns[0].role, 'user');
      assert.match(s.turns[0].text, /pty-probe/);
      const call = s.toolCalls.find(c => c.target.includes('pty-probe'));
      assert.ok(call, 'tool call visible while the session is running');
      assert.match(call.result ?? '', /pty-probe-42/);
    });
  }
}

test('claude: Bash artifact write needs the full command (not only the Write tool)', () => {
  const s = adapters.claude.parseTranscript(transcript('claude', '2.1.301', 'artifact'));
  assert.ok(s.toolCalls.some(c => c.tool === 'Bash' && c.target.includes('.chorus/artifacts/probe/hello.md')));
});

test('claude: hook events of an interactive session carry session id, transcript path and tool', () => {
  const f = path.join(dir('claude', '2.1.284', 'pty'), 'hook-events.jsonl');
  const events = read(f).split('\n').filter(l => l.trim().startsWith('{')).map(l => JSON.parse(l));
  const names = events.map(e => e.hook_event_name);
  assert.deepEqual(names.slice(0, 4), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']);
  assert.ok(events.every(e => e.session_id && e.transcript_path));
  assert.equal(events[2].tool_name, 'Bash');
  assert.equal(events[2].tool_use_id, events[3].tool_use_id);
});

test('shell targets collapse heredoc bodies but keep what follows', async () => {
  const { commandTarget } = await import('../../src/core/adapters/util.ts');
  assert.equal(commandTarget("cat > a.js <<'EOF'\nline1\nline2\nEOF\nnode --test"), 'cat > a.js <<EOF …EOF node --test');
});

test('versionWarning warns only for versions newer than verified', async () => {
  const { versionWarning } = await import('../../src/core/adapters/index.ts');
  assert.equal(versionWarning('codex', '0.163.0'), undefined);
  assert.equal(versionWarning('codex', '0.9.0'), undefined);
  assert.match(versionWarning('agy', '1.4.1')!, /newer than the last verified 1\.4\.0/);
  assert.equal(versionWarning('agy', undefined), undefined);
});

test('status: a finished turn is "waiting", a cut-off transcript is "working"', () => {
  for (const [agent, v] of [['claude', '2.1.284'], ['codex', '0.163.0'], ['agy', '1.4.0']] as [AgentId, string][]) {
    const full = transcript(agent, v, 'shell');
    assert.equal(adapters[agent].parseTranscript(full).status, 'waiting', `${agent} finished`);
    const lines = full.split('\n').filter(l => l.trim());
    // cut right after the tool call started: the agent is mid-turn
    const cutAt = lines.findIndex(l => /tool_use|CommandExecution|run_command|custom_tool_call"/.test(l));
    const partial = lines.slice(0, cutAt + 1).join('\n');
    assert.equal(adapters[agent].parseTranscript(partial).status, 'working', `${agent} mid-turn`);
  }
});
