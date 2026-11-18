// A project's working environment (task #11 step 6): projects.json with folders, variable names and why/by; project-env.json with
// the values, 0600; validation; the one-folder create; describeFolder and suggestFolders, read live.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { badName, ProjectSettings } from '../../src/core/projects.ts';

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function rig() {
  const root = tmp('chorus-prj-root-');
  const parent = tmp('chorus-prj-parent-');
  const project = path.join(parent, 'chorus');
  fs.mkdirSync(project);
  return { root, parent, project, s: new ProjectSettings(root) };
}

test('values go to project-env.json with mode 0600; projects.json keeps names only', () => {
  const { root, parent, project, s } = rig();
  fs.mkdirSync(path.join(parent, 'other'));
  s.setVariable(project, 'GITHUB_TOKEN', 'v-secret-123', { why: 'the release script pushes', by: 'claude 3 (claude)', by_thread: 't_1', approval: 'r_1' });
  const envFile = path.join(root, 'project-env.json');
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(envFile, 'utf8')), { [project]: { GITHUB_TOKEN: 'v-secret-123' } });
  const pj = fs.readFileSync(path.join(root, 'projects.json'), 'utf8');
  assert.ok(!pj.includes('v-secret-123'), 'no value in projects.json');
  const v = s.get(project).variables[0];
  assert.equal(v.name, 'GITHUB_TOKEN');
  assert.equal(v.why, 'the release script pushes');
  assert.equal(v.by, 'claude 3 (claude)');
  assert.equal(v.by_thread, 't_1');
  assert.equal(v.approval, 'r_1');
  assert.deepEqual(s.env(project), { GITHUB_TOKEN: 'v-secret-123' });
  assert.deepEqual(s.env(path.join(parent, 'other')), {}, 'another project gets nothing');
  // a file loosened by hand is set back to 0600 on the next write
  fs.chmodSync(envFile, 0o644);
  s.setVariable(project, 'B', 'x');
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  s.removeVariable(project, 'GITHUB_TOKEN');
  assert.deepEqual(s.env(project), { B: 'x' });
  assert.deepEqual(s.get(project).variables.map(x => x.name), ['B']);
});

test('variable names: letters, digits and _; reserved ones refused with one clear line', () => {
  const { project, s } = rig();
  for (const ok of ['GITHUB_TOKEN', '_X', 'a1']) assert.equal(badName(ok), undefined, ok);
  for (const bad of ['1A', 'A-B', '', 'A B', 'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TERM', 'PWD', 'TMPDIR', 'NODE_OPTIONS', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CHORUS_HOME', 'CLAUDE_CODE_X', 'CLAUDECODE', 'CLAUDE_PID', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD']) {
    assert.throws(() => s.setVariable(project, bad, 'v'), /not a variable name|reserved/, bad);
  }
  assert.equal(s.get(project).version, 0, 'nothing written');
});

test('folders: absolute, existing, a folder, not the project, not / or home; version goes up on every change; why/by kept', () => {
  const { parent, project, s } = rig();
  const core = path.join(parent, 'chorus-core');
  fs.mkdirSync(core);
  fs.writeFileSync(path.join(parent, 'file.txt'), 'x');
  assert.throws(() => s.addFolder(project, 'chorus-core'), /absolute/);
  assert.throws(() => s.addFolder(project, path.join(parent, 'nope')), /does not exist/);
  assert.throws(() => s.addFolder(project, path.join(parent, 'file.txt')), /not a folder/);
  assert.throws(() => s.addFolder(project, project), /project folder itself/);
  assert.throws(() => s.addFolder(project, '/'), /too wide/);
  assert.throws(() => s.addFolder(project, os.homedir()), /too wide/);
  const r1 = s.addFolder(project, core, { why: 'launch flags live there', by: 'claude 3 (claude)', by_thread: 't_9', approval: 'r_2' });
  assert.equal(r1.version, 1);
  assert.deepEqual({ ...r1.folders[0], at: '' }, { path: core, why: 'launch flags live there', by: 'claude 3 (claude)', by_thread: 't_9', at: '', approval: 'r_2' });
  assert.equal(s.setNote(project, 'Chorus app; chorus-core is its CLI layer').version, 2);
  assert.equal(s.get(project).note, 'Chorus app; chorus-core is its CLI layer');
  assert.equal(s.get(project).note_by, 'you');
  assert.throws(() => s.setNote(project, 'x'.repeat(2001)), /too long/);
  assert.deepEqual(s.addDirs(project), [core]);
  assert.equal(s.removeFolder(project, core).version, 3);
  assert.ok(fs.existsSync(core), 'the folder stays on disk');
  assert.throws(() => s.removeFolder(project, core), /not a working folder/);
});

test('create: makes exactly that one folder; refuses an existing one and a missing parent', () => {
  const { parent, project, s } = rig();
  const fresh = path.join(parent, 'chorus-notes');
  const r = s.addFolder(project, fresh, { create: true, why: 'notes for the release', by: 'claude 3 (claude)' });
  assert.ok(fs.statSync(fresh).isDirectory());
  assert.equal(r.folders[0].created, true);
  assert.deepEqual(fs.readdirSync(fresh), [], 'nothing inside it');
  fs.mkdirSync(path.join(parent, 'there'));
  assert.throws(() => s.addFolder(project, path.join(parent, 'there'), { create: true }), /already exists/);
  assert.throws(() => s.addFolder(project, path.join(parent, 'missing', 'deep'), { create: true }), /parent folder .* does not exist/);
  assert.ok(!fs.existsSync(path.join(parent, 'missing')), 'no parent made');
  s.removeFolder(project, fresh);
  assert.ok(fs.existsSync(fresh), 'never deleted on remove, also one Chorus made');
});

test('describeFolder: a git repo gives branch and remote; a plain folder gives none; read live', () => {
  const { parent, s } = rig();
  const repo = path.join(parent, 'repo');
  fs.mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'dev');
  git('remote', 'add', 'origin', 'https://example.com/x.git');
  assert.deepEqual(s.describeFolder(repo), { exists: true, is_dir: true, git: { branch: 'dev', remote_url: 'https://example.com/x.git' } });
  const plain = path.join(parent, 'plain');
  fs.mkdirSync(plain);
  assert.deepEqual(s.describeFolder(plain), { exists: true, is_dir: true, git: null });
  assert.deepEqual(s.describeFolder(path.join(parent, 'gone')), { exists: false, is_dir: false, git: null });
});

test('suggestFolders: a file: dependency, an AGENTS.md mention and a name-prefix sibling; never the project or one already added', () => {
  const { parent, project, s } = rig();
  for (const d of ['chorus-core', 'chorus-admin', 'chorus-workspace', 'video-poster', 'shared-lib', 'unrelated']) fs.mkdirSync(path.join(parent, d));
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ dependencies: { '@x/core': 'file:../chorus-core', left: '^1.0.0', gone: 'file:../not-there' } }));
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Clone beside it; the poster lives in `../video-poster`. The shared-lib repo has the types.\n');
  const t0 = Date.now();
  const got = s.suggestFolders(project);
  assert.ok(Date.now() - t0 < 1000, 'fast');
  const by = Object.fromEntries(got.map(g => [path.basename(g.path), g.why]));
  assert.equal(by['chorus-core'], 'package.json depends on file:../chorus-core (@x/core)');
  assert.equal(by['video-poster'], 'AGENTS.md mentions ../video-poster');
  assert.match(by['shared-lib'], /AGENTS.md names shared-lib/);
  assert.match(by['chorus-admin'], /named like it/);
  assert.match(by['chorus-workspace'], /named like it/);
  assert.equal(by.unrelated, undefined);
  assert.equal(by['not-there'], undefined, 'only existing folders');
  assert.ok(!got.some(g => g.path === project));
  s.addFolder(project, path.join(parent, 'chorus-core'));
  assert.ok(!s.suggestFolders(project).some(g => g.path === path.join(parent, 'chorus-core')), 'not one already added');
  assert.ok(got.length <= 10);
});

test('forget: the project\'s record and its values go; another project\'s stay; no folder is touched', () => {
  const { root, parent, project, s } = rig();
  const other = path.join(parent, 'other');
  const core = path.join(parent, 'chorus-core');
  fs.mkdirSync(other);
  fs.mkdirSync(core);
  s.addFolder(project, core);
  s.setVariable(project, 'A', '1');
  s.setVariable(other, 'B', '2');
  s.forget(project);
  assert.equal(s.get(project).version, 0);
  assert.deepEqual(s.env(project), {});
  assert.deepEqual(s.env(other), { B: '2' });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'project-env.json'), 'utf8'))), [other]);
  assert.ok(fs.existsSync(core) && fs.existsSync(project));
});

test('register: a project with no chat; the refusals; forget removes the registration', () => {
  const { root, parent, project, s } = rig();
  const fresh = path.join(parent, 'fresh');
  assert.match(s.checkNewProject('/') ?? '', /too wide/);
  assert.match(s.checkNewProject(os.homedir()) ?? '', /too wide/);
  assert.match(s.checkNewProject(path.join(os.homedir(), '.chorus', 'computer')) ?? '', /Chorus's own folders/);
  assert.match(s.checkNewProject(path.join(root, 'x'), { create: true }) ?? '', /Chorus's own folders/);
  assert.match(s.checkNewProject(project, { hasChat: true }) ?? '', /already a project/);
  assert.match(s.checkNewProject(fresh) ?? '', /does not exist/);
  assert.match(s.checkNewProject(path.join(fresh, 'a'), { create: true }) ?? '', /parent folder/);
  assert.equal(s.checkNewProject(project), undefined, 'an existing folder with no settings and no chat');
  const r = s.register(fresh, { create: true, by: 'claude 3 (claude)', by_thread: 't_1', approval: 'r_1' });
  assert.ok(fs.statSync(fresh).isDirectory());
  assert.equal(r.registered, true);
  assert.equal(r.registered_by_thread, 't_1');
  assert.ok(r.registered_at);
  assert.deepEqual(s.registered(), [fresh]);
  assert.ok(s.list().includes(fresh));
  assert.match(s.checkNewProject(fresh) ?? '', /already a project: to change it, call propose_project_change/);
  assert.throws(() => s.register(fresh), /already a project/);
  // a folder with settings is a project too
  s.setNote(project, 'x');
  assert.match(s.checkNewProject(project) ?? '', /already a project/);
  s.forget(fresh);
  assert.deepEqual(s.registered(), []);
  assert.ok(fs.existsSync(fresh), 'the folder stays');
});
