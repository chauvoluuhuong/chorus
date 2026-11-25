// Mermaid diagrams in the page: the library is Chorus's own file (src/desktop/vendor), loaded once something has a diagram. Shared by
// the Chat view's replies and the file viewer (plan 2026-11-25): one loader, one cache of drawn diagrams. Elements to draw are
// `[data-mermaid]` with the source as `<code>` inside (md.js mdFull makes them); a diagram that can't be drawn keeps its source.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let mermaidP = null;
let dia = 0;
const drawn = new Map();

function loadMermaid(url) {
  return (mermaidP ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => res(window.mermaid);
    s.onerror = () => ((mermaidP = null), rej(new Error('mermaid did not load')));
    document.head.append(s);
  }).then(m => {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
    m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', fontFamily: 'inherit' });
    return m;
  }));
}

/** A mermaid source as the element `drawDiagrams` draws (a .mmd file in the viewer; md.js makes the same for a fence). */
export const diagramHtml = src => `<div class="cv-dia" data-mermaid><pre><code>${esc(src)}</code></pre></div>`;

/**
 * Draws every `[data-mermaid]` in `root` not drawn yet. `foot`: the line under a drawn diagram (the Chat view's "Full screen";
 * none in the file viewer, which is already full size).
 */
export async function drawDiagrams(root, { url, foot = '' }) {
  for (const el of root.querySelectorAll('[data-mermaid]:not([data-done])')) {
    el.dataset.done = '1';
    const src = el.querySelector('code')?.textContent ?? '';
    if (drawn.has(src)) {
      el.innerHTML = drawn.get(src) + foot;
      el.classList.add('ok');
      continue;
    }
    try {
      const m = await loadMermaid(url);
      const { svg } = await m.render(`cvd${++dia}`, src);
      drawn.set(src, svg);
      if (el.isConnected) {
        el.innerHTML = svg + foot;
        el.classList.add('ok');
      }
    } catch {
      // cannot be drawn: its source stays, as code
      el.classList.add('bad');
      document.getElementById(`dcvd${dia}`)?.remove();
    }
  }
}
