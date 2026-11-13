# Planner loop, approvals and artifacts: what the host does

The `chorus` side of the plan "Planner loop, approvals, artifacts" (2026-11-13). The Planner, its grant, `task_start`,
`ask_planner` / `answer_worker`, the message queue and the Restore card are the optional module's (chorus-core); this page is what
`chorus serve` and the desktop page (`src/desktop/`) do for them, and the host's own new screens. Chorus draws no input for a chat:
every chat is the agent's own CLI in its terminal.

## Typing into a chat (the module's `sendToChat`)

`Controller.sendToChat(id, text, exists)` types one message at a time per chat: the text, then Enter 700 ms later (text and Enter
in one chunk read as a paste in the TUIs). It answers:

| | when |
|---|---|
| `sent` | typed. A chat whose CLI is not running is continued first with its CLI's resume (the same session id, so codex and agy keep writing to their first transcript file) and typed into once its screen has been still for 2.5 s |
| `ended` | not typed now: a permission prompt is on its screen, or the resume did not come up. The module tries again later |
| `gone` | no session to continue: its session file is missing (agy would open an empty chat silently) or it never had one. The module raises its Restore card |

`dismissApproval(thread, request?)` and the chat event `deleted` are given to the module too (below).

## Question and approval cards

- `request_approval` takes `kind`: `question` (a choice or a fact; it can be skipped) or `approval` (the default: approve or decline
  an action). The kind is stored on the request (`requests.kind`) and reaches the page as `askKind`.
- A question's card, in the chat and in Approvals, has **Skip**: it types "Chorus approval <id>: skipped. Decide yourself and say
  what you chose." No decision is logged. An approval has no Skip.
- The card sits under the agent's screen, which ends above it (the CLI's input line stays in view); folded, the screen gets the
  room back. The terminal keeps its focus and its typing while a card is open.
- Typing to the agent (an Enter in its terminal) while its card is open answers it by typing: the card is cancelled and leaves the
  chat and Approvals at once (`typedTo` in `src/serve/server.ts`). The idle → working rule from the previous plan stays as well.

## Delete from Approvals

Every place that shows a waiting item has 🗑 (2026-11-13, waiting items): a row in Approvals and on Home, the card docked in a
chat (beside Fold, also folded) and the Approve / Deny line of a command prompt (at its end). A warning comes first ("Handle it in its chat, or the chat may stay waiting"), with **Don't ask again** (saved UI
key `noDelAsk`); the module's rows use the same dialog (`host.confirmDelete`). Delete takes the item off the list only, the agent
is not answered: an agent's question is cancelled; a command prompt is hidden from Approvals, its counts and its chat until the prompt
on the agent's screen changes (`POST chats/:id/dismiss`, the module's `dismissApproval`). The counts follow the lists: the header's "N waiting", the sidebar's Approvals and Home count the
host's rows plus the module's open needs (the module leaves out a need it hid); a project's "!N" and the Needs you filter count
chats with an item in those lists. Deleting a chat drops its card
and tells the module (`onChatEvent({ type: 'deleted' })`), which closes its plan approvals and gates and withdraws what it asked.

## Artifacts by report

There is no artifacts folder any more. The system prompt (`ARTIFACT_NOTE`: `artifactNote` for Codex's developer instructions, the
MCP server's instructions for Claude Code and agy) tells the agent to call `show_artifact(target, title?)` whenever it makes a file
for the user or finds a link for them, wherever it saves the file. The tool accepts a file that exists (absolute, or relative to the
chat's folder) or an http(s) link; anything else is refused, and nothing is fetched.

The Artifacts view lists what the chat reported, newest first (title, path, when; a file only while it exists), then the old
folder's files for chats from before. A click opens it on this computer with the system's open command (macOS `open`, Linux
`xdg-open`, as an argument, never a shell string; `POST chats/:id/open-report`). From a device on the private link a file inside
the chat's project is served to the device (`GET chats/:id/reported/:id`, sandboxed); a file elsewhere, a link and an old folder's
file say **Open on the Mac**, and a device never opens anything on the Mac.

## The right sidebar's width

A handle on the sidebar's left edge drags its width: at least 280 px, at most 60% of the chat. One width for the app (saved UI key
`sideW`); double-click puts it back; the terminal refits when the drag ends. Desktop only.

## `/` and `@` on New chat and the hand-off form

`src/desktop/text-picker.js` attaches to any text field with a list of triggers, each with its own source and insert rule; it
knows nothing about the screen it is on.

- `/` at the start of a word lists the project's skills that are on (`GET skills`) and puts `/skill-name` in. On Send each
  `/skill-name` that names such a skill becomes `Use the Chorus skill "skill-name" (load it with the chorus get_skill tool).`
  (`expandSkillMentions` in `src/core/skills.ts`, on the server for New chat and the hand-off; on the page for the module's own
  start path), so it works the same on the three CLIs. A `/word` that is no skill is sent as typed. The hand-off form's text now
  reaches the next agent, after the record.
- `@` lists the chosen folder's files (`GET files?folder=&q=`: git's tracked and untracked-not-ignored files, else a walk without
  `.git`, `node_modules` and dot folders; any part of the path; at most 50; only folders the form offers: the project, a chat's or
  a recent folder, This computer, or one inside the home folder) and puts `@relative/path` in, sent as typed. With no folder chosen,
  `@` is plain text: no list, no request.

## Tests

`test/serve/serve.test.ts` (typing into a chat; cards, Skip, delete, a deleted chat; artifacts; `/` and `@`), `test/serve/pro.test.ts`
(the private-link rule), `test/flow/flow.test.ts` (`show_artifact`, the prompt), `test/serve/text-picker.test.ts` and
`skills-files.test.ts`. Screens beside the mockup: `test/smoke/proof-planner-loop.ts`; the real-CLI run: `test/smoke/proof-planner-real.ts`
([testing.md](../testing.md)).
