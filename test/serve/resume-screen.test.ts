// After a restart, opening a chat by its address resumes it and its screen reaches the window (proof:desktop step 8, on the fake TUI):
// the mail watchdog's terminal guard and the stale-turn look must not keep a resumed chat's screen away. Headless Chrome; skipped without.
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
const FAKE = path.join(path.resolve(import.meta.dirname, '../..'), 'tools/fake-agent/fake-tui.mjs');

test('a chat opened by its address after a restart resumes and shows its screen', { skip: !fs.existsSync(CHROME) && 'no Chrome', timeout: 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-rs-home-'));
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-rs-')));
  const serve = async () => {
    const store = new Store(project, { home });
    const c = new Controller({ project, store, app: headlessApp(), tailPollMs: 100, opener: async () => ({ ok: true }), launcher: (agent, l) => ({ bin: process.execPath, args: [FAKE, agent], cwd: l.cwd }) });
    c.restore();
    const srv = new ChorusServer({ controller: c, token: 'g'.repeat(48), check: async () => ({ node: { version: '22', ok: true }, platform: 'test', agents: [], ms: 1 }) as any });
    await srv.start(0);
    return { store, c, srv, done: async () => (srv.close(), c.stop(), c.app.entries.forEach(e => e.host?.kill()), await sleep(200), store.close()) };
  };
  const a = await serve();
  const r = await fetch(`${a.srv.url}/api/chats`, { method: 'POST', headers: { authorization: `Bearer ${a.srv.token}`, 'x-chorus': '1', 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'claude', folder: project }) });
  const id = ((await r.json()) as { id: string }).id;
  a.store.updateThread(id, { native_session_id: 'sess-1', state: 'working' });
  await a.done();
  const b = await serve();
  const ch = await openChrome({ out: fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-rs-shots-')), width: 1280, height: 800 });
  try {
    await ch.cdp('Page.navigate', { url: `${b.srv.openUrl}#/chat/${id}` });
    const shown = await ch.until(() => ch.js<boolean>('(() => { const b = window.chorus.term.buffer.active; let t = ""; for (let y = 0; y < b.length; y++) t += (b.getLine(y)?.translateToString(true) ?? "") + "\\n"; return /READY claude/.test(t); })()'), 20_000);
    assert.ok(shown, 'the resumed screen is in the window');
  } finally {
    ch.close();
    await b.done();
  }
});
