# R7 · Windows

| | |
|---|---|
| **Status** | ❓ not probed: this harness runs on macOS only; nothing here is verified on Windows |
| **Case** | manual · proposed CI job below |
| **Matters for** | the npm package / Node single executable (phase4.md P4.8) and any Windows buyers |

**Known unknowns.**
- `node-pty` on Windows (ConPTY): spawn, resize, kill, and the `@xterm/headless` screen reads. `scripts/fix-pty.mjs` (postinstall) was written for macOS.
- Paths: CLI homes (`~/.claude`, `~/.codex`, `~/.gemini/antigravity-cli`) and the Claude project-slug rule (`cwd` with non-alphanumerics → `-`; drive letters and `\` are unverified).
- Skills sync uses symlinks (`src/core/skills.ts`) with a copy-mode fallback carrying a marker file; the fallback is the Windows path and is untested there.
- Whether the three CLIs run natively on Windows or only under WSL (then Chorus would have to run inside WSL too).
- Ctrl+\ (the menu key) and Esc handling in `conhost` versus Windows Terminal.

**How to probe when needed.**
1. CI: a `windows-latest` job running `npm ci`, `npm run typecheck`, `npm test` (the app tests already drive a fake TUI in real PTYs, so they exercise ConPTY), and `node tools/risk/run.ts store-concurrency`.
2. On a Windows machine with the CLIs installed: `node tools/probe/probe.mjs <cli>` and `node tools/risk/run.ts terminal-protocols --agents …`, then fill this page.

**Fix when needed.** Per failing item; likely a Windows-specific launcher for `fix-pty`, path helpers in `capture.ts`, and `mode: 'copy'` as the default for skills.

**Trigger to revisit.** The first Windows buyer request, or before choosing the desktop shell (Electron handles ConPTY through the same `node-pty`).
