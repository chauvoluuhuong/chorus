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
npm run smoke:app                          # the real app hosting the real agent TUIs in PTYs
node src/cli/index.ts mux codex agy        # try the app by hand
node tools/probe/probe.mjs <cli>           # recapture fixtures after a CLI update
```

## Current state and next steps

Phases 1–3 are built and their L3 proofs pass with the real Claude Code 2.1.284, Codex 0.163.0 and
agy 1.4.0 (see `docs/roadmap.md`).

1. Phase 4 (chorus CLI app): plan and the D1 decision (TypeScript) are in `docs/phase4.md`; the spike is
   in `tools/spike/`. P4.1 (thread host + compositor, `src/app/`) is done and proven with the real CLIs; next is P4.2 (interactive launchers). Approval-card research (hooks per CLI)
   comes before P4.6.
2. D4 (provider terms) before selling.

Known gaps in what exists: nothing tails a transcript live yet (Phase 4); the `skills` table in
architecture §4 is not stored (skills are read from `.chorus/skills`); `file_change`, `reasoning`,
`turn.failed` Codex events, agy errors/quota and the Claude plan-limit hit are not captured (no fixture
yet); the PTY probes press Ctrl+C after the first reply, so the Claude `Stop` hook was not captured
interactively.
