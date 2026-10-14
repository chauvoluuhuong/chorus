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

### Plane 1: The Terminal Plane (Visual Shell)
* Runs each CLI engine in an isolated native pseudo-terminal (PTY) process.
* Streams bidirectional `stdin`/`stdout` to embedded terminal components (`xterm.js` in Tauri or `xterm.dart` in Flutter).
* Preserves 100% native CLI fidelity: interactive menus, cursor navigation, progress bars, and ANSI colors.

### Plane 2: The Control & Telemetry Plane (Intelligence & Governance)
* Runs a local background daemon inside the desktop app.
* Communicates with CLI engines through:
  1. **Lifecycle Hooks**: Intercepts actions (`PreToolUse`, `PostToolUse`, `PreInvocation`) via standard hook scripts.
  2. **Local MCP Server (`agent-bridge-mcp`)**: Exposes query tools for cross-agent collaboration.

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

### 5.4 Storage & Adapter Architecture
- [ ] **AC-4.1**: All storage operations must go through the `StorageAdapter` interface.
- [ ] **AC-4.2**: The PoloDB adapter must run embedded inside the desktop process without external database servers.
- [ ] **AC-4.3**: Tool outputs larger than 4KB must be offloaded to disk log files, keeping the database documents lightweight.
- [ ] **AC-4.4**: Generated files, HTML mockups, and visual assets must be indexed in the artifact registry with disk paths and metadata.
