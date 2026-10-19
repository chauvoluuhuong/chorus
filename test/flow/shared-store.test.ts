// L2: one database for every project (ui-plan item 8), skip-permission flags, and the Skills screen's core.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildInteractive, mcpCommand, SKIP_FLAG } from '../../src/core/launch.ts';
import { disabledSkills, findNativeSkills, importSkill, setSkillEnabled, syncSkills } from '../../src/core/skills.ts';
import { Store } from '../../src/core/store.ts';

const tmp = (tag: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `chorus-${tag}-`)));
const text = (r: any) => r.content.map((x: any) => x.text).join('');

test('shared store: chats of two projects live in one database; artifacts stay in each project', () => {
  const home = tmp('home');
  const a = tmp('proj-a');
  const b = tmp('proj-b');
  const sa = new Store(a, { home });
  const sb = new Store(b, { home });
  assert.equal(sa.shared, true);
  assert.equal(sa.root, home);
  sa.createThread({ id: 't_a', title: 'cake', agent: 'claude', cwd: a });
  sb.createThread({ id: 't_b', title: 'api', agent: 'codex', cwd: b });
  assert.deepEqual(sa.listThreads().map(t => t.id).sort(), ['t_a', 't_b'], 'each process sees both');
  assert.equal(sa.getThread('t_b')!.project, b);
  assert.equal(sa.threadDir('t_b'), path.join(b, '.chorus', 'threads', 't_b'), 'artifacts of a chat in another project stay in that project');
  assert.equal(sb.artifactsDir('t_a'), path.join(a, '.chorus', 'threads', 't_a', 'artifacts'));
  fs.writeFileSync(path.join(sb.artifactsDir('t_b'), 'plan.md'), '# plan');
  sa.scanArtifacts('t_b');
  assert.equal(sa.listArtifacts('t_b')[0].abs, path.join(b, '.chorus', 'threads', 't_b', 'artifacts', 'plan.md'));
  assert.ok(!fs.existsSync(path.join(a, '.chorus', 'chorus.db')), 'no per-project database in shared mode');
  sa.close();
  sb.close();
});

test('project store stays the default (no CHORUS_HOME): the database is in <project>/.chorus', () => {
  const p = tmp('local');
  const old = process.env.CHORUS_HOME;
  delete process.env.CHORUS_HOME;
  const s = new Store(p);
  assert.equal(s.shared, false);
  assert.equal(s.root, path.join(p, '.chorus'));
  s.close();
  if (old) process.env.CHORUS_HOME = old;
});

test('a database made before the shared store gets the new columns and keeps its rows', () => {
  const p = tmp('old');
  fs.mkdirSync(path.join(p, '.chorus'), { recursive: true });
  const db = new DatabaseSync(path.join(p, '.chorus', 'chorus.db'));
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL, agent TEXT NOT NULL, model TEXT, cwd TEXT NOT NULL,
    native_session_id TEXT, parent_thread_id TEXT, state TEXT NOT NULL DEFAULT 'waiting', cli_version TEXT, transcript_path TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
    INSERT INTO threads (id,title,agent,cwd,created,updated) VALUES ('t_old','before','claude','${p}','2026-01-01','2026-01-01');`);
  db.close();
  const s = new Store(p);
  const t = s.getThread('t_old')!;
  assert.equal(t.title, 'before');
  assert.equal(t.skip_permissions, 0);
  assert.equal(t.project, null);
  assert.equal(s.projectOf('t_old'), p, 'a row without a project falls back to the store project');
  s.close();
});

test('importLocal copies a project database into the shared one once', () => {
  const home = tmp('home');
  const p = tmp('legacy');
  const local = new Store(p, { home: path.join(p, '.chorus') }); // a per-project database as written before
  local.createThread({ id: 't_1', title: 'first', agent: 'claude', cwd: p, native_session_id: 'sess' });
  local.recordSession('t_1', { agent: 'claude', turns: [{ seq: 1, role: 'user', text: 'hello' }], toolCalls: [{ id: 'c', turnSeq: 1, tool: 'Bash', target: 'ls', status: 'ok' }], usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 0 } });
  local.close();
  const shared = new Store(p, { home });
  assert.equal(shared.importLocal(p), 1);
  assert.equal(shared.importLocal(p), 0, 'second run adds nothing');
  assert.equal(shared.getTurns('t_1')[0].text, 'hello');
  assert.equal(shared.getToolCalls('t_1')[0].tool, 'Bash');
  assert.equal(shared.getUsage('t_1')!.outputTokens, 6);
  assert.equal(shared.getThread('t_1')!.native_session_id, 'sess');
  shared.close();
});

test('mcp: a chat in one project can load a chat from another through the shared database', async () => {
  const home = tmp('home');
  const a = tmp('proj-a');
  const b = tmp('proj-b');
  const sa = new Store(a, { home });
  sa.createThread({ id: 't_old', title: 'Rate limiter', agent: 'codex', cwd: b, project: b });
  sa.recordSession('t_old', { agent: 'codex', turns: [{ seq: 1, role: 'user', text: 'Add a per-key rate limit' }, { seq: 2, role: 'assistant', text: 'Limiter in place' }], toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } });
  sa.createThread({ id: 't_new', title: 'cake', agent: 'claude', cwd: a, project: a });
  const m = mcpCommand(a, 't_new', home);
  assert.ok(m.args.join(' ').includes(`--home ${home}`), 'the MCP server is told which database to open');
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StdioClientTransport({ command: m.command, args: m.args }));
  const list = text(await c.callTool({ name: 'list_threads', arguments: {} }));
  assert.match(list, /t_old\tcodex\t\w+\tRate limiter\t.*proj-b/);
  const ctx = text(await c.callTool({ name: 'get_handoff_context', arguments: { thread_id: 't_old' } }));
  assert.match(ctx, /Add a per-key rate limit/);
  assert.match(ctx, /Limiter in place/);
  const instr = c.getInstructions() ?? '';
  assert.ok(instr.includes(path.join(a, '.chorus', 'threads', 't_new', 'artifacts')), 'artifacts go to the chat project');
  await c.close();
  sa.close();
});

test('handoff: a title passed as thread_id (what a model does when the prompt quotes it) or an unknown id still loads the chat this one continues', async () => {
  const home = tmp('home');
  const a = tmp('proj-a');
  const sa = new Store(a, { home });
  sa.createThread({ id: 't_parent', title: 'Create calc.js in the curre…', agent: 'claude', cwd: a, project: a });
  sa.recordSession('t_parent', { agent: 'claude', turns: [{ seq: 1, role: 'user', text: 'Create calc.js' }, { seq: 2, role: 'assistant', text: 'done' }], toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 } });
  sa.createThread({ id: 't_child', title: 'child', agent: 'codex', cwd: a, project: a, parent_thread_id: 't_parent' });
  const m = mcpCommand(a, 't_child', home);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StdioClientTransport({ command: m.command, args: m.args }));
  for (const thread_id of [undefined, 't_parent', 'Create calc.js in the curre…', 'no-such-thread']) {
    const r = await c.callTool({ name: 'get_handoff_context', arguments: thread_id ? { thread_id } : {} });
    assert.ok(!(r as any).isError, `thread_id=${thread_id}`);
    assert.match(text(r), /Create calc\.js/, `thread_id=${thread_id}`);
  }
  await c.close();
  sa.close();
});

test('skip permissions: the flag per CLI is added only when asked, and resumed chats keep it', () => {
  const w = tmp('skipflags'); // agy writes its MCP config into the chat folder
  const base = { cwd: w, project: w, threadId: 't_1' };
  for (const agent of ['claude', 'codex', 'agy'] as const) {
    const off = buildInteractive(agent, base);
    const on = buildInteractive(agent, { ...base, skipPermissions: true });
    assert.ok(!off.args.includes(SKIP_FLAG[agent]), `${agent}: off by default`);
    assert.ok(on.args.includes(SKIP_FLAG[agent]), `${agent}: ${SKIP_FLAG[agent]}`);
  }
  assert.equal(SKIP_FLAG.codex, '--dangerously-bypass-approvals-and-sandbox');
  assert.ok(buildInteractive('claude', { ...base, resumeId: 'abc', skipPermissions: true }).args.includes('--dangerously-skip-permissions'));
});

test('effort: the flag per CLI, only when a level is chosen, kept for resumed chats; Codex gets it as a config override', () => {
  const w = tmp('lvlflags');
  const base = { cwd: w, project: w, threadId: 't_1' };
  for (const agent of ['claude', 'codex', 'agy'] as const) {
    assert.ok(!buildInteractive(agent, base).args.some(a => /effort/.test(a)), `${agent}: nothing by default`);
    assert.ok(!buildInteractive(agent, { ...base, effort: 'default' }).args.some(a => /effort/.test(a)), `${agent}: "default" passes no flag`);
  }
  const claude = buildInteractive('claude', { ...base, effort: 'high' }).args;
  assert.deepEqual(claude.slice(claude.indexOf('--effort'), claude.indexOf('--effort') + 2), ['--effort', 'high']);
  const agy = buildInteractive('agy', { ...base, effort: 'low' }).args;
  assert.deepEqual(agy.slice(agy.indexOf('--effort'), agy.indexOf('--effort') + 2), ['--effort', 'low']);
  const codex = buildInteractive('codex', { ...base, effort: 'xhigh' }).args;
  assert.ok(codex.includes('model_reasoning_effort="xhigh"'), 'codex: -c model_reasoning_effort="xhigh"');
  assert.equal(codex[codex.indexOf('model_reasoning_effort="xhigh"') - 1], '-c');
  assert.ok(buildInteractive('claude', { ...base, resumeId: 'abc', effort: 'max' }).args.includes('max'));
});

test('effort: Codex lists the levels of the chosen model from its own cache, the other CLIs the five they document', async () => {
  const { effortsFor } = await import('../../src/app/models.ts');
  assert.deepEqual(effortsFor('claude'), ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortsFor('agy', 'whatever'), ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  const home = tmp('codexhome');
  const old = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'gpt-a', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
    { slug: 'gpt-b', visibility: 'list', priority: 2, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'ultra' }] },
    { slug: 'hidden', visibility: 'hide', priority: 0, supported_reasoning_levels: [{ effort: 'max' }] },
  ] }));
  assert.deepEqual(effortsFor('codex', 'default'), ['default', 'low', 'high'], 'the first listed model is the default');
  assert.deepEqual(effortsFor('codex', 'gpt-b'), ['default', 'low', 'medium', 'ultra'], 'follows the chosen model');
  fs.rmSync(path.join(home, 'models_cache.json'));
  assert.deepEqual(effortsFor('codex', 'gpt-b'), ['default', 'low', 'medium', 'high', 'xhigh', 'max'], 'no cache: the documented five');
  if (old === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = old;
});

test('skills: a skill switched off stays in the library but is not linked; switching it on links it again', () => {
  const p = tmp('skills');
  for (const n of ['pricing', 'tone']) {
    fs.mkdirSync(path.join(p, '.chorus', 'skills', n), { recursive: true });
    fs.writeFileSync(path.join(p, '.chorus', 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: d\n---\nbody`);
  }
  syncSkills(p);
  assert.ok(fs.existsSync(path.join(p, '.claude/skills/pricing')));
  setSkillEnabled(p, 'pricing', false);
  assert.deepEqual(disabledSkills(p), ['pricing']);
  const r = syncSkills(p);
  assert.deepEqual(r.removed.sort(), ['.agents/skills/pricing', '.claude/skills/pricing']);
  assert.ok(!fs.existsSync(path.join(p, '.claude/skills/pricing')));
  assert.ok(fs.existsSync(path.join(p, '.chorus/skills/pricing/SKILL.md')), 'still in the library');
  assert.ok(fs.existsSync(path.join(p, '.claude/skills/tone')));
  setSkillEnabled(p, 'pricing', true);
  syncSkills(p);
  assert.ok(fs.existsSync(path.join(p, '.claude/skills/pricing')));
});

test('skills: skills the agents already have are found, CLI defaults and Chorus links are not, and import copies', () => {
  const p = tmp('found');
  const home = tmp('uhome');
  const mk = (dir: string, name: string) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: about ${name}\n---\nbody`);
  };
  mk(path.join(home, '.claude/skills'), 'release-notes');
  mk(path.join(home, '.agents/skills'), 'pdf-tools');
  mk(path.join(home, '.codex/skills/.system'), 'builtin'); // the CLI's own defaults: never offered
  mk(path.join(p, '.chorus/skills'), 'pricing');
  syncSkills(p); // pricing is now linked into .claude/skills and .agents/skills by Chorus
  const found = findNativeSkills(p, home);
  assert.deepEqual(found.map(f => f.name), ['pdf-tools', 'release-notes']);
  assert.deepEqual(found.map(f => f.from), ['~/.agents/skills', '~/.claude/skills']);
  assert.equal(found.find(f => f.name === 'pdf-tools')!.agent, 'shared');
  const to = importSkill(p, found.find(f => f.name === 'release-notes')!);
  assert.ok(fs.existsSync(path.join(to, 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/release-notes/SKILL.md')), 'the original stays');
  assert.throws(() => importSkill(p, { dir: path.join(home, '.claude/skills/release-notes') }), /already in the library/);
  assert.deepEqual(findNativeSkills(p, home).map(f => f.name), ['pdf-tools'], 'imported ones are not offered again');
});
