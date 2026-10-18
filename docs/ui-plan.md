# UI enhancement plan (mockup first, then code)

Mockup: `docs/mockups/chorus-cli.html` (scenes 1-14, clickable). No app code is changed yet.

**Guiding rule: keep it as simple as an AI chat app.** A sidebar of projects and their chats, a New chat
button, the real agent screen on the right. Anything the agent CLIs already do well (diffs, plan mode,
`@`/`/` menus, stop button) stays in the agent.

## Build order

1. **Click-region registry and widgets** (`src/app/compositor.ts`, `src/app/app.ts`): `compose()` also returns
   `hits` (rect + action id); `onMouse` looks up the hit instead of hardcoded arithmetic. A small widget layer
   (button, link, row, group) draws and registers hits. No TUI framework: the compositor stays ours, on
   `@xterm/headless`.
2. **Look rules**: spacing in whole cells (1 col padding inside every part, 1 blank row between groups, 2 cols
   between buttons). Clickable = a filled chip with its key (button), underlined accent text (link) or a list
   row that lights up on hover (mouse mode 1003). Plain text is never clickable. The bottom hint line is a row
   of buttons. Hand pointer through OSC 22 where supported (probe first).
3. **Sidebar = project tree**: `＋ New chat` on top; projects that open/fold on click, their chats under them
   (one line each: state dot, title, agent; a handoff indented under its parent); `✦ Skills` and `◫ Memory` at
   the bottom. Clicking a chat goes to it. This replaces Home, the project picker and the thread switcher.
4. **New chat form** (also the first screen): Agent (with plan usage under each), Model, Project folder,
   `[ ] Skip permission prompts`. Enter alone starts with defaults. Skip flags: Claude
   `--dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`, agy
   `--dangerously-skip-permissions` (documented; check each in the interactive screen before shipping).
5. **Top bar**: `‹ Back`, path (`chorus › project › chat`), `! N waiting`, `☰ Menu`. Menu trimmed to: hand off,
   new chat, artifacts, approvals, skills, memory, activity, sidebar, help, quit.
6. **Window size**: 110+ cols full sidebar, 90-109 narrow, 70-89 icons, 50-69 hidden, under 50x12 a "too small"
   screen. Status line drops model, ctx, artifacts text, meter in that order. `b` overrides.
7. **Approvals inbox**: pending approvals across chats, `y`/`x`/`⏎`, risk tag from a fixed pattern list, flash and
   optional bell. Artifacts list: rows and link clickable, opener with the "choose how" fallback.

## Shared, not per project

8. **Memory is global**: move the store from `<project>/.chorus/chorus.db` to `~/.chorus/chorus.db` with the project
   folder as a column. The sidebar, the Memory screen and the MCP tools read the same rows, so an agent in one
   project can continue a chat from another (`get_handoff_context(thread_id)`). Artifacts stay in the project
   folder (Codex's sandbox only writes inside its folder).
9. **Skills are global**: one library in `~/.chorus/skills/`, a Skills screen to turn skills on/off and import the
   ones found in the agents' own folders. The UI is in the mockup; how the library reaches and is understood by
   every agent (scan + watcher, global sync source, opt-in user folders, an injected "use your own equivalent
   tool" instruction, the probe that proves it) is technical debt **TD-1** in [roadmap.md](roadmap.md#technical-debt).
   Until TD-1 is done, skills keep syncing per project as today.

## Dropped (left to the agent CLIs or not worth the complexity)

Artifact diff and versions screen, handoff preview screen, activity detail screen, Home screen, project picker,
"Continue from" on the form, chat bubbles, composer, `@`-mentions, `/`-skills popover, stop button, theme switch.

## Tests to update
`test/app/compositor.test.ts` (top bar row, sidebar tree), `test/app/app.test.ts` (mouse via hits, size 100x24),
`test/app/controller.test.ts` (artifacts hints). Add: hit lookup, menu arrows, opener failure, project fold,
skills sync from a global source, store in `~/.chorus`.

## Open decisions
- Skills outside Chorus: opt-in checkbox, off by default (proposed).
- Skip permissions: per chat only, no global "always skip"; status line shows `skip` in amber (proposed).
- Terminal bell default on (proposed, `CHORUS_BELL=0` mutes).
- Mouse works wherever the terminal supports xterm SGR mouse; Windows legacy conhost and the PTY path on Windows
  are unverified.
