// Publisher notifications are checked once per desktop server launch, never on focus or a timer.
// This module owns the installation credential; the browser receives only cached content and read state.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export const NOTIFICATION_API = 'https://chorus-api-141661268347.asia-southeast1.run.app';
export interface NotificationItem { id: string; title: string; html: string; revision: number; publishedAt: string }
interface Event { id: string; type: 'received' | 'opened' }
interface Saved {
  installationId: string; installationKey: string; items: NotificationItem[];
  read: string[]; opened: string[]; received: string[]; pending: Event[]; checkedAt: string | null;
}
export interface NotificationOptions { directory: string; version: string; platform?: string; request?: typeof fetch; endpoint?: string }
function validItem(n: any): n is NotificationItem {
  return !!n && typeof n.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(n.id) && typeof n.title === 'string' && n.title.length <= 100 && typeof n.html === 'string' && Buffer.byteLength(n.html) <= 200_000 && Number.isSafeInteger(n.revision) && n.revision > 0 && typeof n.publishedAt === 'string' && Number.isFinite(Date.parse(n.publishedAt));
}
function queue(s: Saved, event: Event) {
  const old = s.pending.find(e => e.id === event.id);
  if (old) { if (event.type === 'opened') old.type = 'opened'; }
  else s.pending.push(event);
}
export class NotificationInbox {
  private o: NotificationOptions;
  private file: string;
  private saved: Saved;
  private once: Promise<void> | undefined;
  private controller = new AbortController();
  private checking = false;
  private offline = false;
  private sending = new Map<string, Promise<void>>();
  constructor(o: NotificationOptions) {
    this.o = o; this.file = path.join(o.directory, 'inbox.json');
    fs.mkdirSync(o.directory, { recursive: true, mode: 0o700 });
    try { this.saved = this.load(); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw new Error('Notification cache is unreadable; preserving it without registering another installation');
      const saved: Saved = { installationId: crypto.randomUUID(), installationKey: crypto.randomBytes(32).toString('base64url'), items: [], read: [], opened: [], received: [], pending: [], checkedAt: null };
      try { fs.writeFileSync(this.file, JSON.stringify(saved), { mode: 0o600, flag: 'wx' }); this.saved = saved; }
      catch (error: any) { if (error.code !== 'EEXIST') throw error; this.saved = this.load(); }
    }
    fs.chmodSync(this.file, 0o600);
  }
  private load(): Saved {
    const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (typeof s.installationId !== 'string' || typeof s.installationKey !== 'string' || !Array.isArray(s.items) || !s.items.every(validItem) || !Array.isArray(s.read) || !Array.isArray(s.opened) || !Array.isArray(s.pending) || s.pending.some((e: any) => !e || typeof e.id !== 'string' || !['received', 'opened'].includes(e.type))) throw new Error('Invalid cache');
    s.received ??= [];
    if (!Array.isArray(s.received)) throw new Error('Invalid receipt cache');
    return s;
  }
  private update(change: (s: Saved) => void) {
    // Refresh disk state before each synchronous update so another desktop window's queued events survive.
    const s = this.load(); change(s);
    s.read = [...new Set(s.read)].slice(-5000); s.opened = [...new Set(s.opened)].slice(-5000); s.received = [...new Set(s.received)].slice(-5000);
    const tmp = this.file + '.' + crypto.randomBytes(6).toString('hex');
    try { fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, this.file); }
    finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    this.saved = s;
  }
  summary() { return { unread: this.saved.items.filter(n => !this.saved.read.includes(n.id)).length, checkedAt: this.saved.checkedAt, checking: this.checking, offline: this.offline }; }
  snapshot() { return { ...this.summary(), items: this.saved.items.map(({ html: _html, ...n }) => ({ ...n, read: this.saved.read.includes(n.id) })) }; }
  content(id: string) { return this.saved.items.find(n => n.id === id); }
  private async post(route: string, body: object): Promise<any> {
    const response = await (this.o.request ?? fetch)((this.o.endpoint ?? NOTIFICATION_API) + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(8000)]) });
    if (!response.ok) throw new Error('Notification request failed');
    const chunks: Uint8Array[] = []; let bytes = 0;
    if (!response.body) throw new Error('Empty notification response');
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 12_000_000) { throw new Error('Notification response too large'); } chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  private credentials() { return { installationId: this.saved.installationId, installationKey: this.saved.installationKey }; }
  private acknowledge(sent: Event[], s: Saved) { s.received.push(...sent.map(e => e.id)); s.pending = s.pending.filter(e => !sent.some(old => old.id === e.id && old.type === e.type)); }
  startup(): Promise<void> {
    // A rejected launch request is also final for this process. No retry on UI requests, reconnect, or focus.
    return this.once ??= this.checkAtLaunch();
  }
  private async checkAtLaunch() {
    this.checking = true;
    const sent = this.saved.pending.slice(0, 100).map(e => ({ ...e }));
    try {
      const response = await this.post('/v1/startup', { ...this.credentials(), platform: this.o.platform ?? process.platform, appVersion: this.o.version, events: sent });
      if (!Array.isArray(response.notifications) || response.notifications.length > 50 || !response.notifications.every(validItem) || new Set(response.notifications.map((n: NotificationItem) => n.id)).size !== response.notifications.length || typeof response.checkedAt !== 'string' || !Number.isFinite(Date.parse(response.checkedAt))) throw new Error('Invalid notification feed');
      if (this.controller.signal.aborted) return;
      this.update(s => { this.acknowledge(sent, s); s.items = response.notifications.map((n: NotificationItem) => ({ id: n.id, title: n.title, html: n.html, revision: n.revision, publishedAt: n.publishedAt })); s.checkedAt = response.checkedAt; for (const n of s.items) if (!s.received.includes(n.id)) queue(s, { id: n.id, type: 'received' }); });
      this.offline = false;
    } catch { this.offline = true; }
    finally { this.checking = false; }
  }
  markAllRead() { this.update(s => { s.read.push(...s.items.map(n => n.id)); }); }
  async opened(id: string) {
    if (!this.content(id)) return;
    this.update(s => { s.read.push(id); if (!s.opened.includes(id)) { s.opened.push(id); queue(s, { id, type: 'opened' }); } });
    // If startup is still running, retain this event for the next launch. Never create an unregistered identity via /events.
    if (this.checking || !this.saved.pending.length || !this.saved.checkedAt) return;
    if (this.sending.has(id)) return this.sending.get(id); // Repeated clicks on this message share their in-flight delivery.
    const sent = [...this.saved.pending].sort((a, b) => Number(b.id === id) - Number(a.id === id)).slice(0, 100).map(e => ({ ...e }));
    const delivery = (async () => { try { await this.post('/v1/events', { ...this.credentials(), events: sent }); if (!this.controller.signal.aborted) this.update(s => this.acknowledge(sent, s)); } catch { /* Retain events until next launch or an explicit open. */ } })();
    this.sending.set(id, delivery);
    try { await delivery; } finally { this.sending.delete(id); }
  }
  allowsLink(id: string | undefined, value: string): boolean {
    if (value === 'https://chorus-cli.web.app/privacy') return true;
    const n = id && this.content(id); if (!n || value.length > 4096) return false;
    let target: URL; try { target = new URL(value); } catch { return false; }
    if (target.protocol !== 'https:' || target.username || target.password) return false;
    const decode = (s: string) => s.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi, entity => {
      const named: Record<string, string> = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
      if (entity[1] !== '#') return named[entity.toLowerCase()] ?? entity;
      const number = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
      return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
    });
    return [...n.html.matchAll(/<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi)].some(match => { try { return new URL(decode(match[1])).href === target.href; } catch { return false; } });
  }
  close() { this.controller.abort(); }
}
