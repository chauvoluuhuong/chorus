# 🎵 Chorus

> Work across AI coding CLIs (Claude Code, Codex, Antigravity) as easily as in one: hand work
> from one agent to another without losing context, keep every thread in one place, and see what
> the agents do and make.

**Status:** Phase 1 (research) on branch `feat/refactor`. The v1 desktop prototype was removed
(still in git history on `dev`). First product: the **`chorus`** CLI app (package `chorus-cli`).
The desktop app comes after.

**Goal:** $5 lifetime license, ~5,000 buyers. See [docs/product.md](docs/product.md).

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
| [docs/product.md](docs/product.md) | Goal and success, value, pricing, competitors, risks |
| [docs/architecture.md](docs/architecture.md) | Build plan (5 phases), components, what is stored, MCP tools, handoff |
| [docs/roadmap.md](docs/roadmap.md) | Progress per phase; each ends with an e2e proof on the real CLIs |
| [docs/testing.md](docs/testing.md) | Test layers, what runs in the cloud vs on your Mac |
| [docs/integrations/](docs/integrations/README.md) | Verified facts per CLI: flags, events, paths, token usage, gotchas |
| [docs/distribution-and-trust.md](docs/distribution-and-trust.md) | Signing, notarization, payments, licensing |
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
