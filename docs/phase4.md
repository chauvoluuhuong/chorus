# Phase 4 plan: the `chorus` CLI app

Status: P4.1 done (`src/app/`); P4.2 onwards not started. Goal and proof: [architecture.md §2](architecture.md#phase-4--chorus-cli-app),
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

## 4. Approvals: research and design

The agent's own screen already shows its approval prompt when the thread is in front. Chorus adds
value for a **background** thread: the sidebar shows `needs approval`, a card shows the request, and one
key answers it. Two mechanisms, to verify per CLI (CLAUDE.md rule 1; nothing below is verified yet):

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
- **Provider terms (D4)** still gate selling the product; no change from earlier.
- **node-pty in a binary** (P4.8): native addon plus a `spawn-helper` that must be executable
  (`scripts/fix-pty.mjs`).

## 6. Definition of done (Phase 4 proof)

One PTY-driven test (like `tools/spike/drive.mjs`, with assertions): open a Claude and a Codex thread,
switch between them, hand off Claude → Codex and see the continuation summary, answer an approval from a
card on the background thread, and see an artifact listed. Run against the real CLIs on the Mac.
