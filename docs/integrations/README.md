# AI CLI integrations

Chorus depends on three external CLIs it doesn't control. Every fact the code relies on
(flags, event names, file paths, field names) lives in these documents with its **status** and the
**version it was checked against**. When something breaks after a CLI update, start here: re-run the
probe, diff the new fixtures against the committed ones, and update the doc.

| CLI | Doc | Status | Version checked |
|---|---|---|---|
| Claude Code | [claude-code.md](claude-code.md) | ✅ headless + interactive (hooks, transcript tail) verified | 2.1.301 (cloud), 2.1.284 (Mac) |
| OpenAI Codex | [codex.md](codex.md) | ✅ headless + interactive verified | 0.163.0 |
| Antigravity | [antigravity-agy.md](antigravity-agy.md) | ✅ headless + interactive verified | 1.4.0 |
| Skills (all three) | [skills.md](skills.md) | ✅ all three verified | see doc |
| Approvals (all three) | [approvals.md](approvals.md) | ✅ keystrokes on the agent's prompt; hooks only deny | see doc |
| Effort (all three) | [effort.md](effort.md) | ✅ `--effort` (Claude, agy), `-c model_reasoning_effort` (Codex) | see doc |

Which **versions** of each CLI were tested end to end, with the verdict and the evidence per version: [versions.md](versions.md)
(`tools/probe/matrix.mjs`).

## Capability matrix

What Chorus needs from each CLI, and how each provides it.

| Need | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Start with a first prompt (inject envelope) | ✅ `claude "<p>"` / `-p` | 📄 `codex "<p>"` / `exec` | 📄 `agy -i "<p>"` / `-p` |
| Standing instructions | 📄 `--append-system-prompt` | 📄 `AGENTS.md` (no flag) | 📄 rules / `AGENTS.md` |
| Per-session MCP server (thread binding) | ✅ `--mcp-config '<json>'` + `--strict-mcp-config` | ✅ `-c mcp_servers.chorus.*` + `default_tools_approval_mode="approve"` | ✅ workspace `.agents/mcp_config.json` |
| Choose / learn session id | ✅ `--session-id <uuid>` (we choose) | ✅ `thread_id` in `--json` | ✅ `conversation_id` in `init` |
| Resume | ✅ `--resume <id>` | ✅ `exec resume <id>` | ✅ `--conversation <id>` |
| Live structured events | ✅ `--output-format stream-json --verbose` | ✅ `exec --json` | ✅ `--output-format stream-json` |
| Transcript of interactive sessions | ✅ `~/.claude/projects/<slug>/<id>.jsonl` | ✅ `~/.codex/sessions/Y/M/D/rollout-*-<id>.jsonl` (tail works live) | ✅ `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` (tail works live) |
| Live hooks for interactive sessions | ✅ `--settings` hooks | 📄 hooks (need trust) | 📄 `hooks.json` |
| Tool calls | ✅ `tool_use` / `tool_result` | ✅ `item.*` (`command_execution`, `mcp_tool_call`) | ✅ `step_update` (`step_type: tool`) |
| Token usage | ✅ `usage`, `modelUsage`, `total_cost_usd` | ✅ `turn.completed.usage` | ✅ `result.usage`, per-step `usage` |
| Plan-limit signal | ✅ `rate_limit_event` (utilization + resetsAt) | ✅ rollout `token_count.rate_limits.primary.used_percent` (hit behaviour ❓) | 📄 `AGY_ERROR` / `/usage` |
| Project skills folder | ✅ `.claude/skills` only | ✅ `.agents/skills`, `.codex/skills` | ✅ `.agents/skills` |

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

## Other probes

| Tool | Purpose |
|---|---|
| `tools/probe/pty-probe.mjs <cli>` | Starts the real TUI in a PTY, answers the trust prompt, and records whether the transcript is readable while it runs (Claude: also hook events) |
| `tools/probe/skills-probe.mjs [cli…]` | Writes marker skills into candidate folders and checks which the CLI uses (results: `fixtures/skills/`) |

## Rules for adapter code

1. Every parser has a unit test that runs against a committed fixture.
2. Unknown event types and fields are ignored (and kept raw), never fatal.
3. Each run stores the CLI version; the adapter warns when the version is newer than the
   last verified one.
4. Never edit the user's global CLI config; use per-session flags. Where a CLI has none
   (agy?), document the workaround here first.
5. Spawn with stdin closed for headless runs and with the parent-session env vars scrubbed
   (see Claude gotcha #1).
