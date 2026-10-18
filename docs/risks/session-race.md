# R6 · Two threads start in the same second in one folder

| | |
|---|---|
| **Status** | ✅ reproduced for Codex 2026-10-18 (codex 0.163.0, 2 trials) · ❓ agy not run (small quota); Claude is not affected (Chorus chooses its session id) |
| **Case** | `node tools/risk/run.ts session-race` (4 real calls) · evidence `fixtures/risks/session-race/` |
| **Matters for** | `src/core/discover.ts`: Codex and agy pick their own session id, so Chorus finds a new transcript by creation time (`newTranscripts`) and cwd (`codexCwd`) |

**How it was probed.** Two `codex exec` started together in the same folder with different marker words; then `newTranscripts` + `codexCwd` as the app does.

**Findings.** Both rollout files were found, **but their order of creation did not match launch order in 2 of 2 trials** (the second launched was born first; gaps 20 ms and 96 ms), and both share the same `cwd`. Matching "oldest unclaimed file ↔ oldest waiting thread" would swap the two threads' transcripts: each thread would show the other's chat.

**Found while checking:** the Codex rollout's developer message contains the line `This chat is Chorus thread t_xxxxxxxx` (from `artifactNote`), verified in existing rollouts under `~/.codex/sessions/`. That is a deterministic match key that discovery does not use yet.

**Fix when needed.**
1. Codex: read the rollout head and match the thread id from the `developer_instructions` text (fall back to cwd + birth order only if absent). Add an L1 test with two real rollouts from `fixtures/risks/session-race/` style data.
2. agy: no cwd in the transcript. Check whether the first user message or the `.agents/mcp_config.json`-attached server leaves the thread id anywhere in `brain/<id>/` (probe once, a single call); else serialize agy launches (wait until the previous thread's transcript is claimed, ~1 s) and document it.
3. Always: never claim a transcript already claimed; if two candidates remain ambiguous, leave both threads "unlinked" and retry on the next scan instead of guessing.

**Trigger to revisit.** Before advertising multiple Codex/agy chats in one project; the first report of a chat showing another chat's turns.
