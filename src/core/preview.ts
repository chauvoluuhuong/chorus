// Artifact preview: a tiny local web server (127.0.0.1 only) that serves a thread's artifacts and reloads the page
// when the agent edits the file (docs/mockups: "Open one in the browser and it reloads while the agent keeps editing it").
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Store } from './store.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
};

const RELOAD = `<script>(function(){var p=decodeURIComponent(location.pathname);var e=new EventSource('/__events');e.onmessage=function(m){try{var d=JSON.parse(m.data);if(p.endsWith('/'+d.path))location.reload()}catch(x){location.reload()}}})()</script>`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export class PreviewServer {
  readonly store: Store;
  url = '';
  private server: http.Server | undefined;
  private clients = new Set<http.ServerResponse>();
  private watcher: fs.FSWatcher | undefined;
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(store: Store) {
    this.store = store;
  }

  /** Listens on the preferred port if free, otherwise on any free one. */
  async start(preferred = 4317): Promise<string> {
    if (this.server) return this.url;
    const listen = (port: number) =>
      new Promise<http.Server>((resolve, reject) => {
        const s = http.createServer((req, res) => this.handle(req, res));
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => resolve(s));
      });
    try {
      this.server = await listen(preferred);
    } catch {
      this.server = await listen(0);
    }
    this.url = `http://localhost:${(this.server.address() as AddressInfo).port}`;
    const root = path.join(this.store.root, 'threads');
    fs.mkdirSync(root, { recursive: true });
    try {
      this.watcher = fs.watch(root, { recursive: true }, (_e, file) => file && this.changed(String(file)));
    } catch {
      /* no recursive watching on this platform: pages reload on manual refresh */
    }
    return this.url;
  }

  close() {
    this.watcher?.close();
    for (const c of this.clients) c.end();
    this.server?.close();
    this.server = undefined;
  }

  urlFor(threadId: string, rel: string) {
    return `${this.url}/${threadId}/${rel.split(path.sep).map(encodeURIComponent).join('/')}`;
  }

  private changed(file: string) {
    // <thread>/artifacts/<rel>
    const m = file.split(path.sep);
    if (m[1] !== 'artifacts' || m.length < 3) return;
    const rel = m.slice(2).join('/');
    clearTimeout(this.timers.get(file));
    this.timers.set(
      file,
      setTimeout(() => {
        for (const c of this.clients) c.write(`data: ${JSON.stringify({ thread: m[0], path: rel })}\n\n`);
      }, 120),
    );
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    if (url.pathname === '/__events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': ok\n\n');
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }
    if (!parts.length) return this.index(res);
    const [threadId, ...rest] = parts;
    const base = path.resolve(this.store.artifactsDir(threadId));
    const file = path.resolve(base, ...rest);
    if (!this.store.getThread(threadId) || !(file === base || file.startsWith(base + path.sep))) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return void res.end('not found');
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return void res.end('not found');
    }
    if (st.isDirectory()) return this.index(res, threadId);
    const ext = path.extname(file).toLowerCase();
    const type = TYPES[ext];
    if (ext === '.html' || ext === '.htm') {
      const html = fs.readFileSync(file, 'utf8');
      res.writeHead(200, { 'content-type': type });
      return void res.end(/<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${RELOAD}</body>`) : html + RELOAD);
    }
    if (!type) {
      // markdown and other text: show it readably, with the same live reload
      const text = fs.readFileSync(file, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return void res.end(`<!doctype html><meta charset="utf-8"><title>${esc(rest.join('/'))}</title><style>body{font:14px/1.5 ui-monospace,Menlo,monospace;max-width:90ch;margin:24px auto;padding:0 16px;white-space:pre-wrap}</style>${esc(text)}${RELOAD}`);
    }
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(file).pipe(res);
  }

  private index(res: http.ServerResponse, only?: string) {
    const rows = this.store.listArtifacts(only);
    const items = rows.map(a => `<li><a href="/${a.thread_id}/${a.path.split(path.sep).map(encodeURIComponent).join('/')}">${esc(this.store.getThread(a.thread_id)?.title ?? a.thread_id)} · ${esc(a.path)}</a> <small>${a.version}</small></li>`).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>Chorus artifacts</title><style>body{font:15px/1.6 system-ui;max-width:70ch;margin:32px auto;padding:0 16px}small{color:#888}</style><h1>Chorus artifacts</h1><ul>${items || '<li>No artifacts yet.</li>'}</ul>`);
  }
}
