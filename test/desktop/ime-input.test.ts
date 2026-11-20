// Vietnamese typing in the chat terminal (fix/vietnamese-input): the DOM events recorded on xterm's helper textarea in Chorus.app
// (test/fixtures/ime/, real keystrokes on macOS) are replayed through the page's input state with a model of what xterm.js 6 sends
// itself; the CLI's line (DEL removes one character) must be exactly the sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error: a page module, plain JavaScript
import { DEL, editBytes, graphemes, keyEffect, makeImeInput, multiCharKey, plainSpaces } from '../../src/desktop/ime-input.js';

const TARGET = 'Tiếng Việt có dấu: người, được, khoẻ, Đà Nẵng';
const dir = path.join(import.meta.dirname, '..', 'fixtures', 'ime');

type Ev = { type: string; key?: string; keyCode?: number; isComposing?: boolean; shift?: boolean; data?: string | null; inputType?: string; valueTail?: string };
type Ime = ReturnType<typeof makeImeInput>;

/** The CLI's input line: DEL takes off one character. */
function apply(line: string[], bytes: string) {
  for (const ch of graphemes(bytes)) {
    if (ch === DEL) line.pop();
    else line.push(ch);
  }
}

/** Replays one fixture: the page's handlers first, then what xterm.js 6 would send for the event the page let through.
 *  `make` stands in for the page's input state (a stub with no takeover shows what xterm alone sends). */
function replay(events: Ev[], make: (o: { box: { value: string }; send: (d: string) => void }) => Ime = makeImeInput) {
  const line: string[] = [];
  const box = { value: '' };
  const out = (d: string) => apply(line, d);
  const ime = make({ box, send: out });
  let compStart = 0; // xterm's CompositionHelper: where the composition began in its textarea (0 until a compositionstart)
  const xtermSends = (d: string) => {
    ime.data();
    out(d);
  };
  let keyDownSeen = false, keyDownSent = false, keyPressHandled = false;
  for (const ev of events) {
    const e = { ...ev, shiftKey: !!ev.shift, ctrlKey: false, altKey: false, metaKey: false, isComposing: !!ev.isComposing };
    if (ev.type === 'keydown') {
      keyDownSeen = true;
      keyDownSent = false;
      if (!ime.key(e) || ev.keyCode === 229) continue; // 229: xterm's CompositionHelper, which sends nothing here
      const k = ev.key ?? '';
      if (k === 'Backspace') (xtermSends(DEL), (keyDownSent = true));
      else if (k === 'Enter') (xtermSends('\r'), (keyDownSent = true));
      else if (Array.from(k).length === 1 && !/^[A-Z]$/.test(k)) (xtermSends(k), (keyDownSent = true)); // A-Z wait for keypress
    } else if (ev.type === 'keypress') {
      keyPressHandled = false;
      if (keyDownSent || !ime.key(e)) continue;
      const k = ev.key ?? '';
      xtermSends(Array.from(k)[0]); // xterm sends String.fromCharCode(charCode): one character
      keyPressHandled = true;
    } else if (ev.type === 'keyup') {
      keyDownSeen = false;
      keyPressHandled = false;
      ime.key(e);
    } else if (ev.type === 'beforeinput') {
      ime.beforeinput(e);
    } else if (ev.type === 'compositionstart') {
      compStart = box.value.length;
      ime.composition(true);
    } else if (ev.type === 'compositionend') {
      if (ev.valueTail !== undefined) box.value = ev.valueTail;
      if (ime.compositionEnd?.(e)) continue;
      xtermSends(box.value.slice(compStart)); // CompositionHelper sends the textarea from where the composition began
      ime.composition(false);
    } else if (ev.type === 'input') {
      if (ev.valueTail !== undefined) box.value = ev.valueTail; // the whole textarea here (under 80 characters)
      if (ime.input(e)) continue;
      // xterm's own _inputEvent: insertText only, when no keydown is in progress and the keypress did not send it
      if (ev.data && ev.inputType === 'insertText' && !keyDownSeen && !keyPressHandled) xtermSends(ev.data);
    }
  }
  return line.join('');
}

for (const method of ['telex', 'vni', 'okey0', 'okey30']) {
  for (const agent of ['claude', 'codex', 'agy']) {
    test(`${method} into a ${agent} chat: the exact sentence, once`, () => {
      const f = JSON.parse(fs.readFileSync(path.join(dir, `${method}-chat-${agent}.json`), 'utf8'));
      assert.equal(f.target, TARGET);
      assert.notEqual(f.arrived, TARGET); // what Chorus sent before the fix
      assert.equal(replay(f.events), TARGET);
    });
  }
}

// Linux: IBus (ibus-bamboo Telex and VNI) in WebKitGTK, recorded in the Chorus window in Docker (test/smoke/linux-ime/). No
// compositionstart: each word comes as keydown 229 + insertFromComposition + compositionend, and WebKit keeps a trailing space as
// U+00A0. The final Enter commits "Nẵng" and IBus forwards the Enter, which the chat sends.
for (const method of ['telex', 'vni']) {
  test(`linux ibus-bamboo ${method} into a chat: each word once, no extra spaces`, () => {
    const f = JSON.parse(fs.readFileSync(path.join(dir, `linux-${method}-chat.json`), 'utf8'));
    assert.equal(f.target, TARGET);
    assert.ok(!f.events.some((e: Ev) => e.type === 'compositionstart'), 'IBus in WebKitGTK fires no compositionstart');
    assert.ok(f.events.some((e: Ev) => e.valueTail?.includes('\u00a0')), 'WebKit keeps a trailing space as a no-break space');
    const sent: string[] = []; // what the page itself sent: one write per committed word, no DEL, no U+00A0
    assert.equal(replay(f.events, o => makeImeInput({ box: o.box, send: (d: string) => (sent.push(d), o.send(d)) })), TARGET + '\r');
    assert.deepEqual(sent, ['Tiếng ', 'Việt ', 'có ', 'dấu:', 'người,', 'được,', 'khoẻ,', 'Đà ', 'Nẵng']);
    // xterm alone (the page sends nothing itself) resends the whole textarea at every commit: what Chorus did before
    const xtermOnly = replay(f.events, () => ({ key: () => true, beforeinput() {}, input: () => false, data() {}, composition() {}, reset() {} }) as unknown as Ime);
    assert.equal(xtermOnly.replace('\r', ''), f.arrived);
    assert.notEqual(f.arrived, TARGET);
  });
}

test('a commit with no compositionstart is sent once, compared with no-break spaces as spaces', () => {
  const sent: string[] = [];
  const box = { value: 'Tiếng\u00a0' };
  const ime = makeImeInput({ box, send: (d: string) => sent.push(d) });
  ime.key({ type: 'keydown', key: 'Unidentified', keyCode: 229 });
  ime.beforeinput({ inputType: 'insertFromComposition', data: 'Việt ', isComposing: true });
  box.value = 'Tiếng Việt\u00a0';
  assert.equal(ime.input({ inputType: 'insertFromComposition', data: 'Việt ', isComposing: true }), true);
  assert.equal(ime.compositionEnd({ data: 'Việt ' }), true); // xterm must not see it
  assert.deepEqual(sent, ['Việt ']);
  // a commit whose input event never came is sent from its compositionend
  assert.equal(ime.compositionEnd({ data: 'có ' }), true);
  assert.deepEqual(sent, ['Việt ', 'có ']);
  // a real composition (compositionstart came) stays with xterm
  ime.composition(true);
  assert.equal(ime.compositionEnd({ data: 'được' }), false);
  assert.equal(plainSpaces('a\u00a0b '), 'a b ');
});

test('editBytes: DEL per changed character, then the new letters (precomposed ê/ế count as one)', () => {
  assert.equal(editBytes('T', 'Ti'), 'i');
  assert.equal(editBytes('Tiê', 'Tiế'), DEL + 'ế');
  assert.equal(editBytes('ngươ', 'người'), DEL + 'ời');
  assert.equal(editBytes('dduw', 'đư'), DEL.repeat(4) + 'đư');
  assert.equal(editBytes('Tiê', 'Ti'), DEL);
  assert.equal(editBytes('abc', 'abc'), '');
  // decomposed e + combining circumflex is one character on screen, so one DEL
  assert.equal(editBytes('Tiê', 'Tiế'), DEL + 'ế');
});

test('multiCharKey: several letters at once, never a named key', () => {
  assert.equal(multiCharKey('ấu'), true);
  assert.equal(multiCharKey('ợc'), true);
  assert.equal(multiCharKey('a'), false);
  assert.equal(multiCharKey('ế'), false);
  for (const k of ['Enter', 'Backspace', 'ArrowLeft', 'F1', 'Dead', 'Unidentified']) assert.equal(multiCharKey(k), false);
});

test('keyEffect: Backspace trims the word, cursor keys and Enter start a new one, letters leave it', () => {
  assert.equal(keyEffect({ key: 'Backspace', keyCode: 8 }), 'trim');
  for (const key of ['Enter', 'Escape', 'ArrowLeft', 'Home', 'Tab']) assert.equal(keyEffect({ key, keyCode: 1 }), 'clear');
  assert.equal(keyEffect({ key: 'c', keyCode: 67, ctrlKey: true }), 'clear');
  assert.equal(keyEffect({ key: 'a', keyCode: 65 }), null);
  assert.equal(keyEffect({ key: 'a', keyCode: 229 }), null);
});

test('a keydown while an input method works (229 or isComposing) is never sent by xterm', () => {
  const ime = makeImeInput({ box: { value: '' }, send: () => {} });
  assert.equal(ime.key({ type: 'keydown', key: 'a', keyCode: 229 }), false);
  assert.equal(ime.key({ type: 'keydown', key: 'Enter', keyCode: 13, isComposing: true }), false);
  assert.equal(ime.key({ type: 'keydown', key: 'a', keyCode: 65 }), true);
});

test('a composition (IBus preedit, CJK) is left to xterm: the page sends nothing for it', () => {
  const sent: string[] = [];
  const box = { value: '' };
  const ime = makeImeInput({ box, send: (d: string) => sent.push(d) });
  ime.composition(true);
  ime.beforeinput({ inputType: 'insertCompositionText', isComposing: true });
  box.value = 'việ';
  assert.equal(ime.input({ inputType: 'insertCompositionText', data: 'việ', isComposing: true }), false);
  ime.composition(false);
  assert.deepEqual(sent, []);
});

test('Backspace through xterm keeps the input method word in step with the CLI', () => {
  const sent: string[] = [];
  const box = { value: 'Tie' };
  const ime = makeImeInput({ box, send: (d: string) => sent.push(d) });
  ime.key({ type: 'keydown', key: 'Backspace', keyCode: 8 }); // xterm sends the DEL itself
  ime.key({ type: 'keyup', key: 'Backspace', keyCode: 8 });
  assert.equal(box.value, 'Ti');
  ime.beforeinput({ inputType: 'insertReplacementText', data: 'Tiê' });
  box.value = 'Tiê';
  assert.equal(ime.input({ inputType: 'insertReplacementText', data: 'Tiê' }), true);
  assert.deepEqual(sent, ['ê']);
  ime.reset();
  assert.equal(box.value, '');
});
