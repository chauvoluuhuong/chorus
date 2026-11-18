// Follow Chorus (task #13, @workspace/mockups/doctor-tip.html): the follow modal and the Doctor page's Help shape Chorus card.
import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error: a page module, plain JavaScript
import { followHtml, shapeCardHtml, FOLLOW_LINKS, YOUTUBE_URL, FACEBOOK_URL } from '../../src/desktop/follow.js';
import { FOLLOW_LINKS as SERVER_LINKS } from '../../src/serve/server.ts';

test('the follow modal: both channels as plain links that open a new tab, and its three texts', () => {
  const html = followHtml();
  assert.equal(YOUTUBE_URL, 'https://www.youtube.com/@luuhuongtech?sub_confirmation=1');
  assert.equal(FACEBOOK_URL, 'https://www.facebook.com/luuhuongtech/');
  for (const url of [YOUTUBE_URL, FACEBOOK_URL]) assert.ok(html.includes(`href="${url}" target="_blank" rel="noopener"`), url);
  assert.ok(html.includes('Thanks for trying Chorus!'));
  assert.ok(html.includes('Follow us to share ideas and bug reports. Each one makes Chorus better.'));
  assert.ok(html.includes('Maybe later'));
  assert.ok(html.includes('>Subscribe</a>') && html.includes('>Follow</a>'));
  assert.ok(!html.includes('Command copied'), 'the landing page banner stays on the landing page');
  assert.equal((html.match(/data-x="cancel"/g) ?? []).length, 2, '× and Maybe later close it');
});

test('the Doctor page card opens the modal; the server opens the same two links', () => {
  const card = shapeCardHtml();
  assert.ok(card.includes('Help shape Chorus') && card.includes('Follow us to share ideas and bug reports.'));
  assert.ok(card.includes('data-act="follow-open"') && card.includes('♥ Follow Chorus'));
  assert.deepEqual({ ...SERVER_LINKS }, { ...FOLLOW_LINKS });
});
