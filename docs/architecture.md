# Chorus architecture (v2, headless-first)

> Status: agreed direction, on branch `feat/refactor`. Replaces the v1 desktop-first design
> (removed; still in git history on `dev`).

## 1. What Chorus is for

Make it easy for developers to work across AI coding CLIs. Goal and success definition:
[product.md](product.md).

1. **Handoff and shared context between AI CLIs.** Work started in one agent (Claude Code, Codex,
   Antigravity) continues in another without losing what was asked, decided and changed,
   including when the first agent hits its plan limit.
2. **Seeing what the agents do and make.** Tool calls, approvals and artifacts are visible and
   easy to open while the agent keeps running.
3. **All threads in one place.** Every agent session in a sidebar like tabs, with its state.
4. **One set of skills for every agent.** A skill written once is available to, and actually
   used by, all three CLIs.

## 2. Build plan

Five phases. There is no fixed deadline: each phase takes as long as it needs to work for real.
Phases 1 and 2 are research that ends in **verified documentation plus an e2e test
against the real CLIs**; nothing is built on an assumption that a test hasn't proven. Each phase
is done only when its proof passes with the real `claude`, `codex` and `agy`
(see [testing.md](testing.md)).

```
Phase 1  context capture ──┐
                           ├──► Phase 3  MCP server ──► Phase 4  chorus CLI ──► Phase 5  desktop
Phase 2  skills sync ──────┘
```

Phases 1 and 2 can run in parallel. Progress is tracked in [roadmap.md](roadmap.md).

### Phase 1 · How to get the context a handoff needs

**Goal:** for each CLI, know exactly how to get every piece of data the next agent needs, both
when the user works in the CLI's own interactive screen (PTY) and in headless mode.

| Data | Why the next agent needs it |
|---|---|
| Chat turns (user and assistant text) | what was asked and answered |
| Tool calls (tool, target, ok/failed, short result) | files changed, commands run, test results |
| Session id, resume, transcript location | link our thread to the CLI's session; reopen it |
| Token usage, plan-limit signal | status line, "hand off before the limit" |
| Artifacts written | what the agent produced besides code |

**Work:** read each CLI's official docs and help; capture real output with `tools/probe` (extended
to drive interactive sessions, not only headless); write one extraction adapter per CLI.

**Output:**
- [integrations/claude-code.md](integrations/claude-code.md), [codex.md](integrations/codex.md),
  [antigravity-agy.md](integrations/antigravity-agy.md) written as instruction manuals: for each
  data item, *where it comes from* (flag, hook, file, field), the version it was verified on,
  and known gotchas.
- Adapter code + committed fixtures per CLI version.

**Proof (e2e):** for each CLI, a real session does a scripted task (answer a question, edit a
file, run a command, write an artifact). The test asserts that the extracted turns, tool calls,
usage and artifact match what happened. Claude and Codex run in the cloud; agy on the Mac.

**Status:** all three CLIs verified headless; Codex and agy verified interactive (transcript tail);
Claude interactive pending a login. Adapters in `src/core/adapters/` with L1 fixture tests. Smoke proof:
`npm run smoke -- --phase 1`.

### Phase 2 · How to sync skills, and make the agents use them

Syncing is two problems: **putting the files where each CLI looks**, and **making the agent
understand and use them**.

**Questions to answer, per CLI:**
- Where skills are discovered: project and user locations (Claude: `.claude/skills/<name>/SKILL.md`
  and `~/.claude/skills/`; Codex: `$CODEX_HOME/skills/` seen in the probe, project location to
  find; agy: `.agents/` manifests, plugins and rules to check).
- The file format: frontmatter (name, description), extra files and scripts, size limits.
- How the agent decides to use one: automatic match on the description, explicit `/name`, or
  only when told.
- Which skills ship by default (e.g. Codex installs `.system/skill-creator`,
  `.system/review-agent`), so Chorus can list them and avoid name clashes.
- How to sync without breaking user files: copy vs symlink, a marker for Chorus-managed skills,
  removal.
- For a CLI without native skills support (or where loading is unreliable): teach it with a skill
  index in the first prompt, a pointer in `AGENTS.md`, or MCP tools `list_skills` / `get_skill`.

**Output:** `integrations/skills.md` (per-CLI location, format, discovery, invocation, verified
version) and the sync design (one source of truth, how it's written out to each CLI).

**Proof (e2e):** a test skill carries a unique instruction (for example: "when asked for the
probe greeting, answer `kiwi-42`"). After sync, each CLI is asked a question that should trigger
it; the test checks the answer contains the marker and, where the CLI records it, that the skill
was loaded (e.g. Claude's transcript shows the Skill tool call).

### Phase 3 · MCP server: the bridge between agents

The agents never talk to each other directly. Each one talks to the Chorus MCP server, and the
server reads what the other agents left in the shared store.

**Builds:** the store (§4), the capture pipeline that writes Phase 1 data into it, and the MCP
tools (§6), including skills tools from Phase 2.

**Proof (e2e):** a Claude thread does a small task and is captured. A Codex thread started with
the handoff prompt calls `get_handoff_context`, and its summary names the right files and test
result. Plus fast tests with a fake agent for every tool.

### Phase 4 · chorus CLI app

Plan, spike results and the D1 decision: [phase4.md](phase4.md).

The terminal app from the [mockup](mockups/chorus-cli.html): thread sidebar, the real agent screen
in the middle, status line, handoff, memory view, and display of tool calls, artifacts and
**approvals** (badge, sidebar `!`, inbox).

**Approvals (research inside this phase):** the agent's own screen already shows its
approval prompts when the thread is in front. Chorus adds value when a thread is in the
background: the sidebar shows `!`, the top bar counts the waiting chats (`! 2 waiting`, a click opens the
approvals inbox), a status-line flash names the request, and `ctrl+\ y` / `x` answers it without switching.
(A card over the chat in front was tried and removed: it hid that chat's input or its first lines.)
Mechanisms to verify: Claude `PreToolUse` hook (can return allow / deny / ask) or
`--permission-prompt-tool` (an MCP tool decides); Codex approval policy and hooks; agy permission
modes.

**Proof (e2e):** a test drives the CLI app in a PTY: open a Claude and a Codex thread, switch
between them, hand off, answer an approval from the inbox, see an artifact listed.

### Phase 5 · Desktop app

The same operations with a graphical UI, over `chorus serve` (a local API exposed by the CLI).
No business logic of its own. Design reference: [archive/ui-mockup-v3.html](archive/ui-mockup-v3.html).

**As built** ([phase5.md](phase5.md)): `chorus serve` hosts the CLI app's Controller without a terminal and exposes it as a
token-protected HTTP + WebSocket API on 127.0.0.1; the window is a web page (xterm.js draws each agent's own screen) inside a
4.9 MB Tauri shell that starts `chorus serve` through the user's login shell. **Proof (e2e):** `npm run proof:desktop` drives
the page in Chrome with the real Claude Code and Codex (new chat, approval from the inbox, artifacts, handoff, Memory, Skills,
restart and resume) and starts the native app.

## 3. Components

```
                 ┌──────────────── user ────────────────┐
                 ▼                                      ▼
        ┌─────────────────┐                   ┌──────────────────┐
        │   chorus CLI    │                   │  Chorus desktop  │  (Phase 5)
        │ sidebar/threads │                   │  UI over the     │
        │ handoff/approve │                   │  same operations │
        └───────┬─────────┘                   └────────┬─────────┘
                │ spawns in PTY                        │ via chorus serve (local API)
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
        │ store · CLI adapters · handoff context · skills · │
        │ artifact watcher                                  │
        └──────────────────────────────────────────────────┘
                ▲
        ┌───────┴─────────┐
        │     harness     │  fake-agent CLI · fixtures · e2e runners
        └─────────────────┘
```

| Component | Responsibility | Phase |
|---|---|---|
| **core** | Store, one adapter per AI CLI (Phase 1), skills sync (Phase 2), handoff-context builder, artifact watcher. No UI. | 1–3 |
| **chorus mcp** | Stdio MCP server each AI CLI starts for its session. Exposes core as tools. Stateless; every call goes to the store. | 3 |
| **chorus CLI** | User-facing app. Runs each thread's AI CLI in its own PTY, sidebar, switching, handoff, approvals, artifacts. `chorus serve` for the desktop. | 4 |
| **desktop** | UI only. | 5 |
| **harness** | Fake agent, committed fixtures from real CLIs, e2e runners. | all |

Why the MCP server can't hold state: each AI CLI process starts its **own** copy of it. Two agents
means two server processes, plus the CLI app. Shared state has to live in the store.

## 4. What Chorus stores

Store what a feature needs, nothing more. The CLIs keep their own full transcripts; Chorus keeps a
compact copy because those files are internal formats, change between versions, and get cleaned
up (Claude deletes old ones after a retention period).

Per project, in `<project>/.chorus/` (git-ignored):

```
.chorus/
  chorus.db                       SQLite (WAL), shared by the CLI app and every chorus mcp process
  threads/<thread-id>/
    artifacts/                    files agents produce for this thread (watched)
    raw/                          debug capture: pty.log, stdout.jsonl, mcp.jsonl (size-capped, pruned)
```

| Table | Fields | Needed for |
|---|---|---|
| **threads** | id, title, agent, model, cwd, native session id, `parent_thread_id`, state (`working` / `waiting` / `ended`), created, updated, CLI version, native transcript path | sidebar, resume, handoff link, debugging |
| **turns** | thread, seq, role (`user` / `assistant`), text, timestamp | handoff context, memory view |
| **tool_calls** | thread, turn seq, tool name, short target (file path, command, MCP tool), status, duration, one-line result | handoff context (files, commands, tests), tool display |
| **usage** | thread, turn seq, tokens in / out / cache, cost; latest plan-limit reading | status line, limit warning |
| **artifacts** | thread, path, version (content hash), timestamp | artifacts view, handoff context |
| **skills** | name, description, source path, which CLIs it is synced to, version | skills sync (Phase 2) |

**Not stored:** streaming chunks, thinking blocks, full tool output, system prompts, attachments.
Raw output stays in `raw/` for `chorus trace` only.

"Shared memory" is this store: every agent reads it through the MCP tools. The memory view
(`Ctrl+Space m`, `chorus show <thread>`) shows a thread's record, and its preview shows exactly what
`get_handoff_context` returns.

## 5. How data gets out of each CLI

Chorus never parses ANSI terminal output for meaning. Raw PTY bytes are kept only for display and
debugging. Structured data comes from the CLIs' own machine-readable channels:

| Mode | Used for | Claude | Codex | Antigravity |
|---|---|---|---|---|
| **Interactive** (PTY passthrough) | the CLI app: the user works in the real TUI | hooks via `--settings` + transcript tail | session store (SQLite) or app-server, TBD | transcript.jsonl tail, TBD |
| **Headless** (print mode) | tests, automation | `-p --output-format stream-json` | `exec --json` | `-p --output-format stream-json` |

Phase 1 fills in the TBDs. Current facts: [integrations/](integrations/README.md).

## 6. MCP tools

Bound to a thread by `chorus mcp --thread <id>` in the per-session MCP config (verified for Claude
and Codex; open question for agy). All read-only: agents never have to write anything for Chorus
to work.

| Tool | Returns |
|---|---|
| `get_handoff_context(thread_id?)` | Compact digest of the parent thread (or the given one): first request, recent turns, files touched, commands and test results, artifacts, last assistant message. A few thousand tokens at most. |
| `get_thread_turns(thread_id, before?, limit?)` | Older turns, page by page |
| `list_threads()` | Threads in this project |
| `list_artifacts(thread_id?)` | Artifacts with paths, to read with the agent's own file tools |
| `list_skills()` / `get_skill(name)` | Skills, for CLIs that can't load them natively (decided in Phase 2) |

## 7. Handoff = new thread that loads the previous one

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

- Thread (1) is not stopped or asked anything; you can switch back to it.
- Works after a limit hit, because the context comes from the store, not from the old agent.
- If the new agent finishes its first turn without calling `get_handoff_context` (Chorus sees
  every MCP call), the status line shows "context not loaded" with a retry key.

## 8. Threads in the CLI app

- A **sidebar** lists all threads like tabs (title, agent, state). Open one by clicking, with
  `Ctrl+Space ↑/↓` + Enter, or `Ctrl+Space 1–9`. `Ctrl+Space b` hides it.
- Each thread is its own agent process with a virtual screen in memory (headless terminal
  emulator), so switching is a redraw, not a restart.
- States: `working`, `waiting` (turn finished, needs you), `needs approval`, `ended`.
- Memory limits the number of live threads: one `claude` process measured 250–275 MB in the probe.
  Up to N threads stay live (default 6); older idle ones are parked (process stopped, last screen
  kept) and resume in the background when opened.

## 9. Artifacts

- Agents are told the artifact folder `.chorus/threads/<id>/artifacts/` at start, **without touching the user's first prompt**: Claude and agy through the instructions of the Chorus MCP server (the server knows its thread), Codex through `-c developer_instructions=…` (it does not show MCP server instructions to the model). Verified with the real CLIs: `npm run smoke:artifacts`.
- A file watcher registers new versions. Tool-call parsing alone isn't enough: in the probe,
  Claude created an artifact with `Bash` (`mkdir && printf`), not its `Write` tool.
- `chorus artifacts [--open | --serve]`: list, open in the default app, or serve with live reload.

## 10. Debuggability

- Raw capture per thread (`threads/<id>/raw/`, size-capped) next to the normalized data.
- Correlation ids: thread id → native session id → tool-use id (Claude passes
  `_meta["claudecode/toolUseId"]` on MCP calls).
- Every thread records the CLI version; adapters warn on versions newer than the last verified one.
- `chorus doctor` (CLIs, versions, login, paths) and `chorus trace <thread>` (raw vs parsed).
- Integration facts live in [integrations/](integrations/README.md) with the version they were
  checked on; `tools/probe` regenerates the fixtures.

## 11. Open decisions

| # | Question | Proposal |
|---|---|---|
| D1 | Language for core, MCP server and CLI app | **Decided: TypeScript on Node 22+ for Phases 1–3** (adapters, store, MCP server; fastest while the CLI formats are still moving; official MCP SDK; `node:sqlite` built in). **Phase 4: stay on TypeScript** (spike: PTY + virtual screens + sidebar + switching works, see [phase4.md](phase4.md)); packaging is decided by a binary spike in P4.8, with a Rust port of only the thin app layer as the fallback. Keep `node-pty` behind a small interface so a port stays cheap |
| D2 | Per-session MCP config for agy | **Decided:** workspace `.agents/mcp_config.json`, verified with agy 1.4.0 |
| D3 | Desktop technology | **Decided: Tauri 2 as a thin shell** (4.9 MB; Electron ~200 MB). It starts `chorus serve` on the user's Node and shows its page; no logic in the shell. See [phase5.md §3](phase5.md#3-decision-d3-tauri-as-a-thin-shell) |
| D4 | Provider terms (agy subscription orchestration, Claude and Codex account use) | Check before selling; see integration docs |
| D5 | Command name and menu key | `chorus` (package `chorus-cli`); menu key **Ctrl+\** and also Ctrl+Space (macOS keeps Ctrl+Space for input-source switching, so the default had to change), configurable with CHORUS_MENU_KEY |
