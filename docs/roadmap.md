# Roadmap (v2)

Each milestone ends with an **exit check that uses the real CLIs**. Nothing moves on until it
passes. See [testing.md](testing.md).

## M0 · Capability check *(in progress)*

Know exactly what each CLI offers before designing around it.

- [x] Probe tool (`tools/probe/`): hello, MCP, shell, artifact, resume scenarios
- [x] Claude Code verified, fixtures committed, [doc](integrations/claude-code.md)
- [x] Codex: flags + per-session MCP spawn verified ([doc](integrations/codex.md))
- [ ] Codex: probe on a logged-in machine, commit fixtures
- [ ] Agy: probe on the Mac, commit fixtures, settle per-session MCP (D2)
- [ ] Decide D1 (language)

**Exit:** all three integration docs are ✅ for: first prompt, per-session MCP, session id, resume,
live events, tool calls, token usage.

## M1 · core: store + events + adapters

- Store (SQLite WAL + `.chorus/threads/…` files), entities from [architecture §3](architecture.md#3-data-model)
- Normalized event model
- Adapters per CLI: build launch argv, parse stream lines, locate/tail transcript, detect limit signals
- L1 tests against every committed fixture

**Exit:** every fixture parses into the expected events; unknown events are kept, not fatal.

## M2 · chorus-mcp + harness

- Stdio MCP server with the v1 tools ([architecture §5](architecture.md#5-mcp-tools-v1)), bound by `--thread`
- `fake-agent` CLI built from fixture behaviour
- L2 tests: fake agent calls every tool, data lands in the store

**Exit (L3):** real Claude and Codex call `get_thread_context` and `checkpoint` through
chorus-mcp, and the data is in the store.

## M3 · chorus-cli: run, capture, artifacts

- `chorus-cli new`, `run <agent> [--thread]` (PTY passthrough, real TUI), `threads`, `show`
- Raw capture per run + live structured events (Claude hooks/transcript first)
- Artifact folder injected via envelope + file watcher; `chorus-cli artifacts --open`
- `chorus-cli doctor`, `chorus-cli trace`

**Exit (L3):** interactive Claude session in chorus-cli; its tool calls, token usage and an
artifact show up in `chorus-cli show` / `artifacts`.

## M4 · Manual handoff

- `chorus-cli handoff --to <agent>` with the note sources a→b→c ([architecture §6](architecture.md#6-handoff-flow))
- Envelope injection as first prompt for each CLI
- `npm run smoke` script for the Mac

**Exit (L3):** Claude → Codex → Agy → Claude on one thread; each agent continues the task
correctly and sees the previous artifacts.

## M5 · Limit-aware handoff

- Read limit signals (Claude `rate_limit_event` utilization, agy `/usage` + `AGY_ERROR`, Codex TBD)
- Suggest handoff before the limit (e.g. ≥ 90%) and when it hits; note built without the dead agent's help

**Exit (L3):** simulated limit in L2 + one real captured limit event per CLI handled.

## M6 · Ship chorus-cli

- Package (`npm i -g chorus-cli`), README, quick start, troubleshooting page from `doctor`
- Provider-terms check done (D4)

## M7 · Chorus desktop

- `chorus-cli serve` local API, desktop UI over it (threads, live run view, artifact panel, handoff button)
- Design reference: [archive/ui-mockup-v3.html](archive/ui-mockup-v3.html)
