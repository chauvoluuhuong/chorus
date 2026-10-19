# R5 · Capture gaps: errors, file changes, reasoning

| | |
|---|---|
| **Status** | ✅ error and file-change shapes captured 2026-10-18 (claude 2.1.302, codex 0.163.0, agy 1.4.2) · ✅ Codex `reasoning` is mostly encrypted, not capturable · ❓ plan-limit hit: see [plan-limit](plan-limit.md) |
| **Case** | `node tools/risk/run.ts capture-errors` (4 real calls, three of them fail before any model tokens) · evidence `fixtures/risks/capture-errors/` |
| **Matters for** | CLAUDE.md "Known gaps": today's adapters (`src/core/adapters/*`) show a failed run as an empty or normal-looking thread |

**How it was probed.** Headless run with a model name that does not exist, per CLI; plus a Codex run that must create a file with a patch edit.
Each raw stdout is kept and also fed to today's `parseStream` to see what the app would store.

**Findings.**

| Case | What the CLI emits | What the adapter stores today |
|---|---|---|
| Claude, bad model (exit 1) | a synthetic `assistant` message (`model:"<synthetic>"`, text "There's an issue with the selected model…") then `result` with `is_error:true`, `api_error_status:404`, `subtype:"success"` | **1 normal assistant turn**; the error looks like an answer |
| Codex, bad model (exit 1) | `item.completed` of type `error` (a *warning*: "Model metadata … not found"), then `error` and `turn.failed` (`error.message` is a JSON string with `status:400`) | **0 turns**, error invisible |
| agy, bad model (exit 1) | `{"event":"result","result":{"status":"ERROR","error":"invalid model selection … Available models: …"}}` (also on stderr) | **0 turns**, error invisible |
| Codex, patch edit (exit 0, file created) | `item.started`/`item.completed` of type `file_change` with `changes:[{path,kind:"add"}]`, `status` | **0 tool calls**: file changes never appear in the Files view |
| Codex reasoning | **no `reasoning` item** in the headless stream even with `model_reasoning_summary="detailed"`. The interactive rollout has `response_item` of type `reasoning`, but `summary` is `[]` with only `encrypted_content` in 22 of 24 rollouts on this Mac (2 had a summary) | n/a |

Note: Claude's `subtype:"success"` with `is_error:true` means `subtype` alone must never be trusted.

**Fix when needed.**
1. Add `error?: {kind: 'model'|'auth'|'quota'|'unknown', message: string, status?: number}` to `Session` (`src/core/types.ts`); thread state `failed`, shown in the sidebar and in `get_handoff_context` ("last run failed: …").
2. Claude: treat `result.is_error` as the error and drop the `<synthetic>` assistant turn. Codex: `turn.failed` / top-level `error` (parse the JSON string), ignore warning-type `item error`. agy: `result.status === "ERROR"`.
3. Codex `file_change` → `ToolCall{tool:'file_change', target: path, status}` (one per change; `kind` add/update/delete in `result`).
4. Reasoning: **not worth capturing**: it is encrypted or empty almost always. Show nothing, and record only that a reasoning step happened (count) if the UI wants a "thinking" indicator. Revisit only if a CLI starts exposing summaries by default.
5. Commit the raw captures as L1 fixtures (`fixtures/<cli>/<version>/error-*`) and add contract tests; the files in `fixtures/risks/capture-errors/` are the starting point (already redacted).

**Trigger to revisit.** Before the UI shows run failures or the Files view claims to list every change; any CLI update that changes event names.

**Not covered.** Auth expiry / logged-out messages, network failure mid-run, rate-limit 429 (see plan-limit), agy file changes.
