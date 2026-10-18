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
- [x] P4.10 UI pass 2 (simpler, like an AI chat app), built 2026-10-18; plan [ui-plan.md](ui-plan.md), mockup `docs/mockups/chorus-cli.html`:
  - [x] Click-region registry (`Hit`, `hitAt`) and the look rules: button = filled chip, link = underlined, row = lights up under the mouse (mode 1003 hover)
  - [x] Top bar (`‹ Back`, path links, `! N waiting`, `☰ Menu`) and window-size steps (full / narrow / icons / hidden / too small)
  - [x] Sidebar = project tree (`+ New chat`, projects fold, chats under them, ↳ continued, Skills, Memory); Home and project picker removed
  - [x] New chat screen (agent, model, project folder, skip permissions) is the first screen; flags verified interactively (TD-10 resolved)
  - [x] Approvals inbox with risk tags, Decided history (`approvals_log`), y / x / ⏎; menu = the mockup's ten rows (↑↓ ⏎, click, letter)
  - [x] One shared database `~/.chorus/chorus.db` with a `project` column (`CHORUS_STORE=project` keeps the old per-project file); Memory screen across projects; `get_handoff_context` works for any project
  - [x] Skills screen: on/off, import what the agents already have. The global library and the opt-in links outside Chorus stay TD-1
  - [x] **Proof:** `npm run proof` rewritten for the new screens and run with the real Claude Code 2.1.302 and Codex 0.163.0: 52/52 checks, 23 screenshots in `docs/proof/phase4/` (New chat, skip permissions, inbox, handoff, Memory, Skills, menu, artifacts, window sizes)
  - [x] Also built: bell and flash for a request on another chat, artifacts open on ⏎/click with the "open failed: choose how" dialog (`.chorus/open.json`), `chorus skills on|off|import`
  - [x] Second pass against the mockup (2026-10-18): top bar shows only where you are (no `chorus`, no project), `PROJECTS` heading and `!N` badge per project, Skills and Memory side by side, icon mode shows dots only, `☰ Menu ⌃\\` and a clickable `☰ menu` in the status line, inbox `this project / all projects` and `Decided today`, Memory `/` search, Skills `e` edit and `n` new, Activity with counts per kind (approval, usage, handoff rows, durations), Doctor mouse and open lines, limit and handoff dialogs in the mockup's words
  - [x] **Effort** on New chat (asked for after the first pass; the mockup now has the row too): `--effort` for Claude and agy, `-c model_reasoning_effort` for Codex, per-model levels for Codex, stored with the chat, shown in the status line, `chorus new --effort`. Verified in the real TUIs: [integrations/effort.md](integrations/effort.md)
  - [ ] Not built: ctx % in the status line (TD-11), the hand pointer (OSC 22, probe first)

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

### TD-2 · Memory must not depend on agent initiative
Probed ([risks/memory-adoption](risks/memory-adoption.md)): agents save a memory on their own 7/9 times, use it 3/9; Codex 1/3 and 0/3.
- [ ] Inject a ≤300-token digest of global + project memory at chat start through the artifacts-note channels (MCP instructions for Claude/agy, `developer_instructions` for Codex).
- [ ] Capture memory candidates from transcripts and show them in the Memory screen as "Save?" (user confirms); `remember`/`recall` stay as bonus tools.
- [ ] Re-probe with a stronger Claude model and interactive sessions before quoting any adoption rate.

### TD-3 · Failures and file changes are invisible to the adapters
([risks/capture-errors](risks/capture-errors.md)) A bad model shows as a normal Claude turn, or as an empty thread for Codex and agy; Codex `file_change` never reaches the Files view.
- [ ] `Session.error` (`kind`, `message`, `status`), thread state `failed`, shown in sidebar, status line and `get_handoff_context`.
- [ ] Claude `result.is_error` (drop the `<synthetic>` turn), Codex `turn.failed`/`error`, agy `result.status==="ERROR"`; fixtures + L1 tests from `fixtures/risks/capture-errors/`.
- [ ] Codex `file_change` → tool call per changed path. Codex `reasoning` is encrypted: do not capture.

### TD-4 · Transcript matching when two threads start together
([risks/session-race](risks/session-race.md)) Codex birth order disagreed with launch order in 2/2 trials; same cwd.
- [ ] Codex: match the rollout by the `This chat is Chorus thread t_…` line in its developer message (`discover.ts`).
- [ ] agy: launch with a per-thread `--log-file` and read the session id from it (verify with interactive `-i`); fallback: serialize agy launches.
- [ ] Never guess when ambiguous: leave unlinked and retry.

### TD-5 · Focus events and kitty keyboard are not forwarded to threads (mouse is)
([risks/terminal-protocols](risks/terminal-protocols.md)) Codex asks for mouse (1000–1006) and kitty keys; agy for kitty keys; Claude for focus events.
- [x] Mouse: clicks inside the chat area are forwarded as SGR when the agent asked for the mouse, shifted by the sidebar and top bar (P4.10 tests). Wheel and motion are not forwarded yet.
- [ ] Answer the kitty keyboard query honestly and re-encode Shift/Ctrl+Enter; forward focus events to the focused chat only; forward wheel/motion for agents in mouse mode 1002/1003.

### TD-6 · Windows is unverified
([risks/windows](risks/windows.md)) node-pty/ConPTY, CLI home paths, Claude slug rule, skills copy-mode, Ctrl+\ in conhost.
- [ ] `windows-latest` CI job (`npm test` + `store-concurrency`), then a probe on a real Windows machine.

### TD-7 · No real plan-limit capture
([risks/plan-limit](risks/plan-limit.md)) The limit box is built on `fake-agent`; no real message from any CLI.
- [ ] Capture raw transcript + screen at the first natural limit hit; adapter test; `Session.error.kind='quota'`.

### TD-8 · Store write cost grows with session length
`Store.recordSession` rewrites every turn row on each tail (`INSERT OR REPLACE`); worst write was 992 ms with 24 writers ([risks/store-concurrency](risks/store-concurrency.md)). No lost writes.
- [ ] Insert only turns above the stored count; batch tailer writes (~250 ms). Do it with the move to `~/.chorus/chorus.db`.

### TD-9 · Approval prompt wording is version-specific
([risks/approval-drift](risks/approval-drift.md)) Resolved for claude 2.1.302, codex 0.163.0, agy 1.4.2.
- [ ] Run `npm run risk -- approval-drift` before `npm run proof`; refresh fixtures with `approval-probe.mjs` on every CLI update.

### TD-10 · "Skip permissions" flags: ✅ resolved 2026-10-18 (verified in the interactive screen, see [approvals.md §C](integrations/approvals.md))
Claude `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`, agy `--dangerously-skip-permissions` (ui-plan item 4).
- [x] Checked each flag in the interactive TUI with a probe; the status line shows `skip` in amber.

### TD-11 · Context-window meter (`ctx 34%` in the status line)
The status line already has the slot and drops it first when narrow (`StatusBar.ctx`); nothing fills it. What the fixtures show:
- Codex: the rollout's `token_count` events carry `last_token_usage` and `model_context_window` (258400 in `fixtures/codex/0.163.0`), so ctx % = last input tokens / window is derivable.
- Claude: the headless `result` has `modelUsage[model].contextWindow` (200000 / 1000000) but the interactive transcript has per-message `usage` only, no window size; the window per model would have to come from a table that is not verified (same gap as the open "plan meter for Claude interactive threads").
- agy: not looked at.
- [ ] Add `last_input_tokens` and `context_window` to `Session.usage` (adapter + store column), Codex first; probe Claude and agy for a source of the window before showing a number for them (rule 1: no assumed values). Until then the status line shows no ctx, never a guess.
