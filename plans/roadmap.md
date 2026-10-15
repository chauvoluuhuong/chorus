# Implementation Roadmap — Chorus Desktop

> **Companion Document**: See [**`implementation-plan.md`**](implementation-plan.md) for the detailed, milestone-by-milestone technical deliverables and executable E2E verification test specifications.

---

## 7-Milestone Test-Driven Timeline

### Milestone 1: Desktop Shell, PTY Process Manager & Test Harness
- [ ] Initialize Tauri 2.0 app with React 19, TypeScript, Tailwind CSS.
- [ ] Implement Rust pseudo-terminal manager (`portable-pty`).
- [ ] Expose `window.__CHORUS_HARNESS__` and create deterministic CLI simulator stub.
- [ ] **Verification**: `E2E-M1-PTY-STREAM` (spawns real PTY, streams ANSI, verifies Ctrl+C exit).

### Milestone 2: Chat Plane, Composer Dock, Context Mentions (`@`) & Skills (`/`)
- [ ] Build Chat Timeline and dynamic Composer component.
- [ ] Implement `@` autocomplete popover for Files, Folders, and Artifacts.
- [ ] Implement `/` autocomplete popover for Skills and Slash Commands.
- [ ] Implement Prompt Envelope turn assembler with on-demand skill injection.
- [ ] **Verification**: `E2E-M2-MENTIONS-AND-SLASH` (types `@` and `/`, asserts envelope injection).

### Milestone 3: Human-in-the-Loop Inline Approvals & Autonomous Execution
- [ ] Implement interactive Inline Approval Card in chat thread.
- [ ] Pipe native `y\n` / `n\n` to PTY stdin upon user decision.
- [ ] Add `--dangerously-skip-permissions` toggle for autonomous execution.
- [ ] Add Header Bell notification counter for held approvals.
- [ ] **Verification**: `E2E-M3-APPROVAL-AND-AUTONOMOUS` (tests approval pause/resume & autonomous bypass).

### Milestone 4: Scoped Artifact Dispatcher & Draggable Canvas Viewer
- [ ] Create isolated folder hierarchy: `.chorus/artifacts/<ai-cli>/<chat-thread-id>/`.
- [ ] Implement Rust OS file watcher (`notify`) for live hot-reloading.
- [ ] Implement draggable resizer splitter (`#art-resizer`, 320px–85vw, double-click reset, fullscreen).
- [ ] Implement Multi-tab viewer (Preview WebView/GFM, Code, Diff).
- [ ] **Verification**: `E2E-M4-ARTIFACT-CANVAS-RESIZER` (tests file creation, hot-reload, and mouse drag resize).

### Milestone 5: Conversational Handoff & Prompt Envelope Engine
- [ ] Implement voluntary mid-session handoff button `[ ⇄ Hand off ]` in composer toolbar.
- [ ] Implement CLI usage limit auto-detection (transcript scanner).
- [ ] Implement Context Delta engine (<150 tokens) and Prompt Envelope delivery.
- [ ] Implement clean PTY handover (halts previous agent, spawns target agent).
- [ ] **Verification**: `E2E-M5-CONVERSATIONAL-HANDOFF` (tests Claude to Codex transfer with Prompt Envelope).

### Milestone 6: Skills Studio & Multi-Directory Filesystem Sync
- [ ] Implement database-backed Skill Registry storing instructions, scripts, and executable flags.
- [ ] Implement Skills Studio UI with live search, skill cards, and on/off switches.
- [ ] Implement `Sync skills` scanner across `.agents/skills`, `.claude/skills`, `.codex/skills`.
- [ ] Implement physical disk materialization (`chmod +x`) and dematerialization.
- [ ] **Verification**: `E2E-M6-SKILLS-STUDIO-SYNC` (tests disk scan, import, and filesystem materialization).

### Milestone 7: Shared Memory Ledger, Activity Log & Production Release
- [ ] Implement Shared Memory UI (Tier 1 pushed vs Tier 2 on-demand via MCP).
- [ ] Implement Activity Telemetry Log with filters and JSON payload viewer.
- [ ] Enforce in-DB 1 GB ring buffer cap with auto-purge.
- [ ] Configure Apple Notarization (`notarytool`), Windows Code Signing (MSIX), and release CI.
- [ ] **Verification**: `E2E-M7-FULL-REGRESSION-AND-AUDIT` (runs 100% automated regression across all 12 use cases).
