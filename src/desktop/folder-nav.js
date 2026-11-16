// Chorus's folder dialog, by keyboard (plan 2026-11-14, Package 10E; owner, 2026-11-17: "when i press "a" you should let me
// navigate through folder that begin with a, at a sort by time create, name also"). Pure functions, no page: the dialog in
// app.js (openBrowse, drawBrowse) uses them, and test/serve/folder-nav.test.ts tests them.

/** A name as typed: no case, no accents (Vietnamese too: "Tài liệu" → "tai lieu"; đ → d). */
export function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

/** The default direction of each sort: names A→Z, creation newest first. */
export const SORT_DEFAULT = { name: 'asc', created: 'desc' };

/** The sort after a click on `by`: the active one flips its direction; another one starts at its default. */
export function nextSort(cur, by) {
  if (cur?.by === by) return { by, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return { by, dir: SORT_DEFAULT[by] ?? 'asc' };
}

/**
 * Folders in the order shown. `items`: [{ name, created }] (created in ms: the folder's birth time, or its change time where the
 * file system keeps none). Name: natural order, case and accents aside; Created: by time, then by name.
 */
export function sortFolders(items, sort = { by: 'name', dir: 'asc' }) {
  const byName = (a, b) => fold(a.name).localeCompare(fold(b.name), undefined, { numeric: true }) || a.name.localeCompare(b.name);
  const sign = sort.dir === 'desc' ? -1 : 1;
  const cmp = sort.by === 'created' ? (a, b) => ((a.created ?? 0) - (b.created ?? 0)) * sign || byName(a, b) : (a, b) => byName(a, b) * sign;
  return [...items].sort(cmp);
}

/**
 * Type to jump: letters typed within `timeout` ms build a prefix ("do" → Documents, "dow" → Downloads); after a pause it starts
 * again. The same single letter again moves to the next name starting with it, and wraps round. Returns the index to select in
 * `names` (the order shown), or `current` when nothing matches.
 */
export function typeJump({ timeout = 800, now = () => Date.now() } = {}) {
  let prefix = '';
  let last = -Infinity;
  return {
    press(ch, names, current = -1) {
      const c = fold(ch);
      const t = now();
      if (t - last > timeout) prefix = '';
      last = t;
      const folded = names.map(fold);
      if (prefix === c) {
        // the same letter again: the next one that starts with it, wrapping round
        for (let k = 1; k <= folded.length; k++) {
          const i = (current + k + folded.length) % folded.length;
          if (folded[i].startsWith(c)) return i;
        }
        return current;
      }
      prefix += c;
      const i = folded.findIndex(n => n.startsWith(prefix));
      return i >= 0 ? i : current;
    },
    reset() {
      prefix = '';
      last = -Infinity;
    },
  };
}
