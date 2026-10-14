# Open-Core Boundary Specification — Chorus

To maximize user trust while protecting the commercial value of the product, Chorus is strictly divided into two distinct repositories/layers:

---

## 1. The Open-Source Layer (Public on GitHub — MIT License)

*Objective:* Provide complete transparency to prove the software has zero malware, does not steal API keys, and only communicates locally on `127.0.0.1`.

### Components:
1. **`chorus-hook-adapter`**:
   - Lightweight CLI helper (~200 lines).
   - Plugs into `.agents/hooks.json` and `.claude/settings.json`.
   - Transmits stdin/stdout strictly across a local Unix socket (`/tmp/chorus-bridge.sock`).
2. **`chorus-mcp-server`**:
   - Local Model Context Protocol server definition.
   - Implements standard tools (`read_shared_chat`, `ask_peer_agent`).
3. **`starter-skills/`**:
   - Community-contributed `.agents/skills/` templates (e.g. database safety rules, API validators).

---

## 2. The Proprietary Commercial Layer (Closed Source — Paid License)

*Objective:* The defensible intellectual property and user experience that users pay for.

### Components:
1. **Chorus Desktop App (UI Shell)**:
   - High-performance tab management & multi-PTY lifecycle controller.
   - Canvas View parser converting raw JSONL streams into beautiful chat bubbles and collapsible thought traces.
2. **Smart Context Handoff Engine**:
   - Proprietary context-compression algorithm that condenses previous turns across peer agents into compact, token-efficient summaries.
3. **Human-Readable Risk Analyzer & Approval Dashboard**:
   - Semantic parser translating dangerous shell commands into plain-language warnings.
   - Visual side-by-side diff inspector.
4. **1-Click CLI Auto-Installer**:
   - Automated environment provisioning for non-technical users.
5. **License Management & Auto-Updater**:
   - Offline/online license verification integrated with Polar.sh / Lemon Squeezy.
