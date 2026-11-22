# The Chat view

A second way to look at a chat, beside the agent's own screen (Raw): the conversation drawn from the turns Chorus already captures
from the CLI's transcript. Your messages, the agent's replies as Markdown (headings, lists, tables, code, mermaid diagrams), its
tool calls folded into one line per run, and cards for what Chorus's own tools did: sub threads, chats it started, artifacts it
reported, mail it read. The CLI keeps running in its PTY exactly as before: **one session, two views**. Nothing here starts a CLI in
another mode.

| | Phone | Tablet, desktop |
|---|---|---|
| Opens in | Chat | Raw (as before) |
| The switch | the first of the three icons in the top bar (Raw / Chat), then Artifacts, then ⋯ | Raw · Chat in the chat's header |
| Typing | a message box at the bottom, `/` and `@` lists above it, and a key row: `/` `@` Esc ⇧Tab | none: "Reading view. To type, switch to Raw." |
| Kept | per device and size, in browser storage (`chorus.chatView.<size>`) | the same |

The look is `@workspace/mockups/chat-view.html` (agreed 2026-11-22), scene by scene; proof screens for each scene come from
`npm run proof:desktop -- --sizes`.

## What is loaded, and when
- **Opening a chat** in the Chat view: `GET /api/chats/:id/turns` → its last 30 turns, one short row per tool call of those turns
  (`{id, seq, kind, tool, target, status, word}`: what kind, on what, the result in a word) and the cards, each with the turn it came
  after (`seq`). No call's input or output, no one-line result. `more: true` when earlier turns exist; scrolling to the top asks
  `?before=<seq>` and keeps the reader where they were.
- **While it shows**: the page sends `{t: 'cv', id, seq}` on the websocket; from then on the server sends `{t: 'cv', id, turns,
  calls, cards?}` with only the turns after `seq` and the rows that are new or changed (a call going from running to done). It is
  driven by the tailer's own update (`Store.recorded`, called by `recordSession`): no timer of its own. `{t: 'cv'}` with no id stops it.
- **A tap on a row**: `GET /api/chats/:id/calls/:callId` reads that call's whole input and output from the transcript then
  (chorus-core `Adapter.toolCallDetail`), cut at 4 KB; "Show all" asks `?full=1` (up to 256 KB, marked when cut). Nothing new is
  stored. A kind of call the transcript keeps nothing more for shows the row's own text.
- **No terminal bytes**: a page in the Chat view never attaches to the chat's terminal, so a phone gets none of the screen's bytes,
  and opening the view does not resume a parked chat (attaching does). Raw attaches as before.
- **Artifacts**: an HTML file's preview is a sandboxed frame from the existing `GET chats/:id/reported/:id`, loaded only when its card
  comes into view; a Markdown file shows its headings and words. A device on the private link opens only files inside the chat's
  project; anything else says "Open on the Mac", as before.
- **Mermaid**: Chorus serves the library itself (`src/desktop/vendor/mermaid-12.2.0.min.js`, MIT, cached by its versioned name) and
  loads it only when a reply has a fenced `mermaid` block. A block that cannot be drawn keeps its source as code.

One seeded chat measured by `npm run smoke:chatview` (Claude Code, two turns): the page is about 4 KB and the Chat view gets no
screen bytes; Raw gets about 5 KB of screen on attach and every byte the agent writes after it.

## Cards (Chorus's own tools)
`start_subthread`, `start_thread`, `show_artifact`, `request_approval` and `ask_main_thread` are cards, never rows; Chorus's other
tools (`read_mail`, `list_watches`, …) are rows marked ◈.
- **Sub thread**: its agent, what it was asked, its live state (from the page's chats), the first 240 characters of its last report
  (the report mail about it), and a question it asked (`asks`) as a card of its own. Several started after the same turn share one
  card. No permissions line: sub threads always have all permissions.
- **New chat** (`start_thread`): the teammate, the agent and its state, never a report (nothing is watched between sibling chats).
  Inside the new chat, its first line says which chat started it. The ask card before it is today's card, unchanged.
- **Mail read**: one line, "Mail from … was read by the agent" (a sub thread's report is named after the sub thread).

## Sending (phone)
`POST /api/chats/:id/say {text}` is the user typing, through the same gates as keys from the page: refused for a sub thread that is
watch-only; it waits behind the mail watchdog (`locks.run`); it resets what typing resets (`noteTyped`, `typedTo`: open question
cards close). Then:
1. `/skill-name` becomes the sentence each CLI understands (`expandSkillMentions`); the view shows it back as `/skill-name`.
2. The text is typed by the rule probed per CLI (`typedText`, chorus-core `docs/integrations/<cli>.md` → "Chat view"): a new line is
   the CLI's `NEWLINE_KEYS`; a message that ends in an `@path` gets a space after it (Codex's and agy's file menus otherwise take the
   Enter and nothing is sent).
3. A CLI whose input box is not showing (a start-up question such as a new folder's trust, a permission dialog, its own menu)
   gets nothing: the answer is `ended` and the view says "… is showing something on its own screen" with Open Raw.
4. `sendToChat` types it (text, 700 ms, Enter; a parked chat is resumed first). `gone`: the chat cannot be continued.
5. 1.5 s later, if the CLI kept exactly that text in its input (Codex's "Unrecognized command"), it is cleared and the answer is
   `held`: "… did not take the message: its own screen says why."

`POST /api/chats/:id/key {key: 'esc' | 'shift-tab'}`: fixed bytes, same gates, never resumes a parked chat. Stop is Esc: probed to
stop a turn without closing the CLI in all three.

The `/` list is the same skills list as New chat (checked for this chat's agent, the sync dialog for one it lacks), then the agent's
own commands that run from typed text without a menu (`nativeCommands` in the state, chorus-core `NATIVE_COMMANDS`: Claude Code
`/compact` `/context`, Codex `/compact` `/status`, Antigravity `/compact`). Any other `/word` is typed as it is and the CLI decides.
`@` lists the files of the chat's folder. Both open above the box (`attachPicker(…, { above: true })`).

The "Open Raw" banner shows when a page shows the chat in the Chat view, the chat is not working, and its CLI shows a menu of its own
(`menuShown`, probed per CLI: Claude and agy hide their input box; Codex shows numbered `›` rows and "enter select · esc back").

## What each CLI's transcript gives (Stage 0, 2026-11-22)
| | Claude Code 2.1.330 | Codex 0.170.0 | Antigravity 1.5.14 |
|---|---|---|---|
| A reply before the turn ends | yes | yes | yes |
| A running call | yes, about 3 s after the screen | no: written when it ends (the view shows "Working") | yes, at once |
| A message typed mid-turn | taken into the turn (its `queued_command` line) | steered into the turn | queued after it |
| Detail per call | whole input and output | whole (command output, patch diffs, MCP arguments and result) | whole (each result line after its call) |

## Code
- `src/serve/chatview.ts`: the page, the push (`delta`), the detail, `typedText`, `heldInInput`, the keys; wired in `server.ts`
  (routes `GET chats/:id/turns`, `GET chats/:id/calls/:callId`, `POST chats/:id/say`, `POST chats/:id/key`, the `cv` websocket
  message, `state.nativeCommands`, `chats[].menu`).
- `src/core/store.ts`: `tool_calls.kind` and `Store.recorded`.
- `src/desktop/chat-view.js` (the view), `md.js` `mdFull` (replies), `text-picker.js` (`above`, groups), `app.js` (`chatMode`,
  `setChatMode`, `cvPicker`, `chatView`), `style.css` block "the Chat view".
- chorus-core: `ToolCall.kind` and `toolKind`, `Adapter.toolCallDetail`, `NATIVE_COMMANDS`, `menuShown`; probe
  `tools/probe/chatview-probe.mjs`, fixtures `fixtures/chatview-probe/2026-11-22/`.

## Tests
`test/serve/chatview.test.ts` (paging, the push, the detail on request, `say` with a skill, a native command and an `@path`,
watch-only, a CLI with no input box, no terminal bytes, cards); `npm run proof:desktop -- --sizes` (every scene at three sizes, Raw
on a desktop compared with the newest release); `npm run smoke:chatview` (the real CLIs, from a phone's message box); chorus-core
`test/chatview.test.ts` on the probe's fixtures, and its Pro sizes stage (a task chat's Chat tab).
