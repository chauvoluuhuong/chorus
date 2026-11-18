// Follow Chorus (task #13, @workspace/mockups/doctor-tip.html): the landing page's follow modal in the app's colours, without its
// "Command copied" banner. Both channels are plain links: a browser tab opens them in a new tab; the native window sends them to
// the server, which opens the system browser (POST /api/follow/open, the way notification links open).

export const YOUTUBE_URL = 'https://www.youtube.com/@luuhuongtech?sub_confirmation=1';
export const FACEBOOK_URL = 'https://www.facebook.com/luuhuongtech/';
/** what `data-follow` names → the link; the server keeps the same two (FOLLOW_LINKS in src/serve/server.ts) */
export const FOLLOW_LINKS = { youtube: YOUTUBE_URL, facebook: FACEBOOK_URL };

export const HEART_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3l-1.2-1.1C6.3 15.2 3.5 12.6 3.5 9.4 3.5 6.8 5.5 4.8 8 4.8c1.5 0 2.9.7 4 1.8 1.1-1.1 2.5-1.8 4-1.8 2.5 0 4.5 2 4.5 4.6 0 3.2-2.8 5.8-7.3 9.8z" fill="currentColor"/></svg>';

const YT_ICON = '<svg class="fw-ic" viewBox="0 0 24 24" aria-hidden="true"><rect y="3.5" width="24" height="17" rx="5" fill="#f00"/><path d="M9.8 8.3v7.4l6.3-3.7z" fill="#fff"/></svg>';
const FB_ICON = '<svg class="fw-ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1877f2"/><path d="M13.4 20v-6.6h2.2l.4-2.7h-2.6V9c0-.8.3-1.4 1.4-1.4h1.3V5.2c-.3 0-1.1-.1-1.9-.1-2 0-3.3 1.2-3.3 3.4v2.2H8.7v2.7h2.2V20z" fill="#fff"/></svg>';

const row = (icon, where, to, cls, label) =>
  `<div class="w">${icon}<span class="who"><b>Luu Huong Tech</b><small>${where}</small></span><a class="pill ${cls}" href="${FOLLOW_LINKS[to]}" target="_blank" rel="noopener" data-follow="${to}">${label}</a></div>`;

/** The modal's dialog (the caller puts it in a .scrim.follow in #dialogs). */
export function followHtml() {
  return `<div class="fd" role="dialog" aria-modal="true" aria-labelledby="fw-title">
    <button class="fx" data-x="cancel" aria-label="Close">×</button>
    <div class="ty">${HEART_SVG}</div>
    <h3 id="fw-title">Thanks for trying Chorus!</h3>
    <p>Follow us to share ideas and bug reports. Each one makes Chorus better.</p>
    ${row(YT_ICON, 'YouTube', 'youtube', 'yt', 'Subscribe')}
    ${row(FB_ICON, 'Facebook', 'facebook', 'fb', 'Follow')}
    <button class="later" data-x="cancel">Maybe later</button>
  </div>`;
}

/** The Doctor page's lasting card: heart, Help shape Chorus, and the button that opens the modal. */
export function shapeCardHtml() {
  return `<div class="shape-card"><span class="hi">${HEART_SVG}</span><span class="t"><b>Help shape Chorus</b><p>Follow us to share ideas and bug reports.</p></span><button class="btn" data-act="follow-open">♥ Follow Chorus</button></div>`;
}
