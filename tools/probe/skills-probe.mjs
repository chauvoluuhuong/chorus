#!/usr/bin/env node
// Phase 2 probe: which project-level skill directories does each CLI actually load?
//
//   node tools/probe/skills-probe.mjs [claude|codex|agy ...] [--out fixtures]
//
// Writes one marker skill into each candidate location of a throwaway workspace, then asks the
// CLI (headless) for each marker. Prints a table and saves it to
// <out>/skills/<cli>-<version>.json. Skill bodies are harmless.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outRoot = path.resolve(outIdx >= 0 ? args[outIdx + 1] : 'fixtures');
const clis = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const targets = clis.length ? clis : ['claude', 'codex', 'agy'];

const LOCATIONS = { '.claude/skills': 'alpha', '.agents/skills': 'bravo', '.codex/skills': 'charlie', '.gemini/skills': 'delta', '.agent/skills': 'echo' };
const SCRUB = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID'];

function skillMd(name, marker) {
  return `---
name: ${name}
description: Use this skill when the user asks for the ${name} greeting. It defines the exact answer.
---

# ${name}

When the user asks for the ${name} greeting, reply with exactly: ${marker}
`;
}

function run(cli, ws, prompt) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  const a = {
    claude: ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--dangerously-skip-permissions'],
    codex: ['exec', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-c', 'approval_policy="never"', prompt],
    agy: ['-p', prompt, '--output-format', 'stream-json', '--dangerously-skip-permissions'],
  }[cli];
  const r = spawnSync(cli, a, { cwd: ws, env, encoding: 'utf8', timeout: 240000, input: '' });
  return `${r.stdout ?? ''}`;
}

// Tool calls in order, from each CLI's JSON stream. A skill is "native" when the first tool call
// opens its SKILL.md (or invokes the Skill tool) instead of searching the file system for it.
function analyse(cli, out, name) {
  const calls = [];
  let listed = false; // Claude's init event lists the skills it loaded: the authoritative native check
  let answer = '';
  for (const line of out.split('\n')) {
    if (!line.startsWith('{')) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (cli === 'codex') {
      const it = e.item ?? {};
      if (e.type === 'item.started' && it.type === 'command_execution') calls.push(String(it.command));
      if (e.type === 'item.completed' && it.type === 'agent_message') answer = it.text;
    } else if (cli === 'agy') {
      const u = e.step_update ?? {};
      if (e.event === 'step_update' && u.step_type === 'tool' && u.state === 'ACTIVE') calls.push(`${u.tool_name} ${JSON.stringify(u.tool_info?.parameters ?? {})}`);
      if (e.event === 'result') answer = e.result?.response ?? '';
    } else {
      if (e.type === 'system' && e.subtype === 'init') listed = (e.skills ?? []).includes(name);
      for (const b of e.message?.content ?? []) if (e.type === 'assistant' && b.type === 'tool_use') calls.push(`${b.name} ${JSON.stringify(b.input)}`);
      if (e.type === 'result') answer = e.result ?? '';
    }
  }
  const first = calls[0] ?? '';
  const native = cli === 'claude' ? listed : /SKILL\.md|^Skill /.test(first) && !/\b(find|ls|rg|grep|Glob)\b/.test(first);
  return { answer, firstCall: first.slice(0, 160), native };
}

for (const cli of targets) {
  const version = spawnSync(cli, ['--version'], { encoding: 'utf8' }).stdout.trim().replace(/^codex-cli /, '');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `chorus-skills-${cli}-`));
  const markers = {};
  for (const [loc, word] of Object.entries(LOCATIONS)) {
    const name = 'probe-' + word;
    const marker = 'kiwi-' + word;
    markers[loc] = { name, marker };
    markers[loc].marker = marker;
    const dir = path.join(ws, loc, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd(name, marker));
  }
  spawnSync('git', ['init', '-q'], { cwd: ws });
  const results = {};
  for (const [loc, { name, marker }] of Object.entries(markers)) {
    const out = run(cli, ws, `What is the ${name} greeting? Reply with only the greeting.`);
    const a = analyse(cli, out, name);
    results[loc] = { used: a.answer.includes(marker) || (cli === 'claude' && out.includes(marker)), native: a.native, firstCall: a.firstCall, answer: a.answer.trim().slice(0, 120) };
    console.log(`${cli} ${loc.padEnd(16)} ${results[loc].used ? 'used' : 'not used'} ${results[loc].native ? 'NATIVE' : 'found-by-search'}  ${results[loc].answer.replace(/\n/g, ' ')}`);
  }
  fs.mkdirSync(path.join(outRoot, 'skills'), { recursive: true });
  fs.writeFileSync(path.join(outRoot, 'skills', `${cli}-${version}.json`), JSON.stringify({ cli, version, results }, null, 2));
}
