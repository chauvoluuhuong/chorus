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
        │ threads/switch/ │                   │  UI over the     │
        │ handoff/trace   │                   │  same operations │
        └───────┬─────────┘                   └────────┬─────────┘
                │ spawns in PTY                        │ via chorus-cli serve (local API)
                ▼                                      │
   ┌────────────────────────────┐                      │
   │  AI CLI (claude/codex/agy) │                      │
   └────────────┬───────────────┘                      │
                │ spawns per session (stdio)           │
                ▼                                      │
        ┌─────────────────┐                            │
        │   chorus mcp    │  --thread <id>             │
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
| **core** | Storage, normalized events, one adapter per AI CLI, handoff-context builder, artifact watcher. No UI. | SQLite + files in `.chorus/` |
| **chorus-mcp** | Stdio MCP server that each AI CLI starts for its session. Exposes core as tools. Stateless; every call goes to the store. | core |
| **chorus-cli** | User-facing app. Runs each thread's AI CLI in its own PTY (user sees the real TUI), switches between threads, captures turns and tool calls, starts handoff threads, shows artifacts. Later `serve` exposes the same operations to the desktop app. | core, AI CLIs |
| **desktop** | UI only. No business logic of its own. | `chorus-cli serve` |
| **harness** | `fake-agent` (a scripted CLI that behaves like claude/codex/agy and calls MCP), committed fixtures from real CLIs, scenario runner. | everything |

Why chorus-mcp can't hold state: each AI CLI process starts its **own** copy of the MCP server. Two
agents means two server processes, plus chorus-cli. Shared state has to live in the store.

## 3. What Chorus stores

Rule: store what a feature needs, nothing more. Each item below names the feature that needs it.
The CLIs keep their own full transcripts. Chorus stores a compact copy because those files are
internal formats, change between versions, and get cleaned up (Claude deletes old ones after a
retention period).

Per project, in `<project>/.chorus/` (git-ignored):

```
.chorus/
  chorus.db                       SQLite (WAL), shared by chorus-cli and every chorus-mcp process
  threads/<thread-id>/
    artifacts/                    files agents produce for this thread (watched)
    raw/                          debug capture: pty.log, stdout.jsonl, mcp.jsonl (size-capped, pruned)
```

| Table | Fields | Needed for |
|---|---|---|
| **threads** | id, title, agent, model, cwd, native session id, `parent_thread_id`, state (`working` / `waiting` / `ended`), created, updated, CLI version, native transcript path | thread list and switching, resume, handoff link, debugging |
| **turns** | thread, seq, role (`user` / `assistant`), text, timestamp | **handoff context** (what was asked, what was answered), thread preview |
| **tool_calls** | thread, turn seq, tool name, short target (file path, command, MCP tool), status, duration | **handoff context** (files touched, commands run, test results), activity view |
| **usage** | thread, turn seq, tokens in / out / cache, cost; latest plan-limit reading (utilization, resets at) | status line, limit warning, activity totals |
| **artifacts** | thread, path, version (content hash), created by thread, timestamp | artifacts view, handoff context |

**Not stored** in the database: streaming deltas, thinking blocks, full tool output (only a short
status line such as "12 passed"), system prompts, attachments. Raw output stays in `raw/` for
`chorus trace` only, capped in size and pruned.

## 4. How data gets out of each CLI

Chorus never parses ANSI terminal output for meaning. Raw PTY bytes are kept only for display and
debugging. Structured data comes from the CLIs' own machine-readable channels:

| Mode | Used for | Claude | Codex | Antigravity |
|---|---|---|---|---|
| **Interactive** (PTY passthrough) | chorus-cli default: the user sees and types into the real TUI | hooks via `--settings` + transcript tail | session store (SQLite) or app-server, TBD | transcript.jsonl tail, TBD |
| **Headless** (print mode) | tests, automation, maybe the desktop chat view | `-p --output-format stream-json` | `exec --json` | `-p --output-format stream-json` |

Details and verification status: [integrations/](integrations/README.md).

## 5. MCP tools (v1)

Bound to a thread by `chorus mcp --thread <id>` in the per-session MCP config (verified for Claude
and Codex; open question for agy).

| Tool | Returns |
|---|---|
| `get_handoff_context(thread_id?)` | Compact digest of the parent thread (or the given one): first request, the last user and assistant turns, files touched, commands and test results, artifacts, the last assistant message. Kept to a few thousand tokens. |
| `get_thread_turns(thread_id, before?, limit?)` | Older turns, page by page, when the digest isn't enough |
| `list_threads()` | Threads in this project, so an agent can look at related work |
| `list_artifacts(thread_id?)` | Artifacts with paths, to read with the agent's own file tools |

All tools are read-only. Agents never have to write anything for Chorus to work.

## 6. Handoff = new thread that loads the previous one

```
user: Ctrl+Space h → pick codex        (or: chorus handoff --to codex)
  1. create thread (2) with parent_thread_id = (1)
  2. start codex for thread (2) with chorus mcp --thread <2>
  3. first message (fixed text):
       This chat continues the Chorus thread "<title>", worked on by <agent>.
       Call chorus get_handoff_context first. Then reply with at most 5 bullets:
       what was done, decisions, open work, and your next step.
       Wait for my OK before changing anything.
  4. the agent calls the tool, shows its summary, and waits; the user corrects it or says go
```

- Thread (1) is not stopped or asked anything. It stays in the list and you can switch back.
- It works after a limit hit, because the context comes from the store, not from the old agent.
- Safety check: Chorus sees every MCP call. If the new agent finishes its first turn without
  calling `get_handoff_context`, the status line shows "context not loaded" with a retry key.

### Switching threads

Each thread is its own agent process in its own PTY, running in the background. Chorus keeps a
virtual screen per thread (a headless terminal emulator), so bringing a thread to the front
redraws it instantly. The same layer draws the status line.

- `Ctrl+Space t` opens the thread list; `Ctrl+Space 1–9` jumps; `Ctrl+Space [` / `]` cycles.
- Thread state for the list and status line: `working` (turn in progress), `waiting` (turn
  finished, needs you: Claude `Stop` hook / end of turn in the stream), `ended` (process exited;
  resumable with the CLI's resume flag).

## 7. Artifacts

- Agents are told the artifact folder in the envelope.
- A file watcher on `.chorus/threads/*/artifacts/` registers new versions. **Tool-call parsing
  alone isn't enough.** In the probe, Claude created an artifact with `Bash` (`mkdir && printf`),
  not its `Write` tool.
- chorus-cli: `chorus-cli artifacts [--open]` lists them and opens them in the browser or default
  app. The desktop app later shows them in a panel.

## 8. Debuggability (first-class requirement)

- Raw capture of every thread is kept (`threads/<id>/raw/`, size-capped) next to the normalized data.
- Correlation ids everywhere: thread id → native session id → tool-use id
  (Claude passes `_meta["claudecode/toolUseId"]` on MCP calls).
- Every thread records the CLI version; adapters warn on versions newer than the last verified one.
- `chorus doctor`: installed CLIs, versions, login state, paths (transcript dirs, MCP config).
- `chorus trace <thread-id>`: raw + normalized events side by side.
- Integration facts live in [integrations/](integrations/README.md) with the version they were
  checked on, and fixtures re-generated by `tools/probe`.

## 9. Open decisions

| # | Question | Proposal |
|---|---|---|
| D1 | Language for core / chorus-mcp / chorus-cli | **TypeScript on Node 20+**: target users already have Node (Claude Code and Codex install via npm), the official MCP SDK is TypeScript, `node-pty` is mature, and chorus-cli ships with `npm i -g`. Rust stays an option for the desktop shell. |
| D2 | Per-session MCP config for agy | Decide after the agy probe (workspace `.agents/mcp_config.json` vs `agy mcp add` per thread) |
| D3 | Desktop technology | Decide after the chorus-cli milestones; the desktop only needs `chorus-cli serve` |
| D4 | Provider terms (agy subscription orchestration, Claude/Codex account use) | Check before selling; see integration docs |
