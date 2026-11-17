// A small, safe Markdown renderer for an agent's question details (request_approval). All HTML is escaped first; then only a
// subset is formatted: paragraphs, lists, bold, emphasis, code, fenced code blocks, #/## headings as bold lines, line breaks
// and http(s) links. No raw HTML, no images.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Inline formatting on one already-escaped line: code first (its text is left as it is), then links, bold, emphasis. */
function inline(s, links = true) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  if (links)
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, text, url) =>
      // the URL is already escaped; only http(s) becomes a link, anything else (javascript:, data:) stays plain text
      /^https?:\/\//i.test(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>` : all,
    );
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

/** One line of text with inline formatting only (bold and code; no blocks, no links): a question's title. */
export function mdInline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

/** Markdown (the safe subset above) to HTML. */
export function md(text) {
  const lines = esc(String(text ?? '').replace(/\r\n?/g, '\n')).split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag, items }
  const flushPara = () => para.length && (out.push(`<p>${para.map(l => inline(l)).join('<br>')}</p>`), (para = []));
  const flushList = () => list && (out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`), (list = null));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = /^\s*```/.test(l);
    if (fence) {
      flushPara();
      flushList();
      const code = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    if (!l.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^\s*#{1,6}\s+(.*)$/.exec(l);
    if (h) {
      flushPara();
      flushList();
      out.push(`<p class="md-h"><b>${inline(h[1])}</b></p>`);
      continue;
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(l);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(l);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list?.tag !== tag) (flushList(), (list = { tag, items: [] }));
      list.items.push((ul ?? ol)[1]);
      continue;
    }
    // a line right under a list item continues that item
    if (list && /^\s+\S/.test(l)) {
      list.items[list.items.length - 1] += `<br>${l.trim()}`;
      continue;
    }
    flushList();
    para.push(l);
  }
  flushPara();
  flushList();
  return out.join('');
}
