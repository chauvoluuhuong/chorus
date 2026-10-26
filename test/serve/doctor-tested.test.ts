import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('a new list from the backend is kept and makes the next doctor look run the short check again', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-doctor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.CHORUS_DOCTOR_HOME = home;
  const { DOCTOR_DIR, remoteTested, saveRemoteTested } = await import('../../src/core/doctor.ts');
  fs.mkdirSync(DOCTOR_DIR(), { recursive: true });
  fs.writeFileSync(path.join(DOCTOR_DIR(), 'fast.json'), '{}');
  saveRemoteTested({ codex: ['0.164.0'] });
  assert.deepEqual(remoteTested(), { codex: ['0.164.0'] });
  assert.equal(fs.existsSync(path.join(DOCTOR_DIR(), 'fast.json')), false);
  fs.writeFileSync(path.join(DOCTOR_DIR(), 'fast.json'), '{}');
  saveRemoteTested({ codex: ['0.164.0'] }); // the same list again: the last check stays
  assert.equal(fs.existsSync(path.join(DOCTOR_DIR(), 'fast.json')), true);
});
