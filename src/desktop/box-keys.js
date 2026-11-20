// Keys in Chorus's own text boxes while an input method is building a word (fix/vietnamese-input, step 4).
//
// A real composition (Linux IBus preedit, Chinese, Japanese, a macOS input method that shows underlined marked text) owns Enter, Tab,
// Escape and the arrows until the word is done: Enter there finishes the word, so a page handler must not also send, pick or close.
// The browser marks those keys with `isComposing`, or keyCode 229 (WebKit gives 229 to a key an input method took).
// Apple's own Telex and VNI never compose (no composition events, no marked text): their letters come as keyCode 229 after the
// input, but Return comes as keyCode 13 with isComposing false (test/fixtures/ime/telex-enter-*.json), so Enter after a half-typed
// word sends it, exactly as in the Mac's own apps (Planner, 2026-11-20).

// IBus in WebKitGTK (Linux, ibus-bamboo) draws the word itself and fires no compositionstart: Enter there commits the word
// (keydown 229, insertFromComposition, compositionend) and IBus then forwards the Enter itself, as keyCode 13 with isComposing false,
// within a millisecond (test/fixtures/ime/linux-*-enter-*.json). A key that comes that soon after a commit with no start is the key
// that committed the word, so it counts as composing too: Enter finishes the word and does not send.

/** How soon after such a commit a keydown is the forwarded key that made it, in ms (a person's next key comes much later). */
export const FORWARDED_MS = 30;
let started = false;
let commitAt = -Infinity; // e.timeStamp of the last compositionend that had no compositionstart

/** compositionstart / compositionend anywhere on the page (the listeners below; tests call it with plain objects). */
export function compositionSeen(e) {
  if (e.type === 'compositionstart') started = true;
  else if (e.type === 'compositionend') {
    if (!started) commitAt = e.timeStamp ?? -Infinity;
    started = false;
  }
}
if (typeof document !== 'undefined') for (const t of ['compositionstart', 'compositionend']) document.addEventListener(t, compositionSeen, true);

/** True while an input method owns this key: every page handler for Enter, Tab, Escape, arrows or letter shortcuts returns first. */
export const composing = e =>
  !!e?.isComposing || e?.keyCode === 229 || (e?.type === 'keydown' && typeof e.timeStamp === 'number' && e.timeStamp - commitAt <= FORWARDED_MS);

/**
 * Redraws wait for the word: replacing a focused field ends its composition and loses the half-built word.
 * `start()` / `end()` on compositionstart / compositionend; a redraw asks `hold()` first (true = skip it now, it runs at `end()`
 * through `redraw`).
 */
export function makeComposeGate(redraw) {
  let on = false;
  let waiting = false;
  return {
    start() {
      on = true;
    },
    end() {
      on = false;
      if (!waiting) return;
      waiting = false;
      redraw();
    },
    hold() {
      if (on) waiting = true;
      return on;
    },
    get on() {
      return on;
    },
  };
}
