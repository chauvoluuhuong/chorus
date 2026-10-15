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
* Communicates with CLI engines through:
  1. **Lifecycle Hooks**: Intercepts actions (`PreToolUse`, `PostToolUse`, `PreInvocation`) via standard hook scripts.
  2. **Artifact Dispatcher**: Watches file writes via `PostToolUse` and pushes real-time events to the UI Artifact Viewer.
  3. **Local MCP Server (`agent-bridge-mcp`)**: Exposes query tools for cross-agent collaboration.

---

## 2. Human-in-the-Loop Approval Protocol

Before any CLI engine executes a tool:
1. The engine passes the tool payload to `agent-hub-hook` via `stdin`.
2. `agent-hub-hook` relays the payload over the local domain socket to the Chorus desktop app.
3. The UI presents an interactive **Approval Card** and suspends the CLI process.
4. The user can **Approve**, **Reject**, or **Edit Arguments** before execution.
5. The desktop app sends the decision back over the socket, and the CLI engine resumes immediately.

---

## 3. Context Handoff & Token-Optimization Strategy

Chorus balances cross-agent context sharing with token budget conservation using a **Two-Tier Architecture**:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        User-Controlled Handoff                         │
│     [ Keep in @claude ]   [ Continue in @codex ]   [ Hand off to @agy ]│
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     Tier 1: Compact Overview Push                      │
│            PreInvocation hook injects <150 tokens of delta:            │
│       • User Objective  • Touched Files  • Test State  • Milestones    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                       (If Agent Needs Deep Context)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   Tier 2: On-Demand Drill-Down (MCP)                   │
│        • Tool Telemetry Logs   • Artifact & File Inspection            │
│        • HTML Previews         • Direct Peer Inquiries                 │
└────────────────────────────────────────────────────────────────────────┘
```

### 3.1 User-Driven Handoff Flow
* **Explicit Control**: The user explicitly chooses when and which agent takes over work.
* **Preview & Edit Drawer**: Clicking a handoff action presents an editable briefing before dispatching.

### 3.2 Tier 1: Compact Overview (Low Token Overhead)
* Injected into the target agent automatically via `PreInvocation` hooks.
* High-signal data only: user goals, files modified, test pass/fail results, and next tasks (<150 tokens).
* Strips all internal thinking traces, raw tool logs, diff blocks, and conversational noise.

### 3.3 Tier 2: On-Demand Drill-Down
* When a peer agent requires deeper context, it queries the local MCP server (`agent-bridge-mcp`).
* Agents can fetch specific tool outputs, test failures, or inspect generated files without inflating the conversation prompt.

---

## 4. Storage Architecture: The Adapter Pattern

Chorus separates core business logic from data persistence by implementing the **Storage Adapter Pattern**. Because agent executions, handoffs, and artifacts are hierarchical, semi-structured JSON documents, Chorus adopts an embedded **Document Database** architecture.

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
        │PoloDB Adapter │                       │ Other Adapters│
        │(Embedded      │                       │ (SurrealDB,   │
        │ Default)      │                       │  SQLite JSONB)│
        └───────────────┘                       └───────────────┘
```

* **PoloDB as Default Engine**: Embedded in-process Rust document database with a MongoDB-compatible API. Operates directly on `~/.chorus/ledger.polodb` with zero external service dependencies.
* **Pluggable Backends**: The `StorageAdapter` interface allows swapping persistence engines without altering application logic.
* **First-Class Artifact Storage**: Tracks code files, HTML mockups, SVGs, and docs with persistent disk file references.
* **Unified Skill Registry**: Stores discovered and user-created skills across all agents in PoloDB, enabling a visual Skill Studio and fast session-start catalog injection.

> Detailed schemas, trait signatures, and MCP parameter contracts are maintained in [context-and-storage-spec.md](file:///Users/huong/chorus/documents/specs/context-and-storage-spec.md) (subject to refinement during implementation).

---

## 5. Acceptance Criteria

### 5.1 Terminal Plane (Plane 1)
- [ ] **AC-1.1**: The desktop app successfully spawns `agy`, `claude`, and `codex` in separate PTY sessions.
- [ ] **AC-1.2**: Terminal UI supports ANSI escape codes, cursor navigation, terminal resize, and interactive key prompts without screen corruption.
- [ ] **AC-1.3**: Switching between agent tabs preserves the live running state of all background terminal sessions.

### 5.2 Human-in-the-Loop Approval Gate
- [ ] **AC-2.1**: Tool execution events (`run_command`, `replace_file_content`, file deletions) trigger a visual Approval Card before execution.
- [ ] **AC-2.2**: The CLI process remains paused until the user explicitly clicks Approve, Edit, or Deny.
- [ ] **AC-2.3**: If the user modifies arguments in the Approval Card, the overwritten arguments are piped back and executed by the CLI engine.

### 5.3 Context Handoff & Token Optimization
- [ ] **AC-3.1**: The user can trigger agent handoffs via quick-action controls with an editable prompt preview.
- [ ] **AC-3.2**: Automatically injected handoff context must not exceed 200 tokens under normal operation.
- [ ] **AC-3.3**: Injected summaries must contain: original user goal, touched files, verification/test state, and pending milestones.
- [ ] **AC-3.4**: Peer agents can pull deep context (specific execution logs and generated artifacts) on demand via `agent-bridge-mcp` without prompt pollution.
- [ ] **AC-3.5**: Starting a new chat thread queries PoloDB to inject a compact (<100 token) index of enabled skills with file path pointers into the agent's initial prompt envelope.

### 5.4 Storage & Adapter Architecture
- [ ] **AC-4.1**: All storage operations must go through the `StorageAdapter` interface.
- [ ] **AC-4.2**: The PoloDB adapter must run embedded inside the desktop process without external database servers.
- [ ] **AC-4.3**: Tool outputs larger than 4KB must be offloaded to disk log files, keeping the database documents lightweight.
- [ ] **AC-4.4**: Generated files, HTML mockups, and visual assets must be indexed in the artifact registry with disk paths and metadata.
- [ ] **AC-4.5**: Discovered skills across agent directories (`.agents/skills`, `.claude/`, `.codex/`, and custom folders) must be ingested into PoloDB as multi-file Skill Bundles, preserving directory hierarchies (`scripts/`, `templates/`) and executable permissions.
- [ ] **AC-4.6**: The UI Skill Studio must allow users to create and manage multi-file skill bundles (via manual input, AI refinement, or on-the-fly agent requests), persisting the entire bundle in PoloDB.
- [ ] **AC-4.7 (Materialization & Dematerialization)**: Enabling a skill writes its full folder and scripts to disk with executable flags (`chmod +x`); disabling a skill automatically removes its folder from disk while preserving all files in PoloDB.

### 5.5 Canvas & Artifact Viewer (Desktop UI)
- [ ] **AC-5.1**: When an agent writes or modifies a viewer-compatible file (`.html`, `.md`, `.svg`, code files), the UI automatically detects the event and presents an interactive Artifact Card in the session timeline.
- [ ] **AC-5.2 (HTML Web Apps)**: The Artifact Viewer renders HTML files inside an embedded, sandboxed WebView/iframe, preventing unauthorized host script execution while supporting Tailwind/JS interactivity.
- [ ] **AC-5.3 (Live Hot-Reloading)**: Subsequent edits to the same HTML or CSS file by an agent automatically re-render the preview in place without requiring a full app reload.
- [ ] **AC-5.4 (Markdown & Specs)**: The Artifact Viewer renders markdown files with GitHub Flavored Markdown (GFM), syntax-highlighted code blocks, copy-to-clipboard buttons, and Mermaid architecture diagrams.
- [ ] **AC-5.5 (Visual Code Diff Review)**: Before approving file edits, the user can inspect a side-by-side visual diff inside the Canvas view.
- [ ] **AC-5.6 (View Mode Toggle)**: The user can toggle smoothly between the Raw PTY Terminal stream and the Canvas UI at any time without resetting terminal or agent state.
