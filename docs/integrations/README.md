# AI CLI integrations

Chorus depends on three external CLIs it doesn't control. Every fact the code relies on
(flags, event names, file paths, field names) lives in these documents with its **status** and the
**version it was checked against**. When something breaks after a CLI update, start here: re-run the
probe, diff the new fixtures against the committed ones, and update the doc.

| CLI | Doc | Status | Version checked |
|---|---|---|---|
| Claude Code | [claude-code.md](claude-code.md) | ✅ verified (all probe scenarios pass) | 2.1.301 |
| OpenAI Codex | [codex.md](codex.md) | 🟡 flags + MCP spawn verified, no model turn yet | 0.163.0 |
| Antigravity | [antigravity-agy.md](antigravity-agy.md) | 🔴 unverified (needs the Mac) | n/a (changelog 1.3.6) |

## Capability matrix

What Chorus needs from each CLI, and how each provides it.

| Need | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Start with a first prompt (inject envelope) | ✅ `claude "<p>"` / `-p` | 📄 `codex "<p>"` / `exec` | 📄 `agy -i "<p>"` / `-p` |
| Standing instructions | 📄 `--append-system-prompt` | ❓ (`AGENTS.md`) | 📄 rules / `AGENTS.md` |
| Per-session MCP server (thread binding) | ✅ `--mcp-config '<json>'` + `--strict-mcp-config` | ✅ `-c mcp_servers.chorus.*` | ❓ workspace `.agents/mcp_config.json`? |
| Choose / learn session id | ✅ `--session-id <uuid>` (we choose) | 📄 `thread_id` in `--json` | 👀 `conversation_id` in `init` |
| Resume | ✅ `--resume <id>` | 📄 `exec resume <id>` | 🌐 `--conversation <id>` |
| Live structured events | ✅ `--output-format stream-json --verbose` | 📄 `exec --json` | 👀 `--output-format stream-json` |
| Transcript of interactive sessions | ✅ `~/.claude/projects/<slug>/<id>.jsonl` | ✅ SQLite in `CODEX_HOME` (schema ❓) | 🌐 `…/brain/<id>/.system_generated/logs/transcript.jsonl` |
| Live hooks for interactive sessions | ✅ `--settings` hooks | 📄 hooks (need trust) | 📄 `hooks.json` |
| Tool calls | ✅ `tool_use` / `tool_result` | 📄 `item.*` | 👀 `step_update` |
| Token usage | ✅ `usage`, `modelUsage`, `total_cost_usd` | 📄 `turn.completed.usage` | 🌐 `result.usage` |
| Plan-limit signal | ✅ `rate_limit_event` (utilization + resetsAt) | ❓ | 📄 `AGY_ERROR` / `/usage` |

Legend: ✅ verified by running it · 👀 observed by the old prototype · 📄 official help/docs · 🌐 community source · ❓ unknown.

## The probe

`tools/probe/probe.mjs` runs a CLI through five scenarios (`hello`, `mcp`, `shell`, `artifact`,
`resume`) in an empty temp workspace with a tiny logging MCP server, and saves everything to
`fixtures/<cli>/<version>/<scenario>/`:

| File | Content |
|---|---|
| `command.json` | exact argv and cwd used |
| `stdout*.jsonl`, `stderr*.txt` | raw CLI output |
| `mcp-log.jsonl` | every JSON-RPC message between the CLI and our MCP server |
| `home-changes.json` + `home-changes/` | files the CLI created/changed in its home dir (transcripts, DBs) |
| `workspace-files.json` | files left in the workspace (artifact check) |
| `result.json` | checks, exit codes, durations, session ids, event types |

Emails, account ids and the home path are redacted, but review fixtures before committing.

```bash
node tools/probe/probe.mjs claude --model haiku     # ~2 cents
node tools/probe/probe.mjs codex
node tools/probe/probe.mjs agy
node tools/probe/probe.mjs agy --scenario mcp       # one scenario
```

## Rules for adapter code

1. Every parser has a unit test that runs against a committed fixture.
2. Unknown event types and fields are ignored (and kept raw), never fatal.
3. Each run stores the CLI version; the adapter warns when the version is newer than the
   last verified one.
4. Never edit the user's global CLI config; use per-session flags. Where a CLI has none
   (agy?), document the workaround here first.
5. Spawn with stdin closed for headless runs and with the parent-session env vars scrubbed
   (see Claude gotcha #1).
