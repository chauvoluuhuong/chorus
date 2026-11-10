// The size checks of `npm run proof:desktop -- --sizes` (docs/features/responsive.md), shared with chorus-core's Pro harness
// (its test/pro-e2e/checks/sizes.ts): the page at a phone, a tablet and a desktop size over the DevTools protocol, and what must
// hold on each screen. Shadow roots (the optional module's screens) are checked too.

/** The three sizes of the plan: phone ≤ 640 · tablet 641–1024 · desktop ≥ 1025. Phone and tablet are touch screens. */
export const SIZES = {
  phone: { width: 390, height: 844, touch: true },
  tablet: { width: 820, height: 1180, touch: true },
  desktop: { width: 1280, height: 800, touch: false },
} as const;
export type Size = keyof typeof SIZES;
export type Scheme = 'light' | 'dark';

interface Chrome {
  cdp: (method: string, params?: object) => Promise<any>;
  js: <T = any>(expr: string) => Promise<T>;
}

/** Emulates the device: its viewport, touch (which makes `(hover: none)` and `(pointer: coarse)` match), and light or dark. */
export async function setSize(chrome: Chrome, size: Size, scheme: Scheme) {
  const s = SIZES[size];
  await chrome.cdp('Emulation.setDeviceMetricsOverride', { width: s.width, height: s.height, deviceScaleFactor: s.touch ? 2 : 1, mobile: s.touch });
  await chrome.cdp('Emulation.setTouchEmulationEnabled', { enabled: s.touch, maxTouchPoints: s.touch ? 5 : 1 });
  await chrome.cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
}

export interface Problems {
  /** the page, or the screen's own scroller, scrolls sideways */
  overflow: string[];
  /** a visible control sticks out of the screen (not inside something that scrolls sideways on purpose) */
  cut: string[];
  /** touch: a control under 36 px tall, a list, sheet or tab-bar row under 44 */
  small: string[];
  /** touch: a text field whose text is under 16 px (iOS zooms in on focus) */
  font: string[];
}

/** Runs in the page. Rows: what the plan holds to 44 px. */
const IN_PAGE = String.raw`(touch) => {
  const ROWS = '.chat-row, .proj, #tabs > button:not(.newtab), .sheet button, .hm-row, .mrow, .nc-menu > button, .nav button, .news-row';
  const out = { overflow: [], cut: [], small: [], font: [] };
  const W = innerWidth;
  const name = el => {
    const t = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + cls + (t ? ' "' + t + '"' : '');
  };
  const parent = el => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  const all = [];
  const walk = root => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot); } };
  walk(document);
  const shown = el => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    for (let p = el; p; p = parent(p)) {
      if (p.nodeType !== 1) continue;
      const cs = getComputedStyle(p);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return null;
    }
    return r;
  };
  // something that scrolls sideways on purpose (the Portal's board, a code block, the filters): what is in it may go past the edge
  const sideways = el => {
    for (let p = parent(el); p && p !== document.documentElement; p = parent(p)) {
      if (p.nodeType !== 1) continue;
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
    }
    return false;
  };
  if (document.documentElement.scrollWidth > W + 1) out.overflow.push('the page is ' + document.documentElement.scrollWidth + ' px wide');
  for (const el of all) {
    if (!(el instanceof HTMLElement) || !shown(el)) continue;
    const cs = getComputedStyle(el);
    // the screen's own scroller (the view, a Pro page) must not scroll sideways
    if ((el.id === 'view' || el.id === 'wrap' || el.classList.contains('drawer-body') || el.classList.contains('sheet')) && el.scrollWidth > el.clientWidth + 1 && cs.overflowX !== 'hidden')
      out.overflow.push(name(el) + ' scrolls sideways: ' + el.scrollWidth + ' > ' + el.clientWidth);
  }
  const controls = all.filter(el => el instanceof HTMLElement && (el.matches('button, select, textarea, [role=button], [role=tab]') || (el.matches('input') && !/^(checkbox|radio|hidden|range|file)$/.test(el.type)) || (el.matches('a[href], a[data-act]') && getComputedStyle(el).display !== 'inline')));
  for (const el of controls) {
    if (el.closest('.xterm, .term-wrap, .drop-over') || el.disabled && el.matches('select')) continue;
    const r = shown(el);
    if (!r) continue;
    if ((r.right > W + 1 || r.left < -1) && !sideways(el)) out.cut.push(name(el) + ' ' + Math.round(r.left) + '–' + Math.round(r.right));
    // a zoomable canvas (Processes on a tablet): its controls grow with pinch, so their size is not the screen's
    if (!touch || el.closest('.stage')) continue;
    const need = el.matches(ROWS) ? 44 : 36;
    if (r.height < need - 0.5) out.small.push(name(el) + ' ' + Math.round(r.height) + ' px (needs ' + need + ')');
    if (el.matches('input, textarea, select') && parseFloat(getComputedStyle(el).fontSize) < 16) out.font.push(name(el) + ' ' + getComputedStyle(el).fontSize);
  }
  return out;
}`;

/** What breaks the rules on the screen in front, at the size set last. */
export async function problems(chrome: Chrome, touch: boolean): Promise<Problems> {
  return chrome.js<Problems>(`(${IN_PAGE})(${touch})`);
}

export const summary = (p: Problems) =>
  (Object.entries(p) as [keyof Problems, string[]][])
    .filter(([, list]) => list.length)
    .map(([k, list]) => `${k}: ${[...new Set(list)].slice(0, 6).join('; ')}${list.length > 6 ? ` (+${list.length - 6})` : ''}`)
    .join(' | ');

/** The share of pixels that differ between two screenshots of the same size (0..1), measured in the page's own canvas. */
export async function pixelDiff(chrome: Chrome, a: Buffer, b: Buffer): Promise<number> {
  return chrome.js<number>(`(async () => {
    const load = src => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const [x, y] = await Promise.all([load('data:image/png;base64,${a.toString('base64')}'), load('data:image/png;base64,${b.toString('base64')}')]);
    if (x.width !== y.width || x.height !== y.height) return 1;
    const px = img => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
    const p = px(x), q = px(y);
    let n = 0;
    for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2]) > 24) n++;
    return n / (p.length / 4);
  })()`);
}
