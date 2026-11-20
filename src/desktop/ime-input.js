// Vietnamese (and other IME) typing in the chat terminal (fix/vietnamese-input, probe in .chorus/proof/fix-vietnamese-input/).
//
// xterm.js 6 only sends `insertText` input events and a keypress's first character. Two ways of typing lose letters that way:
// - Apple's Telex and VNI in WKWebView fire no composition events: a word's first letter comes as `insertText`, every later key as
//   `insertReplacementText` with the whole word ("Ti" → "Tiê" → "Tiếng"), and the keydown (keyCode 229) comes after the input.
// - OpenKey/EVKey-style tools send Backspace × n and then one key event carrying several letters ("ấu"): xterm sends "ấ".
// So the page takes over every input event that is not part of a composition: it compares xterm's helper textarea before and after
// the edit and sends the change as DEL per removed character plus the new text, once. Keys that xterm handles itself (letters on a
// plain keyboard, space, punctuation, Backspace, arrows …) stay with xterm; their input event, if one follows, is not sent again.
// Compositions (Chinese, Japanese, any input method that starts one) stay with xterm's own CompositionHelper.
// - People overlap keys (fix/ime-human-typing): Apple's input methods send a letter's input event before its own keydown, so the
//   first letter of a word often comes while Space is still down. Only the input event that carries the text xterm sent for a key
//   (Space → insertText " ") is skipped, once; any other input event is compared and sent, whichever key is still down.
// - IBus in WebKitGTK (Linux, ibus-bamboo Telex/VNI) fires no compositionstart or compositionupdate: IBus draws the word itself and
//   it arrives at the commit as a keydown 229, `insertFromComposition` (isComposing true) and compositionend. xterm, which saw no
//   start, would send its whole helper textarea at every commit (each word resends all earlier ones). The page sends such a commit
//   itself, once, and xterm does not see its compositionend. WebKit keeps a space at the end of the textarea as a no-break space
//   (U+00A0) and turns it back into a space when text follows, so the commit is compared with no-break spaces read as spaces.

export const DEL = '\x7f';

const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** The characters as a terminal line editor deletes them: one per grapheme (ế is one, precomposed or not). */
export function graphemes(s) {
  return seg ? Array.from(seg.segment(s), x => x.segment) : Array.from(s);
}

/** The bytes that turn the text `before` into `after` at the end of the CLI's input: DEL per removed character, then the rest. */
export function editBytes(before, after) {
  if (before === after) return '';
  const a = graphemes(before), b = graphemes(after);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  return DEL.repeat(a.length - p) + b.slice(p).join('');
}

/** The textarea's text with WebKit's no-break spaces (a space at the end of a line) read as the spaces the user typed. */
export function plainSpaces(s) {
  return s.replace(/\u00a0/g, ' ');
}

/** A key whose `key` is several letters at once ("ấu" from an OpenKey-style tool), not a named key such as "Enter" or "F1". */
export function multiCharKey(key) {
  return typeof key === 'string' && Array.from(key).length > 1 && !/^[A-Z][A-Za-z0-9]*$/.test(key);
}

const RESET = new Set(['Enter', 'Escape', 'Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Delete']);

/** What a keydown that xterm handles itself does to the word the input method is building: Backspace takes off its last letter,
 *  keys that move the cursor or end the line start a new word; anything else (letters, space, punctuation) leaves it. */
export function keyEffect(e) {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey) return 'trim';
  if (RESET.has(e.key) || ((e.ctrlKey || e.metaKey) && e.key !== 'Control' && e.key !== 'Meta')) return 'clear';
  return null;
}

const OURS = new Set(['insertText', 'insertReplacementText', 'deleteContentBackward']);

/**
 * The input state of one terminal. `box` is xterm's helper textarea (or a stand-in with `value`), `send(bytes)` writes to the chat.
 * The page calls the handlers in the capture phase, before xterm sees the event:
 * - `key(e)` from xterm's custom key handler (keydown, keypress, keyup): false = xterm must ignore the key.
 * - `beforeinput(e)` and `input(e)`: `input` returns true when the page sent the change and xterm must not see the event.
 * - `data()` whenever xterm sends data (term.onData), `composition(on)` on compositionstart/end, `compositionEnd(e)` first on
 *   compositionend (true = the page sent it, xterm must not see it), `reset()` on a click or chat switch.
 */
export function makeImeInput({ box, send, log = null }) {
  // log (the typing recorder, chorus.debugIme): what this state decided, for the debug log only
  const note = log ? (what, more) => log({ what, ...more, keySent, multi, down, composing, commit }) : () => {};
  let before = null; // the textarea before the edit in progress
  let keySent = null; // the text xterm sent for the key now down (from its keydown or keypress): its own input event is not sent again
  let multi = null; // several letters sent from one keydown: its keypress and input event are not sent again
  let composing = false;
  let commit = false; // a commit with no compositionstart (IBus in WebKitGTK) was sent from its input event
  let down = false; // between a keydown and its keyup: data xterm sends now is that key's

  function key(e) {
    if (e.type === 'keyup') {
      keySent = null;
      down = false;
      return true;
    }
    if (e.type === 'keypress') {
      if (multi && e.key === multi) note('skip-keypress', { key: e.key });
      return !(multi && e.key === multi);
    }
    // keydown
    keySent = null;
    multi = null;
    down = true;
    // an input method is at work: its text comes with the input event; xterm sends nothing for this key (no double letters)
    if (e.isComposing || e.keyCode === 229) {
      note('key-ime', { key: e.key });
      return false;
    }
    if (multiCharKey(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      note('send-multi', { bytes: e.key });
      send(e.key);
      multi = e.key;
      return false;
    }
    const fx = keyEffect(e);
    if (fx) note(fx, { key: e.key, value: box.value });
    if (fx === 'trim') box.value = graphemes(box.value).slice(0, -1).join('');
    else if (fx === 'clear') box.value = '';
    return true;
  }

  function beforeinput(e) {
    if (!composing && e.inputType === 'insertFromComposition') return void (before = box.value);
    before = composing || e.isComposing || !OURS.has(e.inputType) ? null : box.value;
  }

  function input(e) {
    const was = before;
    before = null;
    if (!composing && e.inputType === 'insertFromComposition') {
      // a commit with no compositionstart (IBus in WebKitGTK): the page sends it, once
      const now = plainSpaces(box.value);
      let old = was === null ? null : plainSpaces(was);
      if (old === null) old = e.data && now.endsWith(plainSpaces(e.data)) ? now.slice(0, -e.data.length) : now;
      const bytes = editBytes(old, now);
      note('send-commit', { old, now, bytes });
      if (bytes) send(bytes);
      commit = true;
      return true;
    }
    if (composing || e.isComposing || !OURS.has(e.inputType)) {
      note('pass-input', { inputType: e.inputType }); // a composition: xterm's CompositionHelper sends it
      return false;
    }
    if (ownInput(e) || (multi && e.data === multi)) {
      // xterm (or the multi-letter key) already sent this key's text from its keydown or keypress: this is that text's input event
      note('skip-input', { inputType: e.inputType, data: e.data, was });
      keySent = null;
      multi = null;
      return true;
    }
    const now = plainSpaces(box.value);
    let old = was === null ? null : plainSpaces(was);
    if (old === null) {
      // no beforeinput seen: rebuild the old text from the edit (typing at the end)
      const d = e.data ? plainSpaces(e.data) : '';
      old = e.inputType === 'insertText' && d && now.endsWith(d) ? now.slice(0, -d.length) : now;
    }
    // compared with no-break spaces as spaces: the space before a word was sent as a space (WebKit swaps it when text follows)
    const bytes = editBytes(old, now);
    note('send-input', { inputType: e.inputType, was, old, now, bytes });
    if (bytes) send(bytes);
    return true;
  }

  /** The input event of the text xterm sent for the key now down (Space → insertText " ", Backspace → deleteContentBackward),
   *  not another key's text that an input method sent while this key was still held. */
  function ownInput(e) {
    if (keySent === null) return false;
    if (e.inputType === 'deleteContentBackward') return keySent === DEL;
    return e.inputType === 'insertText' && plainSpaces(e.data ?? '') === plainSpaces(keySent);
  }

  return {
    key,
    beforeinput,
    input,
    /** xterm sent `d` (term.onData): while a key is down, that key's text. */
    data(d = '') {
      if (down) keySent = (keySent ?? '') + d;
    },
    composition(on) {
      composing = on;
      before = null;
    },
    /** compositionend: true when the page took this commit (no compositionstart came) and xterm must not see the event. */
    compositionEnd(e) {
      if (composing) return false;
      note('compositionend-own', { data: e.data });
      if (!commit && e.data) send(plainSpaces(e.data)); // no input event came for it
      commit = false;
      return true;
    },
    reset() {
      note('reset', { value: box.value });
      box.value = '';
      before = null;
      keySent = null;
      multi = null;
      down = false;
      commit = false;
    },
  };
}
