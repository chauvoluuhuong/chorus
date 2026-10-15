# Engineering Implementation Plan & E2E Verification Matrix — Chorus Desktop

> **Status**: Approved Implementation Plan  
> **Target Branch**: `dev`  
> **Core Tech Stack**: Tauri 2.0 (Rust Core) + React 19 + TypeScript + Tailwind CSS + `@xterm/xterm`  
> **Companions**:
> - Architectural Blueprint: [`../documents/system-architecture.md`](../documents/system-architecture.md)
> - CLI Engine Adapters: [`../documents/specs/cli-engine-adapters.md`](../documents/specs/cli-engine-adapters.md)
> - Storage & Artifact Hierarchy: [`../documents/specs/context-and-storage-spec.md`](../documents/specs/context-and-storage-spec.md)
> - E2E Testing Architecture: [`../documents/specs/e2e-testing-architecture.md`](../documents/specs/e2e-testing-architecture.md)
> - Use Cases & Acceptance Criteria: [`../documents/ui-use-cases.md`](../documents/ui-use-cases.md)
> - Interactive Prototype: [`../documents/ui-mockup-v3.html`](../documents/ui-mockup-v3.html)

---

## 1. Plan Overview & Verification Strategy

Chorus Desktop is built with a **Test-Driven, Milestone-Based Architecture**. To eliminate regression risks and ensure absolute fidelity across native OS pseudo-terminals (`portable-pty`), file watchers (`notify`), and multi-agent context transfers:

* **No milestone is marked done without an automated E2E test**.
* Each milestone defines:
  1. **Core Deliverables**: Frontend and Backend components built.
  2. **Technical Contracts**: Rust traits, Tauri commands, and React props.
  3. **Proposed E2E Verification Test**: A reproducible, executable Playwright scenario that drives the real UI and real OS processes via the Component Test Harness ([`window.__CHORUS_HARNESS__`](../documents/specs/e2e-testing-architecture.md)).

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                    7-MILESTONE IMPLEMENTATION TIMELINE                      │
├─────────────────────────────────────────────────────────────────────────────┤
│  M1: Scaffold, PTY Simulator & Harness ────────► E2E-01: Terminal Stream    │
│  M2: Composer, @-Mentions & /-Skills ──────────► E2E-02: Token & Context    │
│  M3: Approvals & Autonomous Flag ──────────────► E2E-03: Stdin Approval Gate│
│  M4: Scoped Artifacts & Draggable Canvas ──────► E2E-04: Resizer & Watcher  │
│  M5: Mid-Session & Quota Handoff ──────────────► E2E-05: Context Handoff    │
│  M6: Skills Studio & Disk Sync ────────────────► E2E-06: Symlink Sync       │
│  M7: Shared Memory, Activity & Production ─────► E2E-07: Full Regression    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Milestone 1: Desktop Shell, PTY Process Manager & Test Harness

### 1.1 Scope & Deliverables
1. **Tauri 2.0 Project Initialization**:
   - Initialize Tauri 2.0 app with Vite + React 19 + TypeScript + Tailwind CSS.
   - Configure window properties: frameless/macOS titlebar overlay, dark/light theme tokens matching [`ui-mockup-v3.html`](../documents/ui-mockup-v3.html).
2. **Rust PTY Manager (`portable-pty`)**:
   - Implement Rust subsystem to spawn CLI subprocesses in a pseudo-terminal.
   - Master/Slave TTY pipe: ANSI stream forwarding, process exit trap, `SIGINT` dispatcher.
3. **Component Test Harness Setup**:
   - Expose typed `window.__CHORUS_HARNESS__` when `CHORUS_TEST_MODE=1`.
   - Build standalone deterministic CLI simulator stub (`tests/e2e/stubs/cli-stub.ts`).
4. **Playwright E2E Setup**:
   - Configure `@playwright/test` to drive Tauri via `tauri-driver` / Vite dev server.

### 1.2 Proposed E2E Test to Verify Milestone 1
* **Test ID**: `E2E-M1-PTY-STREAM`
* **Test File**: `tests/e2e/m1-pty-stream.spec.ts`
* **Objective**: Verify that Chorus spawns an actual child CLI in a real PTY, streams ANSI escape sequences to `@xterm/xterm`, and captures log buffers in the test harness without memory leaks.
* **Execution Steps**:
  1. Playwright boots Chorus Desktop with test environment variable `CHORUS_TEST_MODE=1`.
  2. CLI mock scripts a sequence: `stdout: "\x1b[32m[chorus-mock]\x1b[0m Initialized Claude Code session."`.
  3. Playwright verifies the Terminal view renders the green styled text in `@xterm/xterm`.
  4. Playwright calls `window.__CHORUS_HARNESS__.getState()` and asserts `ptyStatus === 'connected'`.
  5. Playwright clicks `[data-test="composer-stop"]` (or sends `Ctrl+C`) and asserts the PTY receives `SIGINT` and exits cleanly with code 130.

---

## Milestone 2: Chat Plane, Composer Dock, Context Mentions (`@`) & Skills (`/`)

### 2.1 Scope & Deliverables
1. **Chat UI & Timeline**:
   - User messages (beige bubble on right) and Assistant replies (signed with engine badge & model).
   - Dynamic auto-resizing textarea with keyboard shortcuts (`Enter` to submit, `Shift+Enter` for newline).
2. **Context Mentions (`@`) Autocomplete**:
   - Popover triggering on `@` keystroke or `[@]` toolbar button.
   - 4-tab filtering: `All` | `📁 Files` | `📂 Folders` | `🎨 Artifacts`.
   - Rust ignore-aware filesystem traversal (excluding `.git`, `node_modules`).
3. **Skills & Slash Commands (`/`) Autocomplete**:
   - Popover triggering on `/` keystroke or `[/]` toolbar button.
   - Lists project skills (`/db-migrate`, `/tailwind-ui`) and built-in actions (`/handoff`, `/sync-skills`, `/compact`).
4. **Prompt Envelope Engine (Turn Injection)**:
   - Assembles user prompt, resolved file contents/pointers, and on-demand skill instructions into the turn envelope.

### 2.2 Proposed E2E Test to Verify Milestone 2
* **Test ID**: `E2E-M2-MENTIONS-AND-SLASH`
* **Test File**: `tests/e2e/m2-mentions-and-slash.spec.ts`
* **Objective**: Verify that typing `@` and `/` opens their respective popovers, inserts tokens into the composer, and injects context into the Prompt Envelope.
* **Execution Steps**:
  1. Type `"Review "` into `[data-test="composer-input"]`.
  2. Type `@` -> Assert `.mention-popover` opens with tabs `Files`, `Folders`, `Artifacts`.
  3. Select `src/components/OrderForm.tsx` -> Assert token `@src/components/OrderForm.tsx` is inserted.
  4. Type `" using "` then `/` -> Assert Slash popover opens with `/db-migrate`, `/tailwind-ui`.
  5. Select `/tailwind-ui` -> Assert `/tailwind-ui` is inserted.
  6. Click `[data-test="composer-submit"]`.
  7. **Verification**: Inspect `window.__CHORUS_HARNESS__.getLastPromptEnvelope()` and verify:
     - `context_files` includes relative path `src/components/OrderForm.tsx`.
     - `on_demand_skills` includes full markdown content of `tailwind-ui/SKILL.md`.

---

## Milestone 3: Human-in-the-Loop Inline Approvals & Autonomous Execution

### 3.1 Scope & Deliverables
1. **Interactive Inline Approval Card**:
   - Appears directly in chat thread when CLI requests privileged execution (`Bash`, migrations, mass deletes).
   - Displays agent mark, command summary, exact executable line, and risk explanation.
   - Buttons: **Allow (`y`)** (`[data-test="approval-allow-btn"]`) and **Don't allow (`n`)** (`[data-test="approval-deny-btn"]`).
2. **PTY Stdin Piping**:
   - Clicking Allow writes native `y\n` to PTY stdin; Don't allow writes `n\n`.
   - Tool card updates in real time to `Allowed · exit 0` or `Blocked · You chose Don't allow`.
3. **Autonomous Mode Switch (`--dangerously-skip-permissions`)**:
   - Toggle switch on Home screen and composer toolbar.
   - Appends `--dangerously-skip-permissions` (or engine equivalent) to CLI spawn arguments.
   - Bypasses approval gates and tags executed tools with `⚡ auto-approved`.
4. **Header Bell Notification Center**:
   - Cross-chat badge counter incrementing on held tools, clearing on resolution.

### 3.2 Proposed E2E Test to Verify Milestone 3
* **Test ID**: `E2E-M3-APPROVAL-AND-AUTONOMOUS`
* **Test File**: `tests/e2e/m3-approval-and-autonomous.spec.ts`
* **Objective**: Verify that interactive approvals halt execution until user confirms, and autonomous mode bypasses prompts cleanly.
* **Execution Steps**:
  1. **Safe Mode Run**:
     - Start chat in Safe Mode. Send command `"Run database migrations"`.
     - Mock CLI prints `Authorize command: npx prisma migrate dev [y/n]: ` and pauses on stdin.
     - Assert `[data-test="inline-approval-card"]` is visible and Bell counter shows `1`.
     - Click `[data-test="approval-allow-btn"]`.
     - Assert mock CLI stdin receives `y\n`, unblocks, and exits 0.
     - Assert Bell counter resets to `0`.
  2. **Autonomous Mode Run**:
     - Click `[data-test="toggle-skip-permissions"]` to ON -> Displays `⚡ auto-approve` chiplet.
     - Send command `"Run database migrations"`.
     - Assert mock CLI argv contains `--dangerously-skip-permissions`.
     - Assert NO approval card appears, execution completes immediately, and tool row shows `⚡ auto-approved (--dangerously-skip-permissions)`.

---

## Milestone 4: Scoped Artifact Dispatcher & Draggable Canvas Viewer

### 4.1 Scope & Deliverables
1. **Scoped Filesystem Hierarchy**:
   - All auxiliary non-codebase files written to `.chorus/artifacts/<ai-cli>/<chat-thread-id>/`.
   - Thread isolation and multi-agent attribution preserved.
2. **Universal OS File Watcher (`notify`)**:
   - Rust background watcher monitoring workspace files and `.chorus/artifacts/`.
   - Emits `artifact:updated` IPC event to frontend on file write.
3. **Canvas Panel UI**:
   - Embedded sandboxed WebView / GFM Markdown renderer with Mermaid diagrams.
   - Version switcher (`‹ v1 of 2 ›`), Code syntax tab, and side-by-side Diff view.
4. **Draggable Resizer Splitter (`#art-resizer`)**:
   - Mouse drag handle on left border resizing width between 320px and 85vw.
   - Real-time pixel pill counter in header (`720px`).
   - Double-click to reset to default 580px; Fullscreen button (`⤢`) to expand to 100vw.

### 4.2 Proposed E2E Test to Verify Milestone 4
* **Test ID**: `E2E-M4-ARTIFACT-CANVAS-RESIZER`
* **Test File**: `tests/e2e/m4-artifact-canvas-resizer.spec.ts`
* **Objective**: Verify live file hot-reloading in Canvas and physical mouse drag resizing on `#art-resizer`.
* **Execution Steps**:
  1. Mock CLI writes `<div class="cake">Order v1</div>` to `.chorus/artifacts/claude/t_cake/order-flow.html`.
  2. Assert Canvas panel `#art-panel` automatically opens and title shows `.chorus/artifacts/claude/t_cake/order-flow.html`.
  3. **Mouse Drag Resizing**:
     - Locate `resizer = page.locator('[data-test="art-resizer"]')`.
     - Dispatch `mousedown`, move mouse left by 140px, dispatch `mouseup`.
     - Assert panel width equals `720px` (± 2px) and header displays `720px`.
  4. **Double-Click Reset**:
     - Double-click `resizer` -> Assert width snaps back to default `580px`.
  5. **Fullscreen Toggle**:
     - Click `[data-test="canvas-fullscreen-btn"]` -> Assert width becomes `100%`. Click again to restore.

---

## Milestone 5: Conversational Handoff & Prompt Envelope Engine

### 5.1 Scope & Deliverables
1. **Voluntary Mid-Session Handoff**:
   - `[ ⇄ Hand off ]` button in composer dock with popover listing candidate agents and live quota status.
2. **Usage Limit Auto-Detection**:
   - Transcript scanner matching CLI plan limit events (`429`, quota exceeded, reset timestamp).
   - Limit banner displaying reset time with quick-action buttons: *Continue with Codex*, *Continue with Antigravity*.
3. **Context Delta Engine**:
   - Builds compact handoff summary (<150 tokens) containing: user goal, touched files, test status, open tasks.
4. **Handoff Process Orchestration**:
   - Cleanly halts source agent PTY session (cancels pending approvals).
   - Spawns target agent PTY session with native Prompt Envelope (`--append-system-prompt`, `-i`, or initial turn).
   - Injects visual handoff divider in chat thread: *"Continued with Codex · GPT Codex"*.

### 5.2 Proposed E2E Test to Verify Milestone 5
* **Test ID**: `E2E-M5-CONVERSATIONAL-HANDOFF`
* **Test File**: `tests/e2e/m5-conversational-handoff.spec.ts`
* **Objective**: Verify seamless context transfer from Claude to Codex without losing turn history.
* **Execution Steps**:
  1. Start active chat with Claude Code. Complete 2 turns (files created: `prisma/schema.prisma`).
  2. Click `[data-test="handoff-trigger-btn"]` -> Assert popover opens with Codex and Antigravity.
  3. Click `[data-test="handoff-agent-opt-codex"]`.
  4. Assert Claude PTY is cleanly stopped with exit 0.
  5. Assert Codex PTY is spawned in the workspace.
  6. Assert chat thread shows divider: *"Continued with Codex · GPT Codex"*.
  7. Assert collapsible briefing *"What Codex was told"* displays Prompt Envelope containing `prisma/schema.prisma`.
  8. Assert picker in composer switches to Codex.

---

## Milestone 6: Skills Studio & Multi-Directory Filesystem Sync

### 6.1 Scope & Deliverables
1. **Database-Backed Skill Registry**:
   - Full bundle persistence in database (instructions, templates, scripts with executable bits).
2. **Skills Studio UI**:
   - Live search input, skill cards, file count, execution indicators, edit drawer.
3. **Multi-Directory Sync Engine (`data-sync-skills`)**:
   - Scans `.agents/skills/`, `.claude/skills/`, and `.codex/skills/`.
   - Imports new bundles; displays toast summary (`"Scanned 3 folders · 2 skills imported"`).
4. **Physical Disk Materialization & Dematerialization**:
   - Toggle ON: Writes directory to `.agents/skills/<name>/` and sets `chmod +x` on scripts.
   - Toggle OFF: Deletes folder from `.agents/skills/<name>/` while preserving bundle in DB.

### 6.2 Proposed E2E Test to Verify Milestone 6
* **Test ID**: `E2E-M6-SKILLS-STUDIO-SYNC`
* **Test File**: `tests/e2e/m6-skills-studio-sync.spec.ts`
* **Objective**: Verify that `Sync skills` scans disk, imports bundles, and toggling materializes files on the filesystem.
* **Execution Steps**:
  1. Test fixture writes a new skill folder `.claude/skills/db-migrate/` with `SKILL.md` and `migrate.sh`.
  2. Navigate to Skills Studio in Chorus UI.
  3. Click `[data-test="sync-skills-btn"]`.
  4. Assert toast displays: *"Scanned skill folders · 1 new skill imported"*.
  5. Assert `db-migrate` row appears in the skills list with origin `Imported from .claude/skills`.
  6. Click Toggle Switch to **ON** for `db-migrate`.
  7. **OS Filesystem Assertion**: Verify directory `.agents/skills/db-migrate/` exists on disk and `migrate.sh` has executable permission (`0o755`).
  8. Click Toggle Switch to **OFF** -> Verify `.agents/skills/db-migrate/` is removed from disk.

---

## Milestone 7: Shared Memory Ledger, Activity Log & Production Release

### 7.1 Scope & Deliverables
1. **Shared Memory Ledger (Tier 1 vs Tier 2)**:
   - Tier 1 (Pushed automatically): Handoff summaries, Active skills index with token meters.
   - Tier 2 (Available on request via MCP): Turns, Tool executions, Artifacts, MCP read audits (`mcp_reads`).
2. **Activity Telemetry Log**:
   - Live filterable table (Workspace Tools, Hooks, Approvals, MCP, Errors) with timing to the second.
   - Side-by-side JSON payload viewer and **Export JSONL** button.
3. **In-DB Ring Buffer Pruning**:
   - Automated 1 GB cap enforcement on execution logs with user purge prompt.
4. **Production Packaging & Code Signing**:
   - Apple Notarization via `notarytool` (macOS Universal DMG/app).
   - Windows Code Signing (MSIX).
   - Auto-updater integration.

### 7.2 Proposed E2E Test to Verify Milestone 7
* **Test ID**: `E2E-M7-FULL-REGRESSION-AND-AUDIT`
* **Test File**: `tests/e2e/m7-full-regression.spec.ts`
* **Objective**: Run full end-to-end regression across all 12 use cases (UC-01 to UC-12), verify database persistence, and validate zero token leaks.
* **Execution Steps**:
  1. Execute automated suite running:
     - New chat with `--dangerously-skip-permissions` (UC-01).
     - Model selection and usage meter inspection (UC-02).
     - Inline approval allow/deny cycle (UC-06).
     - Canvas artifact resizing and diff inspection (UC-07).
     - Mid-session handoff with Prompt Envelope generation (UC-08).
     - Skills sync and materialization (UC-09).
     - Shared Memory Tier 1 & Tier 2 inspection (UC-10).
     - Activity Log payload inspection and JSON export (UC-11).
     - Context Mentions `@` and Skills Slash Commands `/` (UC-12).
  2. Assert all 12 acceptance test suites pass with 0 flakes.
  3. Assert database query confirms all records in `threads`, `turns`, `executions`, `artifacts`, `approvals`, `skills`, and `handoffs` match schema definitions.

---

## 2. Test Execution Commands & Verification Guide

Developers and reviewers can run the verification suite at any milestone using the standard commands:

```bash
# 1. Run all E2E tests headlessly in CI (runs against real PTY mock, sub-30s runtime)
npm run test:e2e

# 2. Run a specific milestone's E2E test with visual UI inspector
npx playwright test tests/e2e/m1-pty-stream.spec.ts --ui
npx playwright test tests/e2e/m3-approval-and-autonomous.spec.ts --headed
npx playwright test tests/e2e/m4-artifact-canvas-resizer.spec.ts --debug

# 3. Inspect live component state via Test Harness in DevTools Console
window.__CHORUS_HARNESS__.getState()
window.__CHORUS_HARNESS__.setArtifactWidth(750)
window.__CHORUS_HARNESS__.triggerHandoff('codex')
```
