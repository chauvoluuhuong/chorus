import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, Differ, gridText, rowToAnsi, layout, T } from '../../src/app/compositor.ts';
import { VirtualScreen } from '../../src/app/screen.ts';

function view(over: Partial<Parameters<typeof compose>[0]> = {}) {
  const screen = new VirtualScreen(40, 11);
  return { cols: 70, rows: 12, sidebarWidth: 24, items: [{ title: 'fix bug', agent: 'claude', state: 'busy' as const, active: true }, { title: 'review', agent: 'codex', state: 'ended' as const, active: false }], screen, statusBar: { title: 'fix bug', agent: 'claude', model: 'sonnet', usage: 62, artifacts: 3 }, statusRight: '⌃\\ menu', ...over };
}
const flush = (s: VirtualScreen, data: string) => new Promise<void>(r => s.write(data, r));

test('layout hides the sidebar on narrow terminals', () => {
  assert.equal(layout(120, 30, 26).sidebar, 26);
  assert.equal(layout(50, 30, 26).sidebar, 0);
  assert.equal(layout(120, 30, 0).contentCols, 120);
});

test('sidebar, separator, child screen and status bar land in the right cells', async () => {
  const v = view();
  await flush(v.screen, 'hello from the agent\r\n\x1b[31mred\x1b[0m 漢字 end');
  const { grid, cursor } = compose(v);
  const t = gridText(grid);
  assert.match(t[0], /^ THREADS\s+·\s+1\/2\s*│hello from the agent/);
  assert.match(t[1], /^▎ ● fix bug\s+│red 漢字 end/);
  assert.match(t[2], /^▎\s+claude · working/);
  assert.match(t[3], /^\s+○ review/);
  assert.match(t[4], /^\s+codex · ended/);
  assert.match(t[11], /^ chorus  fix bug │ claude · sonnet │ 5h ▮▮▮▮▮▮▱▱▱▱ 62% │ 3 artifacts$/); // 70 columns: no room for the menu hint
  assert.deepEqual(cursor, { x: 25 + 12, y: 1 }); // 4 + two wide chars (4) + 4
});

test('the brand chip, the agent colour and the state colour follow the mockup', () => {
  const { grid } = compose(view());
  const status = grid[11];
  assert.ok(status[1].s.includes(T.bgBrand) && status[1].s.includes(T.fgBrand), 'chorus chip');
  const row = gridText(grid)[2];
  const x = row.indexOf('claude');
  assert.ok(grid[2][x].s.includes(T.claude), 'agent name in its colour');
  assert.ok(grid[1][2].s.includes(T.ok), 'working dot is green');
  assert.ok(grid[1][2].s.includes(T.bgSel), 'active thread has the selection background');
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

test('overlay (menu rows) is drawn over the content area and marks the selected row', () => {
  const v = view({ overlay: { title: 'chorus · fix bug', rows: [['h', 'Hand off', false], ['n', 'New thread', true]], foot: 'esc  back to claude' } });
  const { grid, cursor } = compose(v);
  const t = gridText(grid).join('\n');
  assert.match(t, /chorus · fix bug/);
  assert.match(t, /h\s+Hand off/);
  assert.match(t, /n\s+New thread/);
  assert.match(t, /esc  back to claude/);
  assert.equal(cursor, null);
  const row = gridText(grid).findIndex(l => l.includes('New thread'));
  assert.ok(grid[row][gridText(grid)[row].indexOf('New thread')].s.includes(T.bgSel));
});

test('home screen: agents, threads (children indented), keys; no sidebar', () => {
  const { grid } = compose({
    cols: 100, rows: 20, sidebarWidth: 28, items: [], statusRight: 'esc', message: 'home',
    home: {
      project: '~/projects/cake-shop',
      agents: [{ name: 'claude', version: '2.1.302', ok: true }, { name: 'agy', ok: false, note: 'not installed' }],
      threads: [{ id: 'a', title: 'Cake order page', agent: 'claude', state: 'waiting for you', age: '12m ago', artifacts: 3 }, { id: 'b', title: 'continued', agent: 'codex', state: 'working', age: 'just now', artifacts: 1, child: true }],
      selected: 0,
    },
  });
  const t = gridText(grid);
  assert.match(t[0], /chorus 0\.1 +· +~\/projects\/cake-shop/);
  assert.match(t[2], /Agents +claude 2\.1\.302 ✓ +agy not installed ✗/);
  assert.match(t[5], /▸ Cake order page +claude +waiting for you +12m ago +3 artifacts/);
  assert.match(t[6], /↳ continued +codex +working +just now +1 artifact$/);
  assert.match(t.join('\n'), /n new thread +⏎ open +a artifacts +d doctor +q quit/);
  assert.ok(!t.join('\n').includes('THREADS'));
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
