# Effort (reasoning level) per CLI: the New chat "Effort" row

| | |
|---|---|
| **Status** | ✅ verified in the interactive screen 2026-10-18: claude 2.1.302, codex 0.163.0, agy 1.4.2 |
| **Probe** | `npm run risk -- effort-flags` (starts each TUI with a non-default effort, no prompt sent, reads the screen) · evidence `fixtures/risks/effort-flags/` |
| **Used by** | `src/core/launch.ts` (`InteractiveOpts.effort`), `src/app/models.ts` (`effortsFor`), the New chat screen, `chorus new --effort <level>` |

| CLI | how it is passed | levels | what the screen shows with it |
|---|---|---|---|
| Claude Code | `--effort <level>` (`claude --help`) | low, medium, high, xhigh, max | banner `Opus 5.5 with low effort · Claude Pro` ✅ |
| Codex | `-c model_reasoning_effort="<level>"` (no dedicated flag in `codex --help`) | per model, from `~/.codex/models_cache.json` → `supported_reasoning_levels[].effort` (low … max; one model also lists `ultra`) | status line `GPT-6-Luna high · <folder>` ✅ |
| agy | `--effort <level>` (`agy --help`) | low, medium, high, xhigh, max | banner `Gemini 3.8 Flash (Low)` ✅ |

Chorus rules:
- "default" passes nothing: the agent keeps its own default (Claude and Codex medium, agy high on this machine).
- The choice is stored with the chat (`threads.effort`) and passed again when a parked chat resumes.
- The Codex list follows the chosen model (the first listed model when the model is "default"); switching agent or model resets the effort to "default" when the old level is not offered.
- Not checked: whether every level works for every model (Haiku on Claude, the agy models). An unsupported level is the agent's own error to show; if one turns out to exit the agent, add a per-model list the way Codex has one.
