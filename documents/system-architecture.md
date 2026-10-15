# System Architecture & Technical Overview — Chorus

Chorus is a multi-engine desktop orchestrator for autonomous AI coding agents (`agy`, `claude`, `codex`). It provides a unified user interface, human-in-the-loop safety gates, and cross-agent context synchronization without polluting token windows.

---

## 1. High-Level Dual-Plane Architecture

Chorus decouples the visual shell from backend agent orchestration across two planes:

```text
┌────────────────────────────────────────────────────────┐
│               Chorus Desktop App (UI)                  │
│   Browser-style Tabs  •  Canvas UI  •  Approval Gate   │
└───────────────┬────────────────────────┬───────────────┘
                │                        │
     (Terminal Plane: PTY)      (Control Plane: IPC/Sockets)
                │                        │
       ┌────────▼────────┐      ┌────────▼────────┐
       │   portable-pty  │      │ Local IPC / MCP │
       └────────┬────────┘      └────────┬────────┘
                │                        │
 ┌──────────────┼────────────────────────┼──────────────┐
 │              │                        │              │
 ▼              ▼                        ▼              ▼
agy CLI     claude CLI               codex CLI     Hook Adapter
```

### Plane 1: The Terminal & Canvas Plane (Visual Shell)
* **Terminal View**: Runs each CLI engine in an isolated native pseudo-terminal (PTY) process (`xterm.js` / `xterm.dart`).
* **Canvas & Artifact Viewer**: Side-by-side preview panel (like Antigravity & Claude Desktop Artifacts) for live interactive rendering of:
  * **HTML / Web Apps**: Embedded sandboxed WebView with live auto-refresh.
  * **Markdown Docs**: GFM renderer with Mermaid diagram and syntax highlighting support.
  * **Images & SVGs**: Vector preview with pan/zoom.
  * **Code Diffs**: Visual side-by-side comparison before approving changes.

### Plane 2: The Control & Telemetry Plane (Intelligence & Governance)
* Runs a local background daemon inside the desktop app.
* Implements an **Adapter Pattern Architecture** to decouple the Chorus application layer from the varying hook and execution models of underlying CLI engines (`claude`, `codex`, `agy`):
  1. **Lifecycle Hooks Adapter**: Exposes a unified lifecycle interface required by the application (Session Start, Prompt Envelope Injection, Pre-Execution Approval Gate, Post-Execution Telemetry, and Session Interrupt). Each CLI engine provides a concrete adapter fulfilling this contract using its best native mechanism (settings hooks, PTY stream parsing, or flags).
  2. **Artifact Dispatcher Adapter**: Universal asset pipeline that detects newly created or modified artifacts (UI previews, specs, SVGs), indexes metadata into the database, and dispatches live events to the Canvas Viewer. Uses a dual-detection mechanism (Tool Call argument parsing + OS File Watcher on project and `.chorus/artifacts/`).
  3. **Local MCP Server (`agent-bridge-mcp`)**: Shared cross-agent protocol exposing standard query tools for inter-agent context sharing and artifact retrieval.

> Concrete adapter mechanisms and engine-by-engine feasibility evaluations are detailed in [cli-engine-adapters.md](specs/cli-engine-adapters.md).

---

## 2. Human-in-the-Loop Approval Protocol

Before any CLI engine executes a privileged or risky tool:
1. The engine passes the tool execution request to Chorus (via the engine's approval adapter or hook relay).
2. The UI presents an interactive **Inline Approval Card** directly in the chat thread (or notifications if running in background) and suspends the CLI process.
3. The user explicitly chooses **Allow** (`allow` / `y`) or **Don't allow** (`deny` / `n`).
4. The desktop app sends the native decision back to the engine, and the CLI resumes immediately. If denied, the CLI receives the denial signal and prompts the user for alternative instructions.

---

## 3. Context Handoff & Token-Optimization Strategy

Chorus balances cross-agent context sharing with token budget conservation using a **Two-Tier Architecture**:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        User-Controlled Handoff                         │
│     [ Keep in @claude ]   [ Continue in @codex ]   [ Hand off to @agy ]│
│         (Triggered via 1-Click Action or Plan Limit Reached)           │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Tier 1: Prompt Envelope Push                         │
│          Injected natively at session launch / handoff turn            │
│                 Total budget: <150–200 tokens                          │
│                                                                        │
│   1. Artifact Directive (Generalized):                                 │
│      "Auxiliary files created during usage not directly part of the    │
│       project codebase must be saved to:                               │
│       .chorus/artifacts/<ai-cli>/<chat-thread-id>/"                    │
│   2. Enabled Skills Index:                                             │
│      Compact catalog of active skills with file path pointers          │
│   3. Handoff Briefing (if transferring from peer agent):               │
│      • User Goal  • Files Touched  • Test State  • Next Tasks          │
│      • Directives to verify understanding & query agent-bridge-mcp     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                       (If Agent Needs Deep Context)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Tier 2: On-Demand Drill-Down (MCP)                   │
│         Peer agent queries local `agent-bridge-mcp` tools:             │
│        • Tool Telemetry Logs   • Artifact & File Inspection            │
│        • Output Traces         • Direct Peer Inquiries                 │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.1 User-Driven Handoff Flow
* **Explicit Control**: The user explicitly chooses when and which agent takes over work (or accepts the switch when a usage limit is hit).
* **Voluntary Mid-Session Handoff**: At any point during a conversation, the user can click the **Hand off (`⇄`)** button directly in the input bar (beside the Agent Picker) to immediately transfer the thread with the compact Prompt Envelope without waiting for a limit.
* **Conversational Handoff**: When handing off to a new agent, Chorus passes the Prompt Envelope at launch. The receiving agent confirms understanding with the user via MCP tool call before proceeding.

### 3.2 Tier 1: Compact Prompt Envelope (Zero Vendor-Hook Dependency)
* Passed natively through CLI flags or initial turn arguments (e.g. `claude --append-system-prompt`, `agy -i`, or Codex developer turn) without requiring vendor-specific hooks.
* Contains high-signal, compact directives (<150–200 tokens total):
  1. **Generalized Artifact Storage**: Any files created during usage not directly belonging to the project codebase are stored in `.chorus/artifacts/<ai-cli>/<chat-thread-id>/`.
  2. **Active Skill Index**: Compact list of enabled skills with path pointers.
  3. **Handoff Delta (when applicable)**: User goal, touched files, test status, and remaining milestones.
* Strips all internal thinking traces, raw tool logs, verbose diff blocks, and conversational noise.

### 3.3 Tier 2: On-Demand Drill-Down (MCP Bridge)
* When a peer agent requires deeper context, it queries the local MCP server (`agent-bridge-mcp`).
* Agents can fetch specific tool outputs, test failures, or inspect generated files without inflating the conversation prompt.

---

## 4. Storage Architecture: The Adapter Pattern

Chorus separates core business logic from data persistence by implementing the **Storage Adapter Pattern**. To avoid the complexity of relational databases (no SQL schemas, joins, or migrations) and eliminate scattered `.log` files across disk, Chorus adopts a unified, embedded document / key-value architecture.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                   Chorus Core Daemon / MCP Server                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                       «interface» StorageAdapter
                                    │
                ┌───────────────────┴───────────────────┐
                ▼                                       ▼
        ┌───────────────┐                       ┌───────────────┐
        │  redb Adapter │                       │ Other Adapters│
        │  (Embedded    │                       │ (PoloDB,      │
        │   KV Default) │                       │  SurrealDB)   │
        └───────────────┘                       └───────────────┘
```

* **`redb` as Default Engine**: Embedded, pure-Rust Key-Value document database (`~/.chorus/chorus.redb`). Zero external dependencies, ACID crash-safe, and natively supports `compact()` to reclaim disk space after purges.
* **Pluggable Backends via Adapter Pattern**: The application layer talks exclusively to `StorageAdapter` (`save_turn`, `record_execution`, `prune_oldest_executions`, `get_storage_stats`). Each backend implements its own low-level indexing, ring buffer eviction, and database compaction/shrinking logic.
* **In-DB Ring Buffer for Tool Results**: Tool execution outputs are stored directly in the database (no external `.log` files). Total tool output storage is capped (default: 1 GB); when exceeded, Chorus prompts to purge the oldest tool results (10%–20% / 100–200 MB chunk) or auto-cleans, leaving permanent chat history and turn outcomes 100% intact.
* **First-Class Artifact Storage**: Tracks code files, HTML mockups, SVGs, and docs with persistent disk file references.
* **Unified Skill Registry**: Stores discovered and user-created skills across all agents in the database, enabling a visual Skill Studio and fast session-start catalog injection.

> Detailed schemas, trait signatures, and MCP parameter contracts are maintained in [context-and-storage-spec.md](file:///Users/huong/chorus/documents/specs/context-and-storage-spec.md) (subject to refinement during implementation).

---

## 5. Acceptance Criteria

### 5.1 Terminal Plane (Plane 1)
- [ ] **AC-1.1**: The desktop app successfully spawns `agy`, `claude`, and `codex` in separate PTY sessions.
- [ ] **AC-1.2**: Terminal UI supports ANSI escape codes, cursor navigation, terminal resize, and interactive key prompts without screen corruption.
- [ ] **AC-1.3**: Switching between agent tabs preserves the live running state of all background terminal sessions.

### 5.2 Human-in-the-Loop Approval Gate
- [ ] **AC-2.1**: Tool execution events (`run_command`, `replace_file_content`, file deletions) trigger a visual Approval Card before execution.
- [ ] **AC-2.2**: The CLI process remains paused until the user explicitly clicks Allow (`allow` / `y`) or Don't allow (`deny` / `n`).
- [ ] **AC-2.3**: Approval decisions are piped back natively to the CLI engine without mutating LLM arguments, preserving 100% native CLI state and preventing model hallucination.

### 5.3 Context Handoff & Token Optimization
- [ ] **AC-3.1**: The user can trigger agent handoffs via quick-action controls with an editable prompt preview.
- [ ] **AC-3.2**: Automatically injected handoff context must not exceed 200 tokens under normal operation.
- [ ] **AC-3.3**: Injected summaries must contain: original user goal, touched files, verification/test state, and pending milestones.
- [ ] **AC-3.4**: Peer agents can pull deep context (specific execution logs and generated artifacts) on demand via `agent-bridge-mcp` without prompt pollution.
- [ ] **AC-3.5**: Starting a new chat thread queries the storage adapter to inject a compact (<100 token) index of enabled skills with file path pointers into the agent's initial prompt envelope.

### 5.4 Storage & Adapter Architecture
- [ ] **AC-4.1**: All storage operations must go through the `StorageAdapter` interface, decoupling application business logic from the persistence engine.
- [ ] **AC-4.2**: The default storage adapter must run embedded inside the desktop process without external database servers or relational table migrations.
- [ ] **AC-4.3 (In-DB Ring Buffer)**: Tool execution results must be stored directly in the database without separate `.log` files, capped by a user-configurable limit (default 1 GB). When the limit is reached, Chorus prompts to purge the oldest 10%–20% of tool results while guaranteeing chat threads and summaries remain untouched.
- [ ] **AC-4.4**: Generated files, HTML mockups, and visual assets must be indexed in the artifact registry with disk paths and metadata.
- [ ] **AC-4.5**: Discovered skills across agent directories (`.agents/skills`, `.claude/`, `.codex/`, and custom folders) must be ingested into the database as multi-file Skill Bundles, preserving directory hierarchies (`scripts/`, `templates/`) and executable permissions.
- [ ] **AC-4.6**: The UI Skill Studio must allow users to create and manage multi-file skill bundles (via manual input, AI refinement, or on-the-fly agent requests), persisting the entire bundle in the database.
- [ ] **AC-4.7 (Materialization & Dematerialization)**: Enabling a skill writes its full folder and scripts to disk with executable flags (`chmod +x`); disabling a skill automatically removes its folder from disk while preserving all files in the database.
- [ ] **AC-4.8 (Pruned State Resilience)**: When an agent queries a pruned execution record via `get_tool_execution`, the MCP bridge must return `status: "removed"`, and the UI must display a dimmed "Output removed" badge without crashing.

### 5.5 Canvas & Artifact Viewer (Desktop UI)
- [ ] **AC-5.1**: When an agent writes or modifies a viewer-compatible file (`.html`, `.md`, `.svg`, code files), the UI automatically detects the event and presents an interactive Artifact Card in the session timeline.
- [ ] **AC-5.2 (HTML Web Apps)**: The Artifact Viewer renders HTML files inside an embedded, sandboxed WebView/iframe, preventing unauthorized host script execution while supporting Tailwind/JS interactivity.
- [ ] **AC-5.3 (Live Hot-Reloading)**: Subsequent edits to the same HTML or CSS file by an agent automatically re-render the preview in place without requiring a full app reload.
- [ ] **AC-5.4 (Markdown & Specs)**: The Artifact Viewer renders markdown files with GitHub Flavored Markdown (GFM), syntax-highlighted code blocks, copy-to-clipboard buttons, and Mermaid architecture diagrams.
- [ ] **AC-5.5 (Visual Code Diff Review)**: Before approving file edits, the user can inspect a side-by-side visual diff inside the Canvas view.
- [ ] **AC-5.6 (View Mode Toggle)**: The user can toggle smoothly between the Raw PTY Terminal stream and the Canvas UI at any time without resetting terminal or agent state.
- [ ] **AC-5.7 (Draggable Resizer & Fullscreen)**: The Canvas panel provides a draggable resizer (`#art-resizer`) with smooth width clamping (320px to 85vw), double-click reset to 580px, and a 1-click fullscreen toggle (`⤢`).

### 5.6 Context Mentions (@) & Skills Slash Commands (/)
- [ ] **AC-6.1**: Autocomplete popover for `@` filters project Files, Folders, and Artifacts (`.chorus/artifacts/<ai-cli>/<chat-thread-id>/`), inserting typed chip tokens into the composer.
- [ ] **AC-6.2**: Autocomplete popover for `/` lists project skills and built-in actions, enabling on-demand skill execution in the turn's Prompt Envelope without mutating global project skills.

### 5.7 Autonomous Execution Mode (`--dangerously-skip-permissions`)
- [ ] **AC-7.1**: When autonomous mode is enabled on the composer, the CLI engine is spawned with `--dangerously-skip-permissions` (or equivalent), bypassing inline interactive prompts while logging execution telemetry with `⚡ auto-approved` tags.

### 5.8 Component Test Harness & E2E Controllability
- [ ] **AC-8.1**: In test mode (`CHORUS_TEST_MODE=1`), Chorus exposes a typed test bridge `window.__CHORUS_HARNESS__` allowing automated test runners and AI agents to programmatically query state, dispatch actions, and synchronize with async transitions without flaky timeouts.
- [ ] **AC-8.2**: Child CLI engines can be substituted by a deterministic native CLI simulator (`tests/e2e/stubs/cli-stub.ts`) running inside a real pseudo-terminal (`portable-pty`), testing 100% of PTY streaming, ANSI parsing, interactive stdin approval prompts, and error recovery with zero cloud API costs.

> See [e2e-testing-architecture.md](specs/e2e-testing-architecture.md) for full test harness specifications and Playwright recipes.
