# R2 · Mouse and kitty keyboard protocol

| | |
|---|---|
| **Status** | ✅ measured (startup only) 2026-10-18: claude 2.1.302, codex 0.163.0, agy 1.4.2 · ❓ what breaks inside a Chorus thread is not tested |
| **Case** | `node tools/risk/run.ts terminal-protocols` · evidence `fixtures/risks/terminal-protocols/*-startup-raw.txt` |
| **Matters for** | CLAUDE.md known gap "mouse and kitty keyboard protocol are not forwarded" |

**Question.** Which terminal modes does each TUI switch on, i.e. what would Chorus have to forward or emulate?

**How it was probed.** Each CLI started in a PTY (110×32, empty temp folder), 9 s, no prompt sent (no model call), raw bytes searched for `CSI ? … h` modes, kitty `CSI > n u` / `CSI ? u`, `modifyOtherKeys`, OSC 8/52.

**Findings (requested at startup).**

| Mode | claude | codex | agy |
|---|---|---|---|
| mouse tracking 1000 / 1002 / 1003 + SGR 1006 | no | **yes (all four)** | no |
| bracketed paste 2004 | yes | yes | yes |
| focus events 1004 | yes | yes | no |
| kitty keyboard push `CSI > n u` | no (query only) | yes | yes |
| `modifyOtherKeys` | no | yes | yes |
| alternate screen 1049 | no | yes | yes |
| synchronized output 2026 | no | yes | no |

Claude may ask for more once past its first screen (the probe never sent input).

**What this means (inferred, not yet observed).** Codex expects mouse clicks and wheel inside its own region; Chorus uses mouse
for its sidebar, so a click on Codex's area is either dropped or misread. Codex and agy expect modified keys (Shift+Enter,
Ctrl+Enter) as kitty/`CSI u` sequences; a host that does not forward them leaves those keys acting like plain Enter or nothing.

**Fix when needed.**
1. Mouse: when the child enabled 1000/1002/1003, translate clicks inside the thread region (subtract sidebar width/top bar) and forward them as SGR 1006; keep sidebar clicks for Chorus. Needs the child's mode tracked from the virtual screen (xterm headless exposes `modes`).
2. Kitty keyboard: answer the child's `CSI ? u` query honestly (flags the host supports), and re-encode Shift/Ctrl+Enter from the outer terminal's own kitty/`modifyOtherKeys` input. Fallback: map Shift+Enter to the newline the CLI documents (`\\`+Enter or Ctrl+J).
3. Focus events (1004): forward focus-in/out to the focused thread only.
Verify each with `tools/probe/pty-probe.mjs`-style scripted keys, per CLI.

**Trigger to revisit.** A tester can't select/scroll in Codex with the mouse, or Shift+Enter submits instead of adding a line; the Phase 5 terminal pane (xterm.js speaks 1000–1006, 2004, and kitty only through an addon).
