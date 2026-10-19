// Shared by the e2e proofs: an HTML page with the checks and the screenshots, and a way to open it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface Check {
  ok: boolean;
  /** not run for an outside reason (a provider quota): neither pass nor fail */
  skipped?: boolean;
  name: string;
  detail?: string;
}
export interface Shot {
  file: string;
  caption: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function writeReport(out: string, title: string, intro: string, results: Check[], shots: Shot[], cmds: [string, string][]): string {
  const failed = results.filter(r => !r.ok).length;
  const skipped = results.filter(r => r.skipped).length;
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#f4f6f8;--fg:#1a1f27;--muted:#5a6474;--line:#dde2e9;--ok:#0f766e;--bad:#b42318;--panel:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0d1014;--fg:#e3e8ef;--muted:#98a3b4;--line:#262d38;--ok:#4fc1b6;--bad:#f07a7a;--panel:#151a21}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,"Segoe UI",system-ui,sans-serif;padding:24px max(16px,4vw) 64px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 10px}p{color:var(--muted);max-width:80ch}
.verdict{display:inline-block;padding:4px 12px;border-radius:999px;font-weight:600;color:#fff;background:${failed ? 'var(--bad)' : 'var(--ok)'}}
table{border-collapse:collapse;width:100%;max-width:1000px;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
td{padding:7px 12px;border-bottom:1px solid var(--line);vertical-align:top}td:first-child{width:28px}
figure{margin:0 0 28px;max-width:1380px}figcaption{margin:0 0 8px;font-weight:600}
figure img{width:100%;height:auto;border-radius:8px;border:1px solid var(--line);display:block}
pre{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;overflow-x:auto;font-size:12.5px;max-width:1000px}
.n{color:var(--muted);font-weight:400;margin-right:6px}
</style>
<h1>${esc(title)}</h1><p>${esc(intro)}</p>
<span class="verdict">${failed ? `${failed} check(s) failed` : `${results.length - skipped} checks passed${skipped ? `, ${skipped} not run (see below)` : ''}`}</span>
<h2>Screenshots</h2>
${shots.map((s, i) => `<figure><figcaption><span class="n">${String(i + 1).padStart(2, '0')}</span>${esc(s.caption)}</figcaption><img src="${s.file}" alt="${esc(s.caption)}" loading="lazy"></figure>`).join('\n')}
<h2>Checks</h2>
<table>${results.map(r => `<tr><td>${r.skipped ? '⏭' : r.ok ? '✅' : '❌'}</td><td>${esc(r.name)}${(!r.ok || r.skipped) && r.detail ? `<br><small style="color:var(--muted)">${esc(r.detail.slice(0, 300))}</small>` : ''}</td></tr>`).join('')}</table>
<h2>Commands after the run</h2>
${cmds.map(([c, o]) => `<pre>$ ${esc(c)}\n${esc(o)}</pre>`).join('\n')}`;
  const file = path.join(out, 'report.html');
  fs.writeFileSync(file, html);
  return file;
}

/** Open the report in the default browser (macOS `open`, Linux `xdg-open`). */
export function openReport(file: string) {
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawnSync(cmd, [file], { stdio: 'ignore' });
}
