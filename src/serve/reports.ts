// A report from the Doctor's Report issue dialog goes to the Chorus team's admin page, not to GitHub (plan 2026-11-13, report
// issue with images). The page sends it here; chorus serve sends it on to the backend in two kinds of request: POST /v1/reports
// (the text, with the installation ID and key) answers { id, ref }, then PUT /v1/reports/<id>/images/<n> per screenshot (raw
// bytes). The page never talks to the backend. A report is user-started, so it is sent even when notifications are off; the
// installation ID is the notifications' one (chorus-admin docs/client-contract.md, "User-started report").
import { NOTIFICATION_API } from './notifications.ts';

export const MAX_IMAGES = 4;
/** The backend's cap per image; the page scales each one to about 1 MB first. */
export const MAX_IMAGE_BYTES = 1_500_000;
export const LIMITS = { title: 200, what: 5000, details: 60_000, email: 200 } as const;

export type ImageType = 'image/png' | 'image/jpeg' | 'image/webp';
/** The image's type from its first bytes (never from its name or what the page says). */
export function imageType(b: Uint8Array): ImageType | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return undefined;
}

export interface Report {
  title: string;
  what: string;
  details: string;
  setup: Record<string, unknown>;
  email?: string;
  images: { type: ImageType; bytes: Buffer }[];
}

/** What the page sent (`POST /api/doctor/issue/send`): text, the optional email, the setup and up to 4 images as base64. */
export function parseReport(b: Record<string, any>): Report | { error: string } {
  const text = (k: 'title' | 'what' | 'details') => (typeof b[k] === 'string' ? b[k] : '');
  if (!text('details').trim() && !text('what').trim() && !text('title').trim()) return { error: 'Say what happened before sending.' };
  for (const k of ['title', 'what', 'details'] as const) if (text(k).length > LIMITS[k]) return { error: `The ${k === 'what' ? 'text of what happened' : k} is too long (at most ${LIMITS[k].toLocaleString('en')} characters).` };
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  if (email && (email.length > LIMITS.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { error: 'That email address does not look right.' };
  const list = Array.isArray(b.images) ? b.images : [];
  if (list.length > MAX_IMAGES) return { error: `At most ${MAX_IMAGES} screenshots.` };
  const images: Report['images'] = [];
  for (const [i, x] of list.entries()) {
    const data = typeof x?.data === 'string' ? x.data.replace(/^data:[^,]*,/, '') : '';
    const bytes = Buffer.from(data, 'base64');
    const type = imageType(bytes);
    if (!type) return { error: `Screenshot ${i + 1} is not a PNG, JPEG or WebP image.` };
    if (bytes.length > MAX_IMAGE_BYTES) return { error: `Screenshot ${i + 1} is too large (at most ${MAX_IMAGE_BYTES / 1_000_000} MB).` };
    images.push({ type, bytes });
  }
  const setup = b.setup && typeof b.setup === 'object' && !Array.isArray(b.setup) && JSON.stringify(b.setup).length <= 4000 ? b.setup : {};
  // the backend needs a title: the first words of what happened when the user gave none
  const title = text('title').trim().replace(/\s+/g, ' ') || text('what').trim().replace(/\s+/g, ' ').slice(0, 80) || 'Report from the app';
  return { title, what: text('what').trim(), details: text('details'), setup, ...(email ? { email } : {}), images };
}

export interface Credentials {
  installationId: string;
  installationKey: string;
}
export interface ReportOptions {
  /** the installation ID and key: the notifications' (src/serve/notifications.ts), made on first use when notifications are off */
  credentials: () => Credentials;
  version: string;
  platform?: string;
  /** the backend; CHORUS_REPORTS_API, else the notifications' backend */
  endpoint?: string;
  request?: typeof fetch;
  timeoutMs?: number;
}
export type SendResult = { ok: true; id: string; ref: string; images: number; failed: number } | { error: string; offline?: boolean };

export class ReportSender {
  private o: ReportOptions;
  constructor(o: ReportOptions) {
    this.o = o;
  }
  private get base() {
    return (this.o.endpoint ?? process.env.CHORUS_REPORTS_API ?? NOTIFICATION_API).replace(/\/+$/, '');
  }
  private call(route: string, init: RequestInit) {
    return (this.o.request ?? fetch)(this.base + route, { ...init, signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000) });
  }

  async send(r: Report): Promise<SendResult> {
    let creds: Credentials;
    try {
      creds = this.o.credentials();
    } catch (e) {
      return { error: `Chorus could not read its installation ID: ${(e as Error).message}` };
    }
    let res: Response;
    try {
      res = await this.call('/v1/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...creds, title: r.title, what: r.what, details: r.details, setup: r.setup, ...(r.email ? { email: r.email } : {}), platform: this.o.platform ?? process.platform, appVersion: this.o.version, imageCount: r.images.length }),
      });
    } catch {
      return { error: 'the Chorus service could not be reached', offline: true };
    }
    const j = (await res.json().catch(() => ({}))) as { id?: unknown; ref?: unknown; error?: unknown };
    if (res.status >= 500) return { error: 'the Chorus service could not be reached', offline: true };
    if (!res.ok || typeof j.id !== 'string' || typeof j.ref !== 'string') {
      // the limits in plain words (chorus-admin docs/client-contract.md: 5 reports a day; sizes)
      if (res.status === 429) return { error: 'This computer has sent 5 reports today, the most for one day. Nothing is lost: try again tomorrow, or keep the text and send it then.' };
      if (res.status === 413) return { error: 'The report is too large to send. Shorten the details or remove a screenshot, then try again.' };
      return { error: typeof j.error === 'string' ? j.error : `the Chorus service answered ${res.status}` };
    }
    const id = j.id;
    let failed = 0;
    for (const [i, img] of r.images.entries()) {
      // one try more for a screenshot that did not arrive; the report itself is already there
      let ok = false;
      for (let t = 0; t < 2 && !ok; t++) {
        try {
          const put = await this.call(`/v1/reports/${encodeURIComponent(id)}/images/${i + 1}`, { method: 'PUT', headers: { 'content-type': img.type, 'x-installation-id': creds.installationId, 'x-installation-key': creds.installationKey }, body: new Uint8Array(img.bytes) });
          ok = put.ok;
          await put.arrayBuffer().catch(() => undefined);
        } catch {
          ok = false;
        }
      }
      if (!ok) failed++;
    }
    return { ok: true, id, ref: j.ref, images: r.images.length - failed, failed };
  }
}
