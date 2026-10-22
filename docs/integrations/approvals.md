# Approvals: how to answer an agent's permission prompt from outside its screen

| | |
|---|---|
| **Status** | ✅ verified with the real CLIs on the Mac, 2026-10-17 |
| **Versions** | Claude Code 2.1.284, Codex 0.163.0, agy 1.4.0 |
| **Probe** | `node tools/probe/approval-probe.mjs <cli> <allow\|deny\|ask> [--answer <json>] [--keys '["\r"]'] [--nohook] [--outside]`; results in `fixtures/<cli>/<version>/approval-*/` |
| **Used by** | `src/app/approval.ts` (detector), `src/app/controller.ts` (top bar badge, sidebar `!`, status-line flash, approvals inbox, `ctrl+\ y/x`) |

Question (docs/phase4.md §4): when an agent in a background thread asks "may I run this?", can Chorus show a
card and answer it? Two mechanisms were tested: **A. a hook decides**, **B. read the prompt on the virtual
screen and type the key the prompt offers**.

## A. Hooks (interactive TUI)

A `PreToolUse` hook that waits 3 s (a person reading a card) and answers `allow`, `deny` or `ask`:

| CLI | how to install per session | deny | allow | ask |
|---|---|---|---|---|
| Claude Code | `--settings '{"hooks":{"PreToolUse":[{"matcher":".*","hooks":[{"type":"command","command":"…"}]}]}}'`; answer `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}` | ✅ "blocked by a pre-tool use hook", file not created | ✅ runs without a prompt | ✅ the TUI shows "Do you want to proceed? 1. Yes 2. No" |
| agy | `<workspace>/.agents/hooks.json` (`{"name":{"PreToolUse":[{"matcher":"run_command","hooks":[{"type":"command","command":"…","timeout":60}]}]}}`); answer `{"decision":"deny","reason":"…"}`; stdin camelCase JSON with `toolCall`, `conversationId`, `stepIdx` | ✅ blocked | ❌ ignored: agy still shows "Run this command? 1. Yes, run command …" (also with `permissionOverrides`) | ✅ same prompt |
| Codex | `-c 'hooks={PreToolUse=[{matcher=".*",hooks=[{type="command",command="…"}]}]}' --dangerously-bypass-hook-trust`; stdin has `session_id`, `transcript_path`, `tool_name` ("Bash"), `tool_input`; Claude-style answer | ✅ "Blocked by hook", file not created | ❌ "PreToolUse hook returned unsupported permissionDecision:allow" | ❌ "unsupported permissionDecision:ask" |

Hooks fire per tool call (not only when a prompt is needed) and run on the critical path. They cannot
approve for agy or Codex, so they are not the approval mechanism. Deny works in all three and is kept
as a possible "block this" later.

## B. Keystrokes on the agent's own prompt (what Chorus uses)

The prompts, as captured on the virtual screen (`fixtures/<cli>/<version>/approval-ask-nohook-enter/prompt-screen.txt`):

| CLI | prompt | approve | deny |
|---|---|---|---|
| Claude Code | `Do you want to proceed?` / `Do you want to create calc.js?` with `❯ 1. Yes`, `2. …`, `3. No` | **Enter** ✅ (file created) | **Esc** ✅ (file not created) |
| Codex | `Would you like to run the following command?` + `$ <command>` + `1. Yes, proceed (y)` … `Press enter to confirm or esc to cancel` | **Enter** ✅ (file created; `y` is the labelled shortcut) | **Esc** ✅ ("Conversation interrupted", not created) |
| agy (command) | `Run this command?` + `> 1. Yes, run command` … `4. No, cancel` | **Enter** ✅ (file created) | **4** ✅ (cancelled); Esc is also offered ("esc to cancel") |
| agy (file change, 1.4.2) | `Create file` / rule / `<path>  +5` + the code, then `Allow creation of this file?` with `> 1. Yes, allow creation` and `2. No, deny creation`. Fixture `fixtures/agy/1.4.2/approval-file/prompt-screen.txt`. The card shows `Create file · <path>`, not the code | **Enter** ✅ (approved in the e2e proof) | **Esc** ✅ (file not created; "Interrupted · What should Antigravity CLI do instead?") |

Chorus sends Enter / Esc. Detection reads the thread's virtual screen: the question line plus its option line
right below it (so prose that merely mentions "Do you want to proceed?" does not match), then extracts what the
agent wants to do (Claude: lines framed by the rule above the question, e.g. `Create file · calc.js`; Codex:
the `$ …` lines; agy: lines above the question). Fixtures of the three real prompts are L1 tests
(`test/app/approval.test.ts`).

## C. Skipping the prompts altogether (New chat → "Skip permission prompts")

| | |
|---|---|
| **Status** | ✅ verified in the interactive screen 2026-10-18: claude 2.1.302, codex 0.163.0, agy 1.4.2 |
| **Probe** | `node tools/probe/approval-probe.mjs <cli> allow --skip --wait 45` (starts the TUI with the flag, asks for a shell command, no hook) · fixtures `fixtures/<cli>/<version>/approval-allow-skip/` · screen-only check `npm run risk -- skip-flags` |

| CLI | flag | what the screen shows | result |
|---|---|---|---|
| Claude Code | `--dangerously-skip-permissions` | footer `⏵⏵ bypass permissions on (shift+tab to cycle)`; no extra confirmation dialog | command ran, file created, no prompt ✅ |
| Codex | `--dangerously-bypass-approvals-and-sandbox` | banner line `permissions: YOLO mode` under the folder path (seen in the UI-pass-2 proof) | command ran, file created, no prompt ✅ |
| agy | `--dangerously-skip-permissions` | nothing special on screen | command ran, file created, no prompt ✅ |

Only the folder-trust dialog of a new folder still appears (first start in a folder); it is separate from permission prompts. Chorus sets the flag per chat
(`buildInteractive({skipPermissions})`), remembers it on the chat (`threads.skip_permissions`, so a resumed chat keeps it) and shows `skip` in amber in the
status line. Nothing from such a chat reaches the approvals inbox. There is no global "always skip" (rule 4).

## D. Approvals the agent asks for itself: the chorus `request_approval` tool

| | |
|---|---|
| **Status** | ✅ verified with the real CLIs 2026-10-22: Claude Code 2.1.307 (haiku), Codex 0.163.0, agy 1.4.4 (`node test/smoke/ask.ts`, evidence `fixtures/ask/2026-10-22/`) |
| **Code** | tool: `src/mcp/server.ts` (`request_approval`, `APPROVAL_NOTE`); store table `requests`; `Controller.checkRequests` / `answerRequest`; desktop cards in `src/desktop/app.js`; route `POST /api/chats/:id/answer` |

Not every approval is a permission prompt. Asked for something that needs the user's OK, agy 1.4.4 wrote a plan and said
"Please review the plan and click **Proceed**" (its own artifact-feedback feature, a button only its desktop app has), and Codex
0.163.0 wrote `approval-proposal.md` and said "Reply Approve to authorize". Both are plain text in the conversation: no detector
can tell them from any other reply (seen in two real chats, `~/.chorus/threads/t_1483547d`, `t_c8420dbe`).

So every agent is told at start to call `request_approval(question, details?, options?)` instead of asking in
its reply, and to end its turn. The channels: MCP server instructions for Claude, `developer_instructions` for Codex, and for
agy a rule in a Chorus workspace plugin (`.agents/plugins/chorus/rules/AGENTS.md`, git-excluded): agy only shows server
instructions to its model when it reads them, and with them alone it asked in its reply 2 of 2 times. The tool only writes the request to the shared store and returns at once (no tool timeout to
meet: Codex's MCP default is 60 s). The app that runs the chat (CLI or desktop) shows it as a card with the agent's options and a
note field, plus (desktop) **Other…** for an answer of the user's own, sent as `Other: <their words>`; the answer is typed into the
agent as the user's next message, `Chorus approval r_xxxxxxxx: <option> (<note>)`, text
and Enter apart. A card is answered once (`answerRequest` updates only a pending row), so two windows cannot both answer it.
In the CLI app the card is in the inbox like a prompt: `y` picks its first option, `x` its last.

agy asks permission before every MCP tool call ("Allow calling this tool?" under the tool name, `1. Yes, allow tool call`,
`2. Yes, and always allow tool '<server/tool>' in this conversation`). For Chorus's own tools (`chorus/…`: they read the store
or show a card) Chorus answers `2` itself, once per prompt, so the user never approves twice; prompts for other servers' tools
reach the inbox as `MCP tool · <server/tool>`. Fixture: `fixtures/agy/1.4.4/approval-mcp-tool/prompt-screen.txt` (email masked).

## Gotchas

0. **Claude Code 2.1.302 starts in "auto mode"** (footer `⏵⏵ auto mode on`): a classifier approves tool calls for the user, so it rarely shows the prompts above. Earlier versions started in manual mode. A folder's `.claude/settings.local.json` with `{"permissions":{"defaultMode":"default"}}` (or `--permission-mode default`) gives manual mode (`⏸ manual mode on`); the e2e proof does this so there is something to approve. ✅ 2.1.303: a chat started from Chorus with "Skip permission prompts" unticked passes `--permission-mode default` (per session, the user's settings are untouched), so Claude asks and the request reaches the approvals inbox; without it a fresh folder starts in auto mode and nothing is ever captured. 2.1.303 lists `manual` in `--help` and still accepts `default` (older versions only know `default`). Its prompt adds a `Tip: auto mode handles these prompts…` line and a "Yes, and switch to auto mode" option; a file request whose preview is longer than the screen pushes the `Create file` header off it, so Chorus reads the file from the question (`Do you want to create cake.html?`). Fixtures: `fixtures/claude/2.1.303/approval-*`.

1. Codex only asks when the **model** requests escalation (`-a on-request`); the same prompt may or may not
   trigger on repeated runs, so the probe retries until the prompt appears.
2. In the TUIs, text and Enter arriving in one chunk are read as a paste; Chorus and the probes send the key alone.
3. Esc in Codex interrupts the whole turn ("Conversation interrupted"); that is what the prompt's own
   "No, and tell Codex what to do differently (esc)" does.
4. Prompt wording is version-specific: re-run the probe (and refresh the prompt-screen fixtures) after CLI updates;
   the detector tests then show what moved.
