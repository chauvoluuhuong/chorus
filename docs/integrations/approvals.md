# Approvals: how to answer an agent's permission prompt from outside its screen

| | |
|---|---|
| **Status** | ✅ verified with the real CLIs on the Mac, 2026-10-17 |
| **Versions** | Claude Code 2.1.284, Codex 0.163.0, agy 1.4.0 |
| **Probe** | `node tools/probe/approval-probe.mjs <cli> <allow\|deny\|ask> [--answer <json>] [--keys '["\r"]'] [--nohook] [--outside]`; results in `fixtures/<cli>/<version>/approval-*/` |
| **Used by** | `src/app/approval.ts` (detector), `src/app/controller.ts` (cards, `ctrl+\ y/x`) |

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

## Gotchas

0. **Claude Code 2.1.302 starts in "auto mode"** (footer `⏵⏵ auto mode on`): a classifier approves tool calls for the user, so it rarely shows the prompts above. Earlier versions started in manual mode. A folder's `.claude/settings.local.json` with `{"permissions":{"defaultMode":"default"}}` (or `--permission-mode default`) gives manual mode (`⏸ manual mode on`); the e2e proof does this so there is something to approve. Chorus does not change the user's mode.

1. Codex only asks when the **model** requests escalation (`-a on-request`); the same prompt may or may not
   trigger on repeated runs, so the probe retries until the prompt appears.
2. In the TUIs, text and Enter arriving in one chunk are read as a paste; Chorus and the probes send the key alone.
3. Esc in Codex interrupts the whole turn ("Conversation interrupted"); that is what the prompt's own
   "No, and tell Codex what to do differently (esc)" does.
4. Prompt wording is version-specific: re-run the probe (and refresh the prompt-screen fixtures) after CLI updates;
   the detector tests then show what moved.
