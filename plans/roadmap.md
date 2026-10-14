# Implementation Roadmap — Chorus

## Phase 1: Core Bridge & IPC Prototype (Weeks 1–2)
- [ ] Create `chorus-bridge` (lightweight local daemon in Go/Rust).
- [ ] Implement `agent-hub-hook` CLI script receiving `PreToolUse` and `PreInvocation`.
- [ ] Verify hook interception with live `agy` and `claude` sessions.
- [ ] Implement `agent-bridge-mcp` with `read_shared_chat` and `ask_peer_agent`.

## Phase 2: Desktop Shell & Terminal Tabs (Weeks 3–4)
- [ ] Initialize desktop app project (Tauri 2 + Svelte/React OR Flutter Desktop).
- [ ] Integrate multi-tab PTY terminal manager using `portable-pty` + `xterm.js`.
- [ ] Implement tab switcher preserving background terminal state across `agy`, `claude`, and `codex`.
- [ ] Add `.agents/skills/` symlink engine for automatic cross-CLI sharing.

## Phase 3: Canvas UI & Approval Dashboard (Weeks 5–6)
- [ ] Build the Antigravity-style Canvas View parsing JSONL session transcripts in real time.
- [ ] Build the Approval Dashboard UI with Approve, Edit, and Reject actions.
- [ ] Add the Human-Readable Risk Analyzer (translating shell commands to plain warnings).
- [ ] Implement the Smart Context Handoff banner and preview.

## Phase 4: Packaging, Notarization & Monetization (Weeks 7–8)
- [ ] Set up Apple Developer Account ($99) and configure automated `notarytool` in CI/CD.
- [ ] Set up Windows code signing with Azure Trusted Signing.
- [ ] Integrate Polar.sh / Lemon Squeezy license key verification.
- [ ] Build landing page with download buttons, SHA-256 checksums, and 14-day free trial.
