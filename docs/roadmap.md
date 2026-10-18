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

Plan and results: [phase4.md](phase4.md). D1 decided: TypeScript. E2E proof with screenshots: [proof/phase4/README.md](proof/phase4/README.md).

- [x] P4.1 Thread host + compositor (sidebar, status line, resize, switching): `src/app/`, `npm run smoke:app`
- [x] P4.2 Interactive launchers (first prompt + per-thread MCP + skills sync) for each CLI
- [x] P4.3 Live transcript tailing into the store (`src/app/tailer.ts`)
- [x] P4.4 Thread state (`working` / `waiting` / `needs approval` / `ended` / `parked`)
- [x] P4.5 Handoff action with "context not loaded" warning and retry key
- [x] P4.6 Approval cards: research ([integrations/approvals.md](integrations/approvals.md)) and implementation (screen detector + the prompt's own keys)
- [x] P4.7 Memory, tool-call and files views, limit warning, `new/run/handoff/threads/show/memory/artifacts/activity/trace/doctor`
- [x] P4.8 Packaging spike: Node single executable works (147 MB), Bun does not (node-pty); npm package is the main route
- [x] New-thread form: agent, model, folder (mockup scene "New thread")
- [x] P4.9 Mockup look and screens (first pass): home, sidebar, status bar, menu, limit box, Artifacts, Activity, Doctor (`docs/phase4.md`)
- [x] P4.9 remaining parts: mouse clicks, artifact preview server with live reload, `o/p/v`, `r/f`
- [ ] Plan meter for Claude interactive threads (Claude reports plan usage only in the headless stream)
- [x] **Proof:** `npm run proof` drives the real app with real Claude and Codex: two threads, switch, approval from a card, handoff, artifacts; screenshots in `docs/proof/phase4/`
- [ ] P4.10 UI pass 2 (simpler, like an AI chat app): project-tree sidebar, New chat form with skip-permissions, shared Memory and Skills. Plan: [ui-plan.md](ui-plan.md), mockup `docs/mockups/chorus-cli.html`

## Risk harness (before Phase 4.5 / 5)

Probe the known risks first, document the fix for each, build only when its trigger fires. Results: [risks/README.md](risks/README.md).

- [x] Harness `tools/risk/` + 6 probed cases (store concurrency, terminal protocols, approval drift, memory adoption, capture errors, session race)
- [ ] Windows (R7) and a real plan-limit capture (R8): manual, waiting for an environment / an event
- [x] agy session matching (R6: `--log-file`), MCP tool visibility (R4: all three CLIs see the tools), Claude 2.1.302 approval prompt (R3), Codex reasoning (R5: encrypted, skip)
- [ ] Verify agy `--log-file` with an interactive `-i` launch; re-probe memory with a stronger Claude model and interactive sessions

## Phase 5 · Desktop app

- [ ] `chorus serve` local API
- [ ] Desktop UI over it

## Technical debt

### TD-1 · Universal skills (one library that every agent finds and understands)

Today skills sync per project from `<project>/.chorus/skills` (Phase 2, proven). The UI plan makes the library
global (`~/.chorus/skills`). Not solved yet, to do later:

- [ ] **Find new skills:** scan the native folders (`.claude/skills`, `.agents/skills`, `.codex/skills` and the
  `~/` versions) at app start and chat start, plus a file watcher while chats run. New = has `SKILL.md`, is not a
  Chorus link or `.chorus-managed` folder, is not a CLI default (`~/.codex/skills/.system`, agy `builtin/`).
  A content hash catches changes to imported skills. Offer them for import.
- [ ] **Global source:** move the sync source to `~/.chorus/skills`, linked into each project at chat start
  (same links and `.git/info/exclude` as today). Opt-in links in `~/.claude/skills` and `~/.agents/skills` for
  use outside Chorus (rule 4: off by default). agy's user-level folder is ❓: probe first.
- [ ] **Understanding a skill written for another CLI:** the format is the same (✅ `integrations/skills.md`);
  the text may name tools or fields only one CLI has (`TodoWrite`, `WebFetch`, `allowed-tools`, `$ARGUMENTS`).
  Plan: a fixed ~100-token paragraph injected at chat start through the channels already verified for the
  artifacts folder (MCP server instructions for Claude and agy, `-c developer_instructions` for Codex) that maps
  foreign tool names to the agent's own, says to ignore unknown frontmatter and resolves paths from the skill
  folder. No per-skill rewrite and no "works in" UI unless the probe shows it is needed.
- [ ] **Limits to accept:** a prompt cannot make an agent see a skill (native folders do that), cannot add a tool
  the agent lacks, and cannot grant permissions (`allowed-tools` only means something to Claude).
- [ ] **Proof:** a probe puts a Claude-style skill (uses `TodoWrite`, `$ARGUMENTS`, `allowed-tools`) in the
  library and checks in the Codex and agy transcripts that they load it and follow it; fixture in `fixtures/skills/`.
