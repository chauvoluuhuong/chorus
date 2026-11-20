// The chat's right sidebar closes on a click outside it (task #16, owner 2026-11-20): a click on the agent's screen closes it and
// the terminal still takes focus; clicks inside it, on its header button and in the left sidebar leave it as it was; the closed
// state is remembered across a reload. Desktop and tablet; a phone is unchanged. The real page over a real `chorus serve`, in
// headless Chrome; skipped where Chrome is not installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Controller } from '../../src/app/controller.ts';
import { Store } from '../../src/core/store.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import { openChrome, sleep } from '../smoke/chrome.ts';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

test('right sidebar: a click outside it closes it, the terminal keeps the click', { skip: !fs.existsSync(CHROME) && 'no Chrome', timeout: 120_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-rso-home-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-rso-')));
  const store = new Store(project, { home });
  const id = store.createThread({ title: 'Chat one', agent: 'claude', cwd: project, project, native_session_id: 's-1' }).id;
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: () => ({ bin: process.execPath, args: ['-e', 'setInterval(()=>{},1e9)'], cwd: project }) });
  c.restore();
  const srv = new ChorusServer({ controller: c, token: 'r'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 'test', agents: [], ms: 1 }) });
  await srv.start(0);
  // CHORUS_PROOF_DIR keeps the screenshots as proof (.chorus/proof/<branch>/)
  const out = process.env.CHORUS_PROOF_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-rso-shots-'));
  fs.mkdirSync(out, { recursive: true });
  const ch = await openChrome({ out, width: 1280, height: 800 });
  const open = async () => {
    await ch.js(`chorus.go({ name: 'chat', id: ${JSON.stringify(id)} }), 1`);
    assert.ok(await ch.until(() => ch.js<boolean>('!!document.querySelector("#term-slot .xterm textarea")'), 10000), 'the chat shows its terminal');
    await sleep(300);
  };
  const shown = () => ch.js<boolean>('(() => { const d = document.querySelector("#drawer"); return !!d && !d.hidden && d.offsetParent !== null; })()');
  const btn = '#chat-head [data-act="side"][data-arg="artifacts"]';
  const resize = async (width: number) => {
    await ch.cdp('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await ch.js('window.dispatchEvent(new Event("resize")), 1');
    await sleep(500);
  };
  // a first launch's "Your agents" check and "Meet Doctor" tip open once a chat is shown and cover the page: close them
  const clearFirstLaunch = async () => {
    let quiet = 0;
    for (let i = 0; i < 40 && quiet < 6; i++) {
      const hit = await ch.js<boolean>('(() => { const b = document.querySelector("#doctor-pop [data-act=doc-continue], #doctor-tip [data-act=tip-done]"); if (b) b.click(); return !!b; })()');
      quiet = hit ? 0 : quiet + 1;
      await sleep(250);
    }
  };
  try {
    await ch.cdp('Page.navigate', { url: srv.openUrl });
    assert.ok(await ch.until(async () => (await ch.js<number>('document.querySelectorAll("#side .tree .chat-row").length')) > 0, 15000), 'the sidebar lists the chats');
    if (await ch.js<boolean>('!!document.querySelector("[data-act=welcome-skip], [data-act=skip-welcome]")')) await ch.js('document.querySelector("[data-act=welcome-skip], [data-act=skip-welcome]").click(), 1');
    await open();
    await clearFirstLaunch();

    for (const [width, size] of [[1280, 'desktop'], [900, 'tablet']] as const) {
      await resize(width);
      assert.equal(await ch.js<string>('chorus.S.size'), size);
      // a. the header button opens Artifacts
      assert.ok(await ch.click(btn), `${size}: the Artifacts button is there`);
      assert.ok(await shown(), `${size}: Artifacts opens`);
      // b. a click inside it leaves it open
      assert.ok(await ch.click('#drawer'));
      assert.ok(await shown(), `${size}: a click inside the sidebar leaves it open`);
      // c. a click on the agent's screen closes it, and the terminal takes the focus
      await ch.shot(`${size}-before-outside-click`, `${size}: Artifacts open beside the agent's screen, before a click on the screen`);
      assert.ok(await ch.click('#term-slot .xterm-screen'));
      assert.equal(await shown(), false, `${size}: a click on the agent's screen closes it`);
      assert.ok(await ch.js<boolean>('!!document.activeElement?.closest("#term-slot")'), `${size}: the terminal has the focus`);
      await ch.shot(`${size}-after-outside-click`, `${size}: after a click on the agent's screen the sidebar is closed and the terminal has the focus`);
    }

    await resize(1280);
    // d. one click on the header button opens it (not close-then-open), a second closes it
    await ch.click(btn);
    assert.ok(await shown(), 'the header button opens it');
    await ch.click(btn);
    assert.equal(await shown(), false, 'the lit header button closes it');
    // e. a click in the left sidebar (not on a chat) leaves it open
    await ch.click(btn);
    assert.ok(await shown());
    assert.ok(await ch.click('#side .brand b'), 'the brand bar is there');
    assert.ok(await shown(), 'a click in the left sidebar leaves it open');
    // f. closed by an outside click, it comes back closed after a reload
    await ch.click('#term-slot .xterm-screen');
    assert.equal(await shown(), false);
    await sleep(300);
    await ch.js('location.reload(), 1');
    assert.ok(await ch.until(() => ch.js<boolean>('!!document.querySelector("#side .tree")'), 15000));
    await open();
    await sleep(500);
    assert.equal(await shown(), false, 'still closed after a reload');
    assert.equal(await ch.js<string>(`JSON.parse(localStorage.getItem('chorus.side') ?? '{}')[${JSON.stringify(id)}]`), '', 'remembered as closed');

    // a phone: a tap on the terminal throws nothing
    await resize(390);
    assert.equal(await ch.js<string>('chorus.S.size'), 'phone');
    await ch.js('window.__errs = []; window.addEventListener("error", e => window.__errs.push(String(e.message))), 1');
    await open();
    await ch.click('#term-slot .xterm-screen');
    assert.deepEqual(await ch.js<string[]>('window.__errs'), [], 'a tap on a phone throws nothing');
  } finally {
    ch.close();
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await sleep(300); // the agents' exits arrive before the store closes
    store.close();
  }
});
