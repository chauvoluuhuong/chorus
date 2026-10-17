# Roadmap

The plan and the reasoning behind each phase are in [architecture.md §2](architecture.md#2-build-plan).
This file tracks progress. A phase is done only when its e2e proof passes with the real CLIs.

## Phase 1 · Context capture

- [x] Probe tool (`tools/probe/`): hello, MCP, shell, artifact, resume scenarios (headless)
- [x] Claude Code headless verified, fixtures committed
- [x] Codex: flags + per-session MCP spawn verified
- [ ] Decide D1 (language)
- [ ] Extend the probe to interactive (PTY) sessions: hooks, transcript tail
- [ ] Codex: model turn verified (needs login: `OPENAI_API_KEY` in the cloud, or the Mac)
- [ ] Agy: probe on the Mac, settle per-session MCP (D2)
- [ ] Integration docs rewritten as "how to get each data item" manuals
- [ ] Adapter code per CLI + fixture tests
- [ ] **Proof:** scripted real session per CLI; extracted turns, tool calls, usage and artifact match

## Phase 2 · Skills sync

- [ ] Per-CLI research: locations, format, discovery, invocation, default skills
- [ ] `integrations/skills.md`
- [ ] Sync design (source of truth, write-out, Chorus-managed marker, removal)
- [ ] Fallback for CLIs without reliable native loading (first-prompt index / `AGENTS.md` / MCP)
- [ ] **Proof:** marker skill synced to all three CLIs and used by each

## Phase 3 · MCP server

- [ ] Store (SQLite WAL) and capture pipeline
- [ ] MCP tools: `get_handoff_context`, `get_thread_turns`, `list_threads`, `list_artifacts`, skills tools
- [ ] Fake agent + fast tests for every tool
- [ ] **Proof:** Claude thread captured → Codex thread loads it and summarizes correctly

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
