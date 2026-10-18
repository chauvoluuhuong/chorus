# R4 · Will agents save and use shared memory on their own?

| | |
|---|---|
| **Status** | ✅ measured 2026-10-18, three phrasings per CLI (claude 2.1.302 with `--model haiku`, codex 0.163.0, agy 1.4.2) · small sample, see limits |
| **Case** | `node tools/risk/run.ts memory-adoption` (`MEM_PAIRS=0,1,2`, 2 calls per CLI per phrasing) · evidence `fixtures/risks/memory-adoption/` |
| **Matters for** | the planned `remember` / `recall` / `list_memory` tools and the Memory screen ([ui-plan.md](../ui-plan.md) item 8, mockup "2-tier Shared Memory") |

**Question.** If Chorus offers memory tools and tells the agent about them (MCP server instructions for Claude/agy,
`developer_instructions` for Codex, exactly like the artifacts note), does the agent call `remember` when the user states a
lasting preference, and `recall` later in another project?

**How it was probed.** `tools/risk/memory-mcp.mjs` stands in for the future server. Chat A (folder A): "For later: in all my
projects I use pnpm, never npm, and two-space indentation. Just reply OK." Chat B (fresh folder, fresh session): "I am about to add
a dependency to this project. Which command should I run?" The prompts never mention tools. "Used memory" = `recall`/`list_memory`
called **and** the final answer says pnpm (the final assistant message only; raw output also contains words like `pnpm-lock.yaml`).

**Findings (3 phrasings × 3 CLIs, headless, 2026-10-18).** Phrasings: pnpm preference, commit messages in Vietnamese, deploy target Fly.io.

| CLI | saved on its own | recalled on its own | answer used the memory |
|---|---|---|---|
| claude 2.1.302 (haiku) | 3/3 | 1/3 | 1/3 |
| codex 0.163.0 | 1/3 | 1/3 (the one with nothing saved) | 0/3 |
| agy 1.4.2 | 3/3 | 2/3 | 2/3 |

Recall skipped is the common failure: for "write a commit message" every CLI answered from habit without checking memory.
**Codex was not blind**: [case `mcp-visibility`](../../tools/risk/cases/mcp-visibility.ts) asked each CLI to list the Chorus tools, and all three
named `remember`, `recall` and `list_memory`. Codex simply did not choose to call them.

**Consequence.** Memory that only helps when the agent decides to call a tool is unreliable (saving ~70%, using ~35%).
The design must not depend on agent initiative, least of all on Codex.

**Fix when needed (recommended order).**
1. **Inject, don't wait to be asked.** At chat start put a short digest of global and project memory into the channel already used for the artifacts note (MCP instructions for Claude/agy, `developer_instructions` for Codex; `launch.ts`). Keep it under ~300 tokens, newest/pinned first; `recall` stays for the long tail.
2. **Capture from transcripts, confirm in the UI.** Chorus already tails every transcript: detect candidate preferences ("always/never/I use…") after a turn and show them in the Memory screen as "Save?" instead of trusting `remember`.
3. Keep `remember` as a bonus path, with a clearer tool description ("call this when the user says always/never/prefer").
4. Re-probe with a stronger Claude model and with interactive sessions before quoting any adoption rate. (Tool visibility is settled: all three CLIs see the tools.)

**Limits of this probe.** n=3 per CLI (3 phrasings, 1 run each), Claude on the cheapest model, headless runs (interactive may differ), no conflicting or stale memories, no scale.

**Trigger to revisit.** Before building the memory tools; after any change to the instruction text; when a CLI version changes how MCP instructions are shown (Codex already hides them).
