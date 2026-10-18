# R8 · Plan-limit hit

| | |
|---|---|
| **Status** | ❓ not captured: a limit cannot be forced without burning real quota; it is on the CLAUDE.md known-gaps list |
| **Case** | manual · capture recipe below |
| **Matters for** | the limit warning box and the "plan meter" tasks (P4.9), `usage.limit_*` columns |

**What exists.** `fake-agent` can simulate a limit hit (docs/testing.md) and the UI reads `limit_status`; nothing is derived from a **real** limit message of Claude, Codex or agy, and Claude reports plan usage only in the headless stream.

**Capture recipe (do this when a limit happens naturally, or on a test account near its cap).**
1. Do not close the session. Copy the raw transcript (`~/.claude/projects/…/<id>.jsonl`, `~/.codex/sessions/…/rollout-*.jsonl`, `~/.gemini/antigravity-cli/brain/<id>/…/transcript.jsonl`) and a PTY screen dump of the TUI (`tools/probe/pty-probe.mjs`).
2. Note: exact message text, reset time wording, whether the CLI exits, waits or stays interactive, and the exit code in headless mode.
3. Save under `fixtures/<cli>/<version>/limit/`, redact, then add the adapter test.
4. Optional automation: Chorus could save the last 200 transcript lines whenever a turn ends with an error-looking assistant message, so the fixture comes free.

**Fix when needed.** Parse the real message into `LimitReading` (status, resetsAt) and `Session.error.kind = 'quota'` (see [capture-errors](capture-errors.md)); show it in the sidebar row and the status line.

**Trigger to revisit.** The first real limit hit (any CLI) — treat it as a probe opportunity.
