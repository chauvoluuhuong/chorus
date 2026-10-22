# Phase 5: the desktop app

Status: **built**. Goal: [architecture.md §2](architecture.md#phase-5--desktop-app): the same operations as the CLI app with a
graphical UI, over `chorus serve`, no business logic of its own. E2E proof with screenshots: [proof/phase5/README.md](proof/phase5/README.md)
(`npm run proof:desktop`).

## 1. Shape

```
Chorus.app (desktop/, Tauri, 4.9 MB)          a window; no logic
  └─ $SHELL -l -c 'chorus serve --port 0 --exit-with-stdin'
       chorus serve (src/serve/server.ts)     the same Controller as the CLI app, without a terminal
         ├─ ThreadHost × N                    the agents in PTYs (claude, codex, agy), virtual screens
         ├─ Tailer, approvals, handoff …      unchanged (src/app/controller.ts)
         ├─ HTTP  /api/*                      every operation of the window, JSON
         ├─ WS    /ws                         the agent screens: replay + live bytes, keystrokes, resize, state pushes
         └─ static src/desktop/               the page (index.html, app.js, style.css) + xterm.js from node_modules
```

- **One source of truth.** `chorus serve` builds the CLI app's `App` with a headless IO (`headlessApp()`), and the same
  `Controller`. New chat, handoff, approvals, deletes, the limit dialog, artifacts, skills and Memory are the Controller's code.
  The questions it asks the user (`app.alert`, `app.prompt`, `app.choose`) become dialogs in the window; its flashes become toasts.
  Data that the terminal app only rendered as lines was split into data + rendering where the window needed it
  (`Controller.activityRows`).
- **The agent's own screen.** The window draws each agent with xterm.js. Opening a chat sends `attach`; the server replies with a
  replay of the agent's virtual screen (`@xterm/addon-serialize`, plus the modes the addon leaves out: hidden cursor, SGR mouse
  encoding, focus reporting, keypad) and then every byte the agent writes. The empty-write barrier in `snapshot()` makes the
  replay and the live stream meet without a lost or doubled byte. Keystrokes, paste and mouse go back as `in`.
- **Only one terminal answers.** The server's virtual screen already answers the agent's terminal queries (cursor position,
  device attributes, colours). The window's xterm registers handlers that swallow those queries, otherwise each answer would
  reach the agent twice and appear as typed text.
- **Size.** The window's terminal size is the size of every agent screen (one window at a time is the expected use).

## 2. Security of the local API

`chorus serve` can start processes and type into agents that may run with skip-permissions, so a web page must not be able to
drive it:

| Threat | Guard |
|---|---|
| another machine | listens on 127.0.0.1 only |
| any local process or page without the token | 32-byte random token on every request (`Authorization: Bearer`, or the cookie) |
| DNS rebinding (a page on evil.example resolving to 127.0.0.1) | the `Host` header must be `127.0.0.1:<port>` or `localhost:<port>` |
| cross-site requests from the user's browser | `HttpOnly; SameSite=Strict` cookie, writes need the `X-Chorus: 1` header (a cross-origin page cannot send it without a preflight that is never allowed) and a same `Origin` |
| a foreign page opening the WebSocket | upgrades need the token and our own `Origin` |
| two servers on one host (a restart, the CLI's and the app's) | cookies are shared by every port of a host, so the cookie is named `chorus_token_<port>`, and any one right token (header, cookie, address) is enough: a stale cookie never hides a fresh token (found by the proof's restart step) |

The first URL carries the token (`chorus serve: http://127.0.0.1:PORT/?token=…`). That request answers with the page and the
cookie, and the page removes the token from the address bar. No redirect: the desktop app navigates from `tauri://localhost`,
which is a cross-site navigation, and WebKit does not send a `SameSite=Strict` cookie set on a redirect with the redirected
request (seen on the first build: the window showed the 401 JSON).

## 3. Decision D3: Tauri, as a thin shell

| | Tauri 2 | Electron |
|---|---|---|
| app size | **4.9 MB** (`Chorus.app`, WKWebView on macOS) | ~200 MB (Chromium + Node) |
| runs the core | no: `chorus serve` runs on the user's Node, like `chorus` itself | could run it in-process, but `node-pty` would need an Electron rebuild and `node:sqlite` would depend on Electron's Node |
| toolchain | Rust (cargo), `@tauri-apps/cli` | npm only |
| what the shell does | start `chorus serve`, show its page, stop it | the same |

The shell holds no logic, so the cheap one wins. Users of Chorus already have Node 22+ (Codex is an npm install; `chorus` is
an npm package, D1/P4.8); a Node single executable (147 MB) can be put inside the bundle later for users without Node.

How the shell starts the server: `$SHELL -l -c 'exec chorus serve --port 0 --exit-with-stdin'` in the home folder, so a
Finder-launched app gets the PATH of the user's terminal (`chorus`, `node`, `claude`, `codex`, `agy`). It reads the first
line (`chorus serve: <url>`) and navigates the window there. It holds the server's stdin open and never writes to it:
`--exit-with-stdin` makes the server stop with its agents when the app is gone, even after `kill -9` of the app
(checked). On a normal quit it sends SIGTERM first. Logs: `~/.chorus/desktop.log`. `CHORUS_SERVE_CMD` replaces `chorus`
(development: `chorus desktop` passes this checkout), `CHORUS_PROJECT` sets the project folder.

## 4. The window

Built in the look of [archive/ui-mockup-v3.html](archive/ui-mockup-v3.html) (warm neutrals, serif headings, dark mode follows the
system), with the screens of the CLI app ([mockups/chorus-cli.html](mockups/chorus-cli.html)) and the agent colours of the CLI:

| Screen | What it does | API |
|---|---|---|
| Sidebar | New chat, Approvals (count), Memory, Skills; projects that fold, their chats with a state dot and agent letter, continued chats under their source (↳); agents ✓/✗ and Doctor at the bottom | `state` (pushed) |
| New chat | agent cards (version, login, plan %), model, effort, project folder (Browse…, recent, this computer), first message (optional), skip permissions with its flag and warning | `GET newchat`, `POST chats`, `GET/POST folders` |
| Chat | header (agent, state, model · effort, `skip`, plan meter, folder), Hand off, Artifacts / Activity / Record drawers, Delete; an "asks" banner with Approve / Deny when this chat waits; "not loaded" banner with Ask again on a handoff chat; the agent's own screen | `WS /ws`, `GET chats/:id`, `…/artifacts`, `…/activity`, `POST …/approve|deny|retry|open|preview`, `DELETE chats/:id` |
| Hand off | the New chat form for the chat that continues another one | `GET newchat?from=`, `POST chats/:id/handoff` |
| Approvals | every waiting request with its risk tag, Approve / Deny / Open chat, All projects / This project, Decided today; a toast with the same buttons when a background chat asks | `GET approvals` |
| Memory | every chat of every project, search, what it asked, last answer, files, tools, recent calls; Open, Continue with another agent, What an agent reads, Delete | `GET memory?q=` |
| Skills | the library with on/off switches, New skill, Edit (opens SKILL.md), found in the agents' folders with Import | `GET/POST skills…` |
| Doctor | the doctor lines of the CLI app | `GET doctor` |
| Dialogs | the Controller's questions (delete?, limit reached, how to open a file) | `state.dialogs`, `POST dialogs/:id` |

Keys: ⌘N new chat, ⌘I approvals, ⌘B sidebar, ⌘1–9 chats, Esc closes a dialog. Everything else goes to the agent in front.
The address keeps the screen (`#/chat/<id>`), so a reload or a restarted server comes back to it.

## 5. Commands

```bash
chorus serve [--port N] [--open]     # the local API and the page; prints "chorus serve: <url>"; --fake-agents for UI work
npm run install:global               # chorus on the PATH (npm link) + Chorus.app built and copied to /Applications (--no-app: CLI only)
chorus desktop                       # the installed app, else this checkout's build, else the page in the browser
cd desktop && npm install && npm run build   # only builds desktop/src-tauri/target/release/bundle/macos/Chorus.app
npm run proof:desktop                # Phase 5 e2e proof with screenshots (real Claude + Codex, ~10 min)
```

Debugging: `CHORUS_DEBUG_INPUT=<file>` makes `chorus serve` append every keystroke chunk the window sends (JSON lines).
It showed that the window sends exactly what a terminal would (`text`, then `\r`; focus events `ESC [I` / `ESC [O`), and that
Codex 0.163.0 pushes the kitty keyboard flags (`CSI > 7 u`); neither xterm.js build implements that protocol, so it stays on
the legacy keys (TD-5).

## 6. Tests

- L2 `test/serve/serve.test.ts` (fake TUI): token, Host, `X-Chorus`, cookie, Origin on the socket; a new chat streams its screen,
  typing and resize reach it, a second window gets the same screen with its modes; approvals, handoff, delete through a dialog,
  activity, memory, record; a parked chat resumes when opened; skills, new-chat info, folders, doctor.
- L3 `npm run proof:desktop`: 43/43 with Claude Code 2.1.306 and Codex 0.163.0 (2026-10-22), see the proof page. Claude 2.1.306
  is newer than the verified 2.1.302: its approval prompt was still detected (four approvals answered from the inbox).
  What the first two runs found and fixed: the router sent `POST skills/import` to `skills/:id` (Import did nothing; the window
  now shows any failed action as a toast), a stale cookie of an earlier server on 127.0.0.1 hid the fresh token (per-port cookie),
  the ask toast expired while the request still waited (it now stays until answered). One more was the proof's own timing: Codex
  draws its YOLO banner before its folder-trust dialog, so text typed too early lands in the dialog (a `2` picks "Quit"); a person
  sees the dialog, the proof now waits for the empty composer. When a Codex chat never gets a first turn, the next Codex chat in
  the same folder can claim its transcript: that is TD-4, seen here for real.

## 7. Not done / known limits

- One window at a time: the last window's size wins for every agent; two windows on one chat see the same screen.
- The CLI app and the desktop are separate hosts: running both at once on the same chats would start two agents for one session
  (each resumes a parked chat on its own). Not guarded yet.
- Windows and Linux shells are not built or tested (TD-6). The Tauri config has the icons for them.
- No signing/notarisation yet (needed before selling, with D4).
- Desktop notifications for a background approval (the window shows a toast; the OS notification centre is not used).
