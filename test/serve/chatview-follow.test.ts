// The Chat view keeps a reader at the bottom when the area under the conversation grows (phone e2e over the private link,
// 2026-11-26): when a chat started working, "Working" and Stop appeared above the message box, the conversation got shorter, and
// the running call's line ("Running sleep 10 && echo third-done") was left below the visible part, behind the box. A reader who
// scrolled up is left where they are. The real page over a real `chorus serve`, in headless Chrome at a phone's size; skipped where
// Chrome is not installed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Controller } from '../../src/app/controller.ts';
import type { Session } from '@chauvoluuhuong/chorus-core';
import { Store } from '../../src/core/store.ts';
import { ChorusServer, headlessApp } from '../../src/serve/server.ts';
import { openChrome, sleep } from '../smoke/chrome.ts';

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function session(n: number): Session {
  const s: Session = { agent: 'claude', turns: [], toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
  for (let i = 1; i <= n; i++) s.turns.push({ seq: i, role: i % 2 ? 'user' : 'assistant', text: `turn ${i} `.repeat(12), ts: new Date(Date.UTC(2026, 10, 26, 8, 0, i)).toISOString() });
  return s;
}

test('Chat view on a phone: a reader at the bottom stays there when the box below grows; one who scrolled up stays put', { skip: !fs.existsSync(CHROME) && 'no Chrome', timeout: 120_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-cvf-home-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-cvf-')));
  const store = new Store(project, { home });
  const id = store.createThread({ title: 'Long chat', agent: 'claude', cwd: project, project, native_session_id: 's-1' }).id;
  store.recordSession(id, session(40));
  const c = new Controller({ project, store, app: headlessApp(), opener: async () => ({ ok: true }), launcher: () => ({ bin: process.execPath, args: ['-e', 'setInterval(()=>{},1e9)'], cwd: project }) });
  c.restore();
  const srv = new ChorusServer({ controller: c, token: 'f'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 'test', agents: [], ms: 1 }) });
  await srv.start(0);
  const out = process.env.CHORUS_PROOF_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-cvf-shots-'));
  fs.mkdirSync(out, { recursive: true });
  const ch = await openChrome({ out, width: 390, height: 844 });
  const gap = () => ch.js<number>('(() => { const s = document.querySelector(".cv-stream"); return Math.round(s.scrollHeight - s.scrollTop - s.clientHeight); })()');
  // what the area under the conversation does when a chat starts working: it gets taller
  const growFoot = (px: number) => ch.js(`(() => { const d = document.createElement("div"); d.className = "test-grow"; d.style.height = "${px}px"; document.querySelector(".cv-footwrap").prepend(d); return 1; })()`);
  try {
    await ch.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await ch.cdp('Page.navigate', { url: srv.openUrl });
    assert.ok(await ch.until(() => ch.js<boolean>('!!window.chorus?.go'), 15000), 'the page is up');
    await ch.js(`chorus.go({ name: 'chat', id: ${JSON.stringify(id)} }), 1`);
    assert.ok(await ch.until(() => ch.js<boolean>('document.querySelectorAll(".cv-stream .cv-a").length > 5'), 15000), 'a phone opens the chat in the Chat view');
    await sleep(500);
    assert.ok((await gap()) < 2, 'it opens at the bottom');

    // at the bottom: the box grows by 80 px (as "Working" + Stop + a wrapped line), the newest line stays in view
    await growFoot(80);
    await sleep(300);
    assert.ok((await gap()) < 2, `a reader at the bottom stays at the bottom (gap ${await gap()} px)`);
    await ch.shot('phone-follow-after-grow', 'a phone: the box grew; the newest reply is still in view above it');

    // scrolled up to read: the box grows again, the reader is not pulled down
    await ch.js('(() => { const s = document.querySelector(".cv-stream"); s.scrollTop = 200; s.dispatchEvent(new Event("scroll")); return 1; })()');
    await sleep(200);
    const top = await ch.js<number>('document.querySelector(".cv-stream").scrollTop');
    await growFoot(60);
    await sleep(300);
    assert.equal(await ch.js<number>('document.querySelector(".cv-stream").scrollTop'), top, 'a reader who scrolled up stays where they were');
  } finally {
    ch.close();
    srv.close();
    c.stop();
    for (const e of c.app.entries) e.host?.kill();
    await sleep(300);
    store.close();
  }
});
