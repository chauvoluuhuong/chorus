import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, Differ, gridText, rowToAnsi, layout } from '../../src/app/compositor.ts';
import { VirtualScreen } from '../../src/app/screen.ts';

function view(over: Partial<Parameters<typeof compose>[0]> = {}) {
  const screen = new VirtualScreen(40, 11);
  return { cols: 70, rows: 12, sidebarWidth: 24, items: [{ title: 'fix bug', agent: 'claude', state: 'busy' as const, active: true }, { title: 'review', agent: 'codex', state: 'ended' as const, active: false }], screen, status: '1/2 fix bug · claude', statusRight: 'ctrl+space: menu', ...over };
}
const flush = (s: VirtualScreen, data: string) => new Promise<void>(r => s.write(data, r));

test('layout hides the sidebar on narrow terminals', () => {
  assert.equal(layout(120, 30, 26).sidebar, 26);
  assert.equal(layout(50, 30, 26).sidebar, 0);
  assert.equal(layout(120, 30, 0).contentCols, 120);
});

test('sidebar, separator, child screen and status line land in the right cells', async () => {
  const v = view();
  await flush(v.screen, 'hello from the agent\r\n\x1b[31mred\x1b[0m 漢字 end');
  const { grid, cursor } = compose(v);
  const t = gridText(grid);
  assert.match(t[0], /^ CHORUS\s+│\s*hello from the agent/);
  assert.match(t[2], /^▶1 fix bug\s+●│/);
  assert.match(t[3], /^ 2 review\s+✕│/);
  assert.match(t[1], /│red 漢字 end/);
  assert.match(t[11], /^ 1\/2 fix bug · claude\s+ctrl\+space: menu$/);
  assert.equal(grid[11][0].s, '7');
  assert.deepEqual(cursor, { x: 25 + 12, y: 1 } /* 4 + two wide chars (4) + 4 */);
});

test('colors survive the trip: a red cell in the child is red in the frame', async () => {
  const v = view();
  await flush(v.screen, '\x1b[1;31mX\x1b[0m');
  const { grid } = compose(v);
  assert.equal(grid[0][25].t, 'X');
  assert.equal(grid[0][25].s, '1;38;5;1');
});

test('wide characters keep the row width', async () => {
  const v = view();
  await flush(v.screen, '漢字');
  const { grid } = compose(v);
  assert.equal(grid[0].length, 70);
  assert.equal(gridText(grid)[0].includes('漢字'), true);
});

test('overlay is drawn over the content area and marks the selected line', () => {
  const v = view({ overlay: { title: 'chorus', lines: ['1  fix bug', '2  review'], selected: 1 } });
  const { grid, cursor } = compose(v);
  const t = gridText(grid).join('\n');
  assert.match(t, /┌─ chorus/);
  assert.match(t, /│ 2  review/);
  assert.equal(cursor, null);
  const row = grid.findIndex(r => r.map(c => c.t).join('').includes('2  review'));
  assert.equal(grid[row][30].s, '7');
});

test('differ only emits rows that changed', async () => {
  const v = view();
  const d = new Differ();
  const first = d.frame(compose(v).grid);
  assert.equal((first.match(/\x1b\[\d+;1H/g) ?? []).length, 12);
  assert.equal(d.frame(compose(v).grid), '');
  await flush(v.screen, 'x');
  const next = d.frame(compose(v).grid);
  assert.equal((next.match(/\x1b\[\d+;1H/g) ?? []).length, 1);
});

test('a frame replayed into a terminal reproduces the grid', async () => {
  const v = view();
  await flush(v.screen, 'hello\r\n\x1b[32mgreen\x1b[0m 漢字');
  const { grid } = compose(v);
  const outer = new VirtualScreen(70, 12);
  await flush(outer, new Differ().frame(grid));
  assert.deepEqual(outer.text().map(l => l.trimEnd()), gridText(grid));
  assert.equal(rowToAnsi(outer.row(1, 70)).replace(/\s+\x1b\[0m$/, ''), rowToAnsi(grid[1]).replace(/\s+\x1b\[0m$/, ''));
});
