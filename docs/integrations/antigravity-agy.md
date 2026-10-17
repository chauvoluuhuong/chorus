# Google Antigravity CLI (`agy`) integration

| | |
|---|---|
| **Status** | ✅ Headless `-p` verified on the Mac: all 5 probe scenarios pass (15/15 checks). Interactive TUI not probed |
| **Version tested** | `agy 1.4.0` on macOS, 2026-10-17 (a first run on 1.3.6 also passed; agy **auto-updated** between the runs) |
| **Fixtures** | `fixtures/agy/1.4.0/{hello,mcp,shell,artifact,resume}/` (only `brain/<id>/…/transcript.jsonl` is copied from `~/.gemini`) |
| **Adapter** | `src/core/adapters/agy.ts` (`parseStream`, `parseTranscript`), tests in `test/contract/` |
| **To verify** | Quota-exhausted message; approval prompts in the TUI; ToS answer |

Legend: ✅ verified by running it · 📄 official changelog/docs · 🌐 community source only · ❓ unknown.

---

## 1. Launching a session

| Need | How | Source |
|---|---|---|
| Interactive TUI | `agy` | 🌐 |
| Interactive with first prompt | `agy -i "<prompt>"` / `--prompt-interactive` (can't be combined with `--print`, exits 2) | 📄 |
| Headless, one turn | `agy -p "<prompt>" --output-format stream-json --dangerously-skip-permissions` | ✅ |
| Structured output | `--output-format text\|json\|stream-json` | ✅ stream-json |
| Multi-turn over stdin | `--input-format stream-json` (needs `--output-format stream-json`), one JSON prompt per line: `{"event":"user","message":{"content":"…"}}` | 👀 📄 |
| Resume specific conversation | `--conversation <id> -p "<prompt>"`. Keeps the same `conversation_id` and remembers context (`num_turns` counts both turns) | ✅ |
| Resume latest | `-c` / `--continue` (falls back to the latest non-empty conversation) | 📄 |
| Model / effort | `--model <id>` (e.g. `gemini-3.8-flash-low`), `--effort low\|medium\|high`; honoured in `-p` only from 1.1.10 | 👀 🌐 |
| Permissions | `--dangerously-skip-permissions` is needed for tools in `-p` (init shows `permission_mode: always-proceed`). Also `--mode accept-edits\|auto\|plan`, `--sandbox` | ✅ (skip-permissions) |
| Timeout | `--print-timeout` (default unlimited since 1.2.6) | 📄 |
| Workspace | cwd is the workspace (`init.cwd`); `--add-dir` for more | ✅ |
| Other flags (1.3.6 `--help`) | `--agent`, `--project`, `--new-project`, `--log-file`, `--json-schema`, `--input-format`, `--effort low\|medium\|high\|xhigh\|max`, `--remote-control` | ✅ |

**stdin gotcha:** `agy -p` may read stdin even when the prompt is given. The probe spawns with stdin
closed and it works. 🌐 ✅

## 2. Injecting the Chorus prompt envelope

- First user turn: `-i "<envelope>"` (interactive) or `-p` / stdin `user` event (headless). 📄
- Standing rules: `AGENTS.md` / `GEMINI.md` and rule files (workspace and `~/.gemini/config`,
  20k-token budget for rules). 📄 Writing rules into the user's repo is intrusive, so prefer the
  first turn.

## 3. MCP server wiring

**Decision D2 settled: a workspace file works, no global edit needed.** The probe writes
`<workspace>/.agents/mcp_config.json` and agy starts that server for the run:

```json
{ "mcpServers": { "chorus": { "command": "node", "args": ["chorus-mcp.js", "--thread", "t_123"] } } }
```

| Fact | Status |
|---|---|
| `.agents/mcp_config.json` in the cwd is picked up; the server starts, `tools/call` works, the model sees the result | ✅ |
| Args reach the server → `--thread <id>` binding works. Parent env does **not** (`CHORUS_THREAD_ID` was null): use argv | ✅ |
| Handshake: first `server/discover` (we answer -32601, agy continues), then `initialize` with `protocolVersion: "2025-11-25"`, `clientInfo.name: "antigravity-client"`, then `tools/list` | ✅ |
| agy still loads the user's **global** MCP servers too (the run wrote tool files for ElevenLabs, chrome-devtools, etc.), so the model sees many more tools; a unique server name like `chorus` avoids clashes | ✅ |
| agy writes each server's tool schemas to `~/.gemini/antigravity-cli/mcp/<server>/<tool>.json` and the model reads them with `view_file`, then calls `call_mcp_tool` (`ServerName`, `ToolName`, `Arguments`) | ✅ |
| Managed with `agy mcp add [flags] <name> <commandOrUrl> [args…]` (flags `-e/--env`, `-H/--header`, `-t/--type`; flags before the name), `remove`, `list`, `enable`, `disable`. Edits the global config, so not used | ✅ help |
| Headless runs wait for MCP servers to load before the turn; calls with undeclared arguments are rejected (1.1.27+); `_meta["antigravity/alwaysLoad"]` keeps a tool always loaded | 📄 |

## 4. Getting the chat session

### Live stream (`--output-format stream-json`), one JSON object per line ✅

| `event` | Fields |
|---|---|
| `init` | `conversation_id`, `init.cwd`, `init.tools` (~60 names), `init.permission_mode` |
| `step_update` | `step_update.{conversation_id, step_index, state, step_type}`. `state`: `ACTIVE` then `DONE`. `step_type`: `user_input`, `agent_response`, `tool` |
| `step_update` (`agent_response`) | `text_delta` (partial text while `ACTIVE`, `"\n"` at `DONE`), at `DONE`: `duration_seconds` and `usage {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}` |
| `step_update` (`tool`) | `tool_name`, `tool_info.{name, parameters}`; at `DONE`: `tool_info.output` (a string) and `duration_seconds` |
| `result` | `result.{conversation_id, status ("SUCCESS"), response, duration_seconds, num_turns, usage}`; `usage` is summed over the turn's model calls |

Tool names seen: `view_file` (`AbsolutePath`), `run_command` (`CommandLine`; output has `\r\n`),
`write_to_file` (`TargetFile`; no output text), `call_mcp_tool` (`ServerName`, `ToolName`, `Arguments`). Not seen:
`replace_file_content`, errors, quota.

### Files on disk

| What | Path | Status |
|---|---|---|
| Transcript | `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (also `transcript_full.jsonl` and `chunks/transcript*/00000000.jsonl`). Lines: `{step_index, source (USER_EXPLICIT/MODEL), type (USER_INPUT/PLANNER_RESPONSE/GENERIC), status, created_at, content, tool_calls[{name,args}], input_tokens, output_tokens, cache_read_tokens}`. The user input is wrapped in `<USER_REQUEST>…` | ✅ |
| Tool outputs | `brain/<id>/.system_generated/steps/<n>/output.txt` | ✅ |
| Other per-conversation files | `annotations/<id>.pbtxt`, `presence/<id>.lock`, `conversation_summaries.db`, `conversations/`, `cli.log` | ✅ seen, ❓ content |
| IDE (not CLI) data | `~/.gemini/antigravity/` | 👀 |

### Interactive TUI (verified with `tools/probe/pty-probe.mjs`) ✅

- `agy -i "<prompt>"` in a PTY. A new folder shows "Do you trust the contents of this project?":
  Enter on "Yes, I trust this folder". The banner shows the signed-in account (redact it in fixtures).
- `brain/<conversation-id>/.system_generated/logs/transcript.jsonl` is written **while the TUI runs**:
  readable 9 s after launch, including the tool call and its result. Tail it. Fixture:
  `fixtures/agy/1.4.0/pty/`. Ctrl+C once interrupts the running tool; twice exits.
- Conversation id for `--conversation`: the `brain/<id>` folder name.

## 5. Errors, exit codes, limits

| Signal | Meaning | Source |
|---|---|---|
| exit `0` | success (also when `--print-timeout` expires: partial output + warning) | 📄 |
| exit `1` | bad `--agent`, invalid `--json-schema` | 📄 |
| exit `2` | `--print` combined with `--prompt-interactive` | 📄 |
| exit `3` | model/agent error during a headless run; stderr line `AGY_ERROR: {…, "retryable", "error_id"}` | 📄 |
| Quota exhausted | reported immediately (1.3.3+); expected as `RESOURCE_EXHAUSTED` in `AGY_ERROR` | 📄 🌐 ❓ not captured |
| Quota check without spending | `agy --output-format json -p /usage` (don't use `--disable-slash-commands`) | 🌐 |
| Denied actions | `denied_actions` in JSON output | 📄 |

## 6. ⚠️ Terms-of-service risk

Several threads on Google's developer forum ask whether a third-party app may orchestrate `agy`
headless mode on a personal subscription account. No official Google answer was found, and
users cite the Antigravity Additional Terms on third-party software access. **Get a clear answer
before selling a product that drives agy on users' subscription accounts.** `GEMINI_API_KEY`
billing may be the safer path.

## 7. Gotchas

1. **agy auto-updates itself** (1.3.6 → 1.4.0 during this session). Record the version per fixture
   run and re-probe after updates. ✅
2. Without `--dangerously-skip-permissions`, tool calls in `-p` are not auto-approved. ✅ (flag used)
3. The user's global MCP servers load in every run: more tools, slower start (~10-17 s per turn). ✅
4. `~/.gemini` holds an OAuth token and settings backups. Never copy anything but
   `transcript.jsonl` into fixtures. ✅

## 8. Verification checklist

- [x] `agy --version`, `agy --help`, `agy mcp --help` recorded above
- [x] `node tools/probe/probe.mjs agy`; fixtures committed after review
- [x] `.agents/mcp_config.json` is picked up (mcp scenario passes) → D2 settled
- [x] Transcript path and `result` / `usage` field names
- [x] `--conversation <id>` resume keeps the id
- [x] Interactive (PTY) session: transcript tail while the TUI runs
- [ ] Approval prompts in the TUI (Phase 4 research)
- [ ] Capture one quota-exhausted run when it happens
- [ ] Get a clear ToS answer (§6)
