# Roadmap

The plan and the reasoning behind each phase are in [architecture.md §2](architecture.md#2-build-plan).
This file tracks progress. A phase is done only when its e2e proof passes with the real CLIs.
There is no fixed deadline. Next concrete steps are listed in [CLAUDE.md](../CLAUDE.md).

## Phase 1 · Context capture

- [x] Probe tool (`tools/probe/`): hello, MCP, shell, artifact, resume scenarios (headless)
- [x] Claude Code, Codex, agy headless verified, fixtures committed
- [x] Decide D1 (language): TypeScript on Node 22+ for Phases 1–3, revisit Rust at Phase 4
- [x] Codex: model turn verified; agy: probe on the Mac, per-session MCP settled (D2)
- [x] Interactive (PTY) probe: Codex and agy transcript tail verified (`tools/probe/pty-probe.mjs`)
- [x] Interactive Claude: hooks + transcript tail (`fixtures/claude/2.1.284/pty`)
- [x] Integration docs as "how to get each data item" manuals
- [x] Adapter code per CLI + fixture tests (`src/core/adapters`, `test/contract`)
- [x] **Proof (Claude, Codex, agy):** `npm run smoke -- --phase 1` extracts turns, tool calls, usage and artifact

## Phase 2 · Skills sync

- [x] Per-CLI research: locations, format, discovery, invocation, default skills (Codex, agy verified)
- [x] `integrations/skills.md`
- [x] Sync design (source of truth, symlinks, Chorus-managed marker, removal) in `src/core/skills.ts`
- [x] Fallback for CLIs without native loading: MCP `list_skills` / `get_skill`
- [x] Claude Code skills folder verified (`.claude/skills` only)
- [x] **Proof (Claude, Codex, agy):** `npm run smoke -- --phase 2`

## Phase 3 · MCP server

- [x] Store (SQLite WAL, `node:sqlite`) and capture pipeline (`src/core/store.ts`, `capture.ts`)
- [x] MCP tools: `get_handoff_context`, `get_thread_turns`, `list_threads`, `list_artifacts`, `list_skills`, `get_skill`
- [x] Fake agent (`tools/fake-agent`) + fast tests for every tool (`test/flow`)
- [x] **Proof:** one thread captured → another CLI's thread loads it through MCP and summarizes it, all three CLIs as source and target (`npm run smoke -- --phase 3`)

## Phase 4 · chorus CLI app

Plan: [phase4.md](phase4.md). D1 decided: TypeScript. Spike done (`tools/spike/`).

- [ ] P4.1 Thread host + compositor (sidebar, status line, resize, switching)
- [ ] P4.2 Interactive launchers (first prompt + per-thread MCP + skills sync) for each CLI
- [ ] P4.3 Live transcript tailing into the store
- [ ] P4.4 Thread state (`working` / `waiting` / `needs approval` / `ended`)
- [ ] P4.5 Handoff action with "context not loaded" warning
- [ ] P4.6 Approval cards (research first: hooks per CLI, then keystroke fallback)
- [ ] P4.7 Memory view, artifacts view, tool-call strip, limit warning, `doctor`, `trace`, `threads`, `show`
- [ ] P4.8 Packaging spike: Node SEA / Bun compile / per-platform npm packages; binary go/no-go
- [ ] **Proof:** test drives the app in a PTY: two threads, switch, handoff, approval from a card, artifact listed

## Phase 5 · Desktop app

- [ ] `chorus serve` local API
- [ ] Desktop UI over it
