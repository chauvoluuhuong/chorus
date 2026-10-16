# OpenAI Codex CLI (`codex`) integration

| | |
|---|---|
| **Status** | 🟡 Partly verified: flags and MCP spawning checked; no model turn yet (no login in the cloud container) |
| **Version tested** | `codex-cli 0.163.0` (npm `@openai/codex`) on Linux, 2026-10-16 |
| **Fixtures** | none yet |
| **To verify** | On a logged-in machine: `node tools/probe/probe.mjs codex` |

Legend: ✅ verified by running it · 📄 from `codex --help` / docs, not exercised · ❓ unknown.

---

## 1. Launching a session

| Need | How | Status |
|---|---|---|
| Interactive TUI with first prompt | `codex "<prompt>"` (positional `[PROMPT]`) | 📄 |
| Headless, one turn | `codex exec "<prompt>"` (alias `codex e`); prompt from stdin with `-` | 📄 |
| Structured output | `codex exec --json` prints events as JSONL | 📄 |
| Last message to a file | `codex exec -o <file>` | 📄 |
| Resume (headless) | `codex exec resume <SESSION_ID> "<prompt>"`, or `--last` | 📄 |
| Resume (interactive) | `codex resume [--last]`, `codex fork` | 📄 |
| Working dir | `-C <dir>`; outside a git repo needs `--skip-git-repo-check` | 📄 |
| Model | `-m <model>` | 📄 |
| Sandbox / approvals | `-s read-only\|workspace-write\|danger-full-access`, `-c approval_policy="never"`, `--dangerously-bypass-approvals-and-sandbox` | 📄 |
| Any config override | `-c key=value` (value parsed as TOML), dotted paths | ✅ |
| Separate config/auth/state dir | `CODEX_HOME=<dir>` | ✅ |
| Don't persist the session | `--ephemeral` | 📄 |

`codex exec` blocks without error when not logged in (we had to kill it). Check
`codex login status` first. ✅

## 2. Injecting the Chorus prompt envelope

- First user turn = positional prompt (TUI or `exec`). 📄
- Standing instructions: Codex reads `AGENTS.md` in the repo. ❓ Not checked if there is a CLI
  flag for extra instructions; a `-c` override may exist (look for `instructions` keys in
  `codex --help` / config docs during verification).

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
| Server environment: whether the parent env is inherited | ❓ Use argv for the thread id, don't rely on env |
| How tools are named to the model / whether MCP calls need approval in `exec` | ❓ |

## 4. Getting the chat session

| Source | What we know | Status |
|---|---|---|
| `exec --json` stdout | Event JSONL. Expected (from docs, unverified): `thread.started` with `thread_id`, `turn.started`, `item.started` / `item.completed` (items such as agent message, reasoning, command execution, file change, MCP tool call), `turn.completed` with `usage`, `turn.failed`, `error` | 📄 must capture |
| Session storage | A fresh `CODEX_HOME` contains `thread_history_*.sqlite` and `logs_*.sqlite` (+ `-wal`). The `migrate-rollouts` subcommand says older JSONL "rollout" files are **legacy**, so sessions are now in SQLite | ✅ files seen, ❓ schema |
| Session browser | `codex agents` (shared local app-server daemon) | 📄 |
| App server | `codex app-server` (experimental), a JSON-RPC API that may be the most stable way to read threads | 📄 worth evaluating |
| Hooks | Exist (`--dangerously-bypass-hook-trust`), require "hook trust" | 📄 |

## 5. Tool usage, tokens, limits

- Tool calls: expected as `item.*` events (`command_execution`, `file_change`, `mcp_tool_call`). 📄
- Tokens: expected in `turn.completed.usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`). 📄
- Plan limits: message format unknown ("usage limit reached… try again at …" is the
  commonly reported text). ❓ Capture when it happens.

## 6. Gotchas

1. Not logged in → `exec` hangs instead of failing. Run `codex login status` before spawning. ✅
2. With `CODEX_HOME` under `/tmp`, Codex warns it can't create PATH helper binaries; harmless. ✅
3. Storage moved from JSONL rollouts to SQLite; don't build on old blog posts that describe
   `~/.codex/sessions/**/rollout-*.jsonl` without checking the installed version. ✅ (inferred from CLI)

## 7. Verification checklist

- [ ] Run the probe on a logged-in machine and commit `fixtures/codex/<version>/`
- [ ] Record the real `--json` event names and the `usage` fields
- [ ] Find where the thread id appears and confirm `exec resume <id>` keeps it
- [ ] Check MCP tool naming and approval behaviour in `exec`
- [ ] Find the instructions flag or config key for the envelope
- [ ] Inspect the `thread_history_*.sqlite` schema (or use `app-server`) for interactive sessions
