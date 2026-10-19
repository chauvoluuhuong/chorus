# Product: goal, value, market

## Goal and definition of success

- **Price:** $5, one-time, lifetime license.
- **Success:** about **5,000 buyers** (≈ $25,000 gross).
- **Selling window:** most sales are expected in the first **1–3 months after launch**, while the
  product is new and talked about.
- **Build time is not the constraint.** We build as long as needed; what matters is that the
  product is good enough to sell when it launches.
- **We accept that Chorus will be copied.** With AI, someone can rebuild the features in days. We
  don't try to prevent that. We aim to make something clearly valuable, make it a trend, and sell
  during the window.

## What Chorus is for

**Make it easy for developers to work across AI coding CLIs** (Claude Code, Codex, Antigravity).

Today each CLI is its own island. Moving work between them means copy-pasting context by hand,
and the plans, mockups and reports each agent produced end up scattered. Chorus removes that
friction:

| Value | What the developer gets |
|---|---|
| **Handoff with shared context** | Start the next agent and it already knows what was asked, decided and changed. Works even when the first agent has hit its plan limit. |
| **All threads in one place** | Every agent session in a sidebar like tabs; switch instantly; see which one is waiting for you. |
| **Visibility** | Tool calls, approvals (including from background threads) and artifacts, visible while you keep working in the real CLI. |
| **One set of skills** | A skill written once is available to, and used by, every CLI. |

Limit warnings are one feature inside handoff, not the pitch.

## Pricing math

| | Per sale | 5,000 sales |
|---|---|---|
| Price | $5.00 | $25,000 |
| Payment platform fees (Polar ≈ 4% + $0.40, Lemon Squeezy ≈ 5% + $0.50; check current rates) | ≈ –$0.65 to –$0.75 | ≈ –$3,500 |
| **Net** | ≈ $4.30 | **≈ $21,500** |
| Yearly costs: Apple Developer $99; Windows signing ≈ $120/year if Windows ships | | ≈ –$220/year |

The payment platform is the merchant of record and handles sales tax worldwide.

What $5 lifetime implies for the product:
- **No per-user support.** `chorus doctor`, clear docs and good error messages must let users fix
  problems themselves.
- **Simple licensing.** A license key checked against the payment platform and stored locally. No
  heavy anti-piracy work.
- **Updates must be cheap to make.** The CLIs change every few weeks; the probe and fixture tests
  (see [testing.md](testing.md)) are what keep maintenance affordable.

## Competitors (researched 2026-10)

Every individual feature exists somewhere; no tool found combines them around working across CLIs.

| Area | Existing tools |
|---|---|
| Run several AI CLIs side by side | Parallel Code (Claude Code, Codex, Gemini, Antigravity, Copilot; git worktrees), Conductor (Mac app, paid), Claude Squad (tmux, open source), Vibe Kanban (company shut down 2026, community-maintained), Crystal → Nimbalyst |
| Handoff between CLIs | cli-handoff (Claude ↔ Codex, MCP + skills), conversation-handoff-mcp, authsec-bridge (converts session files), Codex session-transfer skill. Small community projects; most need a manual export or the outgoing agent's help. |
| Skills sync | skillport, Skills Manager (50+ agents), symlinks to `~/.agents/skills` |
| Session browsing | Agent Sessions, agys, agy-reader |

Where Chorus differs:
- Built for **continuing one piece of work across agents**, not for running many separate tasks
  in parallel.
- **Handoff without the old agent's help**: everything is recorded as you work, so it works after
  a limit hit.
- **Everything in one place**: threads, handoff, artifacts, approvals, skills.
- **Vendor-neutral**: Anthropic, OpenAI and Google each have no reason to help users move to a
  competitor.
- **Kept working with each CLI release**, with a public compatibility table.

## Launch and selling

- Target: developers who use two or more AI coding CLIs.
- Channels: r/ClaudeAI, r/ChatGPTCoding, Hacker News (Show HN), X, Product Hunt, YouTube demos.
- The demo that sells it: one agent hits its limit or gets stuck → one key → another agent opens
  and says "here's what I picked up" → keeps going. Plus the sidebar with several agents working.
- Build a waitlist before launch from the mockup and short clips.
- Rough funnel: cheap tools convert around 1–3% of visitors, so 5,000 buyers needs on the order of
  200,000–500,000 people seeing it. That takes a viral moment (top of HN / Reddit / X), not only a
  launch post.
- Option to consider: a free tier (e.g. limited handoffs per day) with $5 unlocking everything,
  for word of mouth. See [archive/open-vs-closed-core.md](archive/open-vs-closed-core.md).

## Risks

| Risk | Mitigation |
|---|---|
| Copies appear quickly | Accepted. Be first, be the most talked about, keep it working. |
| CLI updates break Chorus | Probe + fixture tests per CLI version; `chorus doctor` warns on unverified versions. |
| Antigravity terms of service (orchestrating agy on a personal subscription) unclear | Get an answer before selling with agy; can launch with Claude + Codex. See [integrations/antigravity-agy.md](integrations/antigravity-agy.md). |
| Too few buyers | Waitlist and clips before launch show demand early. |
