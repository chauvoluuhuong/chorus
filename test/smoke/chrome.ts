// The Chrome driver of the e2e proofs: headless Chrome over the DevTools protocol, with real mouse clicks and key presses, like a
// person. Used by `npm run proof:desktop` and, from chorus-core, the 2.0 harness.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const KEYS: Record<string, [number, string]> = { Enter: [13, '\r'], ArrowUp: [38, ''], ArrowDown: [40, ''], Escape: [27, ''] };

export interface ChromeOpts {
  /** where screenshots go */
  out: string;
  width: number;
  height: number;
  log?: (s: string) => void;
}

export async function openChrome({ out, width, height, log = () => {} }: ChromeOpts) {
  const shots: { file: string; caption: string }[] = [];
  const freePort = () => new Promise<number>(r => { const s = net.createServer().listen(0, () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)); }); });
  const cdpPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-desk-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
  process.on('exit', () => chrome.kill());
  let pageWs = '';
  for (let i = 0; i < 60 && !pageWs; i++) {
    await sleep(250);
    try {
      const list = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      pageWs = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
    } catch {
      /* not up yet */
    }
  }
  const ws = new WebSocket(pageWs, { perMessageDeflate: false });
  await new Promise(r => ws.once('open', r));
  let seq = 0;
  const waiters = new Map<number, (m: any) => void>();
  ws.on('message', d => {
    const m = JSON.parse(String(d));
    if (m.id && waiters.has(m.id)) {
      waiters.get(m.id)!(m);
      waiters.delete(m.id);
    }
  });
  function cdp(method: string, params: object = {}): Promise<any> {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => waiters.set(id, m => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))));
  }
  async function js<T = any>(expr: string): Promise<T> {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${expr.slice(0, 80)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value as T;
  }
  await cdp('Page.enable');
  await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const scheme = (value: 'light' | 'dark') => cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
  await scheme('light');

  let n = 0;
  /** the next file number, for a picture that does not come from this page */
  const nextShot = () => ++n;
  async function shot(slug: string, caption: string) {
    await sleep(350); // let the last frame paint
    const file = `${String(nextShot()).padStart(2, '0')}-${slug}.png`;
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, file), Buffer.from(data, 'base64'));
    shots.push({ file, caption });
    log(`  📷 ${file}`);
  }
  async function until(pred: () => Promise<boolean> | boolean, ms: number, tick = 400) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try {
        if (await pred()) return true;
      } catch {
        /* the page may be reloading */
      }
      await sleep(tick);
    }
    return false;
  }
  /** a real mouse click in the middle of the first element that matches (and whose text matches) */
  async function click(sel: string, text?: string | RegExp): Promise<boolean> {
    const re = text instanceof RegExp ? text.source : text ? text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
    const at = await js<{ x: number; y: number } | null>(`(() => {
    const els = [...document.querySelectorAll(${JSON.stringify(sel)})].filter(e => e.offsetParent !== null && ${re ? `new RegExp(${JSON.stringify(re)}).test(e.textContent)` : 'true'});
    const e = els[0]; if (!e) return null;
    e.scrollIntoView({ block: 'nearest' });
    const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })()`);
    if (!at) return false;
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
    await sleep(300);
    return true;
  }
  async function key(k: keyof typeof KEYS) {
    const [vk, text] = KEYS[k];
    await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
    await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(150);
  }
  /** types like a person: text, a pause, then Enter apart (TUIs read text + Enter in one chunk as a paste) */
  async function typeLine(text: string, enter = true) {
    await cdp('Input.insertText', { text });
    await sleep(600);
    if (enter) await key('Enter');
  }
  const has = (sel: string, re: RegExp) => js<boolean>(`[...document.querySelectorAll(${JSON.stringify(sel)})].some(e => new RegExp(${JSON.stringify(re.source)}).test(e.textContent))`);
  const close = () => {
    ws.close();
    chrome.kill();
  };
  return { cdp, js, scheme, shot, shots, nextShot, until, click, key, typeLine, has, close };
}
