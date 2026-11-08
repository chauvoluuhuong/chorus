# The Chorus box (Docker)

Chorus in a clean Linux container, opened in your browser, on macOS, Linux and Windows. Plan:
[2026-11-07-browser-everywhere-and-docker](../plans/2026-11-07-browser-everywhere-and-docker.md), part B. Built 2026-11-08.

## Use

```bash
curl -fsSL https://chorus-cli.web.app/docker.sh | bash                    # macOS, Linux; add -s -- --preview for preview
irm https://chorus-cli.web.app/docker.ps1 | iex                           # Windows (Docker Desktop with WSL 2)
```

The launcher asks yes/no questions, Enter meaning yes: **use the stable version?** (no: preview), **share your whole home
folder?** (no: type folders, Tab completes; "Is that all the folders?"), and picks the port itself (4318, or the next free one; `CHORUS_PORT` sets another).
On Windows a folder can also be picked with B (Browse). It starts the box, opens `http://127.0.0.1:<port>/?token=…` (`localhost`
on Windows) and prints the address for another computer. Run it again to open Chorus again: a stopped box is started, nothing is
asked. Start over: `docker rm -f chorus`.

**Signing in the AI CLIs** happens in Chorus: in a container (`CHORUS_BOX=1` or `/.dockerenv`), the Doctor's **Log in** runs the
CLI's own sign-in inside the box (`src/serve/signin.ts`, in a PTY), opens its sign-in page in a new tab (opened on the click, so the
browser doesn't block it), and shows a popup with the link again in case the tab didn't open:

| CLI | What runs | The popup |
|---|---|---|
| Claude Code | `claude auth login` | the link, and a box for the code the page shows after you approve; the code is typed into the CLI |
| Codex | `codex login --device-auth` (its usual login waits for a browser on the box's localhost:1455) | the link and the one-time code to enter there; it finishes by itself |
| agy | `agy`, Google OAuth picked in its menu | the link (taken whole from its hyperlink), a box for a code if the page shows one, and **I've signed in** (agy keeps running after it signs in) |

Chorus can't see agy's sign-in state in the box, so agy's card always has **Log in**. Cancel stops the sign-in in the box. The
fallback, also under "Sign in from your computer's terminal instead" in the popup:

```bash
docker exec -it -u chorus chorus claude auth login
docker exec -it -u chorus chorus codex login --device-auth
docker exec -it -u chorus chorus agy
```

## How it works

| Piece | Where | What it does |
|---|---|---|
| Image `ghcr.io/chauvoluuhuong/chorus-box` | `docker/box/Dockerfile` | `node:22-bookworm-slim` (Debian 12, glibc) with git, Python 3, build tools, tini. Claude Code, Codex (npm, into `/usr/local`) and agy (its GitHub release) at the newest versions in chorus-core `src/tested.json` (`docker/box/tested.mjs`), auto-update off (`DISABLE_AUTOUPDATER=1`, `AGY_CLI_DISABLE_AUTO_UPDATE=1`). User `chorus` (uid 1000). Not Chorus itself. 2.2 GB unpacked (arm64) |
| Entrypoint | `docker/box/entrypoint.sh` | As root: gives `chorus` the host's ids (`HOST_UID`, `HOST_GID`, set by the launcher on Linux), then drops to it. Channel: `CHORUS_CHANNEL`, else the one kept in the volume, else asked (`docker run -it`), else stable. Installs or updates Chorus with the official `install.sh` (`CHORUS_NO_OPEN=1`), then `chorus serve --host 0.0.0.0 --port $CHORUS_PORT` and prints the address. Warns when the installed Chorus is too old for `--host` |
| Launchers | `docker/docker.sh`, `docker/docker.ps1`; served by the website (chorus-admin `site/`) | `docker run -d --name chorus -p <port>:<port> -v chorus-home:/home/chorus -v <folder>:<same path> …` (Windows: `C:\Users\Lan` at `/mnt/c/Users/Lan`). Reads the address from this run's `docker logs` |
| Build | `.github/workflows/docker.yml` | amd64 + arm64, tags `latest` and the date, on a release tag, on chorus-core's `repository_dispatch: tested-changed`, daily when the tested versions differ from the image's labels (`app.chorus.claude` …), or by hand |

- **The port is open on every address of the computer** (`-p <port>:<port>`), so another computer on the network reaches Chorus
  too, and Chorus in the box (`serve --host 0.0.0.0`) accepts any address it is reached by. The token in the address guards every
  request until Chorus has a login (owner's decision, 2026-11-08: no question about it). Before 2026-11-08 the launcher bound
  127.0.0.1 only.
- **`chorus-home`** keeps Chorus, its data, the channel and the CLIs' sign-ins across restarts and new images.
- **Same path inside** for shared folders, so the paths in chats, artifacts and exports match your computer's.
- Every start runs `install.sh` again (an update on the same channel; it downloads the package even when it is current).
- The box needs a Chorus with `serve --host` (this branch's preview and later). The stable channel works once that is released.

Testing the box without publishing anything: `CHORUS_BOX_IMAGE=<local tag>`, `CHORUS_NAME`, `CHORUS_VOLUME`, `CHORUS_NO_OPEN=1`,
and `CHORUS_BOX_DOCKER_ARGS="-v <dir>:/chan:ro -e CHORUS_INSTALL_URL=file:///chan/install.sh -e CHORUS_DOWNLOADS=file:///chan"`
with a package from `node scripts/release-downloads.mjs --no-app --no-desktop --targets=linux-arm64 --out=<dir>`, renamed to a
`-preview.N` version with its `VERSION` and `SHA256SUMS`.

## Checks (2026-11-08, Mac with Docker Desktop 29.7.2, arm64)

| # | Result | Evidence (`.chorus/proof/feature-browser-everywhere/`) |
|---|---|---|
| B.1 | ✅ questions answered; defaults offered | `B1-B2-launcher-first-start.txt` |
| B.2, B.3 | ✅ preview installs through install.sh, the address opens in the Mac's browser, the Doctor sees the three CLIs | `B2-box-log.txt`, `B2-B3-box-in-browser-doctor.jpg` |
| B.4 | ✅ restart: nothing asked, channel, CLI files and database kept; fresh address (a stale-token bug fixed) | `B4-B7-restart-and-files.txt`, `B4-restart-address.txt` |
| B.5 | ✅ Claude Code 2.1.310, Codex 0.164.0, agy 1.4.5, auto-update off | `B5-cli-versions.txt` |
| B.6 | ⏳ Log in in the box opens each CLI's popup with the right link (Claude, agy) and code (Codex), Cancel stops it; a sign-in completed with the owner's accounts not run yet | `signin-*-popup.jpg` |
| B.7 | ⏳ a file the box writes in the shared folder is owned by the Mac user; a real Claude chat editing it waits for B.6 | `B4-B7-restart-and-files.txt` |
| B.8 | changed (owner, 2026-11-08): the port is open on the network; the token is still required | — |
| B.9 | ⏳ arm64 ✅ here; amd64 is checked by the workflow's last step | `B5-cli-versions.txt` |
| B.10–B.12 | ⏳ need Windows; `docker.ps1` parses, and its path mapping is checked in PowerShell | `B10-ps1-paths.txt` |
