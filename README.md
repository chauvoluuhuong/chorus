# 🎵 Chorus

> Hand work between AI coding CLIs (Claude Code, Codex, Antigravity) without losing context, and
> see the artifacts they create.

**Status:** restarting headless-first on branch `refactor`. The v1 desktop prototype was removed
(still in git history on `dev`). First product: **`chorus-cli`**. The desktop app comes after.

## Why

AI CLIs are powerful but siloed. When one hits its plan limit or you want another model's take,
you copy-paste context by hand, and the plans, mockups and reports each agent produced are
scattered. Chorus keeps one **thread** of work across agents:

- **Handoff:** start the next agent with a note of goal, decisions, files touched and next steps,
  injected as its first prompt, with an MCP server it can ask for more.
- **Shared context:** every agent in the thread reads and writes the same store through the
  `chorus` MCP tools (`get_thread_context`, `checkpoint`, `read_handoff`, …).
- **Artifacts:** non-code files go to `.chorus/threads/<id>/artifacts/` and are easy to open.
- **Transparency:** you work in the real CLI TUI; Chorus records everything it does for
  debugging.

## Docs

| Doc | What's in it |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Components (core, chorus-mcp, chorus-cli, desktop, harness), data model, handoff flow |
| [docs/roadmap.md](docs/roadmap.md) | Milestones M0–M7, each with a real-CLI exit check |
| [docs/testing.md](docs/testing.md) | Test layers, what runs in the cloud vs on your Mac |
| [docs/integrations/](docs/integrations/README.md) | Verified facts per CLI: flags, events, paths, token usage, gotchas |
| [docs/distribution-and-trust.md](docs/distribution-and-trust.md) | Signing, notarization, payments |
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
