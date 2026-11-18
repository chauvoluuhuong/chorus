/* The lasting border highlight on a chat's Task and Artifacts buttons (task #14, mockup mail-courier.html v3, scenes 4–5). When the
   chat's task changes (its revision goes up) or its artifacts change (a new one or a new version), the button's border lights up in
   the count flash's yellow, glows twice (1 s each), then stays lit until the user clicks the button. Nothing lights while that panel
   is open: what it shows is seen. A per-chat "seen" mark {task, artifacts} is kept by the server (POST /api/ui) so another device
   clears it too. The page redraws the head often, so a redraw inside the glow continues it (a negative animation-delay), as counts.js
   does for the count flash. A page module with no DOM of its own, so it can be tested. */
export const HL_GLOW_MS = 2000;

export function makeHighlights(env = { now: () => Date.now() }) {
  /** chat → { task?: number, artifacts?: number }: the values the user has seen */
  let seen = {};
  /** `${chat}:${kind}` → when its highlight began (for the glow) */
  const since = new Map();
  let dirty = false;

  /** The server's marks (and the browser's copy): later ones win per chat and kind. */
  function load(marks) {
    if (!marks || typeof marks !== 'object') return;
    for (const [chat, m] of Object.entries(marks)) {
      if (!m || typeof m !== 'object') continue;
      const s = (seen[chat] ??= {});
      for (const kind of ['task', 'artifacts']) if (typeof m[kind] === 'number') s[kind] = Math.max(s[kind] ?? -Infinity, m[kind]);
    }
  }

  /**
   * Is this button highlighted? `value` is the chat's task revision or artifacts mark now (undefined: not known yet). The first value
   * a chat shows is its starting point; an open panel sees every change at once.
   */
  function lit(chat, kind, value, open) {
    const key = `${chat}:${kind}`;
    if (typeof value !== 'number') return false;
    const s = (seen[chat] ??= {});
    if (s[kind] === undefined || open || value < s[kind]) {
      if (s[kind] !== value) (s[kind] = value), (dirty = true);
      since.delete(key);
      return false;
    }
    if (value === s[kind]) {
      since.delete(key);
      return false;
    }
    if (!since.has(key)) since.set(key, env.now());
    return true;
  }

  /** The user clicked the button: what it shows now is seen. */
  function see(chat, kind, value) {
    if (typeof value !== 'number') return;
    const s = (seen[chat] ??= {});
    if (s[kind] !== value) (s[kind] = value), (dirty = true);
    since.delete(`${chat}:${kind}`);
  }

  /**
   * Goes inside a button's class="…" when it is lit: " hl" and, during the two glows, the delay that keeps a redraw in step. `flashing`:
   * the count flash is on this button now (it has its own style attribute and stays on top), so only the class goes in.
   */
  function hlClass(chat, kind, flashing = false) {
    const at = since.get(`${chat}:${kind}`);
    if (at === undefined) return '';
    const age = env.now() - at;
    if (age >= HL_GLOW_MS) return ' hl hl-done';
    return flashing ? ' hl' : ` hl" style="animation-delay:-${age}ms`;
  }

  /** The marks to keep, once something changed since the last call (else undefined). */
  function changed() {
    if (!dirty) return undefined;
    dirty = false;
    return structuredClone(seen);
  }

  /** A chat that was deleted: its marks go. */
  function forget(chat) {
    if (seen[chat]) (delete seen[chat]), (dirty = true);
  }

  return { load, lit, see, hlClass, changed, forget, marks: () => seen };
}

/** A chat's artifacts mark: grows with a new artifact and with a new version of one. */
export const artifactsMark = c => (c?.artifacts ?? 0) + (c?.artifactsRev ?? 0);
