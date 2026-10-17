# 🎵 Chorus

> Hand work between AI coding CLIs (Claude Code, Codex, Antigravity) without losing context, and
> see the artifacts they create.

**Status:** restarting headless-first on branch `feat/refactor`. The v1 desktop prototype was removed
(still in git history on `dev`). First product: **`chorus-cli`**. The desktop app comes after.

## Why

AI CLIs are powerful but siloed. When one hits its plan limit or you want another model's take,
you copy-paste context by hand, and the plans, mockups and reports each agent produced are
scattered. Chorus keeps one **thread** of work across agents:

- **Handoff:** open a new thread with another agent. Its first prompt tells it to load the
  previous thread through the `chorus` MCP tool `get_handoff_context` and confirm in a few
  bullets what it learned.
- **Threads side by side:** several agents run at once; switch between them with one key.
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
| [docs/distribution-and-trust.md](docs/distribution-and-trust.md) | Signing, notarization, payments |
| [docs/mockups/chorus-cli.html](docs/mockups/chorus-cli.html) | Clickable mockup of the chorus terminal app |
| [docs/archive/](docs/archive/) | v1 product concept, brainstorm and UI mockup (reference for the desktop app) |

## Repository layout

```
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
