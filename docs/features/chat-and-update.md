# A chat's ask card, its right sidebar, and Update Chorus in the app

What the desktop page (`src/desktop/`) and `chorus serve` do since the chat and setup fixes (2026-11-12). Desktop is 1025 px and
wider; tablet and phone keep what [`responsive.md`](responsive.md) describes.

## The ask card

An agent asks through the chorus `request_approval` tool ([integrations/approvals.md §D](../integrations/approvals.md)).

- **One open ask per chat.** `Store.createRequest` cancels the chat's older pending asks, so only the newest card shows.
- **Answered by typing.** When a chat goes idle → working while its ask is still open, the user answered in the chat itself:
  the controller (`cancelAnsweredByTyping` in `src/app/controller.ts`) cancels it. An ask made after the chat was last seen
  going idle belongs to the turn that just started and stays (the transcript can show a new turn late). Answering from the
  card marks the ask answered before its line is typed, so nothing changes there. A cancelled ask is not written to the
  approvals log. Asked, then the turn ends and the chat stays idle: the card stays.
- **Where it shows.** Docked over the bottom of the chat column (`#ask-dock` inside `.chat-col`), never over the right
  sidebar: the panel colour with the accent on its border and on "<agent> asks you". The question; the details clamped to 3
  lines with **Show more** only when they overflow (re-checked when the column changes width); the options, **Other…**, a note;
  **Fold** shrinks it to one line, remembered per request (`localStorage chorus.askFold`). The same ask is in Approvals.
- The card names the agent ("Claude Code asks you"); in a task chat the mockup names the teammate, which the page can't do
  until the optional module tells the host which teammate a chat belongs to.
- A CLI's own permission prompt stays the thin red **Approve / Deny** banner, inside the chat column.

## The right sidebar

The chat header has **Task** (a task chat of the optional module, desktop only) · **Artifacts** · **Activity** · **Record**.
Each opens its view in the one right sidebar, with a title row and ✕; the pressed button is lit (a teal outline, as in the mockup's task chat). The lit button or ✕ closes the
sidebar and the chat takes the full width; one view at a time. **Task** holds the module's `chat-side` slot unchanged; the
container draws the frame (`[data-pro-slot="chat-side"]::part(panel) { border-left: 0 }`). A task chat starts on Task, a plain
chat closed; what was open is remembered per chat (`ui.json` key `side`). A click or a key press in the agent's screen closes
Artifacts, Activity and Record; Task stays open; a click on the ask card does not count. The terminal refits when the sidebar
opens or closes.

## Update Chorus

The launch check ([notifications.md](../notifications.md), Release notices) offers a newer production version in a band under
the top bar, which the top bar's update button opens and closes (a phone shows it as a sheet):

1. **Update Chorus** → `POST /api/updates/install`. `chorus serve` fetches the official installer
   `https://chorus-cli.web.app/install.sh` (fixed address, https only, no redirects, at most 512 kB; only a test option in code
   can point elsewhere, never the page) and runs it with `bash`, stdin closed, `CHORUS_NO_OPEN=1`, `CHORUS_NO_MODIFY_PATH=1`,
   the four `CLAUDE*` variables removed, and `CHORUS_INSTALL_DIR` set to the root this Chorus runs from
   (`<root>/versions/<v>/…`). The installer checks every download against `SHA256SUMS` as always.
2. Phases, through the pushed state (`update.install`): **downloading** with a percent (read from curl's progress bar, one
   download per installer part) → **installing** → **ready**; or **failed** with the installer's last lines, **Try again** and
   **Open the instructions** (`/api/updates/open`, as before).
3. **Restart Chorus** → `POST /api/updates/restart`: a small detached script (`RELAUNCH` in `src/serve/updates.ts`) stops the
   Chorus window this server runs under (found among its parents), waits for it and the server to stop, and opens the app again.

On macOS the installer puts `Chorus.app` in a staging folder (`CHORUS_APP_DIR=~/.chorus/updates/app`): it stops a `Chorus.app`
running in the folder it installs to, which would close this window in the middle of the update. Restart moves the staged app
over the one in use, then `open`s it. On Linux the window comes in the package, so Restart runs `<root>/current/bin/chorus
desktop`. With no Chorus window above the server (a browser tab on `chorus serve`) Restart says to quit and open Chorus again.

Install and restart are refused through the private link (403 "Update Chorus on the Mac."); a device's page shows that line
instead of the buttons. In a container the install is refused too.

Proven before it was built (2026-11-12): the live installer into a temporary install (`CHORUS_INSTALL_DIR`, `CHORUS_BIN_DIR`,
`CHORUS_APP_DIR` staging, `CHORUS_DOWNLOADS` on 127.0.0.1 with a fake release) left a running app alone and installed; the
relaunch script then stopped that running test app, swapped in the staged bundle and opened it, four times in a row.
