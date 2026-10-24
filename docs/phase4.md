# Phase 4 plan: the `chorus` CLI app

Status: **P4.1–P4.8 built**; the e2e proof with screenshots is in [proof/phase4/README.md](proof/phase4/README.md) (`npm run proof`). Goal and proof: [architecture.md §2](architecture.md#phase-4--chorus-cli-app),
mockup: [mockups/chorus-cli.html](mockups/chorus-cli.html).

## 1. Decision D1: TypeScript or Rust for the app

**Decision: stay on TypeScript (Node 22+) for Phase 4. Re-decide the packaging question with a spike
inside Phase 4 (§5, P4.8), not before.**

Evidence from the spike (`tools/spike/mux.ts`, driven by `tools/spike/drive.mjs`; it runs Codex and agy
side by side):

| Question | Result |
|---|---|
| Can TypeScript host real agent TUIs in PTYs? | ✅ `node-pty` spawns Codex and agy; interactive trust prompts, resize, Ctrl-C all work |
| Can we keep a virtual screen per thread and switch without restarting? | ✅ `@xterm/headless` per thread; switching redraws from memory, the other agent keeps running (state kept) |
| Can we draw a sidebar and a status line around an agent's full-screen UI? | ✅ a cell-based renderer (colors and attributes per cell, ~40 lines) into a region next to a sidebar, status line on the last row |
| Does `Terminal.serialize` do this for us? | ❌ rendering rows through the serialize addon garbles the layout; use the cell renderer |
| Cost of the whole stack | one Node process (~25 MB for the driver) plus the agents; agents dominate memory (Claude ~250 MB each, measured earlier) |

Why not Rust now:

- Phases 1–3 are written, tested (44 tests) and proven in TypeScript: adapters, store, handoff, skills,
  MCP server. A Rust app would either rewrite all of it or call it as a sidecar, giving two languages
  for one product.
- The reasons to prefer Rust (one small binary, no runtime) are real but are packaging concerns. They
  can be tested cheaply: P4.8 tries a Node single-executable build with `node-pty`, and a Bun compile
  as the alternative. If both fail, port only the thin app layer (PTY, compositor, input) to Rust
  with `portable-pty` + `vt100` + `ratatui` and keep the TypeScript core as a sidecar. The fixtures,
  docs and contracts are language-neutral, so this stays cheap.
- Today's `npm i -g chorus-cli` / `npx chorus-cli` works with TypeScript as is. Caveat: not every
  user has Node (Claude Code and agy install as native binaries); P4.8 decides whether to ship a
  binary for them.

## 2. App structure

```
chorus (one process)
├─ ThreadHost × N     PTY (node-pty) + virtual screen (@xterm/headless) + state; one per thread
├─ Compositor         draws sidebar | active thread's screen | status line | overlays (menu, cards, memory view)
├─ InputRouter        menu key (Ctrl+Space) → Chorus actions; every other byte → active PTY
├─ Tailer             watches each thread's transcript file, parses new lines, writes the store
├─ ApprovalBroker     local socket; hook shims ask it, it shows a card and answers
└─ commands           new · run · handoff · threads · show · artifacts · activity · trace · doctor · mcp
```

All existing core pieces are reused: `adapters`, `Store`, `buildHandoff`/`handoffPrompt`, `syncSkills`,
`mcpCommand`, `captureTranscript`.

## 3. Work packages (each ends with a test that drives the real app)

| # | Package | Done when |
|---|---|---|
| P4.1 | **Thread host + compositor**: productize the spike (resize, scroll region, wide characters, cursor, bracketed paste, mouse off, alt-screen restore on exit/crash) | PTY test: two threads, switch both ways, resize, screen content equals the agent's own screen |
| P4.2 | **Interactive launchers**: first-prompt + per-thread MCP + skills sync for each CLI, interactive flavour (`claude --mcp-config … "<prompt>"`, `codex -c … "<prompt>"`, `agy -i` with the workspace `.agents/mcp_config.json`) | each CLI starts in its PTY with `chorus mcp --thread <id>` connected (MCP log shows it) |
| P4.3 | **Live tailing**: incremental parse (byte offset per transcript file, parse only new lines), session id discovery (Claude: we pass `--session-id`; Codex/agy: newest file created after spawn in that cwd), store update, `fs.watch` + poll fallback | during a live session the store has the user turn, tool calls and usage within ~1 s of the TUI showing them |
| P4.4 | **Thread state**: `working` / `waiting` / `needs approval` / `ended` from transcript events (Codex `task_started`/`task_complete`, Claude `Stop` hook, agy transcript status) | sidebar dot matches reality in a scripted run, including a long tool call |
| P4.5 | **Handoff action**: menu → pick agent → new thread with `parent_thread_id` → launcher with `handoffPrompt` → "context not loaded" warning when `get_handoff_context` was not called | PTY test: Claude thread works, handoff to Codex, Codex's first reply names the files and tests |
| P4.6 | **Approvals** (§4) | PTY test: background thread asks for a command; card appears; answering it lets the agent continue |
| P4.7 | **Views and commands**: memory view (preview of `get_handoff_context`), artifacts view and `chorus artifacts`, tool-call strip, limit warning at ≥90% utilization (Claude `rate_limit_event`, Codex `rate_limits.primary`), `doctor`, `trace`, `threads`, `show` | commands covered by L2 tests; views by a PTY snapshot test |
| P4.8 | **Packaging spike**: Node SEA (+ `node-pty` prebuild next to the binary) and `bun build --compile`; per-platform npm packages; decide binary vs npm-only | a binary on macOS arm64 runs P4.1's test; go/no-go recorded in D1 |

Order: P4.1 → P4.2 → P4.3 → P4.4 (a usable multi-thread viewer) → P4.5 handoff → P4.6 approvals →
P4.7 → P4.8. P4.8 can start any time after P4.1.

### P4.1 as built, and what it taught

Code: `src/app/` (`screen.ts` virtual screen, `pty.ts` node-pty behind an interface, `thread-host.ts`,
`input.ts` menu-key router, `compositor.ts` pure frame composition + row diffing, `app.ts` shell).
`chorus mux <cmd> <cmd> …` runs any commands as threads (dev command). Tests: `test/app/` (fake TUI in
real PTYs, ~1 s) and `npm run smoke:app` (real claude + codex + agy: trust dialogs, answers, switching,
resize, quit).

- **The app is the terminal for each agent**: programs ask their terminal questions (cursor position,
  device attributes). The headless emulator generates the replies; `ThreadHost` writes them back to
  the PTY. Without this some TUIs stall.
- **Modes are mirrored**: when the agent switches on bracketed paste or application cursor keys, the real
  terminal gets the same mode, so pastes and arrow keys reach the agent in the form it expects. Pastes are
  never scanned for the menu key.
- **Not forwarded yet**: mouse reporting (positions would be off by the sidebar width) and the kitty
  keyboard protocol (the menu key relies on the legacy NUL byte for Ctrl+Space). Revisit if an agent needs them.
- **Menu key**: Ctrl+Space (NUL) then a key: `1-9` switch, `b` sidebar, `n` new, `h` hand off (the last two
  report "not available yet" until P4.2/P4.5), `q` quit (twice while threads run), arrows+Enter, Esc cancels,
  menu key twice sends it to the agent.
- **Rendering**: whole frame as cells, only changed rows are written, wrapped in synchronized output.
  Narrow terminals (< 60 columns) hide the sidebar automatically.
- **Testing gotcha**: Claude and Codex read "text then Enter" arriving in one chunk as a paste, and an arrow
  plus Enter in one chunk as a different key. Tests send them separately, like a person types.
- **Known limits**: the thread "busy" dot is a 1.5 s output heuristic until P4.4 reads real events; no
  scrollback in the thread area yet (agents keep their own); no copy/selection support beyond the
  terminal's own.

### Look and screens of the mockup (P4.9, first pass)

Built to match `docs/mockups/chorus-cli.html`, scene by scene (colors are the mockup's: Claude orange, Codex blue,
agy green, Chorus teal):

| Mockup scene | In the app |
|---|---|
| Home screen | `chorus` opens it: agents with versions and login state, this project's threads (a continued thread indented under its source with `↳`), state, age, artifact count; `n ⏎ a d q` |
| New thread | form: agent, model, folder (below) |
| Working / sidebar | two-line items (`● title`, then `agent · state`), `THREADS · n/N` header, key hints at the bottom, children under their source, `waiting for you` for threads that finished their turn |
| Status bar | `chorus` chip · thread · agent · model · plan meter `5h ▮▮▮▮▮▮▱▱▱▱ 62%` (when the transcript reports it, e.g. Codex) · artifact count with a `+ file` toast · menu hint |
| Chorus menu | key + label rows, `esc back to <agent>`, `↑↓` walks the sidebar, `0` home |
| Hand off | agent picker (`h`) |
| Memory | `m` |
| Limit | status-line warning at ≥ 90 % plus the "reached its limit" box (`⏎` continue with another agent, `w` not now) when an agent runs out: Codex/Claude by plan usage ≥ 99 %, agy by its quota message |
| Artifacts | `a`: name, version, who wrote it, age, path, files written by tools |
| Activity | `e`: timeline of tool calls with status, MCP calls, artifacts, continuations |
| Doctor | `d` (also on the home screen): versions, login, data folders, "newer than verified" warnings |

Also built after the first pass: **mouse** (a click on a sidebar item or a home row opens the thread; clicks in the thread
area go to the agent only if it asked for the mouse, shifted by the sidebar; wheel scrolls panes; `CHORUS_MOUSE=0` turns it
off and Shift-drag selects text), the **artifact preview server** (`src/core/preview.ts`: 127.0.0.1 only, serves a thread's
artifacts, reloads the page when the agent edits the file; `o` in the Artifacts view, or `chorus artifacts --serve`), `p` copy
path, `v` versions, and in Activity `f` filter (all/tool/mcp/file) and `r` raw trace.

Not done from the mockup: dimming the agent behind an overlay; a plan meter for Claude interactive threads (Claude only
reports plan usage in the headless stream, not in the transcript).

### New thread: agent, model, folder (as in the mockup)

`ctrl+\ n` (or `chorus new`, or `chorus` in a project with no threads) opens a three-field form: **Agent**
(`←/→`), **Model** (the list changes with the agent: Claude aliases, Codex's model cache, `agy models`; `default`
passes no flag) and **Folder** (text, default = this project, checked to exist). Enter starts the agent in that
folder with the Chorus MCP server attached; you then talk to the agent in its own screen, and the thread takes the
name of your first message. `chorus new --agent claude --model sonnet --folder ~/x` skips the form. Code: `App.form`,
`Controller.newThreadForm`, `src/app/models.ts`. Mockup scene: `docs/mockups/chorus-cli.html` → "New thread".

### P4.2–P4.7 as built

| Package | Where | What it does / what we learned |
|---|---|---|
| P4.2 launchers | `core/launch.ts` `buildInteractive`, `app/controller.ts` `newThread` | Claude: `claude "<prompt>" --session-id <uuid> --mcp-config … --allowedTools mcp__chorus__…` (the prompt goes first because `--allowedTools` is variadic); Codex: `codex -c mcp_servers.chorus… "<prompt>"`, resume `codex … resume <id>`; agy: workspace `.agents/mcp_config.json` + `agy -i "<prompt>"`, resume `--conversation`. No auto-approve flags: the agent asks like it does for a person. The first prompt is typed exactly as given; where artifacts go is told through each agent's instructions (MCP server instructions for Claude and agy, `developer_instructions` for Codex) |
| P4.3 tailing | `app/tailer.ts`, `core/discover.ts` | One tailer per thread: reads appended bytes (keeps the last half line), re-parses the transcript, upserts the store, scans artifacts. Claude's file is known from `--session-id`; for Codex/agy the tailer claims the first unclaimed transcript born after the spawn (Codex: same cwd). Limits: two threads started in the same second in one cwd are matched by creation order; the handoff prompt makes this unambiguous (not yet used as a marker) |
| P4.4 state | adapters (`Session.status`), controller `refreshState` | `working` / `waiting` come from the transcripts (Claude `stop_reason: end_turn`, Codex `task_started`/`task_complete`, agy a planner reply without tool calls); `approval` from the screen detector; `ended` from the process; `parked` for threads of earlier runs. No hooks needed |
| P4.5 handoff | `Controller.handoff`, `checkContext` | `ctrl+\ h` → pick the agent → child thread (`parent_thread_id`) started with the fixed first message. If the child's first turn finishes without a `get_handoff_context` MCP call the status line warns and `ctrl+\ r` types the prompt again |
| P4.6 approvals | `app/approval.ts`, [integrations/approvals.md](integrations/approvals.md) | Screen detector + the prompt's own keys; the card appears only for threads you are not looking at; `ctrl+\ y` / `x` answers the active thread's prompt or the card's |
| P4.7 views and commands | `Controller.memoryLines/toolLines/fileLines`, `cli/commands.ts` | Panes for memory (`m`, the exact digest a handoff carries), tool calls (`t`), files and artifacts (`f`), help (`?`); limit warning at ≥ 90 % plan use; raw PTY capture per thread (`threads/<id>/raw/pty.log`, 2 MB cap); commands `new`, `run`, `handoff`, `threads`, `show`, `memory`, `artifacts`, `activity`, `trace`, `doctor` |

### P4.8 packaging spike: results

| Route | Result |
|---|---|
| **Node single-executable app** (`tools/packaging/build-sea.mjs`, `verify-sea.mjs`) | ✅ works: esbuild bundle (1.7 MB) + official Node 26 → one binary (147 MB; the Node runtime is most of it) that runs the app and `chorus mcp`; `node-pty` stays a folder next to the binary. Needs an **official** Node build (Homebrew's has SEA disabled: "Single executable application is disabled") and, on macOS, an ad-hoc `codesign` after injection (otherwise the binary is killed, exit 137) |
| **Bun compile** | ❌ `node-pty` hangs under Bun (the PTY spawn never returns), so the PTY layer would have to be rewritten for Bun's own terminal API |
| **npm package of the JS** | ✅ `npm i -g chorus-cli` / `npx chorus-cli` works with Node 22+; `node-pty` ships prebuilds (a postinstall chmods its `spawn-helper`) |
| **Rust rewrite of the app layer** | not needed so far; stays the fallback if a small native binary becomes a hard requirement (147 MB is the cost of embedding Node) |

**Go/no-go:** ship the npm package as the main distribution (users of these CLIs mostly have Node; Codex itself
is an npm install). Offer the SEA binary as an optional download for users without Node, built per platform in CI
(macOS arm64/x64, Linux, Windows); if its size is a problem, revisit Rust for the thin app layer (D1).

## 4. Approvals: research and design

The agent's own screen already shows its approval prompt when the thread is in front. Chorus adds
value for a **background** thread: the sidebar shows `needs approval`, a card shows the request, and one
key answers it. Two mechanisms were tested per CLI (CLAUDE.md rule 1). **Outcome:** hooks decide fully only for Claude (allow/deny/ask) and can only deny for agy and Codex; keystrokes on the agent's own prompt work for all three and are what Chorus uses. Verified facts: [integrations/approvals.md](integrations/approvals.md). The plan as written before the tests:

| | A. Hook decides (preferred) | B. Keystroke injection (fallback) |
|---|---|---|
| How | A `PreToolUse` hook command (`chorus hook <cli>`) reads the tool call on stdin, asks the ApprovalBroker over a local socket, waits for the card answer, prints `allow` / `deny` / `ask` | Detect the agent's prompt (hook `Notification`, or screen text), show the card, write the agent's own answer key to its PTY |
| Claude Code | 📄 `PreToolUse` hook JSON output with a permission decision; hooks via `--settings` already work (verified in the interactive probe); `--permission-prompt-tool` (an MCP tool) exists for `-p` only | answer keys in the TUI ❓ |
| agy | 📄 `.agents/hooks.json` `PreToolUse` with output `{"decision":"allow\|deny\|ask","reason":…}`, stdin has `toolCall` and `conversationId`, default timeout 30 s (shipped doc: `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`) | ❓ |
| Codex | 📄 hooks exist and need "hook trust" (`--dangerously-bypass-hook-trust`); binary mentions `PermissionRequest` and `PreToolUse` events; exact contract ❓ | `-a on-request` + answer keys ❓ |

Experiments, in order (each: probe script, fixture, row in the integration doc):

1. Claude: interactive run with a `PreToolUse` hook that sleeps 5 s then returns allow, then deny, then ask;
   record what the TUI shows and whether the hook timeout (default?) bites during a human-speed answer.
2. agy: same with `.agents/hooks.json` (the 30 s default timeout is the constraint for a card the user
   answers late; check `timeout` can be raised).
3. Codex: find the hook config location and trust flow; test `PermissionRequest` vs `PreToolUse`.
4. For any CLI where A fails: B, with the answer keys captured by the PTY probe.

Design points: the shim must fail open or closed by policy (default: fall back to the agent's own
prompt, i.e. return `ask`, if Chorus isn't running); hooks are written per session (Claude `--settings`,
agy workspace file with a Chorus-managed marker, Codex `-c`), never into the user's global config.

## 5. Risks and open questions

- **Terminal fidelity**: agents use modern terminal features (kitty keyboard protocol, synchronized
  output, OSC sequences, mouse). The spike used the default xterm.js modes; expect work on keyboard
  protocol pass-through and the menu key (D5: Ctrl+Space, check each CLI's bindings; the NUL byte it
  sends worked in the spike).
- **Session discovery for Codex/agy** (no way to choose the id): match by cwd and creation time; a
  thread started in a shared cwd needs a unique marker (the Chorus thread id in the first prompt works).
- **Memory**: ≤ 6 live threads (architecture §8), parked threads resume with `--resume`/`resume`.
- **Provider terms (D4)** still gate the release; no change from earlier.
- **node-pty in a binary** (P4.8): native addon plus a `spawn-helper` that must be executable
  (`scripts/fix-pty.mjs`).

## 6. Definition of done (Phase 4 proof)

One PTY-driven test (like `tools/spike/drive.mjs`, with assertions): open a Claude and a Codex thread,
switch between them, hand off Claude → Codex and see the continuation summary, answer an approval from a
card on the background thread, and see an artifact listed. Run against the real CLIs on the Mac.
