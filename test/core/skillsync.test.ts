import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { addSource, allSkills, knownSkills, readKnownSkill, removeSource, syncSkill, unsyncSkill } from '../../src/core/skillsync.ts';
import { Store } from '../../src/core/store.ts';

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
function skill(dir: string, name: string, description = `About ${name}`) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nDo ${name}.\n`);
  return dir;
}

/** A temp home with skills in the CLIs' folders, a project, and a store; never the real home. */
function rig() {
  const home = tmp('chorus-skhome-');
  const project = tmp('chorus-skproj-');
  const store = new Store(project, { home: tmp('chorus-skstore-') });
  skill(path.join(home, '.claude/skills/video-research'), 'video-research');
  skill(path.join(home, '.claude/skills/make-video'), 'make-video');
  skill(path.join(home, '.codex/skills/demo-zoom'), 'demo-zoom');
  skill(path.join(home, '.agents/skills/shared-one'), 'shared-one');
  skill(path.join(home, '.gemini/config/skills/schema'), 'schema');
  fs.mkdirSync(path.join(home, '.codex/skills/.system/builtin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex/skills/.system/builtin/SKILL.md'), '---\nname: builtin\n---\n');
  return { home, project, store, done: () => store.close() };
}
const row = (r: ReturnType<typeof allSkills>, name: string) => r.skills.find(s => s.name === name)!;

test('skillsync: the CLIs\' home folders are read; each skill has a state per CLI; hidden folders are left out', () => {
  const r = rig();
  try {
    const all = allSkills(r.store, r.project, r.home);
    assert.deepEqual(all.skills.map(s => s.name), ['demo-zoom', 'make-video', 'schema', 'shared-one', 'video-research']);
    assert.deepEqual(row(all, 'video-research').state, { claude: 'own', codex: '', agy: '' });
    assert.deepEqual(row(all, 'shared-one').state, { claude: '', codex: 'own', agy: '' }, '~/.agents/skills counts as Codex having it');
    assert.deepEqual(row(all, 'schema').state, { claude: '', codex: '', agy: 'own' });
    assert.equal(row(all, 'video-research').where, '~/.claude/skills');
    assert.deepEqual(all.sources.filter(s => s.fixed && s.cli).map(s => [s.show, s.count, s.reachable]), [
      ['~/.claude/skills', 2, true],
      ['~/.codex/skills', 1, true],
      ['~/.gemini/config/skills', 1, true],
      ['~/.agents/skills', 1, true],
    ]);
    assert.equal(r.store.storedSkills().length, 5, 'stored');
  } finally {
    r.done();
  }
});

test('skillsync: a sync is one recorded link; a second tick removes only that link; a store reopened still knows it', () => {
  const r = rig();
  try {
    const dir = row(allSkills(r.store, r.project, r.home), 'video-research').dir;
    const res = syncSkill(r.store, dir, 'codex', r.home);
    assert.ok(res.ok);
    const link = path.join(r.home, '.codex/skills/video-research');
    assert.equal(res.path, link);
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.realpathSync(link), dir);
    // the agy folder is made when it is missing
    fs.rmSync(path.join(r.home, '.gemini'), { recursive: true });
    assert.ok(syncSkill(r.store, dir, 'agy', r.home).ok);
    assert.ok(fs.lstatSync(path.join(r.home, '.gemini/config/skills/video-research')).isSymbolicLink());
    const after = allSkills(r.store, r.project, r.home);
    assert.deepEqual(row(after, 'video-research').state, { claude: 'own', codex: 'sync', agy: 'sync' });
    assert.equal(after.skills.filter(s => s.name === 'video-research').length, 1, 'the link is the same skill, not a second one');
    // a restart: the store on disk still knows the links
    const again = new Store(r.project, { home: r.store.root });
    assert.equal(again.skillLinks().length, 2);
    again.close();
    assert.ok(unsyncSkill(r.store, dir, 'codex').ok);
    assert.equal(fs.existsSync(link), false);
    assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')), 'the skill itself stays');
    assert.equal(row(allSkills(r.store, r.project, r.home), 'video-research').state.codex, '');
  } finally {
    r.done();
  }
});

test('skillsync: never replaces or removes what Chorus did not make', () => {
  const r = rig();
  try {
    const dir = row(allSkills(r.store, r.project, r.home), 'make-video').dir;
    // the user's own copy of the same name in Codex's folder: "there", and a sync is refused
    skill(path.join(r.home, '.codex/skills/make-video'), 'make-video');
    assert.equal(row(allSkills(r.store, r.project, r.home), 'make-video').state.codex, 'there');
    const no = syncSkill(r.store, dir, 'codex', r.home);
    assert.equal(no.ok, false);
    // a sync into the folder the skill lives in is refused too
    assert.equal(syncSkill(r.store, dir, 'claude', r.home).ok, false);
    // unsync of a link Chorus never made does nothing
    assert.equal(unsyncSkill(r.store, dir, 'codex').ok, false);
    assert.ok(fs.existsSync(path.join(r.home, '.codex/skills/make-video/SKILL.md')));
    // a link Chorus made that the user replaced with a folder is left alone and forgotten
    const vr = row(allSkills(r.store, r.project, r.home), 'video-research').dir;
    assert.ok(syncSkill(r.store, vr, 'agy', r.home).ok);
    const at = path.join(r.home, '.gemini/config/skills/video-research');
    fs.unlinkSync(at);
    skill(at, 'video-research');
    assert.equal(unsyncSkill(r.store, vr, 'agy').ok, false);
    assert.ok(fs.existsSync(path.join(at, 'SKILL.md')));
    assert.equal(r.store.skillLinks().length, 0);
  } finally {
    r.done();
  }
});

test('skillsync: an added folder shows its skills, an added single skill shows itself; removing one unsyncs its links and deletes nothing', () => {
  const r = rig();
  try {
    const team = tmp('chorus-team-');
    skill(path.join(team, 'release-notes'), 'release-notes');
    skill(path.join(team, 'pr-review'), 'pr-review');
    const one = skill(path.join(tmp('chorus-dl-'), 'pdf-tools'), 'pdf-tools');
    assert.deepEqual(addSource(r.store, team, r.project, r.home), { ok: true, kind: 'folder' });
    assert.deepEqual(addSource(r.store, one, r.project, r.home), { ok: true, kind: 'skill' });
    assert.equal(addSource(r.store, path.join(r.home, '.claude/skills'), r.project, r.home).ok, false, 'a home folder is always read');
    const all = allSkills(r.store, r.project, r.home);
    for (const n of ['release-notes', 'pr-review', 'pdf-tools']) assert.ok(row(all, n), n);
    assert.equal(row(all, 'pdf-tools').where, path.dirname(one));
    const added = all.sources.filter(s => !s.fixed);
    assert.deepEqual(added.map(s => [s.kind, s.count, s.reachable]), [['folder', 2, true], ['skill', 1, true]]);
    assert.equal(added[1].skill, 'pdf-tools');
    // sync one of the team's, then remove the team folder
    assert.ok(syncSkill(r.store, row(all, 'pr-review').dir, 'claude', r.home).ok);
    assert.deepEqual(removeSource(r.store, team), { ok: true, unsynced: 1 });
    assert.equal(fs.existsSync(path.join(r.home, '.claude/skills/pr-review')), false);
    assert.ok(fs.existsSync(path.join(team, 'pr-review/SKILL.md')), 'no file is deleted');
    assert.equal(row(allSkills(r.store, r.project, r.home), 'pr-review'), undefined);
    // a source that went away is reported as not reachable, and kept
    fs.rmSync(path.dirname(one), { recursive: true });
    const gone = allSkills(r.store, r.project, r.home).sources.find(s => s.path === one)!;
    assert.deepEqual([gone.reachable, gone.count], [false, 0]);
  } finally {
    r.done();
  }
});

test('skillsync: the project library is one more source; the MCP tools see every stored skill', () => {
  const r = rig();
  try {
    skill(path.join(r.project, '.chorus/skills/cake-pricing'), 'cake-pricing');
    const all = allSkills(r.store, r.project, r.home);
    assert.equal(row(all, 'cake-pricing').library, true);
    assert.equal(row(all, 'make-video').library, false);
    assert.ok(knownSkills(r.store, r.project).some(s => s.name === 'video-research'));
    assert.match(readKnownSkill(r.store, r.project, 'demo-zoom') ?? '', /Do demo-zoom/);
    assert.match(readKnownSkill(r.store, r.project, 'cake-pricing') ?? '', /Do cake-pricing/);
  } finally {
    r.done();
  }
});
