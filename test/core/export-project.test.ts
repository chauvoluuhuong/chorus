// Export this project (task #11 step 7): one zip with only that project's chats and artifacts, project.json with its folders and
// variable NAMES, the paid module's files under pro/ — and never a variable's value or pro.db.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exportProject } from '../../src/core/export.ts';
import { ProjectSettings } from '../../src/core/projects.ts';
import { Store } from '../../src/core/store.ts';

const VALUE = 'ghp_secret_value_4b8d21e0';
const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const unzip = (file: string, flag: string, entry?: string) => execFileSync('unzip', [flag, file, ...(entry ? [entry] : [])], { encoding: 'latin1' });

function rig() {
  const home = tmp('chorus-expp-');
  const a = tmp('shop-a-');
  const b = tmp('shop-b-');
  const store = new Store(a, { home });
  const ta = store.createThread({ title: 'A chat', agent: 'claude', cwd: a, project: a });
  const tb = store.createThread({ title: 'B chat', agent: 'codex', cwd: b, project: b });
  store.recordSession(ta.id, { turns: [{ seq: 1, role: 'user', text: 'alpha words' }], toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } } as any);
  store.recordSession(tb.id, { turns: [{ seq: 1, role: 'user', text: 'bravo words' }], toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } } as any);
  for (const [t, f] of [[ta, 'a-plan.md'], [tb, 'b-plan.md']] as const) {
    fs.mkdirSync(store.artifactsDir(t.id), { recursive: true });
    fs.writeFileSync(path.join(store.artifactsDir(t.id), f), `# ${f}\n`);
  }
  fs.writeFileSync(path.join(home, 'pro.db'), 'pro bytes');
  const s = new ProjectSettings(home);
  const extra = tmp('shop-a-core-');
  s.addFolder(a, extra, { why: 'the shared code' });
  s.setVariable(a, 'GITHUB_TOKEN', VALUE, { why: 'pushes' });
  s.setVariable(b, 'B_ONLY', 'b-value');
  store.close();
  return { home, a, b, ta, tb, extra };
}

test('export one project: only its chats and artifacts, project.json with names, no value anywhere, no pro.db, no other project', () => {
  const r = rig();
  const out = tmp('chorus-expp-out-');
  const e = exportProject({ home: r.home, version: '2.8.0', dir: out, project: r.a, now: new Date('2026-11-18T07:00:00Z') });
  assert.equal(path.basename(e.file), `chorus-${path.basename(r.a)}-2026-11-18.zip`);
  assert.deepEqual([e.chats, e.projects, e.proFiles], [1, 1, 0]);
  assert.match(unzip(e.file, '-t'), /No errors detected/);
  const names = unzip(e.file, '-Z1').trim().split('\n').sort();
  const n = path.basename(r.a);
  assert.deepEqual(names, ['chorus.json', 'manifest.json', 'project.json', `chats/${n}/${r.ta.created.slice(0, 10)} A chat - ${r.ta.id}.md`, `files/${n}/${r.ta.id}/artifacts/a-plan.md`].sort());
  const project = JSON.parse(unzip(e.file, '-p', 'project.json'));
  assert.equal(project.folder, r.a);
  assert.deepEqual(project.working_folders.map((f: any) => [f.path, f.why]), [[r.extra, 'the shared code']]);
  assert.deepEqual(project.variables.map((v: any) => v.name), ['GITHUB_TOKEN']);
  const everything = unzip(e.file, '-p');
  assert.doesNotMatch(everything, new RegExp(VALUE), 'no variable value anywhere in the zip');
  assert.doesNotMatch(everything, /b-value|B_ONLY|bravo words|b-plan/, 'nothing of project B');
  assert.ok(!everything.includes(r.tb.id));
  assert.doesNotMatch(everything, /pro bytes/, 'never pro.db');
  // the same day again: its own name
  assert.equal(path.basename(exportProject({ home: r.home, version: '2.8.0', dir: out, project: r.a, now: new Date('2026-11-18T08:00:00Z') }).file), `chorus-${n}-2026-11-18 (2).zip`);
});

test('export one project: the paid module\'s files go under pro/, and a path that climbs out is dropped', () => {
  const r = rig();
  const out = tmp('chorus-expp-out-');
  const e = exportProject({ home: r.home, version: '2.8.0', dir: out, project: r.a, pro: [{ path: 'pro/tasks.json', data: '{"tasks":[1]}' }, { path: 'pro/tasks/1 Build it.md', data: '# Build it' }, { path: '../evil.txt', data: 'x' }] });
  const names = unzip(e.file, '-Z1').trim().split('\n');
  assert.ok(names.includes('pro/tasks.json') && names.includes('pro/tasks/1 Build it.md'));
  assert.ok(!names.some(x => x.includes('evil')));
  assert.equal(e.proFiles, 2);
  assert.equal(JSON.parse(unzip(e.file, '-p', 'manifest.json')).included.pro, true);
});
