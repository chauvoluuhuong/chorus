// Enter in Chorus's own boxes while an input method builds a word (fix/vietnamese-input, step 4): a real composition (isComposing,
// keyCode 229) owns the key, so no page handler sends, picks or closes; Apple Telex's Return after a half-typed word (keyCode 13,
// isComposing false, recorded in test/fixtures/ime/telex-enter-*.json) still sends. Redraws wait for the word. Skill slugs keep
// Vietnamese letters as their base letters.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
// @ts-expect-error: a page module, plain JavaScript
import { FORWARDED_MS, composing, compositionSeen, makeComposeGate } from '../../src/desktop/box-keys.js';
// @ts-expect-error: a page module, plain JavaScript
import { attachPicker } from '../../src/desktop/text-picker.js';
import { skillSlug } from '../../src/serve/slug.ts';

const root = path.join(import.meta.dirname, '..', '..');
const fixtures = path.join(root, 'test', 'fixtures', 'ime');
type Ev = { type: string; key?: string; keyCode?: number; isComposing?: boolean };
const load = (f: string): Ev[] => JSON.parse(fs.readFileSync(path.join(fixtures, f), 'utf8')).events;

test('Enter during a real composition (Linux IBus preedit, CJK, marked text) is the input method’s', () => {
  assert.equal(composing({ type: 'keydown', key: 'Enter', keyCode: 229, isComposing: true }), true);
  assert.equal(composing({ type: 'keydown', key: 'Enter', keyCode: 13, isComposing: true }), true);
  assert.equal(composing({ type: 'keydown', key: 'Process', keyCode: 229, isComposing: false }), true);
  assert.equal(composing({ type: 'keydown', key: 'Escape', keyCode: 27, isComposing: true }), true);
});

test('Enter after an Apple Telex word still sends: Return comes as keyCode 13, isComposing false (real fixtures)', () => {
  const files = fs.readdirSync(fixtures).filter(f => f.startsWith('telex-enter-'));
  assert.ok(files.length >= 4, 'the four telex-enter fixtures');
  for (const f of files) {
    const events = load(f);
    const enter = events.filter(e => e.type === 'keydown' && e.key === 'Enter');
    assert.equal(enter.length, 1, f);
    assert.equal(composing(enter[0]), false, `${f}: Enter must still act`);
    // the letters before it come as keyCode 229 (Apple's input method took them): those are held, as a shortcut must not fire
    assert.ok(events.some(e => e.type === 'keydown' && e.keyCode === 229 && composing(e)), f);
  }
  // and every plain Enter / Escape in all fixtures acts
  for (const f of fs.readdirSync(fixtures))
    for (const e of load(f)) if (e.type === 'keydown' && (e.key === 'Enter' || e.key === 'Escape')) assert.equal(composing(e), false, f);
});

test('Linux IBus (ibus-bamboo): the Enter IBus forwards after committing a word is held; the next Enter acts (real fixtures)', () => {
  const files = fs.readdirSync(fixtures).filter(f => /^linux-(telex|vni)-enter-/.test(f));
  assert.equal(files.length, 6, 'telex and vni × New chat, card answer, dialog');
  for (const f of files) {
    const events = JSON.parse(fs.readFileSync(path.join(fixtures, f), 'utf8')).events as (Ev & { t: number; data?: string })[];
    assert.ok(!events.some(e => e.type === 'compositionstart'), `${f}: no compositionstart in WebKitGTK`);
    let held = 0;
    for (const e of events) {
      const ev = { ...e, timeStamp: e.t };
      if (e.type === 'compositionstart' || e.type === 'compositionend') compositionSeen(ev);
      if (e.type === 'keydown' && e.key === 'Enter') {
        assert.equal(composing(ev), true, `${f}: the forwarded Enter finishes the word and must not send`);
        held++;
        // the person's own Enter, later: acts
        assert.equal(composing({ ...ev, timeStamp: e.t + FORWARDED_MS + 50 }), false, `${f}: a later Enter sends`);
      }
    }
    assert.equal(held, 1, f);
  }
  // after a real composition (compositionstart came) a quick Enter is the user's: only the commit without a start counts
  compositionSeen({ type: 'compositionstart', timeStamp: 1000 });
  compositionSeen({ type: 'compositionend', timeStamp: 1100 });
  assert.equal(composing({ type: 'keydown', key: 'Enter', keyCode: 13, isComposing: false, timeStamp: 1101 }), false);
});

test('a redraw waits for the word and runs once at compositionend', () => {
  let drawn = 0;
  const g = makeComposeGate(() => drawn++);
  assert.equal(g.hold(), false, 'no composition: redraw now');
  g.end();
  assert.equal(drawn, 0, 'nothing waited');
  g.start();
  assert.equal(g.on, true);
  assert.equal(g.hold(), true);
  assert.equal(g.hold(), true);
  assert.equal(drawn, 0);
  g.end();
  assert.equal(drawn, 1, 'one redraw for all that waited');
  assert.equal(g.hold(), false);
});

/** A field and the bits of the DOM the picker touches. */
function fakeDom() {
  const el = (): any => ({ style: {}, hidden: false, innerHTML: '', setAttribute() {}, append() {}, remove() {}, querySelector: () => null, offsetTop: 0, offsetLeft: 0, offsetWidth: 100, className: '', textContent: '' });
  const g = globalThis as any;
  g.document = { createElement: el, addEventListener() {}, removeEventListener() {}, activeElement: null };
  g.getComputedStyle = () => ({ position: 'relative', lineHeight: '20px' });
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const field: any = {
    ...el(),
    value: '',
    selectionStart: 0,
    parentElement: el(),
    clientWidth: 300,
    scrollTop: 0,
    addEventListener: (t: string, f: (e: any) => void) => (listeners[t] ??= []).push(f),
    removeEventListener() {},
    focus() {},
    setSelectionRange(a: number) {
      field.selectionStart = a;
    },
  };
  const fire = (t: string, e: any = {}) => {
    const ev = { ...e, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, stopPropagation() {} };
    for (const f of listeners[t] ?? []) f(ev);
    return ev;
  };
  return { field, fire };
}

test('the "/" list: Enter during a composition finishes the word, not a pick; plain Enter picks', async () => {
  const { field, fire } = fakeDom();
  const skills = { chars: ['/'], label: 'Skills', query: /[\w.-]*/, items: async () => [{ key: 'review' }], insert: (x: any) => `/${x.key}` };
  const p = attachPicker(field, [skills]);
  field.value = '/re';
  field.selectionStart = 3;
  fire('input');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(p.isOpen(), true);
  const held = fire('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(held.defaultPrevented, false, 'the input method gets Enter');
  assert.equal(field.value, '/re', 'nothing picked');
  const telex = fire('keydown', { key: 'Enter', keyCode: 13, isComposing: false });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(telex.defaultPrevented, true);
  assert.equal(field.value, '/review ', 'Enter picks once the word is done');
  p.destroy();
});

test('every page handler for Enter, Tab, Escape or arrows checks composing() first', () => {
  const app = fs.readFileSync(path.join(root, 'src', 'desktop', 'app.js'), 'utf8').split('\n');
  const found: number[] = [];
  app.forEach((line, i) => {
    if (!/addEventListener\('keydown'|^\s+'keydown',$/.test(line)) return;
    if (/\['pointerdown', 'keydown'\]/.test(app[i - 1] ?? '')) return; // closes a peek on any key in the chat screen: no Enter/Esc action
    found.push(i + 1);
    const head = app.slice(i, i + 4).join('\n');
    assert.match(head, /composing\((e|event)\)/, `app.js:${i + 1} acts on keys without checking composing()`);
  });
  assert.ok(found.length >= 8, `keydown handlers found: ${found.join(', ')}`);
  const picker = fs.readFileSync(path.join(root, 'src', 'desktop', 'text-picker.js'), 'utf8');
  assert.match(picker, /const onKey = e => \{\n.*composing\(e\)/);
});

test('skill slugs keep Vietnamese letters as their base letters', () => {
  assert.equal(skillSlug('Tiếng Việt'), 'tieng-viet');
  assert.equal(skillSlug('Đà Nẵng'), 'da-nang');
  assert.equal(skillSlug('người được khoẻ'), 'nguoi-duoc-khoe');
  assert.equal(skillSlug('Tiếng Việ'), 'tieng-vie');
  assert.equal(skillSlug('My Skill_2!'), 'my-skill-2');
  assert.equal(skillSlug('Café Ñandú'), 'cafe-nandu');
  assert.equal(skillSlug('中文'), '');
});
