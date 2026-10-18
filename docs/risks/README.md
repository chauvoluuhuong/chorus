# Risk harness: probe the risks first, fix them when needed

Before Phase 4.5 / 5 we probe each known risk with the real CLIs (or a real local stress), record what happens, and
write the case down: what was measured, what breaks, **what the fix would be, and what should trigger it**. Nothing here
changes product code. A fix gets built only when its trigger fires (or when a phase needs it).

```bash
node tools/risk/run.ts free      # no model calls: store-concurrency, terminal-protocols, approval-drift
node tools/risk/run.ts cheap     # a few real model calls: memory-adoption, mcp-visibility, capture-errors, session-race, agy-thread-id
node tools/risk/run.ts <case> [--agents claude,codex,agy]
```

Evidence goes to `fixtures/risks/<case>/<timestamp>/` (`result.json` + raw captures). Raw output is redacted by
`tools/risk/lib.ts` (home path, user name, e-mails; Claude's `system` init events list the user's own skills, so they
are stubbed). Review before committing (CLAUDE.md rule 6). Runs use a temp workspace, per-session flags only (rule 4),
closed stdin and a clean env (rule 5). agy has a small plan quota: pass `--agents claude,codex` to skip it.

## Environment

| Piece | What |
|---|---|
| Runner | `tools/risk/run.ts` (Node 22+, no build step), cases in `tools/risk/cases/*.ts`, each a `Case {id, title, cost, run(ctx)}` |
| Real CLIs | the ones on `PATH` (claude 2.1.302, codex 0.163.0, agy 1.4.2 on the first run); a missing CLI is a SKIP |
| Stand-in server | `tools/risk/memory-mcp.mjs`: `remember` / `recall` / `list_memory`, attached the way Chorus attaches its own server |
| Result states | `pass` (no problem found), `risk` (measured, needs a decision later), `fail`, `skip`, `unknown`; `manual` cases cannot run here |

To add a case: one file in `tools/risk/cases/`, one doc here with the sections below.

## Cases (first run 2026-10-18)

| Case | Doc | Cost | Result | Fix needed when |
|---|---|---|---|---|
| R1 shared store under load | [store-concurrency](store-concurrency.md) | free | ✅ pass | never for the move; revisit at 50+ live threads |
| R2 mouse and kitty keyboard | [terminal-protocols](terminal-protocols.md) | free | ⚠️ risk | Codex mouse / modified keys misbehave in a thread |
| R3 approval prompt drift | [approval-drift](approval-drift.md) | free | ✅ resolved for current versions | any CLI update (rerun the case) |
| R4 memory adoption | [memory-adoption](memory-adoption.md) | cheap | ⚠️ risk (save 7/9, use 3/9) | **before** building the Memory feature: inject a digest, don't rely on `recall` |
| R5 capture gaps | [capture-errors](capture-errors.md) | cheap | ⚠️ risk | before the UI shows errors or file changes |
| R6 same-second session matching | [session-race](session-race.md) | cheap | ⚠️ risk, fixes found (Codex: thread id in rollout; agy: `--log-file`) | before shipping Codex/agy multi-thread in one folder |
| R7 Windows | [windows](windows.md) | manual | ❓ unknown | before any Windows build |
| R8 plan-limit hit | [plan-limit](plan-limit.md) | manual | ❓ unknown | when one happens naturally; capture then |

Each case doc has: **Question · Status · How it was probed · Findings · Fix when needed · Trigger to revisit**.
