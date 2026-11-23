# The Chat view

A second way to look at a chat, beside the agent's own screen (the **Terminal** view; named "Raw" until 2026-11-23, and still
`raw` in code and browser storage), which is not changed (owner, 2026-11-22: "the new one is just one more selection"; Raw at three sizes is compared with the last release in the proof run): the conversation drawn from the turns Chorus already captures
from the CLI's transcript. Your messages, the agent's replies as Markdown (headings, lists, tables, code, mermaid diagrams), its
tool calls folded into one line per run, and cards for what Chorus's own tools did: sub threads, chats it started, artifacts it
reported, mail it read. The CLI keeps running in its PTY exactly as before: **one session, two views**. Nothing here starts a CLI in
another mode.

| | Phone | Tablet, desktop |
|---|---|---|
| Opens in | Chat | Terminal (as before) |
| The switch | one icon in the top bar, before ⋯ (the only change to a phone's Terminal view) | Terminal · Chat in the chat's header (the only change to the Terminal view there) |
| Typing | a message box at the bottom, `/` and `@` lists above it, and a key row: `/` `@` Esc ⇧Tab | the same box on the conversation's column (owner, 2026-11-23): Enter sends, Shift+Enter is a new line; `/` `@` ⇧Tab, Stop (while the agent works) and Send sit inside it; it has the focus when the view opens |
| Layout | the screen's width | one 760 px column: replies, your messages, cards, quiet lines and the message box all on it |
| Kept | per device and size, in browser storage (`chorus.chatView.<size>`) | the same |

The look is `@workspace/mockups/chat-view.html` (agreed 2026-11-22), scene by scene, and for a desktop
`@workspace/mockups/chat-view-desktop.html` (agreed 2026-11-23: the column, the quiet lines, the message box, the name Terminal); proof screens for each scene come from
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
  and opening the view does not resume a parked chat (attaching does). The Terminal view attaches as before.
- **Artifacts**: an HTML file's preview is a sandboxed frame from the existing `GET chats/:id/reported/:id`, loaded only when its card
  comes into view; a Markdown file shows its headings and words. A device on the private link opens only files inside the chat's
  project; anything else says "Open on the Mac", as before.
- **Mermaid**: Chorus serves the library itself (`src/desktop/vendor/mermaid-12.2.0.min.js`, MIT, cached by its versioned name) and
  loads it only when a reply has a fenced `mermaid` block. A block that cannot be drawn keeps its source as code.

One seeded chat measured by `npm run smoke:chatview` (Claude Code, two turns): the page is about 4 KB and the Chat view gets no
screen bytes; the Terminal view gets about 5 KB of screen on attach and every byte the agent writes after it.

## Cards (Chorus's own tools)
`start_subthread`, `start_thread`, `show_artifact`, `request_approval` and `ask_main_thread` are cards, never rows; Chorus's other
tools (`read_mail`, `list_watches`, …) are rows marked ◈.
- **Sub thread**: its agent, what it was asked, its live state (from the page's chats), the first 240 characters of its last report
  (the report mail about it), and a question it asked (`asks`) as a card of its own. Several started after the same turn share one
  card. No permissions line: sub threads always have all permissions.
- **New chat** (`start_thread`): the teammate, the agent and its state, never a report (nothing is watched between sibling chats).
  Inside the new chat, its first line says which chat started it. The ask card before it is today's card, unchanged.
- **Mail read**: one quiet line. A sub thread's report: "Report from sub thread · its title", and a click opens the sub thread;
  other mail: "Mail from … · its subject", opening the chat it came from when that chat is still listed.

- **Files, one name on every size** (owner, 2026-11-23): what an agent reports with `show_artifact` is listed under **Files**: the
  phone's Files tab, and now the desktop header's button and its panel too (they said "Artifacts"). A card in the Chat view is
  headed FILE (or LINK). In code, storage and the agents' tool the word is still "artifacts".

## Quiet lines (what is not a message)
A CLI's transcript stores some text as user turns that the user never typed. Shown as the user's bubbles they filled the real
Planner chat (29 background-job notices and a 12,000-character summary in one chat), so each is one line instead (`noteOf` in
`src/serve/chatview.ts`; the turn comes with `note: {kind, head?, sub?}` and at most 600 characters of its text):

| Kind | Recognised by | The line |
|---|---|---|
| `job` | Claude Code's `<task-notification>` block | "Background job finished / failed / still running / stopped" or "Watch reported", then the job's name; a click shows its fields. Three or more in a row fold into "N background jobs reported" |
| `compact` | "This session is being continued from a previous conversation" (Claude Code) | a dashed rule, "Claude Code shortened the conversation here · Read its summary" |
| `answer` | "Chorus approval r_…: …" (typed by Chorus for every CLI) | on the right, smaller than a message: "✓ You answered the card: …" |
| `stopped` | "[Request interrupted by user]" (Claude Code) | on the right: "You stopped Claude Code" |
| `chorus` | "Chorus: …" (also inside a pasted block), "Chorus restarted." | "Chorus · its first line"; a click shows all of it |
| `brief` | the text Chorus starts a task's Planner or step chat with, or a handed-off chat | "Chorus's instructions for this chat"; a click shows them |

A line's whole text is read only when it is opened and is longer than what came with the page: `GET /api/chats/:id/turns/:seq`.
Only a user turn can be a quiet line; anything else the user typed stays a message. Codex and Antigravity have no notices of
their own recognised yet (none seen in their transcripts): what Chorus types into them is recognised, the rest shows as a message.

Above the first reply after the user spoke, a small line names who is speaking (a task chat's teammate, else the agent) and
the time; a rule with "Today", "Yesterday" or the date starts each day.

## Sending
`POST /api/chats/:id/say {text}` is the user typing, through the same gates as keys from the page: refused for a sub thread that is
watch-only; it waits behind the mail watchdog (`locks.run`); it resets what typing resets (`noteTyped`, `typedTo`: open question
cards close). Then:
1. `/skill-name` becomes the sentence each CLI understands (`expandSkillMentions`); the view shows it back as `/skill-name`.
2. The text is typed by the rule probed per CLI (`typedText`, chorus-core `docs/integrations/<cli>.md` → "Chat view"): a new line is
   the CLI's `NEWLINE_KEYS`; a message that ends in an `@path` gets a space after it (Codex's and agy's file menus otherwise take the
   Enter and nothing is sent).
3. A CLI whose input box is not showing (a start-up question such as a new folder's trust, a permission dialog, its own menu)
   gets nothing: the answer is `ended` and the view says "… is showing something on its own screen" with Open Terminal.
4. `sendToChat` types it (text, 700 ms, Enter; a parked chat is resumed first). `gone`: the chat cannot be continued.
5. 1.5 s later, if the CLI kept exactly that text in its input (Codex's "Unrecognized command"), it is cleared and the answer is
   `held`: "… did not take the message: its own screen says why."

`POST /api/chats/:id/key {key: 'esc' | 'shift-tab'}`: fixed bytes, same gates, never resumes a parked chat. Stop is Esc: probed to
stop a turn without closing the CLI in all three.

The `/` list is the same skills list as New chat (checked for this chat's agent, the sync dialog for one it lacks), then the agent's
own commands that run from typed text without a menu (`nativeCommands` in the first page's answer, chorus-core `NATIVE_COMMANDS`: Claude Code
`/compact` `/context`, Codex `/compact` `/status`, Antigravity `/compact`). Any other `/word` is typed as it is and the CLI decides.
`@` lists the files of the chat's folder. Both open above the box (`attachPicker(…, { above: true })`).

The "Open Terminal" banner shows when a page shows the chat in the Chat view, the chat is not working, and its CLI shows a menu of its own
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
  message, `nativeCommands` with the first page, `chats[].menu` only for a chat a page shows in the Chat view).
- `src/core/store.ts`: `tool_calls.kind` and `Store.recorded`.
- `src/desktop/chat-view.js` (the view), `md.js` `mdFull` (replies), `text-picker.js` (`above`, groups), `app.js` (`chatMode`,
  `setChatMode`, `cvSwitch`, `cvPicker`, `chatView`; the only edits to the Terminal view's code are the switch and the branch in `renderChat` /
  `onSize` that picks the view), `style.css` block "the Chat view".
- chorus-core: `ToolCall.kind` and `toolKind`, `Adapter.toolCallDetail`, `NATIVE_COMMANDS`, `menuShown`; probe
  `tools/probe/chatview-probe.mjs`, fixtures `fixtures/chatview-probe/2026-11-22/`.

## Tests
`test/serve/chatview.test.ts` (paging, the push, the detail on request, `say` with a skill, a native command and an `@path`,
watch-only, a CLI with no input box, no terminal bytes, cards); `npm run proof:desktop -- --sizes` (every scene at three sizes, the Terminal view
on a desktop compared with the newest release); `npm run smoke:chatview` (the real CLIs, from a phone's message box); chorus-core
`test/chatview.test.ts` on the probe's fixtures, and its Pro sizes stage (a task chat's Chat tab).
