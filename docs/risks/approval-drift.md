# R3 · Approval prompt drift

| | |
|---|---|
| **Status** | ✅ resolved 2026-10-18: Claude 2.1.302 prompt re-captured (`fixtures/claude/2.1.302/approval-ask-manual-enter/`), detector accepts it; codex 0.163.0 and agy 1.4.2 already had fixtures. The case still flags any future version without one |
| **Case** | `node tools/risk/run.ts approval-drift` (free: compares installed `--version` with `fixtures/<cli>/*/approval*`) |
| **Matters for** | the approval cards: the detector reads prompt wording from the virtual screen ([integrations/approvals.md](../integrations/approvals.md) gotcha 4) |

**Findings.** On first run Claude 2.1.302 had no prompt fixture. `approval-probe.mjs claude ask --manual --keys '["\r"]' --tag manual-enter` (new `--manual` flag: pins manual mode in the probe's own temp folder only) shows the same wording as 2.1.284 (`Do you want to proceed?` / `1. Yes` / `2. No`), Enter approved (file created), and `detectApproval('claude', …)` returns the card with `approve=\r`, `deny=Esc`. Fixtures with prompt screens exist for claude 2.1.284, codex 0.163.0, agy 1.4.0 and 1.4.2. The installed Claude is 2.1.302, so its prompts are unchecked on this version, and 2.1.302 starts in **auto mode** (gotcha 0), which rarely shows prompts at all. Codex/agy approvals were also run end to end (`npm run proof`, `npm run proof:agy`), so the remaining exposure is wording changes in a new CLI version.

**Fix when needed.**
1. Refresh the fixture: `node tools/probe/approval-probe.mjs claude ask --nohook --keys '["\r"]' --tag enter` (and `deny` with Esc), commit `prompt-screen.txt`, run `npm test` (the detector tests in `test/app/approval.test.ts` show what moved).
2. If the wording changed, update the question/option patterns in `src/app/approval.ts`, never loosen them to plain text matching (prose that mentions the question must not match).
3. Make this case part of `npm run proof` preflight so a new CLI version is flagged before a long run.

**Trigger to revisit.** Any `claude`, `codex` or `agy` update; the first time a card fails to appear; the user reports an approval stuck in the thread's own screen.

**Not covered.** Whether auto mode hides approvals the user expects (Chorus does not change the user's mode, rule 4).
