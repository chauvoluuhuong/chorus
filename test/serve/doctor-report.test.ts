import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('a report can be built without a test run, and is sent as a typed user report', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.CHORUS_DOCTOR_HOME = home;
  const { composeIssue, isIssueKind, reportDetails, USER_LABELS } = await import('../../src/core/doctor.ts');
  const r = await reportDetails({
    chats: [{ agent: 'claude', state: 'ended', cli_version: '2.1.306' }, { agent: 'codex', state: 'working', cli_version: '0.163.0' }],
    projects: 2,
    client: { window: 'native', size: '1280×800' },
    errors: [`page: GET /api/x failed for ${os.homedir()}/secret me@example.com`],
  });
  assert.equal(r.kind, 'bug');
  for (const part of ['### This machine and app', '- OS: ', '- Chats: 2 (claude 1, codex 1', '- Projects: 2', 'window native', 'Recent errors', '| CLI | State |']) assert.ok(r.details.includes(part), part);
  assert.ok(!r.details.includes(os.homedir()) && !r.details.includes('me@example.com'), 'redacted');

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
