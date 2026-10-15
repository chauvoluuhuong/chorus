# Technical Research & Specification: CLI Engine Adapters — Chorus

> **Purpose**: This document provides a concrete, engine-by-engine technical evaluation of how Chorus connects to **Claude Code (`claude`)**, **Google Antigravity (`agy`)**, and **OpenAI Codex (`codex`)**. It proves how each CLI satisfies the requirements for **Lifecycle Hooks** and the **Artifact Dispatcher** using the **Adapter Pattern**, without requiring non-native CLI modifications.

---

## 1. The Application Layer Contract

The Chorus desktop application layer requires two unified interfaces from every underlying AI coding engine:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        Chorus Application Layer                        │
│            (Canvas View  •  Inline Approvals  •  Activity Log)         │
└───────────────────┬────────────────────────────────┬───────────────────┘
                    │                                │
         «interface» EngineAdapter         «interface» ArtifactDispatcher
                    │                                │
      ┌─────────────┼─────────────┐                  │
      ▼             ▼             ▼                  ▼
ClaudeAdapter   AgyAdapter   CodexAdapter     Universal File Watcher
 (Settings/PTY) (Stream-JSON) (PTY/Prompt)   + Tool Stream Parser
```

### 1.1 Requirement A: Lifecycle Hooks Contract
1. **Session Start & Prompt Envelope**: Ability to inject initial project context (<150–200 tokens), enabled skills index, and MCP tool directives at session launch.
2. **Pre-Execution Approval Gate**: Ability to hold privileged/risky commands (`Bash`, migrations, mass deletions), display an inline approval card in Chorus (`Allow / Don't allow`), and resume the process upon user decision (`y` / `n`).
3. **Post-Execution Telemetry**: Ability to capture tool names, arguments, exit codes, and stdout/stderr in real time to populate the Activity Log and Shared Memory.
4. **Session Interrupt**: Ability to send a native interrupt (`SIGINT` / `Ctrl+C`) when the user clicks the Stop button (`⏹`) in Chorus.
5. **Quota / Limit Detection**: Ability to detect when an engine hits its plan rate limit and read the reset timestamp.

### 1.2 Requirement B: Artifact Dispatcher Contract
1. **Asset Creation Detection**: Ability to detect when an agent creates or modifies visual files (`.html`, `.md`, `.svg`, code files).
2. **Path Reporting & Segregation**:
   - **Project Code** (`app/order/page.tsx`): Stored directly in the workspace so the app builds and runs.
   - **Chorus Artifacts** (UI mockups, design specs, Mermaid diagrams): Stored under `.chorus/artifacts/<ai_cli>/<chat_thread_id>/` (e.g. `.chorus/artifacts/claude/t_order_cake/order-flow.html`) so the user's Git repo is never polluted with preview scratch files and threads remain cleanly isolated.
3. **Live Canvas Trigger & Hot-Reload**: Ability to dispatch an `artifact:updated` event to the desktop Canvas view within milliseconds of file write.

---

## 2. Deep Dive: Engine 1 — Claude Code (`claude`)

### 2.1 Native Characteristics & CLI Profile
* **Binary**: `/Users/huong/.local/bin/claude` (Anthropic native CLI).
* **Execution Planes**: Native PTY interactive terminal + CLI flags (`--settings`, `--append-system-prompt`, `--output-format stream-json`, `--mcp-config`).
* **Hook Mechanism**: Built-in native hooks declared in settings JSON (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`).

### 2.2 How `ClaudeAdapter` Satisfies the Requirements

| Capability | Concrete Implementation Mechanism | Native CLI Support |
|---|---|---|
| **Session Start & Prompt Envelope** | Chorus passes `--append-system-prompt` at launch containing the project guidelines, `.chorus/artifacts/` convention, and MCP instructions. | **100% Native** (`claude --append-system-prompt "..."`) |
| **Pre-Execution Approval Gate** | Chorus injects a lightweight hook adapter via `--settings '{"hooks":{"PreToolUse":...}}'` without touching user settings. The hook relays stdin to Chorus domain socket. User clicks **Allow** (`y`) or **Don't allow** (`n`). | **100% Native** (`PreToolUse` hook returns `allow` or `deny`) |
| **Post-Execution Telemetry** | Captured via `PostToolUse` hook and verified against Claude's local JSONL transcript in `~/.claude/projects/`. | **100% Native** |
| **Session Interrupt** | Chorus sends `SIGINT` (0x03 / `Ctrl+C`) directly to the child PTY session when the user clicks **Stop** (`⏹`). | **100% Native** |
| **Quota Limit Detection** | Transcript parser matches the native error event: `{"type":"system","subtype":"error","message":"Claude usage limit reached..."}` and extracts reset time (`18:00`). | **100% Native** |

### 2.3 How `ClaudeAdapter` Handles the Artifact Dispatcher
1. **Dual Detection**:
   - **Stream Level**: `ClaudeAdapter` monitors tool calls (`Write`, `Edit`, `apply_patch`). When the target file matches visual extensions (`.html`, `.svg`, `.md`), it indexes metadata (`art_301`) into the Chorus database.
   - **OS File Watcher**: Watches `.chorus/artifacts/` and workspace files. As soon as Claude finishes writing, the watcher fires `FileChanged`.
2. **Canvas Dispatch**: Emits IPC event `canvas:render(path, version)` to update the preview in real time.

---

## 3. Deep Dive: Engine 2 — Google Antigravity (`agy`) / Gemini CLI

### 3.1 Native Characteristics & CLI Profile
* **Binary**: `/Users/huong/.local/bin/agy` (Google Advanced Agentic Coding CLI).
* **Execution Planes**: 
  - Interactive terminal mode via PTY.
  - Headless structured stream mode via `--input-format stream-json --output-format stream-json` (NDJSON per turn).
  - Subcommands: `agy mcp`, `agy models`, `agy agent`.
* **Customization Model**: Workspace rules, prompt directives, subagents, and Model Context Protocol (MCP).

### 3.2 How `AgyAdapter` Satisfies the Requirements

| Capability | Concrete Implementation Mechanism | Native CLI Support |
|---|---|---|
| **Session Start & Prompt Envelope** | Chorus launches `agy` in the workspace directory with `--prompt-interactive` or prepends the envelope instruction. Chorus also injects MCP configuration using standard MCP discovery or `agy mcp`. | **100% Native** (`agy -i "<envelope>"`) |
| **Pre-Execution Approval Gate** | `agy` natively halts on sensitive tool execution (file modification, bash commands) and prompts for confirmation in the terminal stream (`Allow [y/n]`). `AgyAdapter` listens to the PTY stream; when an approval prompt is detected, it surfaces the **Inline Approval Card** in Chorus. When user clicks Allow, Chorus writes `y\n` to PTY stdin; if Deny, writes `n\n`. | **100% Native** (Standard interactive PTY pipe) |
| **Post-Execution Telemetry** | When running with `--output-format stream-json`, `agy` emits real-time NDJSON events for every tool invocation (`write_to_file`, `run_command`) and output. In PTY mode, Chorus parses the transcript stream directly. | **100% Native** (`stream-json` NDJSON output) |
| **Session Interrupt** | Chorus sends `SIGINT` to the PTY process or closes the stream turn. `agy` terminates the current tool execution cleanly. | **100% Native** |
| **Quota / Limit Detection** | `agy` reports quota status in stream events (e.g. rate limit error or model quota exhaustion). `AgyAdapter` reads the event and triggers the Handoff card. | **100% Native** |

### 3.3 How `AgyAdapter` Handles the Artifact Dispatcher
1. **Artifact Directives**: In the initial prompt envelope, Chorus specifies:
   > *"Any files created during usage that are not directly related to the project source code must be saved to `.chorus/artifacts/`."*
2. **Detection**:
   - `agy` calls its native file writing tool (`write_to_file` / `replace_file_content`).
   - The OS File Watcher instantly catches the file creation in `.chorus/artifacts/`.
   - `AgyAdapter` registers the artifact in the Chorus DB and displays the Artifact Card in chat.
3. **Canvas Dispatch**: Live reload updates in the Canvas WebView immediately.

---

## 4. Deep Dive: Engine 3 — OpenAI Codex / ChatGPT CLI (`codex`)

### 4.1 Native Characteristics & CLI Profile
* **Binary**: `codex` / ChatGPT coding CLI.
* **Execution Planes**: Pseudo-terminal (PTY) interactive session + standard developer prompt envelope.
* **Integration Model**: Model Context Protocol (MCP) client + system instructions.

### 4.2 How `CodexAdapter` Satisfies the Requirements

| Capability | Concrete Implementation Mechanism | Native CLI Support |
|---|---|---|
| **Session Start & Prompt Envelope** | Injected as the opening developer envelope in the first conversation prompt, linking `.chorus/artifacts/` and declaring the local `agent-bridge-mcp` server. | **100% Native** |
| **Pre-Execution Approval Gate** | When Codex executes commands (`shell`, `rm`, migrations), it prompts for confirmation in PTY (`y/n`). `CodexAdapter` intercepts the prompt pattern in the PTY buffer, displays the Inline Approval Card in Chorus, and pipes `y` or `n` to stdin upon click. | **100% Native** (PTY stdin/stdout interception) |
| **Post-Execution Telemetry** | Captured by parsing tool execution blocks from the PTY stream and recorded in the Chorus Embedded Ledger (`redb`). | **100% Native** |
| **Session Interrupt** | Standard `SIGINT` sent to the child PTY process. | **100% Native** |
| **Quota / Limit Detection** | Matches OpenAI standard rate-limit messages (`Rate limit reached`, `Usage cap reached. Resets at ...`). | **100% Native** |

### 4.3 How `CodexAdapter` Handles the Artifact Dispatcher
1. **Detection**:
   - Codex applies changes via `apply_patch` or `write_file`.
   - The OS File Watcher detects the write event in `.chorus/artifacts/` or workspace files.
2. **Re-use via MCP Bridge**:
   - When Codex takes over work from Claude Code via Handoff, Chorus tells Codex via the Prompt Envelope:
     > *"Any auxiliary files created during usage not directly part of the project source code are saved in `.chorus/artifacts/`. You can query `agent-bridge-mcp: get_artifact_content` or read the files directly."*
   - Codex queries `get_artifact_content("art_301")` on-demand, reading field names without prompt bloat.

---

## 5. The Prompt Envelope Architecture (Zero-Hook Initialization)

### 5.1 Why Prompt Envelopes Instead of Hooks?
Early designs considered using CLI lifecycle hooks (such as `SessionStart` or `PreInvocation`) to inject system instructions and context. However, cross-engine analysis reveals that hook architectures vary drastically:
* Claude Code has rich hook events declared in settings JSON.
* Google Antigravity uses system prompt options, interactive flags, and rule files.
* OpenAI Codex accepts developer system instructions or opening prompt turns.

Attempting to force a "universal hook" across all three engines would require non-native daemons or fragile wrapper shims. Instead, Chorus adopts the **Prompt Envelope (Initial Prompt Instruction Envelope)** approach:
1. **100% Native Delivery**: Passed via standard CLI flags or the opening turn message at session spawn.
2. **Deterministic Context**: Every agent starts with identical operational knowledge regardless of underlying CLI architecture.
3. **Zero Vendor Lock-in**: Works out of the box with any future CLI engine.

### 5.2 Envelope Payload Specification (<150–200 Tokens)

The Prompt Envelope consists of three lightweight blocks:

```text
[Chorus System Envelope]
1. ARTIFACTS: Any files created during usage that are not directly related to
   the project source code must be saved to `.chorus/artifacts/`. Project source
   code files belong in their respective repository directories.
2. SKILLS: Enabled project skills are materialized on disk:
   - db-migrate: Database migration helpers (.agents/skills/db-migrate/SKILL.md)
   - tailwind-ui: Component style guidelines (.agents/skills/tailwind-ui/SKILL.md)
   Read these skill documents on-demand when relevant to user requests.
3. HANDOFF (Conditional): Continuing from @claude:
   - Goal: Build Cake Order page with real-time price calculator
   - Touched: app/order/page.tsx, components/CakeBuilder.tsx
   - Status: Component created; tests passing; Stripe webhook pending
   - Bridge: Deep logs available via agent-bridge-mcp. Confirm understanding with user.
```

#### A. Generalized Artifact Instruction
Rather than enumerating rigid file types (which causes AI to ignore unanticipated formats), the instruction is defined broadly:
> **Rule**: *"Any files created by the AI during usage that are not directly related to the project source code must be saved into `.chorus/artifacts/`."*
- **Result**: Temporary plans, research notes, benchmark reports, UI mockups, Mermaid diagrams, or scratch prototypes all route to `.chorus/artifacts/` automatically.
- **Project Hygiene**: The user's Git repository remains clean, while the Chorus Canvas Viewer instantly detects and renders both project source edits and auxiliary artifacts.

#### B. Active Skills Catalog (<80–100 Tokens)
Chorus queries the `StorageAdapter` to find all enabled skills for the workspace, rendering a compact index of names, one-line descriptions, and disk paths (`.agents/skills/<name>/SKILL.md`). The full skill content is **never** dumped into the prompt upfront, conserving token budget.

#### C. Handoff Briefing (<150 Tokens)
When a session is created to continue an existing thread (manual switch or plan limit hit), the envelope appends the compact handoff delta and directs the receiving agent to verify understanding with the user before executing new operations.

### 5.3 Concrete Delivery per Engine

| Engine | Native Invocation Mechanism |
|---|---|
| **Claude Code (`claude`)** | `claude --append-system-prompt "<envelope>"` at session launch. |
| **Antigravity (`agy`)** | `agy -i "<envelope>"` or prepended developer instruction at session launch. |
| **OpenAI Codex (`codex`)** | Prepended developer envelope block in the initial turn message. |

---

## 6. Cross-Engine Capability Comparison Matrix

| Application Layer Requirement | Claude Code (`claude`) | Antigravity (`agy`) | Codex (`codex`) |
|---|---|---|---|
| **PTY Terminal Spawning** | Native PTY (`portable-pty`) | Native PTY (`portable-pty`) | Native PTY (`portable-pty`) |
| **Prompt Envelope Delivery** | Native `--append-system-prompt` | Native `-i` / interactive flag | Native initial turn envelope |
| **Pre-Tool Approval Gate** | Native `PreToolUse` hook relay (`allow`/`deny`) | PTY prompt interception (`y`/`n`) | PTY prompt interception (`y`/`n`) |
| **Post-Tool Telemetry** | `PostToolUse` + Transcript JSONL | `--output-format stream-json` / PTY | PTY buffer parser |
| **Interrupt Control (Stop Button)** | `SIGINT` (Ctrl+C) | `SIGINT` (Ctrl+C) | `SIGINT` (Ctrl+C) |
| **Artifact Segregation** | `.chorus/artifacts/` + repo files | `.chorus/artifacts/` + repo files | `.chorus/artifacts/` + repo files |
| **Artifact Detection** | Tool args + OS File Watcher | Tool args + OS File Watcher | Tool args + OS File Watcher |
| **Cross-Agent MCP Bridge** | Supported (`--mcp-config`) | Supported (`agy mcp`) | Supported (MCP config) |
| **Memory / Handoff Delivery** | Native Prompt Envelope | Native Prompt Envelope | Native Prompt Envelope |

---

## 6. Rust Trait Definition for Engine Adapters

In the Chorus Core Daemon, the Adapter Pattern is implemented via the `EngineAdapter` trait:

```rust
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ApprovalDecision {
    Allow,
    Deny { reason: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryEvent {
    pub engine_id: String,
    pub event_type: String, // "workspace_tool", "bridge_tool", "lifecycle", "error"
    pub tool_name: String,
    pub summary: String,
    pub status: String,     // "ok", "bad", "waiting"
    pub duration_ms: Option<u64>,
}

#[async_trait]
pub trait EngineAdapter: Send + Sync {
    /// Spawns the CLI process in an isolated native PTY
    async fn spawn_session(&self, config: &SessionConfig) -> Result<SessionHandle, EngineError>;

    /// Injects the initial prompt envelope (<150-200 tokens) with MCP and skill indices
    async fn inject_envelope(&self, session_id: &str, envelope: &str) -> Result<(), EngineError>;

    /// Sends user input or continuation prompt to the child engine
    async fn send_input(&self, session_id: &str, input: &str) -> Result<(), EngineError>;

    /// Relays native user approval (Allow / Don't allow) back to the engine
    async fn resolve_approval(&self, session_id: &str, decision: ApprovalDecision) -> Result<(), EngineError>;

    /// Sends a native interrupt (SIGINT / Ctrl+C) to abort execution cleanly
    async fn interrupt(&self, session_id: &str) -> Result<(), EngineError>;

    /// Returns engine health, installed status, and quota/model information
    async fn get_status(&self) -> Result<EngineStatus, EngineError>;
}
```

---

## 7. Architectural Verdict

1. **Are the requirements satisfied?**
   - **YES**. All three engines (`claude`, `codex`, `agy`) satisfy the conditions for **Lifecycle Hooks** and the **Artifact Dispatcher**.
2. **Is any non-native hack required?**
   - **NO**. By combining **Prompt Envelope injection**, **PTY stream interception (`y/n`)**, and an **OS File Watcher on `.chorus/artifacts/`**, Chorus achieves a 100% uniform experience at the application layer without mutating CLI binaries or relying on single-vendor hook formats.
