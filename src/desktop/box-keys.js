// Keys in Chorus's own text boxes while an input method is building a word (fix/vietnamese-input, step 4).
//
// A real composition (Linux IBus preedit, Chinese, Japanese, a macOS input method that shows underlined marked text) owns Enter, Tab,
// Escape and the arrows until the word is done: Enter there finishes the word, so a page handler must not also send, pick or close.
// The browser marks those keys with `isComposing`, or keyCode 229 (WebKit gives 229 to a key an input method took).
// Apple's own Telex and VNI never compose (no composition events, no marked text): their letters come as keyCode 229 after the
// input, but Return comes as keyCode 13 with isComposing false (test/fixtures/ime/telex-enter-*.json), so Enter after a half-typed
// word sends it, exactly as in the Mac's own apps (Planner, 2026-11-20).

/** True while an input method owns this key: every page handler for Enter, Tab, Escape, arrows or letter shortcuts returns first. */
export const composing = e => !!e?.isComposing || e?.keyCode === 229;

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
