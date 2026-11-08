# The Chorus box (Docker)

Chorus in a clean Linux container, opened in your browser, on macOS, Linux and Windows. Plan:
[2026-11-07-browser-everywhere-and-docker](../plans/2026-11-07-browser-everywhere-and-docker.md), part B. Built 2026-11-08.

## Use

```bash
curl -fsSL https://chorus-cli.web.app/docker.sh | bash                    # macOS, Linux; add -s -- --preview for preview
irm https://chorus-cli.web.app/docker.ps1 | iex                           # Windows (Docker Desktop with WSL 2)
```

The launcher asks **stable or preview**, the **folders to share** (Enter: your home folder, with a warning; on Windows also
Browse…, and "Share another folder?" until no) and the **port** (4318, or the next free one). It starts the box and opens
`http://127.0.0.1:<port>/?token=…` (`localhost` on Windows). Run it again to open Chorus again: a stopped box is started, nothing is
asked. Start over: `docker rm -f chorus`.

Sign in the AI CLIs from your computer's terminal (the Doctor in the box shows the same command with a Copy button):

```bash
docker exec -it -u chorus chorus claude auth login           # prints a link; paste the code back
docker exec -it -u chorus chorus codex login --device-auth   # its usual login waits for a browser on the box's localhost:1455
docker exec -it -u chorus chorus agy                         # asks on its first start
```

## How it works

| Piece | Where | What it does |
|---|---|---|
| Image `ghcr.io/chauvoluuhuong/chorus-box` | `docker/box/Dockerfile` | `node:22-bookworm-slim` (Debian 12, glibc) with git, Python 3, build tools, tini. Claude Code, Codex (npm, into `/usr/local`) and agy (its GitHub release) at the newest versions in chorus-core `src/tested.json` (`docker/box/tested.mjs`), auto-update off (`DISABLE_AUTOUPDATER=1`, `AGY_CLI_DISABLE_AUTO_UPDATE=1`). User `chorus` (uid 1000). Not Chorus itself. 2.2 GB unpacked (arm64) |
| Entrypoint | `docker/box/entrypoint.sh` | As root: gives `chorus` the host's ids (`HOST_UID`, `HOST_GID`, set by the launcher on Linux), then drops to it. Channel: `CHORUS_CHANNEL`, else the one kept in the volume, else asked (`docker run -it`), else stable. Installs or updates Chorus with the official `install.sh` (`CHORUS_NO_OPEN=1`), then `chorus serve --host 0.0.0.0 --port $CHORUS_PORT` and prints the address. Warns when the installed Chorus is too old for `--host` |
| Launchers | `docker/docker.sh`, `docker/docker.ps1`; served by the website (chorus-admin `site/`) | `docker run -d --name chorus -p 127.0.0.1:<port>:<port> -v chorus-home:/home/chorus -v <folder>:<same path> …` (Windows: `C:\Users\Lan` at `/mnt/c/Users/Lan`). Reads the address from this run's `docker logs` |
| Build | `.github/workflows/docker.yml` | amd64 + arm64, tags `latest` and the date, on a release tag, on chorus-core's `repository_dispatch: tested-changed`, daily when the tested versions differ from the image's labels (`app.chorus.claude` …), or by hand |

- **`127.0.0.1:` in `-p`**: only this computer reaches the box (checked: the Mac's network address is refused).
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
| B.6 | ⏳ sign-in prompts seen (Claude: link + code; Codex: `--device-auth`); a real sign-in needs the owner's accounts | — |
| B.7 | ⏳ a file the box writes in the shared folder is owned by the Mac user; a real Claude chat editing it waits for B.6 | `B4-B7-restart-and-files.txt` |
| B.8 | ✅ the network address is refused | `B8-network-refused.txt` |
| B.9 | ⏳ arm64 ✅ here; amd64 is checked by the workflow's last step | `B5-cli-versions.txt` |
| B.10–B.12 | ⏳ need Windows; `docker.ps1` parses, and its path mapping is checked in PowerShell | `B10-ps1-paths.txt` |
