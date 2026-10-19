// App shell tests: the real node-pty runs a fake TUI (tools/fake-agent/fake-tui.mjs); stdin/stdout are fakes,
// and what the "user" sees is rebuilt by replaying the app's output into a virtual terminal.
import assert from 'node:assert/strict';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { App, type AppIO } from '../../src/app/app.ts';
import { VirtualScreen } from '../../src/app/screen.ts';

const FAKE = path.resolve(import.meta.dirname, '../../tools/fake-agent/fake-tui.mjs');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function harness(cols = 120, rows = 24) {
  const stdin = Object.assign(new PassThrough(), { setRawMode: () => {}, isTTY: true });
  const outer = new VirtualScreen(cols, rows);
  let raw = '';
  const stdout = new PassThrough();
  stdout.on('data', d => {
    raw += d;
    outer.write(d);
  });
  let size = { cols, rows };
  let onResize: () => void = () => {};
  const io: AppIO = { stdin, stdout, size: () => size, onResize: cb => ((onResize = cb), () => {}) };
  const app = new App(io);
  const spec = (name: string) => ({ id: name, title: name, agent: 'fake', file: process.execPath, args: [FAKE, name], cwd: process.cwd() });
  return {
    app,
    spec,
    type: (s: string) => stdin.write(s),
    /** click a hit region by id (SGR mouse, 1-based cells), like a real terminal would report it */
    click(id: string, dx = 1) {
      const hit = app.hits.find(x => x.id === id);
      assert.ok(hit, `no hit region ${id}; have: ${app.hits.map(x => x.id).join(' ')}`);
      stdin.write(`\x1b[<0;${hit.x0 + 1 + dx};${hit.y0 + 1}M\x1b[<0;${hit.x0 + 1 + dx};${hit.y0 + 1}m`);
    },
    screen: () => outer.text(),
    raw: () => raw,
    resize(c: number, r: number) {
      size = { cols: c, rows: r };
      outer.resize(c, r);
      onResize();
    },
    async until(pred: (lines: string[]) => boolean, what: string, ms = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        await sleep(60);
        if (pred(outer.text())) return;
      }
      assert.fail(`timed out waiting for: ${what}\n${outer.text().filter(l => l.trim()).join('\n')}`);
    },
  };
}
const has = (lines: string[], re: RegExp) => lines.some(l => re.test(l));

test('two chats: top bar, project tree, switching keeps each screen, input goes to the active chat only', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'), true);
  h.app.addThread(h.spec('beta'), false);
  h.app.start();
  await h.until(l => has(l, /READY alpha/), 'alpha screen');
  let s = h.screen();
  assert.match(s[0], /‹ Back\s+alpha\s+☰ Menu/);
  assert.ok(!/chorus/.test(s[0]), 'the top bar says where you are, not the product or the project');
  assert.match(s[1], /\+ New chat/);
  assert.match(s[2], /PROJECTS/);
  assert.match(s[3], /▾ .*\s+2\s*│/); // the project, with its two chats
  assert.match(s[4], /▎.*alpha.*fake/);
  assert.match(s[5], /beta/);
  assert.match(s[23], /chorus\s+alpha\s+│\s*fake/);

  h.type('one\r');
  await h.until(l => has(l, /got: "one"/), 'alpha echo');

  h.type('\x002'); // menu key, then 2
  await h.until(l => has(l, /READY beta/), 'beta screen');
  assert.ok(!has(h.screen(), /READY alpha/));
  assert.match(h.screen()[5], /▎.*beta/);
  h.type('two\r');
  await h.until(l => has(l, /got: "two"/), 'beta echo');

  h.type('\x001');
  await h.until(l => has(l, /got: "one"/), 'alpha screen restored from memory');
  assert.ok(!has(h.screen(), /got: "two"/), 'beta input did not reach alpha');
  h.app.stop();
});

test('colors and wide characters from the child appear in the frame', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  await h.until(l => has(l, /red bold blue wide:漢字/), 'colored line');
  assert.match(h.raw(), /\x1b\[0;1;38;5;1mred bold/);
  h.app.stop();
});

test('resize reaches the agent and the layout follows the breakpoints', async () => {
  const h = harness(100, 24);
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  await h.until(l => has(l, /SIZE 79x22/), 'narrow sidebar: 100 - 21 columns, 24 - 2 rows');
  h.resize(120, 30);
  await h.until(l => has(l, /SIZE 91x28/), 'full sidebar after resize');
  h.resize(80, 30);
  await h.until(l => has(l, /SIZE 74x28/), 'icon sidebar');
  h.resize(60, 30);
  await h.until(l => has(l, /SIZE 60x28/), 'hidden sidebar');
  h.app.stop();
});

test('under 50x12 a notice replaces everything; the agent keeps its last size and comes back', async () => {
  const h = harness(120, 24);
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  await h.until(l => has(l, /SIZE 91x22/), 'initial');
  h.resize(40, 10);
  await h.until(l => has(l, /window too small: 40×10/), 'notice');
  assert.ok(!has(h.screen(), /READY alpha/));
  h.resize(120, 24);
  await h.until(l => has(l, /READY alpha/), 'agent screen is back');
  assert.ok(!has(h.screen(), /too small/));
  h.app.stop();
});

test('hiding the sidebar gives the agent the full width', async () => {
  const h = harness(120, 24);
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  await h.until(l => has(l, /SIZE 91x22/), 'initial');
  h.type('\x00b');
  await h.until(l => has(l, /SIZE 120x22/), 'full width');
  assert.ok(!has(h.screen(), /\+ New chat/));
  h.app.stop();
});

test('the app answers terminal queries for the agent (cursor position report)', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  await h.until(l => has(l, /READY alpha/), 'ready');
  h.type('dsr\r');
  await h.until(l => has(l, /CPR \d+;\d+/), 'agent received a cursor position report');
  h.app.stop();
});

test('bracketed paste with the menu key inside reaches the agent and opens no menu', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  await h.until(l => has(l, /READY alpha/), 'ready');
  assert.match(h.raw(), /\x1b\[\?2004h/, 'bracketed paste mode mirrored to the real terminal');
  h.type('\x1b[200~a\x00b\x1b[201~');
  await h.until(l => has(l, /PASTE "a\\u0000b"/), 'paste delivered intact');
  h.app.stop();
});

test('a chat that exits is marked ended; quitting needs a second press and restores the terminal', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'));
  h.app.addThread(h.spec('beta'), false);
  h.app.start();
  await h.until(l => has(l, /READY alpha/), 'ready');
  h.type('q\r');
  await h.until(l => has(l, /\(exited 0\)/), 'ended marker in the status line');
  h.type('\x00q');
  await h.until(l => has(l, /still running/), 'quit asks again while beta runs');
  const finished = h.app.done.then(() => 'done');
  h.type('\x00q');
  assert.equal(await Promise.race([finished, sleep(3000).then(() => 'timeout')]), 'done');
  assert.match(h.raw(), /\x1b\[\?25h\x1b\[0m\x1b\[\?1049l$/);
});

test('alternate-screen programs are shown in the chat area, not on the whole terminal', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  await h.until(l => has(l, /READY alpha/), 'ready');
  h.type('alt\r');
  await h.until(l => has(l, /ALT SCREEN/), 'alt screen content');
  assert.match(h.screen()[1], /│\s*ALT SCREEN/);
  assert.match(h.screen()[0], /☰ Menu/, 'the top bar stays');
  h.app.stop();
});

test('mouse: clicks run the region under them; releases and wheel events do nothing; motion lights a row up', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'), true);
  h.app.addThread(h.spec('beta'), false);
  h.app.start();
  await h.until(l => has(l, /READY alpha/), 'alpha');
  assert.match(h.raw(), /\x1b\[\?1003h\x1b\[\?1006h/, 'mouse reporting (with motion) switched on');
  h.type('\x1b[<64;5;5M'); // wheel over the sidebar
  await sleep(150);
  assert.ok(has(h.screen(), /READY alpha/), 'wheel changed nothing');
  const before = h.raw().length;
  h.type('\x1b[<35;5;5M'); // motion over the second chat
  await sleep(200);
  assert.match(h.raw().slice(before), /48;2;38;48;64/, 'the hovered row lights up');
  h.click('chat:1');
  await h.until(l => has(l, /READY beta/), 'beta opened by the click');
  assert.ok(!has(h.screen(), /READY alpha/));
  h.click('chat:0');
  await h.until(l => has(l, /READY alpha/), 'alpha opened by the click');
  h.app.stop();
  assert.match(h.raw(), /\x1b\[\?1003l\x1b\[\?1006l/, 'mouse reporting switched off on exit');
});

test('mouse: clicks in the chat area reach only agents that asked for the mouse, shifted by the sidebar and top bar', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  await h.until(l => has(l, /READY alpha/), 'ready');
  h.type('\x1b[<0;40;6M');
  await sleep(400);
  assert.ok(!has(h.screen(), /MOUSE/), 'not forwarded: the agent did not ask');
  h.type('mouse\r');
  await sleep(400);
  h.type('\x1b[<0;40;6M');
  await h.until(l => has(l, /MOUSE 0 11 5 M/), 'forwarded with x shifted by the sidebar (40 - 29) and y by the top bar (6 - 1)');
  h.type('\x1b[<0;10;6M');
  await sleep(400);
  assert.ok(!has(h.screen(), /MOUSE 0 10/), 'a click in the sidebar never reaches the agent');
  h.app.stop();
});

test('top bar: Menu opens the menu, a menu row runs by click, ↑↓ + Enter, and its letter; Back goes up one level', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  const actions: string[] = [];
  h.app.on('action', a => actions.push(a));
  await h.until(l => has(l, /READY alpha/), 'ready');
  h.click('menu');
  await h.until(l => has(l, /chorus · alpha/), 'menu open');
  for (const row of ['Hand off to another agent', 'New chat', 'Artifacts', 'Approvals', 'Skills', 'Memory', 'Activity', 'Show / hide sidebar', 'Help', 'Quit']) assert.ok(has(h.screen(), new RegExp(row)), row);
  h.click('menu:k', 8);
  await h.until(l => !has(l, /chorus · alpha/), 'menu closed by the click');
  assert.deepEqual(actions, ['skills']);
  h.type('\x00\x1b[B\x1b[B\r'); // menu, down, down, enter → Artifacts
  await sleep(300);
  assert.deepEqual(actions, ['skills', 'files']);
  h.type('\x00i');
  await sleep(200);
  assert.deepEqual(actions, ['skills', 'files', 'approvals']);
  h.click('back'); // from a chat, Back goes to New chat
  await sleep(200);
  assert.deepEqual(actions.slice(-1), ['new']);
  h.app.waitingProvider = () => 2;
  await h.until(l => has(l, /! 2 waiting/), 'badge');
  h.click('skills');
  h.click('memory');
  h.click('approvals');
  await sleep(200);
  assert.deepEqual(actions.slice(-3), ['skills', 'memory', 'approvals']);
  h.app.stop();
});

test('sidebar: a project folds and opens by click; a folded project shows a red ! when a chat in it needs approval', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'), true);
  h.app.addThread(h.spec('beta'), false);
  h.app.start();
  await h.until(l => has(l, /READY alpha/), 'ready');
  const project = h.app.hits.find(x => x.id.startsWith('project:'))!.id;
  h.click(project);
  await h.until(l => !has(l, /beta/), 'chats hidden');
  assert.match(h.screen()[3], /▸ .*2/);
  h.app.setState('beta', 'approval');
  await h.until(l => has(l, /▸ .*!1/), 'the count of waiting chats on the folded project');
  h.click(project);
  await h.until(l => has(l, /beta/), 'chats shown again');
  h.app.stop();
});

test('panes: Back (top bar or esc) closes them and tells the pane; pane regions get their clicks', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  await h.until(l => has(l, /READY alpha/), 'ready');
  let closed = 0;
  const clicks: string[] = [];
  h.app.showPane('Skills', [[[' import ', '', 'import:x']]], { id: 'skills', crumb: ['Skills'], onClose: () => closed++, onHit: id => clicks.push(id) });
  await h.until(l => has(l, /‹ Back\s+Skills\s+☰ Menu/), 'crumb says where you are');
  assert.match(h.screen().join('\n'), /✦ Skills/);
  h.click('import:x');
  assert.deepEqual(clicks, ['import:x']);
  h.click('back');
  await h.until(l => has(l, /READY alpha/), 'chat is back');
  assert.equal(closed, 1);
  h.app.stop();
});

test('autowrap is switched off while the app runs (a too-long row is cut, never wrapped into a scroll) and back on at exit', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  await h.until(l => has(l, /READY alpha/), 'ready');
  assert.ok(h.raw().includes('\x1b[?7l'), 'autowrap off');
  h.app.stop();
  assert.ok(h.raw().includes('\x1b[?7h'), 'autowrap restored');
});

test('self-heal: the whole frame is sent again every few seconds, so a glitch in the terminal disappears by itself', async () => {
  const stdin = Object.assign(new PassThrough(), { setRawMode: () => {}, isTTY: true });
  const outer = new VirtualScreen(100, 24);
  let raw = '';
  const stdout = new PassThrough();
  stdout.on('data', d => {
    raw += d;
    outer.write(d);
  });
  const app = new App({ stdin, stdout, size: () => ({ cols: 100, rows: 24 }), onResize: () => () => {} }, { repaintMs: 300 });
  app.addThread({ id: 'a', title: 'alpha', agent: 'fake', file: process.execPath, args: [FAKE, 'alpha'], cwd: process.cwd() });
  app.start();
  await sleep(700);
  // something scribbles on the terminal behind the app's back, the way a torn frame or a stray write would
  await new Promise<void>(r => outer.write('\x1b[4;1H\x1b[0mXXXXXXXXXXXX', r));
  assert.ok(outer.text()[3].includes('XXXX'));
  await sleep(1200);
  assert.ok(!outer.text()[3].includes('XXXX'), 'repainted');
  assert.ok((raw.match(/☰ Menu/g) ?? []).length >= 2, 'the top bar was sent more than once');
  app.stop();
});

test('mouse can be switched off', async () => {
  const stdin = Object.assign(new PassThrough(), { setRawMode: () => {}, isTTY: true });
  let raw = '';
  const stdout = new PassThrough();
  stdout.on('data', d => (raw += d));
  const app = new App({ stdin, stdout, size: () => ({ cols: 100, rows: 24 }), onResize: () => () => {} }, { mouse: false });
  app.start();
  assert.ok(!/\x1b\[\?100[03]h/.test(raw));
  app.stop();
});
