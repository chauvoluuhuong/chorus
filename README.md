# 🎵 Chorus

> **The Safe Multi-Engine Desktop App for AI Builders & Vibe Coders.**  
> *Orchestrate Antigravity (`agy`), Claude Code (`claude`), and OpenAI Codex (`codex`) in one seamless window with shared context, real-time approval, and zero terminal anxiety.*

---

## 🌟 Overview

**Chorus** transforms fragmented, terminal-based AI coding tools into an elegant, unified desktop experience. Instead of juggling multiple scary command-line windows, users get:
- **Unified Agent Orchestration**: Run `claude`, `agy`, and `codex` inside isolated native pseudo-terminals (`portable-pty`).
- **Autonomous Mode Switch (`--dangerously-skip-permissions`)**: Toggle between Human-in-the-Loop Safe Mode (interactive inline approvals) and Autonomous execution.
- **Smart Context Mentions (`@`) & Skills Slash Commands (`/`)**:
  - `@`: Context resources — Files (`@src/components/Nav.tsx`), Folders (`@src/components/`), and Artifacts (`@order-flow.html`).
  - `/`: Actions & Skills — Invoke bundled skills on-demand (`/db-migrate`, `/tailwind-ui`) or built-in commands (`/handoff`, `/sync-skills`, `/compact`).
- **Scoped Artifact Dispatcher**: Non-codebase visual files (mockups, SVGs, specs) are stored under an isolated hierarchy `.chorus/artifacts/<ai-cli>/<chat-thread-id>/` with live Canvas preview and draggable split resizer.
- **Mid-Session & Limit Handoff**: 1-click context transfer via compact Prompt Envelopes (<150 tokens) without losing conversation milestones or project state.
- **Skills Studio**: Single source of truth for multi-file skill bundles, materializing to `.agents/skills/` with automated disk synchronization across all CLI engines.
- **Controllable E2E Test Harness**: White-box testability over real OS PTY processes, file watchers, and UI components via `window.__CHORUS_HARNESS__`.

---

## 📁 Repository Structure

```text
chorus/
├── ideas/          # Product vision, target personas, branding, and feature concepts
├── documents/      # Architecture, specs, use cases, and interactive UI mockups
│   └── specs/      # Technical deep dives (CLI adapters, storage, E2E testing)
├── plans/          # Implementation roadmaps, milestones, and go-to-market strategies
└── README.md
```

### 📖 Documentation Index

- **[documents/](documents/)**
  - [`system-architecture.md`](documents/system-architecture.md): Dual-Plane architecture, PTY management, hook contracts, and MCP bridge specs.
  - [`ui-mockup-v3.html`](documents/ui-mockup-v3.html): **Latest interactive desktop UI mockup** featuring draggable resizer, sync skills, `--dangerously-skip-permissions`, `@-mentions`, `/-skills`, and live `window.__CHORUS_HARNESS__`. Open in any browser.
  - [`ui-use-cases.md`](documents/ui-use-cases.md): Comprehensive UI use cases (UC-01 to UC-12) mapping to engineering acceptance criteria.
  - [`open-vs-closed-core.md`](documents/open-vs-closed-core.md): The Open-Core boundary (open-source bridge vs. proprietary desktop GUI).
  - [`distribution-and-trust.md`](documents/distribution-and-trust.md): Apple Notarization, Windows Code Signing, and MoR billing guide.
  - [`ui-mockup-v2.html`](documents/ui-mockup-v2.html) & [`ui-mockup.html`](documents/ui-mockup.html): Earlier mockup iterations kept for design history.

- **[documents/specs/](documents/specs/)**
  - [`cli-engine-adapters.md`](documents/specs/cli-engine-adapters.md): Concrete native adapter specifications for `claude`, `agy`, and `codex` (Prompt Envelope, PTY prompt interception, and lifecycle hooks).
  - [`context-and-storage-spec.md`](documents/specs/context-and-storage-spec.md): Two-tier storage architecture, SQLite/redb schema definitions, in-DB ring buffers, and `.chorus/artifacts/<ai-cli>/<chat-thread-id>/` filesystem hierarchy.
  - [`e2e-testing-architecture.md`](documents/specs/e2e-testing-architecture.md): 4-layer controllable component testing framework using Playwright, `window.__CHORUS_HARNESS__`, and deterministic PTY CLI simulator.

- **[ideas/](ideas/)**
  - [`product-concept.md`](ideas/product-concept.md): Core vision, target persona (vibe coders & creators), and branding breakdown.
  - [`features-brainstorm.md`](ideas/features-brainstorm.md): Feature backlog, inter-agent workflows, and UI requirements.

- **[plans/](plans/)**
  - [`roadmap.md`](plans/roadmap.md): Phase-by-phase implementation plan from core bridge to desktop release.
  - [`marketing-launch.md`](plans/marketing-launch.md): Content strategy, 45-second demo video scripts, and launch channels.
