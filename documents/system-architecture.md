# System Architecture & Technical Specifications — Chorus

## 1. High-Level Dual-Plane Architecture

Chorus operates on two decoupled planes:

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

### Plane 1: The Terminal Plane
- Each agent runs in its own native pseudo-terminal (PTY) process.
- Streams stdout/stdin to an embedded terminal component (`xterm.js` in Tauri or `xterm.dart` in Flutter).
- Ensures 100% native CLI compatibility, ANSI colors, cursor keys, and progress bars.

### Plane 2: The Control & Telemetry Plane
- Runs a lightweight background daemon inside the desktop app.
- Listens on a local Unix Domain Socket / Windows Named Pipe (`/tmp/chorus-bridge.sock`).
- Interacts with CLI engines via two mechanisms:
  1. **Lifecycle Hooks**: `PreToolUse`, `PostToolUse`, and `PreInvocation` (via `hooks.json` in `agy` and `settings.json` in `claude`).
  2. **Local MCP Server (`agent-bridge-mcp`)**: Exposing `read_shared_chat`, `ask_peer_agent`, and `get_terminal_output`.

---

## 2. Hook Protocol Contract

Whenever an engine prepares to execute a tool:
1. Engine pipes hook JSON payload to `agent-hub-hook` via `stdin`.
2. `agent-hub-hook` relays payload over the local socket to Chorus Desktop App.
3. Chorus Desktop App displays the **Approval Card** and pauses the CLI.
4. User clicks **Approve** or **Reject**.
5. Desktop App returns decision:
   ```json
   {
     "decision": "allow",
     "overwrite": { "CommandLine": "npm test" }
   }
   ```
   or:
   ```json
   {
     "decision": "deny",
     "reason": "Dangerous command rejected by user."
   }
   ```
6. `agent-hub-hook` prints the JSON to `stdout` and exits with code 0.
7. The CLI engine resumes immediately.
