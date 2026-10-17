// L2: skills sync against a temp project (no CLI).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { listSkills, MARKER, parseFrontmatter, readSkill, syncSkills } from '../../src/core/skills.ts';

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-skills-'));
  fs.mkdirSync(path.join(dir, '.git', 'info'), { recursive: true });
  return dir;
}
function addSkill(dir: string, name: string, desc = `Use for ${name}.`) {
  const d = path.join(dir, '.chorus', 'skills', name);
  fs.mkdirSync(path.join(d, 'references'), { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: >-\n  ${desc}\n  Second line.\n---\nBody of ${name}\n`);
  fs.writeFileSync(path.join(d, 'references', 'extra.md'), 'extra');
}

test('frontmatter: plain and folded values', () => {
  assert.deepEqual(parseFrontmatter('---\nname: a\ndescription: >-\n  one\n  two\n---\nx'), { name: 'a', description: 'one two' });
  assert.deepEqual(parseFrontmatter('no frontmatter'), {});
});

test('sync links claude and shared agents folders, with extra files reachable', () => {
  const p = project();
  addSkill(p, 'alpha');
  const r = syncSkills(p);
  assert.deepEqual(r.linked.sort(), ['.agents/skills/alpha', '.claude/skills/alpha']);
  for (const d of ['.claude/skills', '.agents/skills']) {
    assert.ok(fs.lstatSync(path.join(p, d, 'alpha')).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(p, d, 'alpha', 'references', 'extra.md'), 'utf8'), 'extra');
  }
  assert.match(fs.readFileSync(path.join(p, '.git/info/exclude'), 'utf8'), /\/\.agents\/skills\/alpha/);
});

test('sync never overwrites a user-owned skill with the same name', () => {
  const p = project();
  addSkill(p, 'alpha');
  fs.mkdirSync(path.join(p, '.claude/skills/alpha'), { recursive: true });
  fs.writeFileSync(path.join(p, '.claude/skills/alpha/SKILL.md'), 'mine');
  const r = syncSkills(p);
  assert.deepEqual(r.conflicts, ['.claude/skills/alpha']);
  assert.equal(fs.readFileSync(path.join(p, '.claude/skills/alpha/SKILL.md'), 'utf8'), 'mine');
  assert.ok(fs.lstatSync(path.join(p, '.agents/skills/alpha')).isSymbolicLink());
});

test('removing a source skill removes only managed entries', () => {
  const p = project();
  addSkill(p, 'alpha');
  addSkill(p, 'beta');
  syncSkills(p);
  fs.mkdirSync(path.join(p, '.agents/skills/theirs'), { recursive: true });
  fs.rmSync(path.join(p, '.chorus/skills/beta'), { recursive: true });
  const r = syncSkills(p);
  assert.deepEqual(r.removed.sort(), ['.agents/skills/beta', '.claude/skills/beta']);
  assert.ok(fs.existsSync(path.join(p, '.agents/skills/theirs')));
  assert.ok(fs.existsSync(path.join(p, '.agents/skills/alpha')));
});

test('copy mode writes a marker and a second sync updates in place', () => {
  const p = project();
  addSkill(p, 'alpha');
  syncSkills(p, { mode: 'copy' });
  assert.ok(fs.existsSync(path.join(p, '.agents/skills/alpha', MARKER)));
  fs.appendFileSync(path.join(p, '.chorus/skills/alpha/SKILL.md'), 'more\n');
  const r = syncSkills(p, { mode: 'copy' });
  assert.equal(r.updated.length, 2);
  assert.match(fs.readFileSync(path.join(p, '.agents/skills/alpha/SKILL.md'), 'utf8'), /more/);
});

test('list and read skills', () => {
  const p = project();
  addSkill(p, 'alpha', 'Do alpha.');
  assert.equal(listSkills(p)[0].description, 'Do alpha. Second line.');
  assert.match(readSkill(p, 'alpha')!.body, /Body of alpha/);
  assert.equal(readSkill(p, 'nope'), undefined);
});
