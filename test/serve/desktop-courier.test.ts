// The desktop page's part of task #14, on the real page over a real `chorus serve`, in headless Chrome (skipped without Chrome):
// - the mail watchdog's overlay: only over the chat being typed into, gone at the end, gone after 10 s whatever happened;
// - the Artifacts button's lasting highlight: lit by a new artifact, cleared by opening its panel, kept by the server across a reload;
// - opening a chat from elsewhere scrolls the sidebar to it (its folded project opens);
// - the left sidebar's width: dragged by its right edge, kept across a reload.
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

test('desktop: the type-in overlay, the Artifacts highlight, the sidebar scroll and the left sidebar width', { skip: !fs.existsSync(CHROME) && 'no Chrome', timeout: 120_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-dc-home-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-dc-')));
  const store = new Store(project, { home });
  const ids: string[] = [];
  for (let p = 0; p < 8; p++) {
    const cwd = path.join(project, `shop-${p}`);
    fs.mkdirSync(cwd);
    for (let i = 0; i < 5; i++) ids.push(store.createThread({ title: `Chat ${p}.${i}`, agent: 'claude', cwd, project: cwd, native_session_id: `s-${p}-${i}` }).id);
  }
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: () => ({ bin: process.execPath, args: ['-e', 'setInterval(()=>{},1e9)'], cwd: project }) });
  c.restore();
  const srv = new ChorusServer({ controller: c, token: 'e'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 'test', agents: [], ms: 1 }) });
  await srv.start(0);
  const out = process.env.CHORUS_PROOF_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-dc-shots-'));
  fs.mkdirSync(out, { recursive: true });
  const ch = await openChrome({ out, width: 1280, height: 860 });
  const [A, B] = [ids[0], ids[1]];
  const last = ids.at(-1)!;
  const typing = (thread: string, phase: 'start' | 'end') => (srv as any).broadcast({ t: 'mail-typing', thread, phase, from: { title: 'Step 2 · type-in helpers', agent: 'claude' }, ok: true });
  const overlay = () => ch.js<boolean>('!!document.querySelector("#mail-typing:not(.out)")');
  const open = async (id: string) => {
    await ch.js(`chorus.go({ name: 'chat', id: ${JSON.stringify(id)} }), 1`);
    await sleep(300);
  };
  try {
    await ch.cdp('Page.navigate', { url: srv.openUrl });
    assert.ok(await ch.until(async () => (await ch.js<number>('document.querySelectorAll("#side .tree .chat-row").length')) > 0, 15000), 'the sidebar lists the chats');
    if (await ch.js<boolean>('!!document.querySelector("[data-act=welcome-skip], [data-act=skip-welcome]")')) await ch.js('document.querySelector("[data-act=welcome-skip], [data-act=skip-welcome]").click(), 1');

    /* the overlay: only for the open chat */
    await open(A);
    typing(A, 'start');
    assert.ok(await ch.until(overlay, 3000), 'shown over the chat being typed into');
    assert.match(await ch.js<string>('document.querySelector("#mail-typing").textContent'), /Delivering a message to this chat[\s\S]*From Step 2 · type-in helpers\. What you typed is saved and comes back in a moment\./);
    assert.equal(await ch.js<string>('getComputedStyle(document.querySelector("#mail-typing")).position'), 'fixed', 'the whole window');
    await open(B);
    assert.equal(await overlay(), false, 'another chat is not interrupted');
    await open(A);
    assert.equal(await overlay(), true, 'opening the chat meanwhile shows it');
    typing(A, 'end');
    await sleep(450);
    assert.equal(await ch.js<boolean>('!!document.querySelector("#mail-typing")'), false, 'gone at the end, after its fade');
    typing(B, 'start');
    await sleep(200);
    assert.equal(await overlay(), false, 'typing into another chat shows nothing here');
    typing(A, 'start');
    assert.ok(await ch.until(overlay, 3000));
    await sleep(10_600);
    assert.equal(await overlay(), false, 'gone after 10 s whatever happened');

    /* the Artifacts highlight: lit by a new one, cleared by opening its panel, kept across a reload */
    const lit = () => ch.js<boolean>('!!document.querySelector("#chat-head [data-arg=artifacts].hl")');
    await open(A);
    assert.equal(await lit(), false);
    const f1 = path.join(project, 'shop-0', 'notes.md');
    fs.writeFileSync(f1, '# notes\n');
    store.reportArtifact(A, f1, 'notes');
    srv.pushState();
    assert.ok(await ch.until(lit, 5000), 'a new artifact lights the button');
    await ch.shot('artifacts-highlight', 'The Artifacts button keeps a yellow border after a new artifact');
    await ch.js('location.reload(), 1');
    assert.ok(await ch.until(() => ch.js<boolean>('!!document.querySelector("#chat-head")'), 15000));
    assert.ok(await ch.until(lit, 5000), 'still lit after a reload');
    await ch.js('document.querySelector("#chat-head [data-arg=artifacts]").click(), 1');
    await sleep(300);
    assert.equal(await lit(), false, 'opening its panel clears it');
    await ch.js('document.querySelector("#chat-head [data-arg=artifacts]").click(), 1'); // and closes it
    await sleep(300);
    assert.equal(await lit(), false);
    await ch.shot('highlight-cleared', 'After a click the highlight is gone');
    await sleep(500); // the mark reaches the server
    await ch.js('location.reload(), 1');
    assert.ok(await ch.until(() => ch.js<boolean>('!!document.querySelector("#chat-head")'), 15000));
    await sleep(800);
    assert.equal(await lit(), false, 'the server kept the click');

    /* opening a chat from elsewhere scrolls the sidebar to it, and opens its folded project */
    const lastCwd = path.join(project, 'shop-7');
    await ch.js(`(() => { const t = document.querySelector("#side .tree"); t.scrollTop = 0; return 1; })()`);
    await ch.js(`document.querySelector('#side .proj[data-arg=${JSON.stringify(lastCwd)}]').click(), 1`); // fold it
    await sleep(200);
    await open(last);
    const seen = await ch.js<{ inView: boolean; top: number }>(`(() => {
      const t = document.querySelector('#side .tree'), r = [...t.querySelectorAll('.chat-row')].find(x => x.dataset.arg === ${JSON.stringify(last)});
      if (!r) return { inView: false, top: t.scrollTop };
      const a = t.getBoundingClientRect(), b = r.getBoundingClientRect();
      return { inView: b.top >= a.top - 1 && b.bottom <= a.bottom + 1, top: t.scrollTop };
    })()`);
    assert.ok(seen.inView && seen.top > 0, `the opened chat's row is scrolled into view (${JSON.stringify(seen)})`);

    /* the left sidebar's width: drag its right edge */
    const w0 = await ch.js<number>('document.querySelector("#side").getBoundingClientRect().width');
    const h = await ch.js<{ x: number; y: number }>('(() => { const r = document.querySelector("[data-resize-left]").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 300 }; })()');
    await ch.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: h.x, y: h.y, button: 'left', clickCount: 1 });
    for (let dx = 20; dx <= 100; dx += 20) await ch.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: h.x + dx, y: h.y, button: 'left' });
    await ch.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: h.x + 100, y: h.y, button: 'left', clickCount: 1 });
    await sleep(300);
    const w1 = await ch.js<number>('document.querySelector("#side").getBoundingClientRect().width');
    assert.ok(Math.abs(w1 - (w0 + 100)) <= 2, `dragged 100 px wider (${w0} → ${w1})`);
    await ch.shot('sidebar-resized', 'The left sidebar dragged 100 px wider');
    await sleep(400);
    await ch.js('location.reload(), 1');
    assert.ok(await ch.until(() => ch.js<boolean>('!!document.querySelector("#side .tree")'), 15000));
    await sleep(800);
    const w2 = await ch.js<number>('document.querySelector("#side").getBoundingClientRect().width');
    assert.ok(Math.abs(w2 - w1) <= 2, `kept after a reload (${w2})`);
  } finally {
    ch.close();
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await sleep(200);
    store.close();
  }
});
