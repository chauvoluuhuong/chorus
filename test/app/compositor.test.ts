import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compose, Differ, gridText, hitAt, layout, rowToAnsi, T, type SideRow, type View } from '../../src/app/compositor.ts';
import { VirtualScreen } from '../../src/app/screen.ts';

const SIDE: SideRow[] = [
  { kind: 'new' },
  { kind: 'project', cwd: '/w/cake-shop', name: 'cake-shop', open: true, count: 2, alert: false, active: false },
  { kind: 'chat', index: 0, title: 'fix bug', agent: 'claude', state: 'busy', active: true },
  { kind: 'chat', index: 1, title: 'review', agent: 'codex', state: 'ended', active: false, child: true },
  { kind: 'project', cwd: '/w/api', name: 'api', open: false, count: 1, alert: true, active: false },
  { kind: 'skills', active: false },
  { kind: 'memory', active: false },
];

function view(over: Partial<View> = {}): View & { screen: VirtualScreen } {
  const screen = new VirtualScreen(90, 22);
  return {
    cols: 120,
    rows: 24,
    sidebarOn: true,
    side: SIDE,
    top: { back: true, crumb: ['chorus', 'cake-shop', 'fix bug'], waiting: 2 },
    screen,
    statusBar: { title: 'fix bug', agent: 'claude', model: 'sonnet', usage: 62, ctx: 34, artifacts: 3 },
    statusRight: '⌃\\ menu',
    ...over,
  };
}
const flush = (s: VirtualScreen, data: string) => new Promise<void>(r => s.write(data, r));

test('layout: the sidebar shrinks in steps and the window can be too small', () => {
  assert.equal(layout(120, 30).mode, 'full');
  assert.equal(layout(120, 30).sidebar, 28);
  assert.equal(layout(100, 30).mode, 'narrow');
  assert.equal(layout(80, 30).mode, 'icons');
  assert.equal(layout(60, 30).mode, 'hidden');
  assert.equal(layout(120, 30, false).mode, 'hidden');
  assert.equal(layout(120, 30, false).contentCols, 120);
  assert.equal(layout(49, 30).tooSmall, true);
  assert.equal(layout(120, 11).tooSmall, true);
  const L = layout(120, 30);
  assert.deepEqual([L.contentX, L.contentY, L.contentRows], [29, 1, 28]); // top bar above, status line below
  assert.ok(layout(110, 30).contentCols >= 80, 'the agent keeps 80+ columns at the first breakpoint');
});

test('top bar, project tree, child screen and status bar land in the right cells', async () => {
  const v = view();
  await flush(v.screen, 'hello from the agent\r\n\x1b[31mred\x1b[0m 漢字 end');
  const { grid, cursor } = compose(v);
  const t = gridText(grid);
  assert.match(t[0], /^\s+‹ Back\s+chorus › cake-shop › fix bug\s+! 2 waiting\s+☰ Menu\s*$/);
  assert.match(t[1], /^\s+\+ New chat\s+│hello from the agent/);
  assert.match(t[2], /^ ▾ cake-shop\s+2\s*│red 漢字 end/);
  assert.match(t[3], /^▎ ?\s*● fix bug\s+claude\s*│/);
  assert.match(t[4], /^\s+↳ ○ review\s+codex\s*│/);
  assert.match(t[5], /^ ▸ api\s+!\s*│/); // folded project with an approval waiting
  assert.match(t[20], /^─+/); // rule above the footer rows (Skills, Memory)
  assert.match(t[21], /^ ✦ Skills/);
  assert.match(t[22], /^ ◫ Memory/);
  assert.match(t[23], /^ chorus  fix bug │ claude · sonnet │ 5h ▮▮▮▮▮▮▱▱▱▱ 62% │ ctx 34% │ 3 artifacts/);
  assert.deepEqual(cursor, { x: 29 + 12, y: 2 }); // 4 + two wide chars (4) + 4
});

test('the brand chip, the agent colour, the state colour and the selection follow the mockup', () => {
  const { grid } = compose(view());
  const status = grid[23];
  assert.ok(status[1].s.includes(T.bgBrand) && status[1].s.includes(T.fgBrand), 'chorus chip');
  const x = gridText(grid)[3].indexOf('claude');
  assert.ok(grid[3][x].s.includes(T.claude), 'agent name in its colour');
  assert.ok(grid[3][3].s.includes(T.ok), 'working dot is green');
  assert.ok(grid[3][3].s.includes(T.bgSel), 'active chat has the selection background');
  const menu = gridText(grid)[0].indexOf('☰ Menu');
  assert.ok(grid[0][menu].s.includes(T.bgSel) && grid[0][menu].s.includes('1'), 'the Menu button is a filled chip');
  const crumb = gridText(grid)[0].indexOf('cake-shop');
  assert.ok(grid[0][crumb].s.includes('4'), 'a path part that goes somewhere is underlined');
});

test('every clickable thing is a hit region and a click finds it', () => {
  const { hits } = compose(view());
  const at = (id: string) => hits.find(h => h.id === id)!;
  for (const id of ['back', 'crumb:0', 'crumb:1', 'approvals', 'menu', 'new', 'project:/w/cake-shop', 'project:/w/api', 'chat:0', 'chat:1', 'skills', 'memory'])
    assert.ok(at(id), `hit ${id}`);
  assert.equal(hits.find(h => h.id === 'crumb:2'), undefined, 'the last part of the path is plain text');
  const chat = at('chat:1');
  assert.equal(hitAt(hits, 3, chat.y0), 'chat:1');
  assert.equal(hitAt(hits, 27, chat.y0), 'chat:1', 'the whole sidebar row is the target');
  assert.equal(hitAt(hits, 60, chat.y0), undefined, 'the agent area is not Chorus\'s');
  const menu = at('menu');
  assert.equal(hitAt(hits, menu.x0 + 1, 0), 'menu');
});

test('colors survive the trip: a red cell in the child is red in the frame', async () => {
  const v = view();
  await flush(v.screen, '\x1b[1;31mX\x1b[0m');
  const { grid } = compose(v);
  assert.equal(grid[1][29].t, 'X');
  assert.equal(grid[1][29].s, '1;38;5;1');
});

test('wide characters keep the row width', async () => {
  const v = view();
  await flush(v.screen, '漢字');
  const { grid } = compose(v);
  assert.equal(grid[1].length, 120);
  assert.equal(gridText(grid)[1].includes('漢字'), true);
});

test('narrow, icon and hidden sidebars; the agent area grows as they shrink', () => {
  const narrow = gridText(compose(view({ cols: 100 })).grid);
  assert.match(narrow[3], /● fix bug/);
  assert.ok(!/claude\s*│/.test(narrow[3]), 'narrow drops the agent name');
  const icons = gridText(compose(view({ cols: 80 })).grid);
  assert.match(icons[3], /^▎\s*● c\s*│/);
  const hidden = compose(view({ cols: 60 }));
  assert.ok(!hidden.hits.some(h => h.id.startsWith('chat:')));
  assert.ok(hidden.hits.some(h => h.id === 'menu'), 'the top bar stays');
});

test('narrow window: the path is cut with an ellipsis before the buttons, which keep their gap', () => {
  const t = gridText(compose(view({ cols: 78, side: SIDE.slice(0, 4), top: { back: true, crumb: ['chorus', 'a-very-long-project-folder-name', 'a very long chat title that cannot fit'], waiting: 2 } })).grid)[0];
  assert.match(t, /…\s{2,}! 2 waiting\s+☰ Menu\s*$/, t);
  const icons = gridText(compose(view({ cols: 78 })).grid);
  assert.ok(!/▾\w/.test(icons[2]), 'icon mode: a project row is just its caret, no clipped name');
  assert.match(icons[2], /^\s*▾\s*│/);
  assert.match(icons[5], /^\s*▸\s*!\s*│/, 'a folded project with an approval waiting keeps its !');
});

test('too small: only a notice, no hit regions', () => {
  const { grid, hits } = compose(view({ cols: 40, rows: 10 }));
  assert.match(gridText(grid).join('\n'), /window too small: 40×10/);
  assert.equal(hits.length, 0);
});

test('the status line drops its least useful parts first: model, ctx, artifacts text, meter', () => {
  const full = (cols: number) => gridText(compose(view({ cols, sidebarOn: false })).grid)[23];
  assert.match(full(120), /sonnet.*ctx 34%.*3 artifacts/);
  const a = full(80);
  assert.ok(!a.includes('sonnet'), 'model goes first');
  const b = full(66);
  assert.ok(!b.includes('ctx'), 'then ctx');
  const c = full(58);
  assert.ok(/3◆/.test(c) && !c.includes('artifacts'), 'then the artifacts text');
  const d = full(52);
  assert.ok(!d.includes('▮'), 'the meter goes last');
  assert.match(d, /62%/);
});

test('a chat without prompts shows the amber skip marker', () => {
  const t = gridText(compose(view({ statusBar: { title: 'x', agent: 'codex', usage: 5, artifacts: 0, skip: true } })).grid)[23];
  assert.match(t, /codex skip/);
});

test('overlay (menu rows) is drawn over the content area, marks the selected row and registers its rows', () => {
  const v = view({ overlay: { title: 'chorus · fix bug', rows: [['h', 'Hand off', false, 'menu:h'], ['n', 'New chat', true, 'menu:n']], foot: 'esc  back to claude' } });
  const { grid, cursor, hits } = compose(v);
  const t = gridText(grid).join('\n');
  assert.match(t, /chorus · fix bug/);
  assert.match(t, /h\s+Hand off/);
  assert.match(t, /n\s+New chat/);
  assert.match(t, /esc  back to claude/);
  assert.equal(cursor, null);
  const row = gridText(grid).findIndex(l => l.includes('New chat') && l.includes('│', 40));
  assert.ok(grid[row][gridText(grid)[row].lastIndexOf('New chat')].s.includes(T.bgSel));
  const h = hits.find(x => x.id === 'menu:n')!;
  assert.equal(hitAt(hits, h.x0 + 2, h.y0), 'menu:n', 'the overlay sits on top of the sidebar and the agent');
});

test('pane: title, whole-row hits with a selected background, segment hits, hint buttons', () => {
  const { grid, hits } = compose(
    view({
      pane: {
        title: 'Approvals',
        lines: [
          { line: [['Stripe webhook']], hit: 'row:a', sel: true },
          [['   '], [' y Approve ', T.ok, 'approve:a']],
        ],
        hint: [[' esc ', T.dim, 'back'], [' back']],
      },
    }),
  );
  const t = gridText(grid);
  assert.match(t[1], /Approvals/);
  assert.match(t[2], /Stripe webhook/);
  assert.ok(grid[2][40].s.includes(T.bgSel), 'selected row has the selection background across the row');
  assert.ok(hits.some(h => h.id === 'row:a' && h.x1 > 100));
  const ap = hits.find(h => h.id === 'approve:a')!;
  assert.equal(hitAt(hits, ap.x0 + 1, ap.y0), 'approve:a');
  assert.ok(hits.some(h => h.id === 'back' && h.y0 === 22), 'hint buttons are hits too');
});

test('a bare pane has no title row: its own heading is the first line and it gets one more row', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  const titled = gridText(compose(view({ pane: { title: 'Doctor', lines, hint: 'esc' } })).grid);
  const bare = gridText(compose(view({ pane: { title: 'Memory', bare: true, lines, hint: 'esc' } })).grid);
  assert.match(titled[1], /Doctor/);
  assert.match(titled[2], /line 0/);
  assert.match(bare[1], /line 0/, 'no title row above the first line');
  assert.ok(bare.join('\n').includes('line 20') && !titled.join('\n').includes('line 21'), 'one more line fits');
  assert.ok(!bare[1].includes('Memory'));
});

test('hover lights up the region under the mouse', () => {
  const v = view({ hover: 'chat:1' });
  const { grid, hits } = compose(v);
  const h = hits.find(x => x.id === 'chat:1')!;
  assert.ok(grid[h.y0][10].s.includes(T.bgSel));
  assert.ok(!compose(view()).grid[h.y0][10].s.includes(T.bgSel));
});

test('differ only emits rows that changed', async () => {
  const v = view();
  const d = new Differ();
  const first = d.frame(compose(v).grid);
  assert.equal((first.match(/\x1b\[\d+;1H/g) ?? []).length, 24);
  assert.equal(d.frame(compose(v).grid), '');
  await flush(v.screen, 'x');
  const next = d.frame(compose(v).grid);
  assert.equal((next.match(/\x1b\[\d+;1H/g) ?? []).length, 1);
});

test('a frame replayed into a terminal reproduces the grid', async () => {
  const v = view();
  await flush(v.screen, 'hello\r\n\x1b[32mgreen\x1b[0m 漢字');
  const { grid } = compose(v);
  const outer = new VirtualScreen(120, 24);
  await flush(outer, new Differ().frame(grid));
  assert.deepEqual(outer.text().map(l => l.trimEnd()), gridText(grid));
  assert.equal(rowToAnsi(outer.row(2, 120)).replace(/\s+\x1b\[0m$/, ''), rowToAnsi(grid[2]).replace(/\s+\x1b\[0m$/, ''));
});
