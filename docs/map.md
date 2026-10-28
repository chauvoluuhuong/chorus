# Docs map

Read in this order: [`AGENTS.md`](../AGENTS.md) (decisions, workflow, rules) → this file → the docs of the area you are
touching → its plan and failures. Every fact has one home; other files link to it instead of repeating it.

| Folder / file | What's inside | The skill's name for it |
|---|---|---|
| [`architecture.md`](architecture.md) | The build plan (5 phases), components, data stored, MCP tools, handoff, threads | features (the whole app) |
| [`roadmap.md`](roadmap.md) | Progress per phase, technical debt TD-1.. | status |
| [`phase4.md`](phase4.md), [`phase5.md`](phase5.md), [`doctor.md`](doctor.md), [`notifications.md`](notifications.md), [`chorus-core.md`](chorus-core.md), [`ui-plan.md`](ui-plan.md) | Plans and how each part works, written before this layout | plans + features |
| `plans/<yyyy-mm-dd>-<slug>.md` | The agreed approach of each new feature or fix (from 2026-10-28) | plans |
| `features/<slug>.md` | What exists and how it works, for features built from now on | features |
| [`integrations/`](integrations/) | Verified facts per CLI and the tested versions ([`versions.md`](integrations/versions.md)); lives in chorus-core | integrations |
| [`testing.md`](testing.md) | Test layers, what runs where, how to run the e2e with the real CLIs | harness |
| [`proof/`](proof/) | Committed e2e proof per phase (screenshots, reports); per-branch proof is in `.chorus/proof/<branch>/` (gitignored) | harness/evidence |
| [`risks/`](risks/) | One page per probed risk: finding, fix when needed, trigger | learnings |
| `failures/<yyyy-mm-dd>-<slug>.md` | What broke, why, how to avoid it (linked from its GitHub issue) | failures |
| `learnings/<topic>.md` | Other lessons: platform limits, CLI quirks, tool tricks (a CLI fact goes in `integrations/`) | learnings |
| `releases/vX.Y.Z.md` | Production releases from 1.1.0: the preview each one rests on, changelog, evidence | releases |
| [`mockups/`](mockups/), [`archive/`](archive/) | The CLI app mockup; v1 material and UI mockup v3 (reference only) | ideas |

Folders without a link are created by the first file that needs them. Older docs stay where they are; move one only when you
rewrite it.
