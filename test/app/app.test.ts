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

function harness(cols = 100, rows = 24) {
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
  const app = new App(io, { sidebarWidth: 24 });
  const spec = (name: string) => ({ id: name, title: name, agent: 'fake', file: process.execPath, args: [FAKE, name], cwd: process.cwd() });
  return {
    app,
    spec,
    type: (s: string) => stdin.write(s),
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

test('two threads: sidebar, switching keeps each screen, input goes to the active thread only', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'), true);
  h.app.addThread(h.spec('beta'), false);
  h.app.start();
  await h.until(l => has(l, /READY alpha/), 'alpha screen');
  let s = h.screen();
  assert.match(s[0], /THREADS\s+·\s+1\/2/);
  assert.match(s[1], /▎.*alpha/);
  assert.match(s[3], /beta/);
  assert.match(s[23], /chorus\s+alpha\s+│\s*fake/);

  h.type('one\r');
  await h.until(l => has(l, /got: "one"/), 'alpha echo');

  h.type('\x002'); // menu key, then 2
  await h.until(l => has(l, /READY beta/), 'beta screen');
  assert.ok(!has(h.screen(), /READY alpha/));
  assert.match(h.screen()[3], /▎.*beta/);
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

test('resize reaches the agent and the layout follows', async () => {
  const h = harness(100, 24);
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  await h.until(l => has(l, /SIZE 75x23/), 'initial size 100-24-1 columns, 23 rows');
  h.resize(120, 30);
  await h.until(l => has(l, /SIZE 95x29/), 'new size after resize');
  h.app.stop();
});

test('hiding the sidebar gives the agent the full width', async () => {
  const h = harness(100, 24);
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  await h.until(l => has(l, /SIZE 75x23/), 'initial');
  h.type('\x00b');
  await h.until(l => has(l, /SIZE 100x23/), 'full width');
  assert.ok(!has(h.screen(), /THREADS/));
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

test('a thread that exits is marked ended; quitting needs a second press and restores the terminal', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'));
  h.app.addThread(h.spec('beta'), false);
  h.app.start();
  await h.until(l => has(l, /READY alpha/), 'ready');
  h.type('q\r');
  await h.until(l => has(l, /fake · ended/), 'ended marker');
  assert.match(h.screen()[2], /fake · ended/);
  h.type('\x00q');
  await h.until(l => has(l, /still running/), 'quit asks again while beta runs');
  const finished = h.app.done.then(() => 'done');
  h.type('\x00q');
  assert.equal(await Promise.race([finished, sleep(3000).then(() => 'timeout')]), 'done');
  assert.match(h.raw(), /\x1b\[\?25h\x1b\[0m\x1b\[\?1049l$/);
});

test('alternate-screen programs are shown in the thread area, not on the whole terminal', async () => {
  const h = harness();
  h.app.addThread(h.spec('alpha'));
  h.app.start();
  await h.until(l => has(l, /READY alpha/), 'ready');
  h.type('alt\r');
  await h.until(l => has(l, /ALT SCREEN/), 'alt screen content');
  assert.match(h.screen()[0], /│\s*ALT SCREEN/);
  h.app.stop();
});
