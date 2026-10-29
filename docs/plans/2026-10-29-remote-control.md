# Remote control: Telegram and a VPS

Status: **proposal**, waiting for the owner's choices (§7). Nothing is built.

## 1. Outcome

A user away from their Mac can, from a phone:

- get told when an agent **needs an approval**, **finished a turn**, **failed** or **hit a limit**;
- **approve / deny / answer** an approval card (`request_approval` included);
- see the chat list and the **last screen** of an agent;
- **send a message** to a running chat, **start a new chat** in a known project, **hand off** a chat to another CLI;
- optionally, open the **full desktop page** (xterm screens and all) in a phone browser.

Out of scope for now: Windows, multi-user teams, a Chorus-run hosted service (that would be chorus-admin and has a cost).

## 2. What exists today

`chorus serve` (`src/serve/server.ts`, `docs/phase5.md` §2) already exposes every operation the window needs as `/api/*` JSON
plus the agent screens over `/ws`. It is locked to one machine on purpose: 127.0.0.1 only, a 32-byte token, a strict `Host`
check against DNS rebinding, `SameSite=Strict` cookie, `X-Chorus: 1` on writes, same-`Origin` WebSocket. The routes a remote
needs are there: `GET state`, `GET chats/:id`, `POST chats`, `POST chats/:id/approve|deny|answer|handoff|retry`,
`GET approvals`, and `snapshot(host)` gives a replay of a screen.

So the remote is a **new client of the Controller**, not new business logic, same rule as the desktop page.

## 3. The two ways

### Way A: a Telegram bot inside `chorus serve` (no VPS)

```
phone (Telegram) ⇄ api.telegram.org ⇄ (long polling, outbound HTTPS) ⇄ chorus serve on the Mac ─ Controller ─ agents
```

- The user makes a bot with @BotFather and pastes its token in Settings → Remote → Telegram. The token is stored in
  `~/.chorus/remote.json` (mode 0600; later the macOS keychain).
- **Pairing**: Chorus shows a one-time code; the user sends `/pair <code>` to the bot. Chorus stores that Telegram **user id**
  and **chat id**; every other sender is ignored (no reply, logged). Unpair from Settings or `/unpair`.
- **Outbound only**: `getUpdates` long polling. No port opened, works behind NAT, no VPS, no webhook.
- Pushes: approval cards as messages with inline buttons (Approve / Deny / options of `request_approval` / Other… → the next
  text is the answer); "turn done" and "failed" messages (muted by default, per-chat toggle).
- Commands: `/chats`, `/screen <chat>` (the screen as plain text in a `<pre>` block, last ~40 lines), `/send <chat> <text>`
  or reply to any message of that chat, `/new <project> <cli> <prompt>`, `/handoff <chat> <cli>`, `/stop <chat>`.
- Code: `src/serve/remote/telegram.ts` calling the Controller (or the same `route()` the HTTP API uses, so there is one place
  that checks arguments), a Settings panel in `src/desktop/`.
- Limit: the Mac must be on and awake (Tauri can ask for no-sleep while a remote is paired; `caffeinate` style).

### Way B: the full app through the user's VPS

Two shapes, same code on the Mac side:

- **B1. VPS as relay.** `chorus serve` dials out a WebSocket to `chorus relay` on the user's VPS (`npx @chauvoluuhuong/chorus
  relay`, Docker image, Caddy for HTTPS). The relay serves the desktop page over HTTPS and forwards `/api` and `/ws` frames
  through that tunnel. Agents still run on the Mac. The relay sees everything that passes, so it must be the user's own box.
- **B2. VPS as the computer.** `chorus serve --headless` runs on a Linux VPS under systemd, with the CLIs logged in there;
  the repos live on the VPS. The phone reaches it through B1's relay on the same box, or through Tailscale. The Mac is not
  needed at all, and agents keep working while the laptop is closed.

Both need a **remote auth layer** the local API does not have: a long-lived device login (passkey, or a password + device
pairing code shown on the Mac), per-device revocation, HTTPS only, rate limits, an audit log of every remote write. The local
guards stay unchanged for 127.0.0.1; the remote path gets its own `Host`/`Origin` allowlist.

### Comparison

| | A: Telegram bot | B1: VPS relay | B2: VPS host |
|---|---|---|---|
| What the user gets | notifications, approvals, short replies, text screens | the whole desktop page in a browser | the whole page, and agents run with the laptop closed |
| Setup for the user | make a bot, paste token, `/pair` (2 min) | a VPS, a domain, `chorus relay`, pair (20–30 min) | B1 + install and log in the CLIs on Linux |
| Code here | small: one client of the Controller + a Settings panel | medium: tunnel protocol, relay, remote auth | B1 + headless serve, systemd unit, docs |
| Runs on | the Mac, outbound only | Mac + VPS | VPS |
| Cost to the user | $0 | ~$4–6/month VPS | ~$4–6/month, more RAM if several agents run |
| Cost to Chorus | $0 | $0 (self-hosted) | $0 |
| Privacy | prompts, screens and code snippets pass through Telegram's servers (bot chats are not end-to-end encrypted) | only the user's VPS | only the user's VPS |
| Unproven (rule 1) | nothing CLI-specific; Telegram Bot API behaviour (message size 4096, edit limits) | WebSocket through a proxy with the screen stream | each CLI's login and TUI on a headless Linux box |

### Recommendation

**Build A first, then B2 with the relay of B1 on the same box.** A covers the moment people actually need the phone (an agent
waiting for an approval) with the least code and no infrastructure, and it is the right base for B: the pairing, the remote
auth checks, the audit log and the notification events are written once and reused. B2 is more useful than B1 because agents
keep running when the laptop sleeps, and Linux is already a supported platform; B1 falls out of it for users who want to keep
their repos on the Mac.

## 4. Security (the part that matters)

`chorus serve` can start processes and type into agents that may run with skip-permissions, so a remote is remote code
execution by design. Guards:

- Telegram: only the paired user id **and** chat id; group chats refused; the bot token never logged; unpair on token change.
- Every remote write is logged in `~/.chorus/remote.log` (who, what, which chat) and shown in the app.
- Remote can be switched off with one toggle; it is **off by default**.
- New chats from remote: only in projects already known to Chorus (no free path); skip-permissions from remote needs a
  second confirm in the app, or is refused (owner's choice, §7).
- Screens sent to Telegram are plain text, secrets are not redacted automatically: the Settings panel says so.
- B: HTTPS only, no token in URLs, device pairing shown on the Mac, per-device revoke, rate limit on login.

## 5. Phases and proof

| Step | What | Proof |
|---|---|---|
| R1 | spike: Telegram long polling from `chorus serve`, pair, one approval button round trip with the fake agent | preview build; video from a real phone |
| R2 | A complete: commands, pushes, Settings panel, audit log; L2 tests with a fake Telegram server | `npm test`; `npm run smoke:ask` driven from Telegram with real Claude + Codex |
| R3 | spike: `chorus serve --headless` on a Linux VPS, log in each CLI, run one chat | terminal output and a fixture per CLI in chorus-core (headless login is an integration fact) |
| R4 | relay + remote auth, desktop page over HTTPS on the VPS | `proof:desktop` against the relay URL |
| R5 | docs: `docs/features/remote.md`, a VPS guide, the website section | – |

Each step ships as a preview (`vX.Y.Z-preview.N`); production only after "approve vX.Y.Z".

## 6. Risks

- **One screen size** for every viewer (`docs/phase5.md` §1): a phone attaching to the full page would resize the Mac's agents.
  B needs a per-viewer size or a "remote is read-only while the window is open" rule.
- **Two drivers of one chat** (the window and the phone) at once: same family as the open item "CLI app and desktop resuming the
  same chat" (`docs/phase5.md` §7); writes need a simple lock or last-writer-wins with a notice.
- **Telegram limits**: 4096 chars per message, ~30 messages/s, edits limited; screens must be trimmed, pushes batched.
- **Mac sleep** stops Way A silently: the bot should answer "Mac offline" — impossible without a server, so the app says so
  in Settings instead, and B2 is the real fix.
- **Headless CLI logins** (B2) are unproven per CLI; agy may not support it at all.
- Provider terms (D4) for running agents unattended on a server: check before B2 ships.

## 7. Decisions for the owner

1. Which way first: A then B2 (recommended), A only, or B first.
2. Telegram privacy: accept that prompts and screens pass through Telegram (bot chats are not end-to-end encrypted), or only
   send notifications + buttons and never screen text.
3. Skip-permissions chats started from remote: refused, or allowed with a confirm in the app.
4. Self-hosted only (each user runs their own bot and VPS, $0 for Chorus), or later a Chorus-hosted relay (a chorus-core /
   chorus-admin decision with a monthly cost; not planned here).
