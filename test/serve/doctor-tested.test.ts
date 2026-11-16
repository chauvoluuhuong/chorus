import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('a new list from the backend is kept; the short check keeps nothing on disk', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.CHORUS_DOCTOR_HOME = home;
  const doctor = await import('../../src/core/doctor.ts');
  doctor.saveRemoteTested({ codex: ['0.164.0'] });
  assert.deepEqual(doctor.remoteTested(), { codex: ['0.164.0'] });
  // one check for every screen lives in the desktop server; there is no second, saved one to read
  assert.equal('lastCheck' in doctor, false);
  assert.equal(fs.existsSync(path.join(doctor.DOCTOR_DIR(), 'fast.json')), false);
});

/* ---------- Off (plan 2026-11-14, Stage 1): a failed critical check turns that version off; no real CLI runs here ---------- */

import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import { CRITICAL, SCENARIOS, type AgentCheck, type DeepReport, type FastReport } from '@chauvoluuhuong/chorus-core/doctor';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** A detailed test of `version` in which `fail` failed (a critical one also in `critical`, as the core reports it). */
function report(agent: 'codex', version: string, fail?: string): DeepReport {
  const results = SCENARIOS.map(([id, title]) => ({ id, title, status: id === fail ? ('fail' as const) : ('pass' as const), reason: id === fail ? `forced ${id}` : undefined, ms: 10, evidence: '' }));
  const critical = fail && CRITICAL.has(fail) ? [{ id: fail, title: SCENARIOS.find(s => s[0] === fail)![1], reason: `forced ${fail}` }] : undefined;
  return { agent, version, results, ok: !fail, ms: 80, ...(critical ? { critical } : {}) };
}

test('off marks: a failed critical check of a version is kept; a non-critical failure or a skipped one is not; a later pass clears it', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.CHORUS_DOCTOR_HOME = home;
  const doctor = await import('../../src/core/doctor.ts');
  for (const id of ['envelope', 'mcp', 'turn-end']) {
    doctor.recordDeep(report('codex', '0.170.0', id));
    assert.deepEqual(doctor.offMarks(), [{ agent: 'codex', version: '0.170.0', reason: `forced ${id}`, scenario: id }], id);
  }
  assert.ok(fs.existsSync(path.join(doctor.DOCTOR_DIR(), 'off.json')), 'beside last.json');
  doctor.recordDeep(report('codex', '0.170.0', 'transcript'));
  assert.deepEqual(doctor.offMarks(), [], 'a pass of every critical check clears it, even with another check failing');
  doctor.recordDeep(report('codex', '0.170.0', 'mcp'));
  // a run of only some scenarios, or one where a critical one was skipped, does not clear it
  doctor.recordDeep({ ...report('codex', '0.170.0'), results: report('codex', '0.170.0').results.filter(r => r.id === 'hello') }, ['hello']);
  const skipped = report('codex', '0.170.0');
  skipped.results.find(r => r.id === 'turn-end')!.status = 'skip';
  doctor.recordDeep(skipped);
  assert.equal(doctor.offMarks().length, 1);
  // another version's test leaves this one's mark
  doctor.recordDeep(report('codex', '0.163.0'));
  assert.equal(doctor.offMarks().length, 1);
  doctor.recordDeep(report('codex', '0.170.0'));
  assert.deepEqual(doctor.offMarks(), []);
});

test('off: a forced failure of each critical check keeps the agent out of New chat, Hand off and sub threads; the verified version or a passing test turns it on', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.CHORUS_DOCTOR_HOME = home;
  process.env.CHORUS_SKILLS_HOME = home;
  const doctor = await import('../../src/core/doctor.ts');
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-off-')));
  const store = new Store(project, { home });
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: (_a, o) => ({ bin: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: o.cwd }) });
  // the short check as fastCheck does it: an agent whose installed version has an off mark is `off`
  let codexVersion = '0.170.0';
  const agent = (a: AgentCheck['agent'], version: string, state: AgentCheck['state']): AgentCheck => ({ agent: a, name: { claude: 'Claude Code', codex: 'Codex', agy: 'Antigravity CLI' }[a], state, version, login: 'yes', page: '', loginCommand: [], newestTested: a === 'codex' ? '0.163.0' : version, testedInstall: a === 'codex' ? 'npm install -g @openai/codex@0.163.0' : undefined, ms: 1 });
  const check = async (): Promise<FastReport> => ({
    node: { version: '22', ok: true }, platform: 't', ms: 1,
    agents: [agent('claude', '2.1.309', 'ready'), agent('codex', codexVersion, codexVersion === '0.163.0' ? 'ready' : 'untested'), agent('agy', '1.4.5', 'ready')].map(a => {
      const m = doctor.offMarks().find(x => x.agent === a.agent && x.version === a.version);
      return m ? { ...a, state: 'off' as const, off: { reason: m.reason, scenario: m.scenario, version: m.version } } : a;
    }),
  });
  let fail: string | undefined;
  const srv = new ChorusServer({ controller: c, token: 'a'.repeat(48), check, deep: async () => ({ dir: home, report: report('codex', codexVersion, fail) }) });
  const url = await srv.start(0);
  const api = async (method: string, p: string, body?: object) => (await fetch(url + p, { method, headers: { authorization: `Bearer ${srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<any>;
  const deep = async () => {
    const job = await api('POST', '/api/doctor/run', { agent: 'codex', action: 'deep' });
    for (let i = 0; i < 100 && !(await api('GET', `/api/doctor/${job.id}`)).done; i++) await sleep(30);
  };
  const codex = () => srv.state().doctor?.agents?.find((a: AgentCheck) => a.agent === 'codex');
  try {
    await srv.checkAgents();
    const main = c.newThread({ agent: 'claude', cwd: project }).id;
    for (const id of ['envelope', 'mcp', 'turn-end']) {
      fail = id;
      await deep();
      assert.equal(codex()?.state, 'off', id);
      assert.deepEqual(codex()?.off, { reason: `forced ${id}`, scenario: id, version: '0.170.0' });
      const refused = await api('POST', '/api/chats', { agent: 'codex', folder: project });
      assert.equal(refused.id, undefined, `${id}: no chat starts`);
      assert.match(refused.error, new RegExp(`Codex 0\\.170\\.0 can't be used with Chorus: forced ${id}\\. See Doctor\\.`));
      assert.match((await api('POST', `/api/chats/${main}/handoff`, { to: 'codex' })).error, /can't be used/, 'no hand off to it');
      assert.match(((await srv.subs.call('start_subthread', { title: 'x', brief: 'y', agent: 'codex' }, main)) as any).error, /codex is not usable now/, 'no sub thread or task step on it');
      // a later detailed test of that version that passes turns it on again
      fail = undefined;
      await deep();
      assert.equal(codex()?.state, 'untested', `${id}: on again, as an untested version is`);
    }
    // a non-critical failure looks and behaves as today: still usable
    fail = 'transcript';
    await deep();
    assert.equal(codex()?.state, 'untested');
    assert.ok((await api('POST', '/api/chats', { agent: 'codex', folder: project })).id, 'a chat starts');
    // installing the verified version turns an off agent on
    fail = 'mcp';
    await deep();
    assert.equal(codex()?.state, 'off');
    codexVersion = '0.163.0';
    await srv.checkAgents();
    assert.equal(codex()?.state, 'ready');
    assert.ok((await api('POST', '/api/chats', { agent: 'codex', folder: project })).id);
  } finally {
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await sleep(200);
    store.close();
  }
});
