#!/usr/bin/env node
// L3: does each real agent know where this thread's artifacts go, without being told in the prompt?
// The prompt only says "write a note for the user"; the folder comes from Chorus's instructions
// (Claude and agy: the MCP server's instructions; Codex: developer_instructions).
//
//   node test/smoke/artifacts.ts [--agents claude,codex,agy]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters } from '../../src/core/adapters/index.ts';
import { buildHeadless, run } from '../../src/core/launch.ts';
import { Store } from '../../src/core/store.ts';
import type { AgentId } from '../../src/core/types.ts';

const argv = process.argv.slice(2);
const agents = (argv.includes('--agents') ? argv[argv.indexOf('--agents') + 1] : 'claude,codex,agy').split(',') as AgentId[];
let failed = 0;
const PROMPT = 'Write a one-line markdown note saying "hello" for the user to read later, using your file tools. Save it wherever it belongs for this chat (do not ask me). Reply with only the full path of the file you wrote.';

for (const agent of agents) {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-art-')));
  fs.mkdirSync(path.join(project, '.git'));
  const store = new Store(project);
  const t = store.createThread({ id: 't_art', title: 'artifact folder', agent, cwd: project });
  const r = await run(buildHeadless(agent, { prompt: PROMPT, cwd: project, project, threadId: t.id, model: agent === 'claude' ? 'haiku' : undefined }), { timeoutMs: 300_000 });
  const answer = adapters[agent].parseStream(r.stdout, { prompt: PROMPT }).turns.at(-1)?.text ?? '';
  const dir = store.artifactsDir(t.id);
  const written = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const strayNotes = fs.readdirSync(project).filter(f => /\.md$/.test(f));
  const ok = written.length > 0 && strayNotes.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${agent}: note written in the thread artifacts folder (${written.join(', ') || 'nothing there'}); stray notes in the project: ${strayNotes.join(', ') || 'none'}; it answered: ${answer.replace(/\s+/g, ' ').slice(0, 120)}`);
  store.close();
}
console.log(failed ? '\nFAILED' : '\nOK');
process.exit(failed ? 1 : 0);
