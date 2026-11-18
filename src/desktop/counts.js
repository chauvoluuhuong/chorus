/* Counts that flash when they grow (Approvals, a chat's Artifacts, a chat's Task): the whole button grows and turns yellow for
   about a second, then goes back, and the number rolls to its new value. Only growth flashes (a drop rolls quietly); several at
   once are one flash; a count that grew while the window was hidden is not replayed. The page redraws these buttons often, so a
   redraw inside the second continues the animation from where it was (a negative animation-delay) instead of restarting it.
   A page module with no DOM of its own, so it can be tested; `env` gives the clocks and whether the window is hidden. */
export const COUNT_MS = 1100;
export const COUNT_BOOT_MS = 4000;

export function makeCounts(env = { now: () => Date.now(), uptime: () => performance.now(), hidden: () => document.hidden }) {
  const counts = new Map(); // key → { n: the number now, from: the number before, at: when it changed (0 = never shown moving) }
  function noteCount(key, n) {
    const c = counts.get(key);
    if (!c) return void counts.set(key, { n, from: n, at: 0 });
    // nothing moves while the page is still loading its first numbers, or while the window is hidden
    if (n !== c.n) counts.set(key, { n, from: c.n, at: env.hidden() || env.uptime() < COUNT_BOOT_MS ? 0 : env.now() });
  }
  const countAge = key => {
    const c = counts.get(key), now = env.now();
    return c && c.at && now - c.at < COUNT_MS ? now - c.at : -1;
  };
  /** Goes inside a button's class="…": closes it with " flash" and the delay that keeps a redraw in step, when its count just grew. */
  function countFlash(key) {
    const c = counts.get(key), age = countAge(key);
    return age >= 0 && c.n > c.from ? ` flash" style="animation-delay:-${age}ms` : '';
  }
  /** The number itself: the old one rolls out and the new one in while the change is fresh; from nothing it just appears. */
  function countNum(key, n) {
    const c = counts.get(key), age = countAge(key);
    return age >= 0 && c.from > 0 && c.n === n ? `<span class="cnt-roll${c.n < c.from ? ' down' : ''}" style="animation-delay:-${age}ms"><i>${c.from}</i><i>${n}</i></span>` : String(n);
  }
  /** Each chat's task revision (the paid module's taskRev: it goes up when the task, its steps or comments change). A chat whose
   *  task the module does not know yet is not noted, so the first number it does know is the starting point and never flashes
   *  (the module loads after the first state, and its data after that). */
  function noteTaskRevs(chats, pro) {
    for (const c of chats ?? []) {
      let rev;
      try {
        rev = pro?.taskRev?.(c.id);
      } catch {
        rev = undefined;
      }
      if (typeof rev === 'number') noteCount(`taskrev:${c.id}`, rev);
    }
  }
  return { noteCount, countFlash, countNum, countAge, noteTaskRevs };
}

/** A chat head's button that opens its view in the right sidebar; the lit one (or ✕) closes it. `flash` comes from countFlash. */
export const sideBtn = (view, k, label, icon, extra = '', flash = '') =>
  `<button class="btn${view === k ? ' on' : ''}${flash}" data-act="side" data-arg="${k}" aria-pressed="${view === k}" title="${label}" aria-label="${label}"><span class="ic-only">${icon}</span><span class="lbl">${label}</span>${extra}</button>`;
