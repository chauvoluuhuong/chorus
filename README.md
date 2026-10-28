# 🎵 Chorus

> Work across AI coding CLIs (Claude Code, Codex, Antigravity) as easily as in one: hand work
> from one agent to another without losing context, keep every thread in one place, and see what
> the agents do and make.

**Website: [chorus-cli.web.app](https://chorus-cli.web.app/)**

Chorus is a desktop app (macOS and Linux) with the `chorus` command. The window runs `chorus serve` and shows every
thread, tool call, approval and artifact; the agents themselves stay the real CLIs.

## Install

The website ([chorus-cli.web.app](https://chorus-cli.web.app/)) has the downloads and the install script. Needs at least one of `claude`, `codex`, `agy` installed and logged in (`chorus doctor` checks).

```bash
curl -fsSL https://chorus-cli.web.app/install.sh | sh                        # production
curl -fsSL https://chorus-cli.web.app/install.sh | bash -s -- --preview      # newest preview
```

`chorus` opens the desktop app. `chorus-cli` opens the terminal app (on hold, see Contributing), which is also what
`chorus` opens on Linux with no display, as over SSH.

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
- **Transparency:** you work in the real CLI; Chorus shows tool calls, approvals and
  artifacts, and records everything for debugging.

## Use it

```bash
chorus                                                          # the desktop app
chorus new --agent claude --model sonnet --folder ~/work/api    # a thread without the form
chorus handoff --to codex                                       # continue the latest thread in Codex
chorus doctor | threads | show <id> | memory <id> | activity | trace <id>
chorus artifacts --serve --open                                 # artifacts in the browser, live reload
chorus-cli                                                      # the terminal app
```

In the terminal app the menu key is `Ctrl+\` (`CHORUS_MENU_KEY=ctrl+b` picks another), then one letter: `n` new thread ·
`h` hand off · `1-9` switch · `m` memory · `a` artifacts · `e` activity · `y`/`x` approve/deny · `0` home · `?` help · `q` quit.

## Contributing

Chorus is AGPL-3.0 and developed in the open. Needs Node 22+; clone `chorus` and its private sibling `chorus-core` (the CLI
integration library) side by side, because `package.json` depends on `file:../chorus-core`; build that first.

```bash
npm install
npm test                  # contract + flow tests, no login needed
npm run typecheck
node src/cli/index.ts serve --open --fake-agents     # the desktop page without model calls
npm run proof:desktop     # end-to-end with the real CLIs (needs them logged in)
```

**Git flow.** `main` (preview releases) ← `dev` ← `feature/<slug>` | `fix/<slug>`; a `hotfix/<slug>` starts from a
production tag. Use Conventional Commits (`feat:`, `fix:`, `docs:`...), since the version is computed from them. Never work
directly on `dev` or `main`; open a PR into `dev`. Every bug fix comes with a regression test that failed before the fix.

**Rules that keep the app honest.**
1. Verify against the real CLIs. Never build on an assumed flag, event or file path: capture it with `tools/probe`, commit
   the fixture, then write the code.
2. Never edit the user's global CLI config; use per-session flags.
3. When spawning a CLI, close stdin for headless runs and remove `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
   `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID` from its environment.
4. Review fixtures for personal data before committing (the probe redacts emails, account ids and the home path).
5. The desktop app (`src/serve/`, `src/desktop/`, `desktop/`) comes first; the terminal app (`src/app/`) is on hold, so
   leave it alone unless a maintainer says otherwise.
6. This repo is public: no business material (pricing, plans, competitors) in code, docs or commits.

**Working with an AI coding agent.** Point it at this README and [docs/map.md](docs/map.md) (every doc, and where plans,
failures and learnings go). Example prompts:

- "Read README.md and docs/map.md, then fix <issue>. Branch from dev, add a failing regression test first."
- "Add <feature> to the desktop page. Verify against the real CLIs and save a screenshot as proof."

AI agent instruction files (`AGENTS.md`, `CLAUDE.md`) are not part of this repository; keep your own local copies, they are
git-ignored.

**Releases.** A merge into `main` is followed by a tag `vX.Y.Z-preview.N`, which `.github/workflows/release.yml` builds as
the rolling prerelease `preview`. A production tag `vX.Y.Z` is cut by the maintainer on the commit of a tested preview; it
builds the downloads attached to the GitHub Release. The website and `install.sh` live in a separate repository.

Build setup (repository settings): the secret `CHORUS_CORE_DEPLOY_KEY` is a read-only deploy key of the private chorus-core,
which the workflow checks out next to this repo (only the core's built `dist/` goes into the downloads); the optional variable
`CHORUS_CORE_REF` is the chorus-core branch or tag to bundle (`dev` when unset). `npm run release:downloads` builds the same
files on a Mac (needs Docker and the Tauri toolchain); `npm run release:fetch` pulls a release into the website repository.

## Docs

| Doc | What's in it |
|---|---|
| [docs/map.md](docs/map.md) | Start here: every doc, and where new plans, features, failures and releases go |
| [docs/architecture.md](docs/architecture.md) | Build plan (5 phases), components, what is stored, MCP tools, handoff |
| [docs/roadmap.md](docs/roadmap.md) | Progress per phase and open technical debt |
| [docs/testing.md](docs/testing.md) | Test layers, what runs in the cloud vs on your Mac |
| [docs/phase5.md](docs/phase5.md) | The desktop app |
| [docs/integrations/](docs/integrations/README.md) | Verified facts per CLI: flags, events, paths, token usage, gotchas |
| [docs/mockups/chorus-cli.html](docs/mockups/chorus-cli.html) | Clickable mockup of the terminal app |
| [docs/archive/](docs/archive/) | v1 product concept, brainstorm and UI mockup (reference) |

## Repository layout

```
src/core/        adapters, store, handoff, skills sync, launch (TypeScript, Node 22+, no build step: node file.ts)
src/serve/       chorus serve: local API + agent screens over WebSocket
src/desktop/     the desktop page it serves
desktop/         the native window: a thin Tauri shell that starts chorus serve
src/mcp/, src/cli/   the chorus MCP server and the chorus entry point
src/app/         the terminal app (on hold)
docs/            architecture, roadmap, testing, per-CLI integration docs
tools/probe/     capability probe: runs a real CLI through fixed scenarios, records fixtures
fixtures/        captured real CLI output, per CLI and version (used by contract tests)
test/            contract/, flow/, app/, serve/, smoke/
```

```bash
node tools/probe/probe.mjs claude --model haiku    # recapture fixtures; also codex, agy
```

## Licence

GNU AGPL version 3 only ([LICENSE](LICENSE)), with an additional permission to combine Chorus with its CLI integration
library `@chauvoluuhuong/chorus-core`, which has its own licence. See [NOTICE.md](NOTICE.md).
