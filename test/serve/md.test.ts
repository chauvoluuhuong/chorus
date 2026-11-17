// The ask card's Markdown (src/desktop/md.js): everything is escaped first, then only a safe subset is formatted.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a page module, plain JavaScript
import { md, mdInline } from '../../src/desktop/md.js';

test('HTML stays text: a script tag is escaped, never markup', () => {
  const h = md('Hi <script>alert(1)</script> & <img src=x onerror=y>');
  assert.equal(h, '<p>Hi &lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;img src=x onerror=y&gt;</p>');
  assert.ok(!/<script|<img/.test(md('```\n<script>x</script>\n```')));
});

test('paragraphs, line breaks and headings', () => {
  assert.equal(md('one\ntwo\n\nthree'), '<p>one<br>two</p><p>three</p>');
  assert.equal(md('# Title\nbody'), '<p class="md-h"><b>Title</b></p><p>body</p>');
});

test('bullet and numbered lists', () => {
  assert.equal(md('- a\n* b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(md('Pick:\n1. one\n2. two'), '<p>Pick:</p><ol><li>one</li><li>two</li></ol>');
});

test('bold, emphasis, code and code blocks', () => {
  assert.equal(md('**big** and *soft* and `x*y*z`'), '<p><b>big</b> and <em>soft</em> and <code>x*y*z</code></p>');
  assert.equal(md('```js\nconst a = 1 < 2;\n```'), '<pre><code>const a = 1 &lt; 2;</code></pre>');
});

test('http(s) links open in a new tab; a javascript: link stays plain text', () => {
  assert.equal(md('[docs](https://example.com/a?b=1&c=2)'), '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">docs</a></p>');
  const bad = md('[click](javascript:alert(1))');
  assert.ok(!bad.includes('<a'), bad);
  assert.ok(bad.includes('[click](javascript:alert(1))'));
  assert.ok(!md('![img](https://x/y.png)').includes('<img'));
});

test('a question title: bold and code only, no blocks or links', () => {
  assert.equal(mdInline('Merge **now**? `dev` <b>'), 'Merge <b>now</b>? <code>dev</code> &lt;b&gt;');
  assert.equal(mdInline('- [a](https://x)'), '- [a](https://x)');
});
