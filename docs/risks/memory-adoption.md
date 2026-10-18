# R4 · Will agents save and use shared memory on their own?

| | |
|---|---|
| **Status** | ✅ measured 2026-10-18, one run per CLI (claude 2.1.302 with `--model haiku`, codex 0.163.0, agy 1.4.2) · small sample, see limits |
| **Case** | `node tools/risk/run.ts memory-adoption` (6 real calls) · evidence `fixtures/risks/memory-adoption/` |
| **Matters for** | the planned `remember` / `recall` / `list_memory` tools and the Memory screen ([ui-plan.md](../ui-plan.md) item 8, mockup "2-tier Shared Memory") |

**Question.** If Chorus offers memory tools and tells the agent about them (MCP server instructions for Claude/agy,
`developer_instructions` for Codex, exactly like the artifacts note), does the agent call `remember` when the user states a
lasting preference, and `recall` later in another project?

**How it was probed.** `tools/risk/memory-mcp.mjs` stands in for the future server. Chat A (folder A): "For later: in all my
projects I use pnpm, never npm, and two-space indentation. Just reply OK." Chat B (fresh folder, fresh session): "I am about to add
a dependency to this project. Which command should I run?" The prompts never mention tools. "Used memory" = `recall`/`list_memory`
called **and** the final answer says pnpm (the final assistant message only; raw output also contains words like `pnpm-lock.yaml`).

**Findings.**

| CLI | `remember` in A | `recall` in B | answer in B |
|---|---|---|---|
| claude (haiku) | ✅ saved "use pnpm, never npm, 2-space" | ❌ none | listed npm/pnpm/yarn as options: **did not know** |
| codex | ❌ no tool call at all | ❌ none | "no manifest, tell me the ecosystem": **did not know** |
| agy | ✅ | ✅ | "Based on your preference to use pnpm…": **used memory** |

Writing on its own works for 2 of 3; reading on its own works for 1 of 3. Why Codex made no call is **unverified**: the run shows no
MCP error, but the tool list the model saw was not captured.

**Consequence.** Memory that only helps when the agent decides to call a tool is unreliable. The design must not depend on
`recall` initiative.

**Fix when needed (recommended order).**
1. **Inject, don't wait to be asked.** At chat start put a short digest of global and project memory into the channel already used for the artifacts note (MCP instructions for Claude/agy, `developer_instructions` for Codex; `launch.ts`). Keep it under ~300 tokens, newest/pinned first; `recall` stays for the long tail.
2. **Capture from transcripts, confirm in the UI.** Chorus already tails every transcript: detect candidate preferences ("always/never/I use…") after a turn and show them in the Memory screen as "Save?" instead of trusting `remember`.
3. Keep `remember` as a bonus path, with a clearer tool description ("call this when the user says always/never/prefer").
4. Re-probe with ≥5 phrasings per CLI and a stronger model for Claude before claiming any adoption rate; verify Codex really lists the tools (add a case that asks "which tools do you have from Chorus?").

**Limits of this probe.** n=1 per CLI, one phrasing, Claude on the cheapest model, headless runs (interactive may differ), no conflicting or stale memories, no scale.

**Trigger to revisit.** Before building the memory tools; after any change to the instruction text; when a CLI version changes how MCP instructions are shown (Codex already hides them).
