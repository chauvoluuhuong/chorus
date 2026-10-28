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
