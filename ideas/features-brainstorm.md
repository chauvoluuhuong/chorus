# Features Brainstorm & Backlog — Chorus

## 1. Core Feature Set (MVP)

- [ ] **Agent Picker**: Pick `claude`, `agy` or `codex` and its model from the composer, with plan-limit and token usage per agent. Full detail lives on the Activity page (see [`ui-use-cases.md`](../documents/ui-use-cases.md)).
- [ ] **Dual-Plane View**:
  - **Canvas View**: Clean chat bubbles, collapsible thinking traces, and structured tool execution cards.
  - **PTY Terminal View**: Full-fidelity terminal emulator (`xterm.js` / `xterm.dart`) for power users who want the raw stream.
- [ ] **Smart Context Handoff**:
  - Automatically captures actions from the active tab.
  - Injects a compact summary into the target tab when switching (via `PreInvocation` in `agy` or `UserPromptSubmit` in `claude`).
- [ ] **Centralized Approval Gate**:
  - Intercepts dangerous actions (`run_command`, `replace_file_content`, file deletion).
  - Translates shell commands into plain language ("Wants to install 3 packages", "Wants to modify database schema").
  - 1-Click Approve, Edit Arguments, or Reject.
- [ ] **Unified Skills Discovery**:
  - Single canonical `.agents/skills/` directory.
  - Auto-symlinked to `.claude/skills/` and shared with `codex`.

## 2. Advanced Features (V2 / Pro)

- [ ] **Direct Inter-Agent `@Mentions`**:
  - Type `@claude ask @codex to run vitest and verify my change`.
  - Routed over local `agent-bridge-mcp` without manual intervention.
- [ ] **1-Click CLI Auto-Installer**:
  - Detects missing CLI binaries (`agy`, `claude`, `codex`) and installs them automatically in the background without user terminal commands.
- [ ] **Visual Side-by-Side File Diff Reviewer**:
  - Review code changes visually before approving file edits.
- [ ] **Undo / Snapshot Time Machine**:
  - Git branch checkpoint created before every agent run, allowing instant 1-click rollback if an agent makes a mistake.
