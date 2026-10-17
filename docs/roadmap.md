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
- [ ] Interactive Claude: hooks + transcript tail (needs `claude auth login`)
- [x] Integration docs as "how to get each data item" manuals
- [x] Adapter code per CLI + fixture tests (`src/core/adapters`, `test/contract`)
- [x] **Proof (Codex, agy):** `npm run smoke -- --phase 1` extracts turns, tool calls, usage and artifact
- [ ] **Proof (Claude):** same, after login

## Phase 2 · Skills sync

- [x] Per-CLI research: locations, format, discovery, invocation, default skills (Codex, agy verified)
- [x] `integrations/skills.md`
- [x] Sync design (source of truth, symlinks, Chorus-managed marker, removal) in `src/core/skills.ts`
- [x] Fallback for CLIs without native loading: MCP `list_skills` / `get_skill`
- [ ] Claude Code skills folder verified (needs login)
- [x] **Proof (Codex, agy):** `npm run smoke -- --phase 2`; [ ] Claude

## Phase 3 · MCP server

- [x] Store (SQLite WAL, `node:sqlite`) and capture pipeline (`src/core/store.ts`, `capture.ts`)
- [x] MCP tools: `get_handoff_context`, `get_thread_turns`, `list_threads`, `list_artifacts`, `list_skills`, `get_skill`
- [x] Fake agent (`tools/fake-agent`) + fast tests for every tool (`test/flow`)
- [x] **Proof (Codex ↔ agy):** one thread captured → another CLI's thread loads it through MCP and summarizes it (`npm run smoke -- --phase 3`); [ ] Claude as source/target

## Phase 4 · chorus CLI app

- [ ] Threads in PTYs with virtual screens, sidebar, status line, menu key
- [ ] Handoff, memory view, artifacts view, tool-call display
- [ ] Approval cards (research: Claude hooks / permission-prompt tool, Codex, agy)
- [ ] Limit warning and handoff suggestion
- [ ] `chorus doctor`, `chorus trace`
- [ ] **Proof:** test drives the app in a PTY: two threads, switch, handoff, approval from a card, artifact listed

## Phase 5 · Desktop app

- [ ] `chorus serve` local API
- [ ] Desktop UI over it
