import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InputRouter, type InputEvent } from '../../src/app/input.ts';

function run(chunks: string[]) {
  const ev: InputEvent[] = [];
  const r = new InputRouter(e => ev.push(e));
  chunks.forEach(c => r.feed(c));
  return ev;
}
const pass = (ev: InputEvent[]) => ev.filter(e => e.type === 'pass').map(e => (e as any).data).join('');

test('plain typing passes through untouched, including escape sequences', () => {
  assert.equal(pass(run(['hello', '\x1b[A', 'é漢'])), 'hello\x1b[Aé漢');
});

test('menu key opens the menu and the next key is a command, not agent input', () => {
  const ev = run(['ab\x002cd']);
  assert.deepEqual(ev.map(e => e.type), ['pass', 'menu-open', 'menu-key', 'pass']);
  assert.equal((ev[2] as any).key, '2');
  assert.equal(pass(ev), 'abcd');
});

test('menu key split across chunks and arrows/enter/escape inside the menu', () => {
  const ev = run(['\x00', '\x1b[B', '\x1bOB', '\x1b[A', '\r']);
  assert.deepEqual(ev.map(e => (e.type === 'menu-move' ? e.delta : e.type)), ['menu-open', 1, 1, -1, 'menu-enter']);
  const esc = run(['\x00', '\x1b']);
  assert.deepEqual(esc.map(e => e.type), ['menu-open', 'menu-close']);
});

test('menu key twice sends it to the agent', () => {
  const ev = run(['\x00\x00']);
  assert.equal(pass(ev), '\x00');
  assert.deepEqual(ev.map(e => e.type), ['menu-open', 'menu-close', 'pass']);
});

test('bracketed paste is never scanned, even when split into chunks', () => {
  const ev = run(['\x1b[200~line1\x00', 'line2\x1b[20', '1~', 'x']);
  assert.equal(pass(ev), '\x1b[200~line1\x00line2\x1b[201~x');
  assert.ok(!ev.some(e => e.type === 'menu-open'));
});

test('menu keys: Ctrl+\\ works (macOS keeps Ctrl+Space for itself) and so does Ctrl+Space', () => {
  const ev = new Array<InputEvent>();
  const r = new InputRouter(e => ev.push(e));
  r.feed('a\x1cn');
  r.feed('\x00h');
  assert.deepEqual(ev.map(e => (e.type === 'menu-key' ? `key:${e.key}` : e.type === 'pass' ? `pass:${e.data}` : e.type)), ['pass:a', 'menu-open', 'key:n', 'menu-open', 'key:h']);
});

test('menu key twice sends that same key to the agent, for either key', () => {
  for (const k of ['\x1c', '\x00']) {
    const ev = new Array<InputEvent>();
    new InputRouter(e => ev.push(e)).feed(k + k);
    assert.deepEqual(ev.filter(e => e.type === 'pass'), [{ type: 'pass', data: k }]);
  }
});

test('CHORUS_MENU_KEY chooses the key and the label shown on screen', async () => {
  const { parseMenuKeys } = await import('../../src/app/input.ts');
  assert.deepEqual(parseMenuKeys(undefined), { keys: ['\x1c', '\x00'], label: '⌃\\' });
  assert.deepEqual(parseMenuKeys('ctrl+b'), { keys: ['\x02'], label: '⌃B' });
  assert.deepEqual(parseMenuKeys('Ctrl+Space'), { keys: ['\x00'], label: '⌃Space' });
  assert.deepEqual(parseMenuKeys('^]'), { keys: ['\x1d'], label: '⌃]' });
  assert.deepEqual(parseMenuKeys('nonsense'), { keys: ['\x1c', '\x00'], label: '⌃\\' });
  const ev = new Array<InputEvent>();
  new InputRouter(e => ev.push(e), parseMenuKeys('ctrl+b').keys).feed('\x1c\x02q');
  assert.deepEqual(ev.map(e => e.type), ['pass', 'menu-open', 'menu-key']); // Ctrl+\ is now an ordinary key for the agent
});

test('the menu key opens the menu in capture mode too (panes, dialogs)', () => {
  const ev: string[] = [];
  const r = new InputRouter(e => ev.push(e.type), '\x1c');
  r.capture = true;
  r.feed('\x1c');
  assert.deepEqual(ev, ['menu-open']);
  r.feed('n');
  assert.deepEqual(ev, ['menu-open', 'menu-key']);
});
