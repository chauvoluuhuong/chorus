# 🎵 Chorus

> Work across AI coding CLIs (Claude Code, Codex, Antigravity) as easily as in one: hand work
> from one agent to another without losing context, keep every thread in one place, and see what
> the agents do and make.

## Run it

Needs Node 22+ and at least one of `claude`, `codex`, `agy` installed and logged in (`chorus doctor` checks).
Open a **real terminal** (Terminal.app, iTerm), go to the project you want to work on, and run:

```bash
cd ~/path/to/your/project
node /Users/huong/chorus/src/cli/index.ts app      # the CLI app's home screen: agents, threads, n = new thread
```

Shorter: run `npm link` once in this repo (it installs the global `chorus` and `chorus-cli` commands): `chorus` opens the
desktop app, `chorus-cli` the CLI app in this terminal (also what `chorus` opens on Linux with no display, as over SSH).
Other ways in:

```bash
chorus new --agent claude --model sonnet --folder ~/work/api   # skip the form
chorus handoff --to codex                                       # continue the latest thread in Codex
chorus doctor | threads | show <id> | memory <id> | activity | trace <id>
chorus artifacts --serve --open                                 # artifacts in the browser, live reload
```

Keys inside the app: the menu key, then one letter. The menu key is `Ctrl+\` (on a Mac `Ctrl+Space` is usually taken by macOS for
switching input sources; it also works if you turned that shortcut off; `CHORUS_MENU_KEY=ctrl+b` picks another).
`Ctrl+\` then `n` new thread · `h` hand off · `1-9` switch (or click the sidebar) ·
`m` memory · `a` artifacts · `e` activity · `y`/`x` approve/deny a waiting request · `0` home · `?` help · `q` quit.
Hold Shift while dragging to select text (the app uses the mouse for the sidebar; `CHORUS_MOUSE=0` turns that off).

## Why

AI CLIs are powerful but siloed. When one hits its plan limit or you want another model's take,
you copy-paste context by hand, and the plans, mockups and reports each agent produced are
scattered. Chorus keeps one **thread** of work across agents:

- **Handoff:** open a new thread with another agent. Its first prompt tells it to load the
  previous thread through the `chorus` MCP tool `get_handoff_context` and confirm in a few
  bullets what it learned. Works even when the first agent has hit its plan limit.
- **All threads in one place:** several agents run at once in a sidebar like tabs; switch
  instantly and see which one is waiting for you.
- **Artifacts:** non-code files go to `.chorus/threads/<id>/artifacts/` and are easy to open.
- **Skills:** one set of skills, synced to every CLI and used by each agent.
- **Transparency:** you work in the real CLI TUI; Chorus shows tool calls, approvals and
  artifacts, and records everything for debugging.

## Docs

| Doc | What's in it |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Build plan (5 phases), components, what is stored, MCP tools, handoff |
| [docs/roadmap.md](docs/roadmap.md) | Progress per phase; each ends with an e2e proof on the real CLIs |
| [docs/testing.md](docs/testing.md) | Test layers, what runs in the cloud vs on your Mac |
| [docs/integrations/](docs/integrations/README.md) | Verified facts per CLI: flags, events, paths, token usage, gotchas |
| [docs/mockups/chorus-cli.html](docs/mockups/chorus-cli.html) | Clickable mockup of the chorus terminal app |
| [docs/archive/](docs/archive/) | v1 product concept, brainstorm and UI mockup (reference for the desktop app) |

## Repository layout

```
CLAUDE.md        start here: context, rules and next steps for AI coding sessions
docs/            architecture, roadmap, testing, per-CLI integration docs
tools/probe/     capability probe: runs a real CLI through fixed scenarios, records fixtures
fixtures/        captured real CLI output, per CLI and version (used by contract tests)
```

## Probe a CLI

```bash
node tools/probe/probe.mjs claude --model haiku
node tools/probe/probe.mjs codex
node tools/probe/probe.mjs agy
```

## Licence

GNU AGPL version 3 only ([LICENSE](LICENSE)), with an additional permission to combine Chorus with its CLI integration
library `@chauvoluuhuong/chorus-core`, which has its own licence. See [NOTICE.md](NOTICE.md).

## Website maintenance

The public website remains at [chorus-cli.web.app](https://chorus-cli.web.app). Its source and deployment are maintained in the separate `chorus-admin` repository. Release maintainers clone that repository beside this one; `npm run release:downloads` writes its installer artifacts there and `npm run deploy:site` delegates deployment.

### Release downloads (GitHub Actions)

`.github/workflows/release.yml` builds the installer downloads when `main` gets a new `package.json` version (or a `v*` tag
is pushed, or it is run by hand from the Actions tab) and attaches them to the GitHub Release `v<version>`:
`chorus-cli-<v>.tgz`, `chorus-darwin-arm64-<v>.tar.gz` and `Chorus-macOS-<v>.zip` on a macOS arm64 runner (Tauri),
`chorus-linux-x64-<v>.tar.gz` and `chorus-linux-arm64-<v>.tar.gz` on Linux runners of each arch (Docker: Debian 11 for the command,
Ubuntu 22.04 for the window `desktop/chorus-desktop`), and
`SHA256SUMS`. Run by hand on another branch it only keeps the files as workflow artifacts. It deploys nothing; to publish:

```bash
npm run release:fetch      # the release's files into ../chorus-admin/site/dl/, checksums verified, VERSION set in install.sh
npm run deploy:site
```

`npm run release:downloads` still builds everything on this Mac instead (needs Docker and the Tauri toolchain).

One-time setup, in the repository settings:

- **Secret `CHORUS_CORE_DEPLOY_KEY`** (Settings → Secrets and variables → Actions): the private chorus-core is checked
  out next to this repo with a read-only deploy key. Make one with `ssh-keygen -t ed25519 -N '' -C chorus-release -f chorus-core-deploy`,
  add `chorus-core-deploy.pub` to chauvoluuhuong/chorus-core → Settings → Deploy keys (read access only), paste the private
  `chorus-core-deploy` into the secret here, then delete both files. Only the core's built `dist/` goes into the downloads.
- **Variable `CHORUS_CORE_REF`** (optional): the chorus-core branch or tag to bundle; `dev` when unset. A manual run can
  pick another one.
