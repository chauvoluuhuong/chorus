# Chorus architecture (v2, headless-first)

> Status: proposal, on branch `refactor`. Replaces the v1 desktop-first design (removed; still in
> git history on `dev`).

## 1. What Chorus is for

Two things, in this order:

1. **Shared context and handoff between AI CLIs.** Work started in one agent (Claude Code,
   Codex, Antigravity) continues in another without losing the goal, decisions, touched files and
   artifacts, including when the first agent hits its plan limit.
2. **Seeing what the agents make.** Artifacts the agents write are collected per thread and easy to
   open while the CLI keeps running.

Everything else (skills studio, approval cards, activity dashboards) comes after these two work
end to end with the real CLIs.

## 2. Products and components

Two products, built in this order:

- **`chorus-cli`**, a terminal app. Ships first and proves the engine.
- **Chorus desktop**, built later on the same engine.

Five loosely coupled components:

```
                 ┌──────────────── user ────────────────┐
                 ▼                                      ▼
        ┌─────────────────┐                   ┌──────────────────┐
        │   chorus-cli    │                   │  Chorus desktop  │  (later)
        │ run / handoff / │                   │  UI over the     │
        │ threads / trace │                   │  same operations │
        └───────┬─────────┘                   └────────┬─────────┘
                │ spawns in PTY                        │ via chorus-cli serve (local API)
                ▼                                      │
   ┌────────────────────────────┐                      │
   │  AI CLI (claude/codex/agy) │                      │
   └────────────┬───────────────┘                      │
                │ spawns per session (stdio)           │
                ▼                                      │
        ┌─────────────────┐                            │
        │   chorus-mcp    │  --thread <id>             │
        └───────┬─────────┘                            │
                ▼                                      ▼
        ┌──────────────────────────────────────────────────┐
        │                    core (library)                 │
        │ store · event model · CLI adapters · handoff ·    │
        │ artifact watcher                                  │
        └──────────────────────────────────────────────────┘
                ▲
        ┌───────┴─────────┐
        │     harness     │  fake-agent CLI · fixtures · scenario runner
        └─────────────────┘
```

| Component | Responsibility | Talks to |
|---|---|---|
| **core** | Data model and storage, normalized events, one adapter per AI CLI, handoff-note builder, artifact watcher. No UI. | SQLite + files in `.chorus/` |
| **chorus-mcp** | Stdio MCP server that each AI CLI starts for its session. Exposes core as tools. Stateless; every call goes to the store. | core |
| **chorus-cli** | User-facing commands. Starts AI CLIs in a PTY (user sees the real TUI), captures everything, creates threads, triggers handoff, shows artifacts. Later `serve` exposes the same operations to the desktop app. | core, AI CLIs |
| **desktop** | UI only. No business logic of its own. | `chorus-cli serve` |
| **harness** | `fake-agent` (a scripted CLI that behaves like claude/codex/agy and calls MCP), committed fixtures from real CLIs, scenario runner. | everything |

Why chorus-mcp can't hold state: each AI CLI process starts its **own** copy of the MCP server. Two
agents means two server processes, plus chorus-cli. Shared state has to live in the store.

## 3. Data model

Per project, in `<project>/.chorus/` (git-ignored):

```
.chorus/
  chorus.db                       SQLite (WAL), shared by all processes
  threads/<thread-id>/
    artifacts/                    files agents produce for this thread (watched)
    handoff.md                    latest handoff note, human-readable
    runs/<run-id>/
      pty.log                     raw terminal bytes (interactive)
      stdout.jsonl, stderr.txt    raw output (headless)
      mcp.jsonl                   MCP traffic for this run
      meta.json                   argv, cwd, CLI version, native session id, exit
```

| Entity | Meaning |
|---|---|
| **Thread** | A Chorus conversation about one piece of work. Spans agents. |
| **Run** | One AI CLI process attached to a thread. Has `agent`, `cli_version`, `native_session_id`, `mode` (interactive/headless), `end_reason` (exit, user-stop, limit, crash). |
| **Event** | Normalized record from a run: `session.started`, `message.user`, `message.assistant`, `tool.call`, `tool.result`, `usage`, `limit.status`, `error`, `session.ended`. Keeps a pointer to the raw line it came from. |
| **Artifact** | File under the thread's `artifacts/`, versioned by content hash. |
| **Checkpoint** | Progress note written by an agent through MCP: summary, decisions, next steps, files. |
| **Handoff** | From run → to run, reason, the note that was injected. |

## 4. How data gets out of each CLI

Chorus never parses ANSI terminal output for meaning. Raw PTY bytes are kept only for display and
debugging. Structured data comes from the CLIs' own machine-readable channels:

| Mode | Used for | Claude | Codex | Antigravity |
|---|---|---|---|---|
| **Interactive** (PTY passthrough) | chorus-cli default: the user sees and types into the real TUI | hooks via `--settings` + transcript tail | session store (SQLite) or app-server, TBD | transcript.jsonl tail, TBD |
| **Headless** (print mode) | tests, automation, maybe the desktop chat view | `-p --output-format stream-json` | `exec --json` | `-p --output-format stream-json` |

Details and verification status: [integrations/](integrations/README.md).

## 5. MCP tools (v1)

Bound to a thread by `chorus-mcp --thread <id>` in the per-session MCP config (verified for Claude
and Codex; open question for agy).

| Tool | Purpose |
|---|---|
| `get_thread_context` | Thread goal, latest checkpoint, handoff note, artifact list, where to save artifacts |
| `checkpoint(summary, decisions[], next_steps[], files[])` | Agent records progress. This is what makes a handoff possible after a limit hit. |
| `write_handoff(note)` | Outgoing agent writes the note when asked |
| `read_handoff()` | Incoming agent reads the full note |
| `list_artifacts()` / `register_artifact(path, title)` | Artifacts of this thread |
| `list_threads()` / `read_thread(id, limit)` | Read another thread's history on demand |

## 6. Handoff flow

```
user: chorus-cli handoff --to codex          (or automatic suggestion on limit)
  1. pick the note source, best available first:
       a. ask the running agent to call write_handoff   (only if it is alive and not limited)
       b. latest checkpoint(s) from the store
       c. auto-built from events: goal, last user asks, files touched, artifacts,
          last assistant message                          (always available)
  2. write .chorus/threads/<id>/handoff.md and a handoff row
  3. stop agent A (SIGINT, then SIGTERM/SIGKILL after a grace period)
  4. start agent B in the PTY with:
       - its per-session MCP config (chorus-mcp --thread <id>)
       - first prompt = envelope (below)
  5. agent B calls read_handoff / get_thread_context for more detail as needed
```

The envelope is injected as the **first prompt argument**, deterministically. The handoff never
depends on the model choosing to call a tool.

```
[Chorus] You are continuing thread "<title>" (id <id>), previously worked on by <agent A>.
Read .chorus/threads/<id>/handoff.md first (or call chorus get_thread_context).
Save non-code files you create (plans, mockups, reports) in .chorus/threads/<id>/artifacts/.
Call chorus checkpoint after each meaningful step.
Task: <next step from the note, or the user's message>
```

## 7. Artifacts

- Agents are told the artifact folder in the envelope.
- A file watcher on `.chorus/threads/*/artifacts/` registers new versions. **Tool-call parsing
  alone isn't enough.** In the probe, Claude created an artifact with `Bash` (`mkdir && printf`),
  not its `Write` tool.
- chorus-cli: `chorus-cli artifacts [--open]` lists them and opens them in the browser or default
  app. The desktop app later shows them in a panel.

## 8. Debuggability (first-class requirement)

- Raw capture of every run is kept (`runs/<run-id>/`) next to the normalized events.
- Correlation ids everywhere: thread id → run id → native session id → tool-use id
  (Claude passes `_meta["claudecode/toolUseId"]` on MCP calls).
- Every run records the CLI version; adapters warn on versions newer than the last verified one.
- `chorus-cli doctor`: installed CLIs, versions, login state, paths (transcript dirs, MCP config).
- `chorus-cli trace <run-id>`: raw + normalized events side by side.
- Integration facts live in [integrations/](integrations/README.md) with the version they were
  checked on, and fixtures re-generated by `tools/probe`.

## 9. Open decisions

| # | Question | Proposal |
|---|---|---|
| D1 | Language for core / chorus-mcp / chorus-cli | **TypeScript on Node 20+**: target users already have Node (Claude Code and Codex install via npm), the official MCP SDK is TypeScript, `node-pty` is mature, and chorus-cli ships with `npm i -g`. Rust stays an option for the desktop shell. |
| D2 | Per-session MCP config for agy | Decide after the agy probe (workspace `.agents/mcp_config.json` vs `agy mcp add` per thread) |
| D3 | Desktop technology | Decide after the chorus-cli milestones; the desktop only needs `chorus-cli serve` |
| D4 | Provider terms (agy subscription orchestration, Claude/Codex account use) | Check before selling; see integration docs |
