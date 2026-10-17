# Chorus: notes for Claude

Read this first in every session. Details live in `docs/`.

## What we are building

Chorus makes it easy for developers to work across AI coding CLIs (Claude Code `claude`, OpenAI
Codex `codex`, Google Antigravity `agy`): handoff with shared context, all threads in one place,
visibility of tool calls / approvals / artifacts, one set of skills for every CLI.

- First product: **`chorus` CLI app** (package `chorus-cli`). Desktop app later, on the same core.
- Goal: $5 lifetime, ~5,000 buyers, mostly in the first 1–3 months after launch. Copies are
  expected and accepted. Build time is not the constraint. See `docs/product.md`.

## Where things are

| Path | What |
|---|---|
| `docs/product.md` | Goal, value, pricing, competitors, risks |
| `docs/architecture.md` | **Build plan (5 phases)**, components, data stored, MCP tools, handoff, threads |
| `docs/roadmap.md` | Progress checklist per phase |
| `docs/testing.md` | Test layers; what runs in the cloud vs locally |
| `docs/integrations/` | Verified facts per CLI (flags, events, file paths, fields, gotchas) |
| `docs/mockups/chorus-cli.html` | Clickable mockup of the CLI app |
| `tools/probe/` | Capability probes: `probe.mjs` (headless scenarios), `pty-probe.mjs` (interactive), `skills-probe.mjs` |
| `src/core/` | Adapters (`adapters/`), store, handoff, skills sync, launch, capture (TypeScript, Node 22+, no build step: `node file.ts`) |
| `src/mcp/`, `src/cli/` | The `chorus mcp` server and the `chorus` entry point |
| `test/` | `contract/` (L1, fixtures), `flow/` (L2, fake agent), `smoke/` (L3, real CLIs) |
| `tools/fake-agent/` | Fake AI CLI for L2 tests |
| `fixtures/<cli>/<version>/` | Real captured CLI output |
| `docs/archive/` | v1 material (product concept, UI mockup v3, marketing notes); reference only |

The v1 Tauri/React prototype was removed; it is in git history on `dev`. Work happens on
`feat/refactor`.

## Rules

1. **Verify against the real CLIs.** Never build on an assumed flag, event or file path. Run it,
   capture it with `tools/probe`, commit the fixture, then write the code. v1 failed because its
   tests passed against a fake harness while the real app didn't work.
2. **Every integration fact goes in `docs/integrations/<cli>.md`** with its status
   (✅ verified / 📄 docs only / ❓ unknown) and the version it was checked on.
3. **A phase is done only when its e2e proof passes with the real CLIs** (see architecture §2).
4. Never edit the user's global CLI config; use per-session flags.
5. When spawning a CLI: close stdin for headless runs, and remove `CLAUDECODE`,
   `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID` from the environment
   (a parent Claude session leaks its session id otherwise).
6. Review fixtures for personal data before committing (the probe redacts emails, account ids and
   the home path).

## Commands

```bash
npm test                                   # L1 + L2, no login needed
npm run typecheck
npm run smoke -- --agents claude,codex,agy --phase 1,2,3   # L3 against the real CLIs (not-logged-in CLIs are SKIPped)
node tools/probe/probe.mjs <cli>           # recapture fixtures after a CLI update
```

## Current state and next steps

Phases 1–3 are built and proven with Codex and agy on the Mac (see `docs/roadmap.md`). Claude Code's
login expired on the Mac, so every Claude-specific L3 step is pending:

1. `claude auth login`, then `npm run smoke -- --agents claude,codex,agy` (all phases), then
   `node tools/probe/pty-probe.mjs claude` (hooks + transcript tail while the TUI runs). Fix what fails,
   commit the new fixtures (`fixtures/claude/<version>/pty`), update `docs/integrations/claude-code.md`
   and `skills.md` (Claude skills folder).
2. Phase 4 (chorus CLI app): decide TypeScript vs Rust at its start (architecture D1), then PTY threads,
   sidebar, handoff, approvals. Approval-card research (Claude hooks / permission-prompt tool, Codex, agy)
   is part of it.
3. D4 (provider terms) before selling.

Known gaps in what exists: adapters read headless streams and transcripts but nothing tails a
transcript live yet (Phase 4); the `skills` table in architecture §4 is not stored (skills are read
from `.chorus/skills`); `file_change`, `reasoning`, `turn.failed` Codex events and agy errors/quota are
not captured yet (no fixture).
