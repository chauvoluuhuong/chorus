// The sidebar keeps where the user scrolled it: a state push redraws the whole sidebar (renderChrome rewrites #side), and the
// chat list `.tree` must come back at the same scrollTop, not at the top. The real page over a real `chorus serve`, in headless
// Chrome (the driver of the e2e proofs); skipped where Chrome is not installed.
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

test('sidebar: a state push and a redraw keep the chat list where it was scrolled', { skip: !fs.existsSync(CHROME) && 'no Chrome' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-side-home-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-side-')));
  const store = new Store(project, { home });
  // more chats and projects than fit in the sidebar
  for (let p = 0; p < 8; p++) {
    const cwd = path.join(project, `shop-${p}`);
    fs.mkdirSync(cwd);
    for (let i = 0; i < 6; i++) store.createThread({ title: `Chat ${p}.${i}`, agent: i % 2 ? 'codex' : 'claude', cwd, project: cwd, native_session_id: `s-${p}-${i}` });
  }
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: () => ({ bin: process.execPath, args: ['-e', ''], cwd: project }) });
  c.restore();
  const srv = new ChorusServer({ controller: c, token: 'b'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 'test', agents: [], ms: 1 }) });
  const url = await srv.start(0);
  // CHORUS_PROOF_DIR keeps the screenshot as proof (.chorus/proof/<branch>/)
  const out = process.env.CHORUS_PROOF_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-side-shots-'));
  fs.mkdirSync(out, { recursive: true });
  const ch = await openChrome({ out, width: 1280, height: 900 });
  try {
    await ch.cdp('Page.navigate', { url: srv.openUrl });
    assert.ok(await ch.until(async () => (await ch.js<number>('document.querySelectorAll("#side .tree .chat-row").length')) > 0, 15000), 'the sidebar lists the chats');
    const size = await ch.js<{ h: number; c: number }>('(() => { const t = document.querySelector("#side .tree"); return { h: t.scrollHeight, c: t.clientHeight }; })()');
    assert.ok(size.h > size.c + 200, `the chat list overflows (${size.h} > ${size.c})`);
    const top = await ch.js<number>('(() => { const t = document.querySelector("#side .tree"); t.scrollTop = 200; return t.scrollTop; })()');
    assert.equal(top, 200);

    // a state push from the server (an agent working, a chat added): the page redraws the sidebar
    await ch.js('window.__tree = document.querySelector("#side .tree"), 1');
    srv.pushState();
    assert.ok(await ch.until(() => ch.js<boolean>('document.querySelector("#side .tree") !== window.__tree'), 5000), 'the push redrew the sidebar');
    await sleep(200);
    assert.equal(await ch.js<number>('document.querySelector("#side .tree").scrollTop'), 200, 'still where it was scrolled after a state push');
    await ch.shot('sidebar-scroll-after-push', 'After a state push the sidebar is still scrolled down (the list starts mid-way), not back at the top');

    // any other redraw (a click that re-renders the chrome, the paid module's refresh)
    await ch.js('chorus.renderChrome(), 1');
    assert.equal(await ch.js<number>('document.querySelector("#side .tree").scrollTop'), 200, 'still where it was scrolled after a redraw');
  } finally {
    ch.close();
    srv.close();
    c.stop();
    await sleep(200);
    store.close();
  }
});
