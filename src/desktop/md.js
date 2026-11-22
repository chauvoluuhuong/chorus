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

/* ---------- the Chat view's replies (plan 2026-11-22 chat-view): what agents write ----------
   Headings, nested lists, tables, block quotes, rules, fenced code (a `mermaid` fence becomes a diagram placeholder the view draws),
   links, bold, emphasis and code. Escaped first, as md(); no raw HTML, no images. md() above stays as it is for the question cards. */

const cell = s => inline(s.trim());
const isRow = l => /^\s*\|.*\|\s*$/.test(l);
const isRule = l => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const splitRow = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');

/** Lists with nesting by indentation: lines of `- x` / `1. x`, each with its indent. */
function listHtml(items) {
  let html = '';
  const stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      html += `<${it.tag}>`;
      stack.push({ indent: it.indent, tag: it.tag });
    } else if (top.tag !== it.tag) {
      html += `</li></${stack.pop().tag}><${it.tag}>`;
      stack.push({ indent: it.indent, tag: it.tag });
    } else html += '</li>';
    html += `<li>${inline(it.text)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html.replace(/<(ul|ol)><\/li>/g, '<$1>');
}

/** A reply as the Chat view shows it. Mermaid fences come out as `<div class="cv-dia" data-mermaid>` with the source as code inside. */
export function mdFull(text) {
  const lines = esc(String(text ?? '').replace(/\r\n?/g, '\n')).split('\n');
  const out = [];
  let para = [];
  let items = [];
  let quote = [];
  const flushPara = () => para.length && (out.push(`<p>${para.map(l => inline(l)).join('<br>')}</p>`), (para = []));
  const flushList = () => items.length && (out.push(listHtml(items)), (items = []));
  const flushQuote = () => quote.length && (out.push(`<blockquote>${mdFull(quote.join('\n').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'))}</blockquote>`), (quote = []));
  const flush = () => (flushPara(), flushList(), flushQuote());
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(l);
    if (fence) {
      flush();
      const code = [];
      const close = new RegExp(`^\\s*${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      for (i++; i < lines.length && !close.test(lines[i]); i++) code.push(lines[i]);
      const lang = fence[2].toLowerCase();
      if (lang === 'mermaid') out.push(`<div class="cv-dia" data-mermaid><pre><code>${code.join('\n')}</code></pre></div>`);
      else out.push(`<pre${lang ? ` data-lang="${lang}"` : ''}><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    if (!l.trim()) {
      flush();
      continue;
    }
    // a table: a row of cells, then a rule of dashes
    if (isRow(l) && i + 1 < lines.length && isRule(lines[i + 1])) {
      flush();
      const head = splitRow(l);
      const rows = [];
      for (i += 2; i < lines.length && isRow(lines[i]); i++) rows.push(splitRow(lines[i]));
      i--;
      out.push(`<div class="cv-table"><table><thead><tr>${head.map(h => `<th>${cell(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${head.map((_, k) => `<td>${cell(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      flush();
      const n = Math.min(6, h[1].length + 2);
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) {
      flush();
      out.push('<hr>');
      continue;
    }
    const q = /^\s*&gt;\s?(.*)$/.exec(l);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]);
      continue;
    }
    flushQuote();
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) {
      flushPara();
      items.push({ indent: li[1].replace(/\t/g, '    ').length, tag: /\d/.test(li[2]) ? 'ol' : 'ul', text: li[3] });
      continue;
    }
    // a line right under a list item continues that item
    if (items.length && /^\s+\S/.test(l)) {
      items[items.length - 1].text += ` ${l.trim()}`;
      continue;
    }
    flushList();
    para.push(l);
  }
  flush();
  return out.join('');
}
