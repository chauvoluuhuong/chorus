// Export (plan stage 11): the top bar's button saves everything to one .zip. Checked with the system's own unzip, so the file opens anywhere.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Controller } from '../../src/app/controller.ts';
import { exportAll } from '../../src/core/export.ts';
import { Store } from '../../src/core/store.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';

function rig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-exp-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cake-shop-')));
  const store = new Store(project, { home });
  const t = store.createThread({ title: 'CSV export of orders', agent: 'claude', cwd: project, model: 'opus' });
  store.recordSession(t.id, { turns: [{ seq: 1, role: 'user', text: 'Add CSV export' }, { seq: 2, role: 'assistant', text: 'Done: the button downloads what is filtered.' }], toolCalls: [{ id: 'c1', turnSeq: 2, tool: 'Edit', target: 'api/export.ts', status: 'ok' }], usage: { inputTokens: 10, outputTokens: 5 } } as any);
  fs.mkdirSync(store.artifactsDir(t.id), { recursive: true });
  fs.writeFileSync(path.join(store.artifactsDir(t.id), 'plan.md'), '# Plan\n');
  store.logApproval(t.id, 'Bash npm test', 'approved');
  fs.mkdirSync(path.join(home, 'skills', 'release-notes'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'release-notes', 'SKILL.md'), '---\nname: release-notes\n---\n');
  fs.writeFileSync(path.join(home, 'pro.db'), 'pro bytes');
  // what must never leave: licences, keys, the token
  fs.mkdirSync(path.join(home, 'pro'), { recursive: true });
  fs.writeFileSync(path.join(home, 'pro', 'install.json'), '{"secret":"install key"}');
  fs.writeFileSync(path.join(home, 'serve.json'), '{"mcpToken":"secret"}');
  return { home, project, store, t };
}
const unzip = (file: string, ...a: string[]) => execFileSync('unzip', [...a, file], { encoding: 'utf8' });

test('export: every chat, its messages, files, the skill library and Pro data, in a zip that opens anywhere; no secrets', () => {
  const r = rig();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-exp-out-'));
  const e = exportAll({ home: r.home, version: '2.0.0', dir: out, now: new Date('2026-11-08T07:00:00Z') });
  assert.equal(path.basename(e.file), 'chorus-export-2026-11-08.zip');
  assert.equal(e.chats, 1);
  assert.match(unzip(e.file, '-t'), /No errors detected/);
  const names = unzip(e.file, '-Z1').trim().split('\n').sort();
  const name = path.basename(r.project);
  assert.deepEqual(names, ['chorus.json', `chats/${name}/${r.t.created.slice(0, 10)} CSV export of orders - ${r.t.id}.md`, `files/${name}/${r.t.id}/artifacts/plan.md`, 'manifest.json', 'pro/pro.db', 'skills/release-notes/SKILL.md'].sort());
  const data = JSON.parse(execFileSync('unzip', ['-p', e.file, 'chorus.json'], { encoding: 'utf8' }));
  const c = data.chats[0];
  assert.deepEqual([c.title, c.agent, c.model, c.turns.length, c.toolCalls[0].tool, c.approvals[0].decision, c.artifacts[0]?.file ?? null], ['CSV export of orders', 'claude', 'opus', 2, 'Edit', 'approved', null]);
  assert.match(execFileSync('unzip', ['-p', e.file, `chats/${name}/${r.t.created.slice(0, 10)} CSV export of orders - ${r.t.id}.md`], { encoding: 'utf8' }), /## You[\s\S]*Add CSV export/);
  assert.equal(JSON.parse(execFileSync('unzip', ['-p', e.file, 'manifest.json'], { encoding: 'utf8' })).counts.chats, 1);
  const all = execFileSync('unzip', ['-p', e.file], { encoding: 'latin1' });
  assert.doesNotMatch(all, /install key|mcpToken/, 'licences, install keys and the token never leave');
  // a second export the same day gets its own name
  assert.equal(path.basename(exportAll({ home: r.home, version: '2.0.0', dir: out, now: new Date('2026-11-08T08:00:00Z') }).file), 'chorus-export-2026-11-08 (2).zip');
  r.store.close();
});

test('the top bar\'s Export: POST /api/export writes the zip; Show in Finder reveals it', async () => {
  const r = rig();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-exp-out-'));
  const shown: string[] = [];
  const c = new Controller({ project: r.project, store: r.store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (_a, o) => ({ bin: process.execPath, args: [], cwd: o.cwd }) });
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 't', agents: [], ms: 1 }), exportDir: out, onReveal: f => shown.push(f) });
  const url = await srv.start(0);
  const post = async (p: string) => (await fetch(url + p, { method: 'POST', headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1' } })).json();
  const res = await post('/api/export');
  assert.equal(res.chats, 1);
  assert.ok(fs.existsSync(res.file) && res.file.startsWith(out));
  assert.deepEqual(await post('/api/export/reveal'), { ok: true });
  assert.deepEqual(shown, [res.file]);
  srv.close();
  c.stop();
  r.store.close();
});
