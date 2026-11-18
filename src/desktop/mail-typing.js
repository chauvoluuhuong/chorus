/* The window dimmed while the mail watchdog types a message into the open chat (task #14, mockup mail-courier.html v3, scenes 1–3):
   one card in the centre with the sender, this chat, a dashed arc and a letter travelling along it. Shown only for the type-in, never
   for a retry; gone when serve says the draft is back, or after MAIL_TYPING_MAX_MS whatever happened. Never an input box. */
export const MAIL_TYPING_MAX_MS = 10_000;

/** The overlay's markup. `from`: the sender chat {title, agent} (none: Chorus itself); `to`: this chat {agent}. */
export function mailTypingHtml({ from, to, esc, letter }) {
  const title = from?.title || 'Chorus';
  const who = (agent, side) => `<span class="mt-who ${side}${agent ? ` ${esc(agent)}` : ''}">${agent ? esc(letter(agent)) : '✉'}</span>`;
  return `<div class="mt-scrim" id="mail-typing" aria-busy="true"><div class="mt-card" role="status" aria-live="polite">
    <div class="mt-wire"><svg viewBox="0 0 280 92" aria-hidden="true"><path class="mt-arc" d="M52 52 C 100 2, 180 2, 228 52"/></svg>
      ${who(from?.agent, 'a')}${who(to?.agent, 'b')}
      <span class="mt-lbl a">${esc(title)}</span><span class="mt-lbl b">This chat</span><span class="mt-env"></span></div>
    <h3>Delivering a message to this chat</h3>
    <p>From <b>${esc(title)}</b>. What you typed is saved and comes back in a moment.</p>
  </div></div>`;
}
