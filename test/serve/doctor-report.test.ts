import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('a report can be built without a test run; the terminal\'s GitHub issue keeps its kind', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.CHORUS_DOCTOR_HOME = home;
  const { composeIssue, isIssueKind, reportDetails, USER_LABELS } = await import('../../src/core/doctor.ts');
  const r = await reportDetails({
    chats: [{ agent: 'claude', state: 'ended', cli_version: '2.1.306' }, { agent: 'codex', state: 'working', cli_version: '0.163.0' }],
    projects: 2,
    client: { window: 'native', size: '1280×800', language: 'en-US', view: 'doctor' },
    errors: [`page: GET /api/x failed for ${os.homedir()}/secret me@example.com`],
  });
  assert.equal(r.kind, 'bug');
  for (const part of ['### Chorus', '- App: Chorus ', 'chorus-core ', '- Window: native app, 1280×800', '### This machine', '- Node ', '### AI CLIs (short check, just now)', '| CLI | Installed | State | Newest tested | Newest release | Install | Login |', '- Binaries: ', '### Detailed tests on file', '### Use', '- Chats: 2 (claude 1, codex 1', '- Projects: 2', '### Recent errors (last 30 lines)']) assert.ok(r.details.includes(part), part);
  assert.ok(!r.details.includes(os.homedir()) && !r.details.includes('me@example.com'), 'redacted');
  // nothing that names the machine or the person
  assert.ok(!r.details.includes(os.hostname()), 'no host name');
  assert.ok(!new RegExp(`\\b${os.userInfo().username}\\b`).test(r.details), 'no user name');
  // the short setup for the admin list and the chips: the same facts
  // (chorus-admin docs/client-contract.md: these keys, short strings, clis a list with ready / login / update / missing)
  for (const k of Object.keys(r.setup)) assert.ok(['channel', 'install', 'core', 'paid', 'os', 'kernel', 'arch', 'cpu', 'ram', 'node', 'shell', 'clis'].includes(k), k);
  assert.ok(['preview', 'production', 'dev'].includes(r.setup.channel));
  assert.deepEqual(r.setup.clis.map(c => c.id).sort(), ['agy', 'claude', 'codex']);
  assert.ok(r.setup.clis.every(c => ['ready', 'login', 'update', 'missing'].includes(c.state)));
  assert.ok(Object.values(r.setup).every(x => typeof x !== 'string' || x.length <= 200));
  assert.ok(r.chips[0].startsWith('Chorus ') && r.chips[1] === `core ${r.setup.core}` && r.chips.length === 7, r.chips.join(' | '));

  const it = composeIssue({ kind: 'feature', summary: '  dark   mode ', what: 'Please add it', details: r.details });
  assert.equal(it.title, '[Feature request] dark mode');
  assert.ok(it.body.startsWith('<!-- chorus-report kind=feature -->'));
  assert.ok(it.body.includes('### What happened\n\nPlease add it'));
  assert.deepEqual(it.labels, ['enhancement', ...USER_LABELS]);
  assert.ok(USER_LABELS.includes('priority: low'));
  assert.equal(composeIssue({ kind: 'bug', summary: '', what: '', details: '' }).title, '[Bug] report from the app');
  assert.equal(isIssueKind('cli'), true);
  assert.equal(isIssueKind('toString'), false);
});

test('how Chorus was installed and its channel', async () => {
  const { channelOf, installMethod } = await import('../../src/core/doctor.ts');
  assert.equal(installMethod('/Users/x/.chorus/versions/2.4.0/app/src/core/doctor.ts'), 'curl installer');
  assert.equal(installMethod('/usr/local/lib/node_modules/@chauvoluuhuong/chorus/src/core/doctor.ts'), 'npm global');
  assert.equal(installMethod('/Users/x/chorus/src/core/doctor.ts'), 'from a checkout');
  assert.equal(channelOf('2.4.1-preview.3', 'curl installer'), 'preview');
  assert.equal(channelOf('2.4.1', 'curl installer'), 'production');
  assert.equal(channelOf('2.4.1', 'from a checkout'), 'dev');
});
