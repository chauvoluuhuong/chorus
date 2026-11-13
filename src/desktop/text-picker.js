// A list that opens in a text field when a word starts with a trigger character, and puts the chosen item in the text
// (plan 2026-11-13, item 8). It attaches to any <textarea> or <input>, with a list of triggers, each with its own source and insert
// rule; it knows nothing about the screen it is on. Used today on New chat and the hand-off form: "/" for a skill, "@" for a file.
//
//   attachPicker(field, [{ chars: ['/'], label: 'Skills', empty: 'No skill matches', query: /[\w.-]*/,
//                          enabled: () => true, items: async q => [{ key, main, sub }], insert: item => `/${item.key}` }])
//
// The list is ↑ ↓ to move, Enter or Tab or a click to pick, Esc to close. Its styles are in style.css, block "text picker".

/** The longest list shown. */
export const MAX_ITEMS = 50;

/**
 * The trigger word the caret is in, if any: a trigger character at the start of a word (start of the text or after a space) and
 * the query typed after it. A trigger whose `enabled()` says no is not a trigger now: the character stays plain text.
 */
export function findToken(text, caret, triggers) {
  const before = text.slice(0, caret);
  for (const t of triggers) {
    if (t.enabled && !t.enabled()) continue;
    const chars = t.chars.map(c => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
    const m = before.match(new RegExp(`(^|\\s)(${chars})(${(t.query ?? /[\w.-]*/).source})$`, 'u'));
    if (m) return { trigger: t, char: m[2], query: m[3], start: caret - m[3].length - m[2].length };
  }
  return null;
}

/** The items that match the query, those that start with it first, at most MAX_ITEMS. */
export function rank(items, query) {
  const q = query.toLowerCase();
  const starts = x => x.key.toLowerCase().startsWith(q) || String(x.main ?? '').toLowerCase().startsWith(q);
  return items
    .filter(x => x.key.toLowerCase().includes(q))
    .sort((a, b) => Number(starts(b)) - Number(starts(a)))
    .slice(0, MAX_ITEMS);
}

/** The text with the trigger word from `start` to the caret replaced by `insert` and a space; and where the caret goes. */
export function applyPick(text, start, caret, insert) {
  const ins = `${insert} `;
  return { text: text.slice(0, start) + ins + text.slice(caret), caret: start + ins.length };
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Where the caret is in the field, from a hidden copy of its text (for placing the list under it). */
function caretAt(field) {
  const m = document.createElement('div'), cs = getComputedStyle(field);
  for (const k of ['font', 'lineHeight', 'padding', 'border', 'width', 'letterSpacing', 'boxSizing', 'textIndent']) m.style[k] = cs[k];
  Object.assign(m.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '0' });
  m.textContent = field.value.slice(0, field.selectionStart);
  const mark = document.createElement('span');
  mark.textContent = '​';
  m.append(mark);
  field.parentElement.append(m);
  const r = { top: mark.offsetTop - field.scrollTop + field.offsetTop, left: mark.offsetLeft + field.offsetLeft, h: parseFloat(cs.lineHeight) || 22 };
  m.remove();
  return r;
}

/**
 * Attaches the picker to a field. `onChange(text)` is told when a pick changed the text. Returns { close, destroy, isOpen }.
 * A source is asked again as the query changes; an answer that comes after the query moved on is dropped.
 */
export function attachPicker(field, triggers, { onChange } = {}) {
  const box = document.createElement('div');
  box.className = 'tpick';
  box.setAttribute('role', 'listbox');
  box.hidden = true;
  field.parentElement.style.position ||= 'relative';
  if (getComputedStyle(field.parentElement).position === 'static') field.parentElement.style.position = 'relative';
  field.parentElement.append(box);
  let tok = null, list = [], sel = 0, ask = 0;

  const close = () => {
    tok = null;
    list = [];
    box.hidden = true;
  };
  const draw = () => {
    if (!tok) return close();
    box.setAttribute('aria-label', tok.trigger.label);
    box.innerHTML = list.length
      ? list.map((x, i) => `<button type="button" role="option" aria-selected="${i === sel}" class="${i === sel ? 'on' : ''}${x.file ? ' file' : ''}" data-i="${i}"><span class="mono">${esc(x.main ?? x.key)}</span>${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</button>`).join('')
      : `<div class="tpick-empty">${esc(tok.trigger.empty ?? 'Nothing matches')}</div>`;
    const c = caretAt(field);
    box.hidden = false;
    box.style.left = `${Math.max(0, Math.min(c.left, field.offsetLeft + field.clientWidth - box.offsetWidth))}px`;
    box.style.top = `${c.top + c.h + 4}px`;
    box.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  };
  const update = async () => {
    const t = findToken(field.value, field.selectionStart ?? field.value.length, triggers);
    if (!t) return close();
    const same = tok && tok.trigger === t.trigger && tok.query === t.query;
    tok = t;
    if (same) return draw();
    sel = 0;
    const n = ++ask;
    let items = [];
    try {
      items = await t.trigger.items(t.query);
    } catch {
      items = [];
    }
    if (n !== ask || !tok) return;
    list = rank(items, t.query);
    draw();
  };
  const pick = i => {
    if (!tok || !list[i]) return;
    const r = applyPick(field.value, tok.start, field.selectionStart ?? field.value.length, tok.trigger.insert(list[i]));
    field.value = r.text;
    field.focus();
    field.setSelectionRange(r.caret, r.caret);
    close();
    onChange?.(field.value);
  };
  const onKey = e => {
    if (!tok || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), close();
    if (!list.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length;
      return draw();
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      pick(sel);
    }
  };
  const onDown = e => {
    const b = e.target.closest?.('[data-i]');
    if (b && box.contains(b)) {
      e.preventDefault();
      pick(Number(b.dataset.i));
    } else if (tok && e.target !== field && !box.contains(e.target)) close();
  };
  const onInput = () => void update();
  const onCaret = e => (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') && void update();
  field.addEventListener('input', onInput);
  field.addEventListener('keydown', onKey, true);
  field.addEventListener('keyup', onCaret);
  field.addEventListener('blur', () => setTimeout(() => document.activeElement !== field && close(), 150));
  document.addEventListener('mousedown', onDown, true);
  return {
    close,
    isOpen: () => !!tok && !box.hidden,
    destroy() {
      close();
      field.removeEventListener('input', onInput);
      field.removeEventListener('keydown', onKey, true);
      field.removeEventListener('keyup', onCaret);
      document.removeEventListener('mousedown', onDown, true);
      box.remove();
    },
  };
}
