// Vietnamese (and other IME) typing in the chat terminal (fix/vietnamese-input, probe in .chorus/proof/fix-vietnamese-input/).
//
// xterm.js 6 only sends `insertText` input events and a keypress's first character. Two ways of typing lose letters that way:
// - Apple's Telex and VNI in WKWebView fire no composition events: a word's first letter comes as `insertText`, every later key as
//   `insertReplacementText` with the whole word ("Ti" → "Tiê" → "Tiếng"), and the keydown (keyCode 229) comes after the input.
// - OpenKey/EVKey-style tools send Backspace × n and then one key event carrying several letters ("ấu"): xterm sends "ấ".
// So the page takes over every input event that is not part of a composition: it compares xterm's helper textarea before and after
// the edit and sends the change as DEL per removed character plus the new text, once. Keys that xterm handles itself (letters on a
// plain keyboard, space, punctuation, Backspace, arrows …) stay with xterm; their input event, if one follows, is not sent again.
// Compositions (Linux IBus preedit, Chinese, Japanese) stay with xterm's own CompositionHelper.

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
 * - `data()` whenever xterm sends data (term.onData), `composition(on)` on compositionstart/end, `reset()` on a click or chat switch.
 */
export function makeImeInput({ box, send }) {
  let before = null; // the textarea before the edit in progress
  let keySent = false; // xterm (or the page) already sent this key's text from its keydown or keypress
  let multi = null; // several letters sent from one keydown: its keypress and input event are not sent again
  let composing = false;
  let down = false; // between a keydown and its keyup: data xterm sends now is that key's

  function key(e) {
    if (e.type === 'keyup') {
      keySent = false;
      down = false;
      return true;
    }
    if (e.type === 'keypress') return !(multi && e.key === multi);
    // keydown
    keySent = false;
    multi = null;
    down = true;
    // an input method is at work: its text comes with the input event; xterm sends nothing for this key (no double letters)
    if (e.isComposing || e.keyCode === 229) return false;
    if (multiCharKey(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      send(e.key);
      multi = e.key;
      keySent = true;
      return false;
    }
    const fx = keyEffect(e);
    if (fx === 'trim') box.value = graphemes(box.value).slice(0, -1).join('');
    else if (fx === 'clear') box.value = '';
    return true;
  }

  function beforeinput(e) {
    before = composing || e.isComposing || !OURS.has(e.inputType) ? null : box.value;
  }

  function input(e) {
    const was = before;
    before = null;
    if (composing || e.isComposing || !OURS.has(e.inputType)) return false; // a composition: xterm's CompositionHelper sends it
    if (keySent || (multi && e.data === multi)) {
      // xterm (or the multi-letter key) already sent this key's text from its keydown or keypress
      multi = null;
      return true;
    }
    let old = was;
    if (old === null) {
      // no beforeinput seen: rebuild the old text from the edit (typing at the end)
      old = e.inputType === 'insertText' && e.data && box.value.endsWith(e.data) ? box.value.slice(0, -e.data.length) : box.value;
    }
    const bytes = editBytes(old, box.value);
    if (bytes) send(bytes);
    return true;
  }

  return {
    key,
    beforeinput,
    input,
    data() {
      if (down) keySent = true;
    },
    composition(on) {
      composing = on;
      before = null;
    },
    reset() {
      box.value = '';
      before = null;
      keySent = false;
      multi = null;
      down = false;
    },
  };
}
