# OpenAI Codex CLI (`codex`) integration

| | |
|---|---|
| **Status** | ✅ Headless `exec` verified on a logged-in Mac: all 5 probe scenarios pass (15/15 checks). Interactive TUI not probed yet |
| **Version tested** | `codex-cli 0.163.0` (npm `@openai/codex`) on Linux 2026-10-16 (flags) and macOS 2026-10-17 (model turns) |
| **Fixtures** | `fixtures/codex/0.163.0/{hello,mcp,shell,artifact,resume}/` (only session transcripts are copied from `~/.codex`) |
| **Adapter** | `src/core/adapters/codex.ts` (`parseStream`, `parseTranscript`), tests in `test/contract/` |
| **To verify** | Plan-limit message; approval prompts in the TUI |

Legend: ✅ verified by running it · 📄 from `codex --help` / docs, not exercised · ❓ unknown.

---

## 1. Launching a session

| Need | How | Status |
|---|---|---|
| Interactive TUI with first prompt | `codex "<prompt>"` (positional `[PROMPT]`) | 📄 |
| Headless, one turn | `codex exec "<prompt>"` (alias `codex e`); prompt from stdin with `-` | ✅ |
| Structured output | `codex exec --json` prints events as JSONL | ✅ |
| Last message to a file | `codex exec -o <file>` | 📄 |
| Resume (headless) | `codex exec <flags> resume <THREAD_ID> "<prompt>"`. Keeps the same thread id and remembers context. Flags go before `resume` | ✅ |
| Resume (interactive) | `codex resume [--last]`, `codex fork` | 📄 |
| Working dir | `-C <dir>`; outside a git repo needs `--skip-git-repo-check` | 📄 |
| Model | `-m <model>` | 📄 |
| Sandbox / approvals | `-s workspace-write` + `-c approval_policy="never"` work for shell commands and file writes. Also `read-only`, `danger-full-access`, `--dangerously-bypass-approvals-and-sandbox` | ✅ (workspace-write) |
| Any config override | `-c key=value` (value parsed as TOML), dotted paths | ✅ |
| Separate config/auth/state dir | `CODEX_HOME=<dir>` | ✅ |
| Don't persist the session | `--ephemeral` | 📄 |

`codex exec` blocks without error when not logged in (seen in the container). Check
`codex login status` first (prints `Logged in using ChatGPT`). ✅

## 2. Injecting the Chorus prompt envelope

- First user turn = positional prompt (TUI or `exec`). 📄
- First user turn = positional prompt. ✅
- Standing instructions: Codex reads `AGENTS.md` in the repo. 📄 No CLI flag for extra
  instructions found in `codex exec --help`; `-c` override key still ❓.

## 3. MCP server wiring

Per session, without editing `~/.codex/config.toml`:

```bash
codex exec \
  -c 'mcp_servers.chorus.command="node"' \
  -c 'mcp_servers.chorus.args=["chorus-mcp.js","--thread","t_123"]' \
  "<prompt>"
```

| Fact | Status |
|---|---|
| `-c mcp_servers.<name>.*` overrides start the server for that run only | ✅ |
| `args` reach the server → `--thread <id>` binding works | ✅ |
| Handshake: `initialize` with `protocolVersion: "2025-06-18"`, `capabilities.experimental["codex/auth-change"]`, then `tools/list` | ✅ |
| Server environment: parent env is **not** passed (`CHORUS_THREAD_ID` arrived as null) | ✅ Use argv for the thread id |
| `tools/call` works and the model sees the result (`mcp_tool_call` item with `server`, `tool`, `arguments`, `result.content[]`) | ✅ |
| **MCP calls need approval even with `approval_policy="never"`**: without the next flag the item fails with `MCP tool call requires approval, but approval policy is never` | ✅ |
| Fix: `-c 'mcp_servers.chorus.default_tools_approval_mode="approve"'` auto-approves that server's tools. (`"auto"` still fails.) | ✅ |
| Tool is called by its plain name (`probe_get_context`) when the prompt names the server | ✅ |

## 4. Getting the chat session

`exec --json` stdout, one JSON object per line (verified, see fixtures):

| Event | Fields |
|---|---|
| `thread.started` | `thread_id` (UUID v7; resume with it) |
| `turn.started` | none |
| `item.started` / `item.completed` | `item` with `id`, `type`, `status` (`in_progress` / `completed` / `failed`) |
| `turn.completed` | `usage`: `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` |

Item types seen: `agent_message` (`text`), `command_execution` (`command` as `/bin/zsh -lc '…'`,
`aggregated_output`, `exit_code`), `mcp_tool_call` (`server`, `tool`, `arguments`, `result`, `error`).
Not yet seen: `reasoning`, `file_change` (file writes went through `command_execution`), `turn.failed`, `error`.

Session files on disk:

| Source | What we know | Status |
|---|---|---|
| Transcript | `~/.codex/sessions/YYYY/MM/DD/rollout-<local-time>-<thread_id>.jsonl`, written live. Lines: `{timestamp, ordinal, type, payload}`. Types: `session_meta` (id, cwd, cli_version, `base_instructions`, creator ids, **personal: redact**), `turn_context`, `response_item` (message, custom_tool_call, …), `event_msg` (`task_started`, `task_complete`, `token_count`, `item_completed`), `token_usage_record`, `world_state` | ✅ |
| Index | `~/.codex/state_5.sqlite` has `threads`, `projects`, `thread_*` tables; `logs_2.sqlite` is logs. Schema not inspected | ✅ tables seen, ❓ schema |
| Session browser | `codex agents` (shared local app-server daemon) | 📄 |
| App server | `codex app-server` (experimental) JSON-RPC API; may be the stable way to read threads | 📄 worth evaluating |
| Hooks | Exist (`--dangerously-bypass-hook-trust`), require "hook trust" | 📄 |

### Interactive TUI (verified with `tools/probe/pty-probe.mjs`) ✅

- `codex "<prompt>"` in a PTY. First start in a new folder asks to trust it: Enter (`allow`) continues.
- The rollout file `~/.codex/sessions/…/rollout-<time>-<thread_id>.jsonl` is written **while the TUI
  runs**: it was readable 7.5 s after launch, with the user turn, the `CommandExecution` result and
  the token counts. Tail it for live data. Fixture: `fixtures/codex/0.163.0/pty/`.
- On exit the TUI prints `codex resume <thread_id>` and a token summary. The thread id is also in
  `session_meta.payload.id`.
- Hooks and the app-server were not needed; the rollout tail is enough for turns, tool calls and usage.

### Which rollout belongs to which Chorus thread (TD-4) ✅ codex 0.163.0, 2026-10-22

Probed with two TUIs in one folder, the first never sent a turn (`npm run risk -- codex-thread-marker`, evidence
`fixtures/risks/codex-thread-marker/`).
- A TUI that gets **no turn writes no rollout file** at all (it still prints a `Session ID` on exit). So "the first new rollout in
  this cwd" is the next chat's rollout: matching by cwd + birth time gives an idle chat someone else's transcript.
- A rollout is born ~1 s after the first prompt with `session_meta` + `event_msg/task_started` only (no marker yet). With the
  first turn, line 3 is `response_item` `{type: "message", role: "developer"}` whose **first content item is our
  `developer_instructions`**: `This chat is Chorus thread <id>. Files meant for the user …` (`content_item_kinds[0]` is
  `generic.developer_instructions`; the next items are Codex's skills, permissions and collaboration-mode text).
- Chorus matches a new rollout to its thread by that line, read only from a developer message (`codexThreadId` in
  `src/core/discover.ts`); no marker yet → the thread stays unlinked and the Tailer retries. The rollout also carries the
  user's skill list and account ids in `session_meta`: redact both in fixtures.

## 5. Tool usage, tokens, limits

- Tool calls: `command_execution` and `mcp_tool_call` items, with start and completion events. ✅
- Rollout equivalents: `event_msg/item_completed` with `item.type` `CommandExecution` (`command` array, `aggregated_output`, `exit_code`, `duration`) or `McpToolCall` (`server`, `tool`, `arguments`, `status`, `result.content[]`). ✅
- Plan-limit reading: `event_msg/token_count.rate_limits.primary.used_percent` in the rollout. ✅ (field seen, limit behaviour ❓)
- Tokens: `turn.completed.usage` per turn (fields above). ✅ Note `input_tokens` includes cached tokens.
- Plan limits: message format unknown. ❓ Capture when it happens.

## 6. Gotchas

1. Not logged in → `exec` hangs instead of failing. Run `codex login status` before spawning. ✅
2. With `CODEX_HOME` under `/tmp`, Codex warns it can't create PATH helper binaries; harmless. ✅
3. `exec` prints `Reading additional input from stdin...` to stderr; close stdin (`</dev/null`). ✅
4. Sessions are still **JSONL rollout files** in `~/.codex/sessions/` in 0.163.0 (the earlier note
   that they moved to SQLite was wrong; SQLite is an index/log beside them). ✅
5. `~/.codex/config.toml` is user-specific and changes between runs (plugins, marketplaces, local
   app paths). Never copy it into fixtures; probe copies session transcripts only. ✅
6. A run touches many files in `~/.codex` (skills cache, plugin cache, models cache, sqlite). Treat
   the dir as Codex's, read-only for us. ✅
7. MCP approval needs `default_tools_approval_mode="approve"` (see §3). ✅
8. The shell tool runs commands as `/bin/zsh -lc '<cmd>'`. ✅
9. **An older TUI next to a newer Codex's background server** (0.160.0 pinned while 0.163.0 is installed, 2026-10-23): before the
   first prompt the TUI asks "Background server has incompatible feature settings … 1. Run without daemon this time 2. Restart
   with these settings 3. Cancel" (cursor on Cancel). `1` runs this session alone and changes nothing; `2` rewrites the shared
   settings for every Codex client. The approval probe answers `1`; a Chorus chat on such a version shows the dialog on the agent's
   screen for the user to answer. `exec` (headless) is not affected. Evidence: `fixtures/codex/0.160.0/approval-ask-nohook-enter/`. ✅

## 7. Verification checklist

- [x] Run the probe on a logged-in machine and commit `fixtures/codex/<version>/`
- [x] Record the real `--json` event names and the `usage` fields
- [x] Find where the thread id appears and confirm `exec resume <id>` keeps it
- [x] Check MCP tool naming and approval behaviour in `exec`
- [ ] Find the instructions flag or config key for the envelope (not needed: first message carries it)
- [x] Interactive (PTY) session: rollout tail while the TUI runs
- [x] Rollout ↔ Chorus thread: the `developer_instructions` marker, present from the first turn (no turn, no rollout)
- [ ] Approval prompts in the TUI (Phase 4 research)
- [ ] `reasoning`, `file_change`, `turn.failed`, `error` event shapes; plan-limit message
