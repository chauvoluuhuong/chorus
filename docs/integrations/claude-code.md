# Claude Code (`claude`) integration

| | |
|---|---|
| **Status** | ✅ Verified with the capability probe |
| **Version tested** | `2.1.301` on Linux (cloud container), 2026-10-16 |
| **Fixtures** | [`fixtures/claude/2.1.301/`](../../fixtures/claude/2.1.301/) |
| **Re-verify** | `node tools/probe/probe.mjs claude --model haiku` |

Legend: ✅ verified by a probe run · 📄 from `claude --help` or docs, not yet exercised · ❓ unknown.

---

## 1. Launching a session

| Need | How | Status |
|---|---|---|
| Interactive TUI with first prompt | `claude "<prompt>"` (positional `[prompt]`) | 📄 |
| Headless, one turn | `claude -p "<prompt>"` | ✅ |
| Choose the session id ourselves | `--session-id <uuid>` (we generate the UUID, so we know the transcript path up front) | ✅ |
| Resume | `--resume <session-id>`; keeps the same id | ✅ |
| Continue latest in this cwd | `-c` / `--continue` | 📄 |
| Fork on resume | `--fork-session` with `--resume` | 📄 |
| Add to system prompt | `--append-system-prompt <text>` or `--append-system-prompt-file` | 📄 |
| Model | `--model <alias or id>` (e.g. `haiku`) | ✅ |
| Permissions | `--permission-mode <mode>`, `--allowedTools "a,b,c"`, `--dangerously-skip-permissions` | ✅ (`acceptEdits` + allowedTools) |
| Extra settings (hooks etc.) without touching user files | `--settings <file-or-json>` | ✅ |
| Isolated run (no user hooks/CLAUDE.md/plugins) | `--bare` (requires `ANTHROPIC_API_KEY`; OAuth is not read) | 📄 |

**Argument order gotcha:** `--mcp-config` and `--allowedTools` are variadic. Put the prompt
right after `-p`, before any variadic option, or it is swallowed as an option value.

## 2. Injecting the Chorus prompt envelope

Two native ways, both usable together:

1. **First user turn** = the positional prompt (`claude "<envelope + task>"` or `-p`). ✅
2. **System prompt addition** = `--append-system-prompt "<envelope>"`. 📄 Survives across turns;
   better place for standing rules (where to put artifacts, which MCP tools exist).

## 3. MCP server wiring

```bash
claude --strict-mcp-config \
  --mcp-config '{"mcpServers":{"chorus":{"command":"node","args":["chorus-mcp.js","--thread","t_123"]}}}'
```

| Fact | Status |
|---|---|
| `--mcp-config` accepts an inline JSON **string** (no temp file needed) | ✅ |
| `--strict-mcp-config` ignores the user's other MCP servers for this session | ✅ |
| Per-session `args` reach the server → thread binding via `--thread <id>` works | ✅ |
| The server inherits the parent environment (an env var set on `claude` arrives in the MCP server) | ✅ |
| Tools are exposed as `mcp__<server>__<tool>`, e.g. `mcp__chorus__probe_get_context` | ✅ |
| MCP tools are **deferred**: the model first calls `ToolSearch` (`select:mcp__chorus__…`) and then the tool. Costs one extra step. | ✅ |
| Handshake: client sends `server/discover` first (we answer `-32601`, it falls back fine), then `initialize` with `protocolVersion: "2025-11-25"` | ✅ |
| `tools/call` carries `_meta["claudecode/toolUseId"]` → correlate MCP calls with transcript `tool_use` ids | ✅ |
| In the init event, `mcp_servers: [{name, status: "connected", source: "dynamic"}]` confirms the server loaded | ✅ |

## 4. Getting the chat session (structured data)

### 4a. Live stream (headless): `-p --output-format stream-json --verbose`

One JSON object per line. Event `type`s seen in the probe:

| `type` (`subtype`) | Use for Chorus |
|---|---|
| `system` (`init`) | `session_id`, `model`, `cwd`, `tools`, `mcp_servers`, `permissionMode`, `claude_code_version` |
| `system` (`status`, `post_turn_summary`) | progress / status (informational) |
| `stream_event` | raw API deltas (`message_start`, `content_block_delta`, …) for live typing |
| `assistant` | full assistant message: `message.content[]` blocks `text`, `thinking`, `tool_use{id,name,input}`; `message.usage` |
| `user` | tool results: `message.content[]` → `tool_result`; plus `tool_use_result` with e.g. `{stdout, stderr, interrupted}` for Bash |
| `rate_limit_event` | **limit detection**, see §6 |
| `result` (`success` / error) | end of turn: `result` text, `is_error`, `num_turns`, `usage`, `modelUsage`, `total_cost_usd`, `permission_denials`, `stop_reason`, `terminal_reason` |
| `active_goal`, `autocompact_state` | internal state (ignore, but don't crash on unknown types) |

Rule for the parser: **ignore unknown `type`s**. New ones appear between versions.

### 4b. Transcript file (works for interactive TUI sessions too)

- Path: `~/.claude/projects/<cwd-slug>/<session-id>.jsonl` ✅
  - `<cwd-slug>` = absolute cwd with every non-alphanumeric char replaced by `-`
    (e.g. `/tmp/chorus-probe-x` → `-tmp-chorus-probe-x`). ✅
- Record `type`s seen: `queue-operation`, `user`, `assistant`, `attachment`, `last-prompt`,
  `atis-latch`, `cost-state`. ✅
- `assistant` records carry `message.usage`; `cost-state` carries `totalCostUSD`, `modelUsage`,
  `totalLinesAdded/Removed`. ✅
- `user` records with tool results carry `toolUseResult` and `sourceToolAssistantUUID`. ✅
- Size: a one-line "got it" session wrote ~220 KB (mostly `attachment` records). Tail it, don't re-read it. ✅

### 4c. Hooks (live events from interactive sessions)

Injected per session with `--settings '{"hooks":{…}}'`, without touching user settings. ✅
The hook command receives JSON on stdin:

| Event | Fields seen |
|---|---|
| `SessionStart` | `session_id`, `transcript_path`, `cwd`, `source: "startup"` |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms`, `permission_mode`, `prompt_id` |
| `Stop` | `last_assistant_message`, `stop_hook_active`, `background_tasks` |

`transcript_path` in every hook payload is the easiest way to locate the transcript of an
interactive session. ✅

## 5. Tool usage

- Tool calls = `assistant` blocks of type `tool_use` (`name`, `input`, `id`); results = `user`
  `tool_result` blocks with the same `tool_use_id`. ✅
- **Artifact detection cannot rely on tool names.** Asked to create
  `.chorus/artifacts/probe/hello.md`, Claude used `Bash` (`mkdir -p … && printf … > file`), not
  `Write`. Chorus needs a file watcher on the artifact folder. ✅

## 6. Token usage, cost and limits

| Data | Where | Status |
|---|---|---|
| Per-message tokens | `assistant.message.usage`: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` | ✅ |
| Per-turn totals + cost | `result.usage`, `result.modelUsage[<model>]` (`inputTokens`, `outputTokens`, `costUSD`, `contextWindow`), `result.total_cost_usd` | ✅ |
| Plan limit status | `rate_limit_event.rate_limit_info`: `status` (`allowed`…), `resetsAt` (unix s), `unifiedWindows.five_hour.utilization` / `seven_day.utilization` (0–1) with their own `resetsAt` | ✅ (only the `allowed` state seen) |
| What a hit limit looks like | Not yet captured. Expect `status` ≠ `allowed` and/or `result.is_error` with `api_error_status`. Capture it when it happens. | ❓ |

`utilization` lets Chorus suggest a handoff **before** the limit is hit (e.g. at 90%).

## 7. Stopping

- Headless: process exits after the turn. Interactive: SIGINT (Ctrl+C) interrupts a turn. 📄
- Kill grace: SIGTERM, then SIGKILL after 10 s (probe implementation). ✅

## 8. Gotchas (read these when debugging)

1. **Environment leak from a parent Claude session.** If `chorus-cli` itself runs inside Claude
   Code (or the cloud), `CLAUDE_CODE_SESSION_ID` is inherited and the child `claude` reports the
   *parent's* session id in hooks. Always remove `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`,
   `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID` before spawning. ✅
2. `-p` skips the workspace trust dialog and silently ignores invalid settings files. 📄
3. MCP tools cost an extra `ToolSearch` step because they are deferred. ✅
4. The transcript schema is internal and changes between versions: parse defensively,
   key everything on `type`, keep the raw line.
