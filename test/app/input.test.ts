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
