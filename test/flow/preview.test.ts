import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PreviewServer } from '../../src/core/preview.ts';
import { Store } from '../../src/core/store.ts';

const get = (url: string) =>
  new Promise<{ status: number; type: string; body: string }>(resolve => {
    http.get(url, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, type: String(res.headers['content-type']), body }));
    });
  });

function rig() {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-prev-'));
  const store = new Store(proj);
  store.createThread({ id: 't_a', title: 'cake page', agent: 'claude', cwd: proj });
  const dir = store.artifactsDir('t_a');
  fs.writeFileSync(path.join(dir, 'order.html'), '<html><body><h1>v1</h1></body></html>');
  fs.writeFileSync(path.join(dir, 'notes.md'), '# notes <b>raw</b>');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'a b.txt'), 'deep');
  store.scanArtifacts('t_a');
  fs.writeFileSync(path.join(proj, 'secret.txt'), 'secret');
  return { store, dir, proj };
}

test('preview: serves artifacts, injects live reload into html and shows text files readably', async () => {
  const { store } = rig();
  const srv = new PreviewServer(store);
  const url = await srv.start(0);
  try {
    const html = await get(srv.urlFor('t_a', 'order.html'));
    assert.equal(html.status, 200);
    assert.match(html.type, /text\/html/);
    assert.match(html.body, /<h1>v1<\/h1>/);
    assert.match(html.body, /EventSource\('\/__events'\)/);
    const md = await get(`${url}/t_a/notes.md`);
    assert.match(md.body, /# notes &lt;b>raw&lt;\/b>/, 'escaped, not interpreted');
    assert.equal((await get(srv.urlFor('t_a', path.join('sub', 'a b.txt')))).body.includes('deep'), true);
    assert.match((await get(url)).body, /cake page · order\.html/);
  } finally {
    srv.close();
    store.close();
  }
});

test('preview: nothing outside the artifacts folder is served', async () => {
  const { store } = rig();
  const srv = new PreviewServer(store);
  const url = await srv.start(0);
  try {
    for (const p of ['/t_a/../../secret.txt', '/t_a/%2e%2e/%2e%2e/secret.txt', '/nope/order.html', '/t_a/missing.html']) {
      const r = await get(url + p);
      assert.equal(r.status, 404, p);
      assert.ok(!r.body.includes('secret'), p);
    }
  } finally {
    srv.close();
    store.close();
  }
});

test('preview: the page is told to reload when the agent edits the file', async () => {
  const { store, dir } = rig();
  const srv = new PreviewServer(store);
  const url = await srv.start(0);
  try {
    const events: string[] = [];
    const req = http.get(url + '/__events', res => res.on('data', d => events.push(String(d))));
    await new Promise(r => setTimeout(r, 300));
    fs.writeFileSync(path.join(dir, 'order.html'), '<html><body><h1>v2</h1></body></html>');
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !events.join('').includes('order.html')) await new Promise(r => setTimeout(r, 100));
    req.destroy();
    assert.match(events.join(''), /"thread":"t_a","path":"order\.html"/);
    assert.match((await get(srv.urlFor('t_a', 'order.html'))).body, /<h1>v2<\/h1>/);
  } finally {
    srv.close();
    store.close();
  }
});
