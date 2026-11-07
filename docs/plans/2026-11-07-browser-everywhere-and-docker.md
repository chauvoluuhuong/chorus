# Chorus in the browser everywhere, and a ready Docker box

Status: **planned** (owner, 2026-11-07; the website's install box and Windows added the same day). Not built. Free features. Part A comes
first: part B needs it, and part C needs part B's launchers.

## Outcome

- **Every start shows the browser address.** On a computer with a screen, `chorus` opens the window **and** prints the address of the same Chorus in a
  browser. With no screen, it runs Chorus for the browser and prints the address. Chorus can always be used from a web browser.
- **A clean Linux Docker box** with the AI CLIs at the newest versions Chorus has tested. On first start you pick **stable or preview** and **which
  folder to share** (default: your home folder), and Chorus opens in your browser. It works on macOS, Linux and **Windows**.
- **The website's install box offers both,** simply: Docker beside macOS and Linux, and a **Preview** tick beside Copy.

## What exists today (checked on `dev`, 2026-11-07)

| Fact | Where |
|---|---|
| Bare `chorus` opens the window when there is a screen; with **no screen it opens the CLI app** in the terminal | `src/cli/index.ts` line 95 |
| No window possible (no app, missing WebKitGTK): falls back to `chorus serve --open`, which tries `xdg-open` and fails silently with no browser | `src/cli/index.ts`, `desktop` |
| The window starts its own `chorus serve` on a **random port** (`--port 0`) | `desktop/src-tauri/src/main.rs` |
| `chorus serve` listens on **127.0.0.1 only** and refuses any Host but `127.0.0.1:<port>` / `localhost:<port>` | `src/serve/server.ts` |
| It writes `~/.chorus/serve.json` (0600) with its URL and the MCP token, not the page's token | `src/serve/server.ts` |
| Every viewer shares one screen size; a remote viewer never resizes the agents | `src/serve/server.ts` |
| The installer covers Linux x64 and arm64 (glibc), `CHORUS_CHANNEL=production|preview`, `CHORUS_NO_OPEN=1` | chorus-admin `site/install.sh` |
| Newest tested CLIs: Claude Code 2.1.310, Codex 0.164.0, agy 1.4.5 | chorus-core `src/tested.json` |
| On a fresh Linux machine: Codex signs in with `codex login --with-api-key`; agy 1.4.7 stops at a Google sign-in link | chorus-core `docs/integrations/` |

## Part A: the browser address, always

1. **Print it after the window opens.** `chorus` waits up to 20 s for `serve.json` from the window's `chorus serve`, then prints
   `Chorus is open. In a browser too: http://127.0.0.1:4318/?token=…`. If Chorus is already running, it brings the window forward and prints the
   same. `serve.json` gains `openUrl`, the page's address with its token (same file, same 0600).
2. **A steady address.** The window starts `chorus serve --port 4318` and falls back to a random port only when 4318 is taken (serve already does).
   The token stays new on every start: an old link stops working after a restart, by design.
3. **The window and a browser tab at once.** Only the window sets the agents' screen size while it's open; a browser tab on the same Mac joins as a
   viewer that never resizes (the mode remote viewers already use).
4. **No screen: the browser, not the CLI app.** Bare `chorus` with no screen runs `chorus serve` in the foreground and prints:

   ```
   Chorus is running. There's no screen here, so open this in a browser:
     http://127.0.0.1:4318/?token=…
   In a container or on a server? Start it with --host so another computer's browser can reach it.
   ```

   **This changes how the CLI app is reached** (rule 7, owner's request 2026-11-07): `chorus-cli` still opens it, and the message says so.
   No screen is: Linux with no `DISPLAY` and no `WAYLAND_DISPLAY`, an SSH session with no display, or a container (`/.dockerenv`,
   `/run/.containerenv`). `--open` is skipped when nothing can open a browser, instead of failing silently.
5. **`--host <address>`, opt-in only.** `chorus serve --host 0.0.0.0` listens there and adds that host to its Host and Origin checks. The token
   is still required on every request. It always prints: "Anyone who can reach this port with the address can run agents on this computer."
   Never on by default; a real login and HTTPS come with remote access.

| # | Check | Evidence |
|---|---|---|
| A.1 | Mac with the app: the window opens and the terminal prints a working browser address; opening it in Chrome shows the same chats | Terminal output, screenshot |
| A.2 | Run `chorus` again while open: the window comes forward, the same address is printed | Terminal output |
| A.3 | Linux desktop with the window: the same as A.1 | Terminal output, screenshot |
| A.4 | Window and a browser tab together: resizing the tab never resizes the agents; the window does | Screen sizes logged |
| A.5 | No screen (SSH, `DISPLAY` unset): bare `chorus` prints the message and serves; `chorus-cli` opens the CLI app | Terminal output |
| A.6 | `--host 0.0.0.0` in a container: reachable from the Mac's browser through `-p 127.0.0.1:4318:4318`; a wrong Host is refused; no token is refused | Screenshot, HTTP log |
| A.7 | Without `--host`, nothing outside the machine can connect | HTTP log |
| A.8 | Unit tests for the screen detection (each case above) and for the Host and Origin checks with and without `--host` | `npm test` |

## Part B: the Docker box

**One image, `ghcr.io/chauvoluuhuong/chorus-box`** (GitHub's registry, free for a public repo), for `linux/amd64` and `linux/arm64`:

| In the image | Why |
|---|---|
| Debian 12 slim (glibc), `git`, `curl`, `ca-certificates`, Node.js 22, Python 3, build tools | The installer needs glibc; agents need the usual tools to run a project's checks |
| Claude Code, Codex and agy at the **newest tested versions**, read from chorus-core `src/tested.json` at build time, with their auto-update off | The same versions the Doctor pins; an update can't break the box underneath Chorus |
| A user `chorus` (not root), and an entrypoint | Agents never run as root |
| **Not** Chorus itself | You choose stable or preview at start, and the installer is the same one everyone else uses |

**The entrypoint, on start:**

1. **Stable or preview?** Asked once if the terminal is interactive (`docker run -it`), else read from `CHORUS_CHANNEL`. It installs with the official
   `install.sh` (`CHORUS_NO_OPEN=1`), and on later starts updates on the same channel. The answer is kept in the volume.
2. Starts `chorus serve --host 0.0.0.0 --port 4318` and prints the browser address (also in `docker logs chorus`).

**The launcher on your computer**, `docker.sh`, served by the website next to `install.sh` (chorus-admin `site/`):

```
curl -fsSL https://chorus-cli.web.app/docker.sh | bash                    # add -s -- --preview for preview
```

It checks Docker is installed, then asks three things: **stable or preview**, **folder to share** (default: your home folder), **port** (default
4318). Then it runs:

```
docker run -it --name chorus \
  -p 127.0.0.1:4318:4318 \
  -v chorus-home:/home/chorus \
  -v "$FOLDER":"$FOLDER" \
  -e CHORUS_CHANNEL="$CHANNEL" \
  ghcr.io/chauvoluuhuong/chorus-box
```

- **`127.0.0.1:` in `-p`** keeps Chorus reachable from this computer only.
- **The shared folder appears at the same path inside**, so the paths in chats, artifacts and exports match your computer's.
- **`chorus-home`** keeps Chorus, its data and the CLIs' sign-ins across restarts and new images.
- **Sharing the home folder** (the default you chose) lets agents read and change anything in it, including keys and settings files. The launcher
  says so and suggests a projects folder instead.
- On Linux hosts the container runs with your user and group id, so files the agents write stay yours.

**Signing in the CLIs inside the box:** Chorus's Doctor shows each CLI's state; with no terminal app to open, it shows the command instead, for
example `docker exec -it chorus claude`. To prove first, per CLI (rule 1): Claude Code's sign-in from a container (a link and a code to paste);
Codex with ChatGPT or `--with-api-key`; agy, which stopped at a Google sign-in link on a fresh Linux machine. If agy can't sign in inside a
container, the box ships without it and says so.

**Build:** `.github/workflows/docker.yml` builds and pushes the image when a release is made and when chorus-core's tested versions change, tagged
`latest` and with the date. It reads `src/tested.json` from chorus-core the same way `release.yml` bundles it.

| # | Check | Evidence |
|---|---|---|
| B.1 | `docker.sh` on a Mac with Docker Desktop: asks the three questions; defaults work by pressing Enter | Terminal recording |
| B.2 | First start, stable: the installer runs, the address prints, Chorus opens in the Mac's browser | Screenshot |
| B.3 | Preview: the preview version installs, and the app says preview | Screenshot |
| B.4 | Restart the container: no reinstall question, logins and chats are still there | Screenshots |
| B.5 | The CLIs in the image are exactly the newest tested versions, and don't update themselves | `--version` output |
| B.6 | Each CLI signs in inside the box (or agy is documented as not supported) | Doctor screenshot |
| B.7 | A real Claude Code chat edits a file in the shared folder; on the host the file is owned by your user | `ls -l` output |
| B.8 | From another computer on the network, port 4318 refuses to connect | Command output |
| B.9 | `linux/arm64` on Apple silicon and `linux/amd64` both start | Run logs |

### Windows

Chorus has no native Windows build yet (TD-6), so the box is the way to run it on Windows. Docker Desktop runs the same Linux image through WSL 2,
its default on Windows; Chorus opens in the normal Windows browser at `http://localhost:4318/?token=…`.

- **`docker.ps1`**, the same launcher for PowerShell, served by the website too:

  ```
  irm https://chorus-cli.web.app/docker.ps1 | iex                           # preview: $env:CHORUS_CHANNEL="preview"; irm … | iex
  ```

- **Folder to share:** the home folder `C:\Users\<you>` by default (Enter), any other path typed, or **Browse…**, which opens Windows' own folder
  picker. Any drive works. It asks "Share another folder?" until the answer is no. Each one is mounted at a matching Linux path inside, for example
  `C:\Users\Lan` at `/mnt/c/Users/Lan`; Chorus could show these paths the Windows way later.
- **Speed:** a folder on `C:` is read across Windows and Linux, so big projects are slower there than in a folder inside WSL. When WSL has one,
  the launcher offers it.
- File ownership is not a concern on Windows. The 127.0.0.1 port binding works the same.

| # | Check | Evidence |
|---|---|---|
| B.10 | Windows 11, Docker Desktop with WSL 2: `docker.ps1` asks the questions, Browse… picks a folder, Chorus opens in Edge or Chrome | Screen recording |
| B.11 | Two shared folders on two drives: both show inside, and an agent edits a file in each | Screenshots |
| B.12 | Preview through `$env:CHORUS_CHANNEL="preview"` installs the preview | Screenshot |

## Part C: the website's install box

chorus-admin `site/index.html` (and `site-vi.json` for the Vietnamese page). Mockup: chorus-admin `docs/mockups/install-chooser.html`. It stays the
box the page has today, with two additions:

- **Docker beside macOS and Linux** in the switch at the top right of the box.
- **A Preview tick beside Copy.** Ticking it changes the command to the preview channel; the tick turns amber, and its tooltip says "Every change
  as soon as it's merged. It can break."
- The hint under the command and the requirements line follow the choice, as they already do for macOS and Linux.
- **Windows visitors** see only Docker, and the box says PowerShell. No extra message: there is no other choice.

| Choice | Command | Preview ticked |
|---|---|---|
| macOS or Linux | `curl -fsSL https://chorus-cli.web.app/install.sh \| bash` | adds ` -s -- --preview` |
| Docker on macOS or Linux | `curl -fsSL https://chorus-cli.web.app/docker.sh \| bash` | adds ` -s -- --preview` |
| Docker on Windows | `irm https://chorus-cli.web.app/docker.ps1 \| iex` | starts with `$env:CHORUS_CHANNEL="preview"; ` |

A merge to chorus-admin's `main` is a production deploy, so this ships only with the owner's OK, after part B's launchers work.

| # | Check | Evidence |
|---|---|---|
| C.1 | Each system (macOS, Linux, Windows) and each choice shows the command in the table, with and without Preview | Screenshots |
| C.2 | Copy copies exactly what is shown; the copied command works in a fresh terminal | Terminal output |
| C.3 | The Vietnamese page shows the same box in Vietnamese | Screenshot |
| C.4 | A phone: nothing scrolls sideways; Preview and Copy fit under the command | Screenshot |

## Risks

- **A shared home folder is a lot to give agents.** It's the owner's chosen default; the launcher warns every time it is used.
- **`--host` with the token in the address:** anyone who sees the address can use Chorus. That's why it stays opt-in, and why the launcher binds to
  127.0.0.1.
- **Signing in from a container** is unproven for all three CLIs, and failed for agy on a fresh Linux machine.
- **The image grows with three CLIs and build tools** (estimate: about 1 GB); pulled once, then cached.
- **Provider terms** for running agents in a container on a personal subscription are still unchecked (D4).

## Steps

| Step | Branch | Done when |
|---|---|---|
| A | `feature/browser-everywhere` | Checks A.1–A.8 pass; a preview ships |
| B0 | `feature/docker-box` | The sign-in probes per CLI (rule 1), fixtures in chorus-core |
| B | `feature/docker-box` | Checks B.1–B.12 pass; the image is on GHCR; a preview ships with `docker.sh` and `docker.ps1` |
| C | chorus-admin `codex/install-box` | Checks C.1–C.4 pass; deployed after the owner's OK |
