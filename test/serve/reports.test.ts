// A report from the Doctor's dialog goes to the admin backend (plan 2026-11-13): src/serve/reports.ts against a fake backend.
import assert from 'node:assert/strict';
import http from 'node:http';
import type net from 'node:net';
import { test } from 'node:test';
import { imageType, MAX_IMAGE_BYTES, parseReport, ReportSender, type Report } from '../../src/serve/reports.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const creds = () => ({ installationId: 'inst-1', installationKey: 'k'.repeat(43) });

/** A backend that records what it gets; `mode` changes how it answers. */
async function backend() {
  const seen: { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
  let mode: 'ok' | 'down' | 'limit' | 'error' | 'image-fails' = 'ok';
  const srv = http.createServer((req, res) => {
    if (mode === 'down') return void req.socket.destroy();
    const parts: Buffer[] = [];
    req.on('data', d => parts.push(d));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(parts) });
      const json = (code: number, v: object) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
      if (req.url === '/v1/reports') return mode === 'limit' ? json(429, { error: 'Five reports a day from one installation.' }) : mode === 'error' ? json(503, { error: 'busy' }) : json(201, { id: 'abc', ref: 'R-7K2F9' });
      if (mode === 'image-fails' && req.url?.endsWith('/2')) return json(500, { error: 'disk' });
      json(200, { ok: true });
    });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`, seen, set: (m: typeof mode) => (mode = m), close: () => srv.close() };
}

test('imageType reads the first bytes, never the name', () => {
  assert.equal(imageType(PNG), 'image/png');
  assert.equal(imageType(JPG), 'image/jpeg');
  assert.equal(imageType(WEBP), 'image/webp');
  assert.equal(imageType(Buffer.from('GIF89a')), undefined);
  assert.equal(imageType(Buffer.from('<svg')), undefined);
});

test('parseReport: text, email, setup and up to 4 images; refuses what the backend would', () => {
  const b64 = (b: Buffer) => b.toString('base64');
  const ok = parseReport({ title: '  Codex   prompt ', what: 'it hung', details: '### Chorus', email: ' me@example.com ', setup: { appVersion: '2.4.0' }, images: [{ data: `data:image/png;base64,${b64(PNG)}` }, { data: b64(JPG) }] }) as Report;
  assert.equal(ok.title, 'Codex prompt');
  assert.equal(ok.email, 'me@example.com');
  assert.deepEqual(ok.images.map(i => i.type), ['image/png', 'image/jpeg']);
  assert.deepEqual(ok.setup, { appVersion: '2.4.0' });
  assert.equal('email' in (parseReport({ details: 'x', email: '' }) as Report), false);
  assert.match((parseReport({ details: 'x', email: 'nope' }) as { error: string }).error, /email/);
  assert.match((parseReport({ details: 'x', images: Array(5).fill({ data: b64(PNG) }) }) as { error: string }).error, /At most 4/);
  assert.match((parseReport({ details: 'x', images: [{ data: b64(Buffer.from('GIF89a......')) }] }) as { error: string }).error, /Screenshot 1 is not a PNG/);
  assert.match((parseReport({ details: 'x', images: [{ data: b64(Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)])) }] }) as { error: string }).error, /too large/);
  assert.match((parseReport({ details: 'x', what: 'w'.repeat(5001) }) as { error: string }).error, /too long/);
  assert.match((parseReport({}) as { error: string }).error, /Say what happened/);
});

test('ReportSender: POST /v1/reports with the installation ID and key, then PUT each image; the reference comes back', async t => {
  const be = await backend();
  t.after(() => be.close());
  const s = new ReportSender({ endpoint: be.url, credentials: creds, version: '2.4.1', platform: 'darwin' });
  const report = parseReport({ title: 'T', what: 'W', details: 'D', email: 'me@example.com', setup: { channel: 'preview' }, images: [{ data: PNG.toString('base64') }, { data: WEBP.toString('base64') }] }) as Report;
  const r = await s.send(report);
  assert.deepEqual(r, { ok: true, id: 'abc', ref: 'R-7K2F9', images: 2, failed: 0 });
  const [post, ...puts] = be.seen;
  assert.equal(post.method, 'POST');
  assert.deepEqual(JSON.parse(post.body.toString()), { installationId: 'inst-1', installationKey: 'k'.repeat(43), title: 'T', what: 'W', details: 'D', setup: { channel: 'preview' }, email: 'me@example.com', platform: 'darwin', appVersion: '2.4.1', imageCount: 2 });
  assert.deepEqual(puts.map(p => [p.method, p.url, p.headers['content-type'], p.headers['x-installation-id'], p.headers['x-installation-key']?.length]), [
    ['PUT', '/v1/reports/abc/images/1', 'image/png', 'inst-1', 43],
    ['PUT', '/v1/reports/abc/images/2', 'image/webp', 'inst-1', 43],
  ]);
  assert.ok(puts[0].body.equals(PNG));
});

test('ReportSender: not reached, rate limit, a backend error, and a screenshot that does not arrive', async t => {
  const be = await backend();
  t.after(() => be.close());
  const s = new ReportSender({ endpoint: be.url, credentials: creds, version: '2.4.1', timeoutMs: 3000 });
  const one = parseReport({ details: 'D', images: [{ data: PNG.toString('base64') }, { data: JPG.toString('base64') }] }) as Report;
  be.set('down');
  assert.deepEqual(await s.send(one), { error: 'the Chorus service could not be reached', offline: true });
  be.set('error');
  assert.equal((await s.send(one) as { offline?: boolean }).offline, true, 'a 5xx reads as not reached: Try again');
  be.set('limit');
  assert.deepEqual(await s.send(one), { error: 'Five reports a day from one installation.' });
  be.set('image-fails');
  be.seen.length = 0;
  assert.deepEqual(await s.send(one), { ok: true, id: 'abc', ref: 'R-7K2F9', images: 1, failed: 1 });
  assert.equal(be.seen.filter(x => x.url.endsWith('/images/2')).length, 2, 'tried once more');
  // nobody listening at all
  const nowhere = new ReportSender({ endpoint: 'http://127.0.0.1:9', credentials: creds, version: '2.4.1' });
  assert.equal((await nowhere.send(one) as { offline?: boolean }).offline, true);
  // no installation ID could be read: said, nothing sent
  const broken = new ReportSender({ endpoint: be.url, credentials: () => { throw new Error('unreadable cache'); }, version: '2.4.1' });
  assert.match((await broken.send(one) as { error: string }).error, /installation ID: unreadable cache/);
});
