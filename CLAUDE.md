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
| `docs/risks/` | Risk harness results: one page per risk (finding, fix when needed, trigger). Runner `tools/risk/`, evidence `fixtures/risks/` |
| `tools/probe/` | Capability probes: `probe.mjs` (headless scenarios), `pty-probe.mjs` (interactive), `skills-probe.mjs` |
| `src/core/` | Adapters (`adapters/`), store, handoff, skills sync, launch, capture (TypeScript, Node 22+, no build step: `node file.ts`) |
| `src/mcp/`, `src/cli/` | The `chorus mcp` server and the `chorus` entry point |
| `src/serve/`, `src/desktop/` | `chorus serve` (local API + agent screens over WebSocket) and the desktop page it serves (`docs/phase5.md`) |
| `desktop/` | The native window: a thin Tauri shell that starts `chorus serve` (`npm run build` inside) |
| `test/` | `contract/` (L1, fixtures), `flow/` + `app/` + `serve/` (L2, fake agent), `smoke/` (L3, real CLIs) |
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
npm run smoke:artifacts                    # each real agent saves a note in the thread's artifacts folder without being told in the prompt
npm run smoke:ask                          # each real agent asks for approval through a Chorus card (request_approval) and continues after the answer
npm run proof                              # Phase 4 e2e with screenshots → docs/proof/phase4/report.html, opened in the browser (real Claude + Codex, ~10 min)
npm run proof:agy                          # the same with agy (docs/proof/phase4-agy/, 30/30); agy has a small plan quota, don't repeat it often
npm run proof:desktop                      # Phase 5 e2e: the desktop page in Chrome + the native app, real Claude + Codex → docs/proof/phase5/
node src/cli/index.ts serve --open         # the desktop page in your browser (--fake-agents for UI work without model calls)
node src/cli/index.ts desktop              # the native window (installed app, else this checkout's build, else the browser)
npm run install:global                     # `chorus` on the PATH (npm link) + Chorus.app built and copied to /Applications
node src/cli/index.ts mux codex agy        # try the app by hand
npm run risk -- free|cheap|<case>          # risk harness (docs/risks/README.md); `cheap` makes a few real model calls
node tools/probe/probe.mjs <cli>           # recapture fixtures after a CLI update
```

## Current state and next steps

Phases 1–5 are built and proven with the real CLIs: 1–4 with Claude Code 2.1.302, Codex 0.163.0 and agy 1.4.2; Phase 5 (desktop:
`chorus serve` + the page in `src/desktop/` + the Tauri shell in `desktop/`, D3 decided) with Claude Code 2.1.306 and Codex 0.163.0,
43/43 in `docs/proof/phase5/` (`docs/phase5.md`, `docs/roadmap.md`).
Phase 4 includes UI pass 2 (P4.10): the CLI app now matches `docs/mockups/chorus-cli.html` (top bar, project-tree sidebar, New chat
screen with skip-permissions, approvals inbox, shared Memory across projects in `~/.chorus/chorus.db`, Skills screen, window-size
steps). The e2e proof with screenshots of every step is `docs/proof/phase4/README.md` (`npm run proof`).

The risks found before Phase 5 are probed and written down in `docs/risks/`; the fixes wait for their triggers and are listed as
technical debt TD-2..TD-10 in `docs/roadmap.md` (memory must be injected, not left to agents; errors and file changes are invisible
to the adapters; transcript matching; kitty keyboard; Windows; plan-limit capture).

1. Technical debt that a buyer would hit first: TD-3 (a failed run looks empty), TD-4 for agy (two agy chats started together; Codex is matched by thread marker since 2026-10-22), TD-2
   (memory digest at chat start), TD-1 (one global skill library).
2. Desktop before selling: signing and notarisation of `Chorus.app`, Windows/Linux builds (TD-6), a guard against the CLI app and
   the desktop resuming the same chat at once (`docs/phase5.md` §7).
3. D4 (provider terms) before selling.

Known gaps: `file_change`, `reasoning`, `turn.failed` Codex events, agy errors/quota and the Claude plan-limit hit are not
captured by the adapters (fixtures of the first three are in `fixtures/risks/capture-errors/`, TD-3); ctx % in the status line is not built
(TD-11); the hand pointer (OSC 22) is not probed.
