# R1 · Shared store under many writer processes

| | |
|---|---|
| **Status** | ✅ verified 2026-10-18, macOS (Darwin 27), Node 26.10, `node:sqlite` |
| **Case** | `node tools/risk/run.ts store-concurrency` · evidence `fixtures/risks/store-concurrency/` |
| **Matters for** | moving the store to `~/.chorus/chorus.db` ([ui-plan.md](../ui-plan.md) item 8): the app, every thread's tailer and every agent's own `chorus mcp` process then write one file |

**Question.** Does one SQLite file (WAL, `busy_timeout=5000`, as `Store` sets it) survive many processes writing at once?

**How it was probed.** 4, 12 and 24 worker processes, each opening `Store` on the same folder and doing 150 rounds of the real
write path (`recordSession` transaction growing 1..150 turns + a tool call + usage, `logMcpCall`, `listThreads`).

**Findings.**

| Writers | crashed | `database is locked` | lost writes | worst single write |
|---|---|---|---|---|
| 4 | 0 | 0 | 0 | 152 ms |
| 12 | 0 | 0 | 0 | 347 ms |
| 24 | 0 | 0 | 0 | 992 ms |

No lost or failed writes. Latency grows with writers because `recordSession` rewrites every turn row each time (`INSERT OR REPLACE`
of the whole session); it is the part to watch, not locking.

**Fix when needed.** If a tailer write ever exceeds ~1 s in real use: make `recordSession` write only turns above the stored
count (the code already deletes extra rows; inserts could skip unchanged `seq`), and batch tailer writes per 250 ms.
Per-project files stay an option (what exists today) if the global file ever misbehaves.

**Trigger to revisit.** More than ~20 simultaneously live threads; a network or iCloud-synced home folder (WAL needs a local
disk); Windows (R7).

**Not covered.** Network filesystems, Windows file locking, a crash mid-transaction (WAL should recover; not killed on purpose here).
