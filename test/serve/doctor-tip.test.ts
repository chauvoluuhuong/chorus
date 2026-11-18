// The first-launch "Meet Doctor" popover (task #13, @workspace/mockups/doctor-tip.html): once, on a first launch only, after the
// Welcome and after the Doctor popup when that opened.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a page module, plain JavaScript
import { showDoctorTip } from '../../src/desktop/doctor-popup.js';

const ready = { first: true, seen: false, welcomePending: false, doctorPopupOpen: false };

test('a first launch with the Welcome done and no Doctor popup: the tip shows', () => {
  assert.equal(showDoctorTip(ready), true);
});
test('not a first launch (an existing user who updated, or a later launch): hidden', () => {
  assert.equal(showDoctorTip({ ...ready, first: false }), false);
  assert.equal(showDoctorTip({ ...ready, first: undefined }), false);
});
test('seen already (Got it, or a click on Doctor): hidden', () => {
  assert.equal(showDoctorTip({ ...ready, seen: true }), false);
});
test('the Welcome is still in front: hidden', () => {
  assert.equal(showDoctorTip({ ...ready, welcomePending: true }), false);
});
test('the Doctor popup is open: hidden until it closes', () => {
  assert.equal(showDoctorTip({ ...ready, doctorPopupOpen: true }), false);
});
