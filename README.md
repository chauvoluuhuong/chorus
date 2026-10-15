# 🎵 Chorus

> **The Safe Multi-Engine Desktop App for AI Builders & Vibe Coders.**  
> *Orchestrate Antigravity (`agy`), Claude Code (`claude`), and OpenAI Codex (`codex`) in one seamless window with shared context, real-time approval, and zero terminal anxiety.*

---

## 🌟 Overview

**Chorus** transforms fragmented, terminal-based AI coding tools into an elegant, unified desktop experience. Instead of juggling multiple scary command-line windows, users get:
- **Browser-Style Tabs**: Hot-swap between `agy`, `claude`, and `codex` instantly.
- **Smart Context Sync**: Switch tabs mid-task without losing conversation context—agents automatically receive deltas of what peers did via lifecycle hooks.
- **Human-Readable Approval Dashboard**: Dangerous commands and file mutations are intercepted before execution, translated into plain language, and held for one-click approval.
- **Direct Agent Collaboration**: Agents can query each other, delegate subtasks, and inspect peer terminal outputs via a local MCP bridge.
- **Single Source of Truth for Skills**: Unified `.agents/skills/` and `AGENTS.md` shared across all engines.

---

## 📁 Repository Structure

```text
chorus/
├── ideas/          # Product vision, target personas, branding, and feature concepts
├── documents/      # Technical architecture, open-vs-closed boundary, and security docs
├── plans/          # Implementation roadmaps, milestones, and go-to-market strategies
└── README.md
```

- **[ideas/](ideas/)**
  - [`product-concept.md`](ideas/product-concept.md): Core vision, target persona (vibe coders & creators), and branding breakdown.
  - [`features-brainstorm.md`](ideas/features-brainstorm.md): Feature backlog, inter-agent workflows, and UI requirements.
- **[documents/](documents/)**
  - [`system-architecture.md`](documents/system-architecture.md): Dual-Plane architecture, PTY management, hook contracts, and MCP bridge specs.
  - [`ui-mockup-v2.html`](documents/ui-mockup-v2.html): Interactive desktop UI mockup in AI-chat-app style: pick agent and model, tool calls, terminal view, approvals in the bell, usage-limit handoff, skills sync, shared memory, activity. Open in a browser.
  - [`ui-use-cases.md`](documents/ui-use-cases.md): UI use cases (UC-01 to UC-11), how each is built on the specs, and the spec additions this UI needs.
  - [`ui-mockup.html`](documents/ui-mockup.html): v1 mockup, superseded by v2 and kept for history.
  - [`open-vs-closed-core.md`](documents/open-vs-closed-core.md): The Open-Core boundary (open-source bridge vs. proprietary desktop GUI).
  - [`distribution-and-trust.md`](documents/distribution-and-trust.md): Apple Notarization, Windows Code Signing, and MoR billing guide.
- **[plans/](plans/)**
  - [`roadmap.md`](plans/roadmap.md): Phase-by-phase implementation plan from CLI prototype to commercial launch.
  - [`marketing-launch.md`](plans/marketing-launch.md): Content strategy, 45-second demo video scripts, and launch channels.
