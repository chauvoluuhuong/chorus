# Google Antigravity CLI (`agy`) integration

| | |
|---|---|
| **Status** | 🔴 Not verified: agy cannot be installed or logged in from the cloud container |
| **Evidence so far** | (a) stream-json events observed by the old Chorus prototype on the developer's Mac, (b) the official changelog (`google-antigravity/antigravity-cli`, latest seen 1.3.6), (c) community tools and guides |
| **Fixtures** | none yet |
| **To verify** | On the Mac: `node tools/probe/probe.mjs agy` |

Legend: 👀 observed by the old prototype on a real machine · 📄 official changelog/docs · 🌐 community source only · ❓ unknown.

Why the cloud can't test it: `antigravity.google` (installer and docs) doesn't resolve from the
container, there is no official npm package, and login is a Google account (or `GEMINI_API_KEY`).

---

## 1. Launching a session

| Need | How | Source |
|---|---|---|
| Interactive TUI | `agy` | 🌐 |
| Interactive with first prompt | `agy -i "<prompt>"` / `--prompt-interactive` (can't be combined with `--print`, exits 2) | 📄 |
| Headless, one turn | `agy -p "<prompt>"` (`--print` / `--prompt`) | 📄 |
| Structured output | `--output-format text\|json\|stream-json` | 📄 |
| Multi-turn over stdin | `--input-format stream-json` (needs `--output-format stream-json`), one JSON prompt per line: `{"event":"user","message":{"content":"…"}}` | 👀 📄 |
| Resume specific conversation | `--conversation <id>` | 🌐 |
| Resume latest | `-c` / `--continue` (falls back to the latest non-empty conversation) | 📄 |
| Model / effort | `--model <id>` (e.g. `gemini-3.8-flash-low`), `--effort low\|medium\|high`; honoured in `-p` only from 1.1.10 | 👀 🌐 |
| Permissions | `--dangerously-skip-permissions`, `--mode accept-edits\|plan` | 👀 🌐 |
| Timeout | `--print-timeout` (default unlimited since 1.2.6) | 📄 |
| Workspace | cwd is the workspace (1.2.16+); `--add-dir` for more | 🌐 |

**stdin gotcha:** `agy -p` reads stdin even when the prompt is given; leave stdin open and it
can block. Spawn with stdin closed. 🌐

## 2. Injecting the Chorus prompt envelope

- First user turn: `-i "<envelope>"` (interactive) or `-p` / stdin `user` event (headless). 📄
- Standing rules: `AGENTS.md` / `GEMINI.md` and rule files (workspace and `~/.gemini/config`,
  20k-token budget for rules). 📄 Writing rules into the user's repo is intrusive, so prefer the
  first turn.

## 3. MCP server wiring

| Fact | Source |
|---|---|
| Managed with `agy mcp add\|remove\|list\|enable\|disable`, which edit `mcp_config.json` | 📄 |
| Global config: `~/.gemini/config/mcp_config.json` | 🌐 |
| Workspace config: `.agents/mcp_config.json` (sources disagree) | 🌐 ❓ The probe writes this file to test it |
| **No per-session `--mcp-config` flag known** | ❓ Biggest open question. If workspace config doesn't work, we need `agy mcp add` with a unique name per thread, or a single server that learns the thread another way |
| Headless runs wait for MCP servers to load before the turn | 📄 |
| `_meta["antigravity/alwaysLoad"]` on a tool keeps it always loaded | 📄 |
| MCP calls with undeclared arguments are rejected (1.1.27+) | 📄 |

## 4. Getting the chat session

### Live stream (`--output-format stream-json`)

Seen by the old prototype (field names as it parsed them): 👀

| `event` | Fields used |
|---|---|
| `init` | `conversation_id`, `init.model` (official docs: also reports `permission_mode`) |
| `user` | echo of our input |
| `step_update` | `step_update.step_index`, `step_type` (`tool`, …), `tool_name` / `tool_info.name`, `tool_info.parameters` (`AbsolutePath`, `TargetFile`, `CommandLine`, …), `tool_info.output`, `state` (`ACTIVE` while running) |
| `result` | `response`, `usage {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}`, `num_turns`, status `SUCCESS`; `structured_output` with `--json-schema` | 🌐 |

Tool names seen: `view_file`, `write_to_file`, `replace_file_content`, `run_command`. 👀

### Files on disk

| What | Path | Source |
|---|---|---|
| Transcript | `~/.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` (+ `transcript_full.jsonl` when fields are truncated) | 🌐 |
| Conversation DB | `~/.gemini/antigravity-cli/conversations/*.db` or `…/cache/` (sources disagree) | 🌐 ❓ |
| IDE (not CLI) data | `~/.gemini/antigravity/` (the old prototype wrote reports to `brain/` here) | 👀 |

The probe snapshots all of `~/.gemini` before and after each run to settle these paths.

## 5. Errors, exit codes, limits

| Signal | Meaning | Source |
|---|---|---|
| exit `0` | success (also when `--print-timeout` expires: partial output + warning) | 📄 |
| exit `1` | bad `--agent`, invalid `--json-schema` | 📄 |
| exit `2` | `--print` combined with `--prompt-interactive` | 📄 |
| exit `3` | model/agent error during a headless run; stderr line `AGY_ERROR: {…, "retryable", "error_id"}` | 📄 |
| Quota exhausted | reported immediately (1.3.3+); expected as `RESOURCE_EXHAUSTED` in `AGY_ERROR` | 📄 🌐 not captured |
| Quota check without spending | `agy --output-format json -p /usage` (don't use `--disable-slash-commands`) | 🌐 |
| Denied actions | `denied_actions` in JSON output | 📄 |

## 6. ⚠️ Terms-of-service risk

Several threads on Google's developer forum ask whether a third-party app may orchestrate `agy`
headless mode on a personal subscription account. No official Google answer was found, and
users cite the Antigravity Additional Terms on third-party software access. **Get a clear answer
before selling a product that drives agy on users' subscription accounts.** `GEMINI_API_KEY`
billing may be the safer path.

## 7. Verification checklist (run on the Mac)

- [ ] `agy --version`, `agy --help`, `agy mcp --help` → paste into this doc
- [ ] `node tools/probe/probe.mjs agy` and commit `fixtures/agy/<version>/` after review
- [ ] Confirm `.agents/mcp_config.json` is picked up (mcp scenario passes); if not, find another per-session method
- [ ] Confirm transcript path and the `result` / `usage` field names
- [ ] Confirm `--conversation <id>` resume keeps the id (resume scenario)
- [ ] Capture one quota-exhausted run when it happens
