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
| `tools/probe/` | Capability probe: runs a real CLI through scenarios and records fixtures |
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

## Current state and next steps (Phase 1)

Done:
- Claude Code 2.1.301 verified in headless mode (all 5 probe scenarios pass, fixtures committed).
- Codex 0.163.0: headless probe passes all 5 scenarios on the Mac (fixtures committed); interactive not yet.

Next, best done on the developer's Mac where all three CLIs are logged in:
1. `node tools/probe/probe.mjs codex` and `node tools/probe/probe.mjs agy`; review and commit
   `fixtures/`; update `docs/integrations/codex.md` and `antigravity-agy.md`.
2. Paste `agy --help` and `agy mcp --help` output into the agy doc; settle how agy gets a
   per-session MCP server (open decision D2).
3. Decide D1 (language). Proposal: TypeScript on Node 20+.
4. Extend the probe to interactive (PTY) sessions: Claude hooks + transcript tail, Codex session
   store, agy transcript.
5. Rewrite the integration docs as "how to get each data item" manuals, write the adapters with
   fixture tests, and build the Phase 1 e2e proof.

Phase 2 (skills sync research) can run in parallel. See `docs/roadmap.md`.
