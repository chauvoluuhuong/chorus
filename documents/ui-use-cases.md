# UI Use Cases — Chorus Desktop

> Companion to [`ui-mockup-v2.html`](ui-mockup-v2.html). Open it in a browser; the buttons at the top are labelled with the use case IDs below.
> [`ui-mockup.html`](ui-mockup.html) is the v1 mockup, kept for history only.
>
> Every use case has a **How it's built** note that ties the screen to [`system-architecture.md`](system-architecture.md) and [`specs/context-and-storage-spec.md`](specs/context-and-storage-spec.md). Things the specs don't cover yet are collected in §6.

---

## 1. The core value

**Start a chat, pick which coding agent (Claude Code, Antigravity or Codex) and which model does the work, and when that agent hits its usage limit, hand the chat to another agent without starting over.**

```text
 New chat ─► pick agent + model ─► installed? ─no─► install popup ─┐
                                      │ yes                         │
                                      ▼                             │
                                    Chat  ◄─────────────────────────┘
          ┌──────────────┬───────────┴─────┬──────────────────┐
          ▼              ▼                 ▼                  ▼
     Tool calls     Needs approval     Makes a file       Usage limit
     (rows in       (bell menu)        (artifact panel)   (hand off to
      the chat)                                            another agent)
```

Supporting pages: **Skills** (stored in Chorus, written to `.agents/skills`), **Shared memory** (what agents can read), **Activity** (everything agents did, in full detail). Each chat can also be viewed as its raw **Terminal**.

---

## 2. Layout

Chorus follows the layout of AI chat desktop apps (Claude desktop): sidebar, chat, and a side panel that opens for artifacts.

| Area | Contents |
|---|---|
| **Sidebar** | New chat · Chats · Skills · Shared memory · Activity · Recents (each with its current agent's mark) · Settings. No user profile: Chorus has no account of its own; each agent signs in with its own account. |
| **Home** | Serif headline "What should we build?", the message box, quick-start chips. |
| **Message box** | `+` attach · project folder (home only) · context meter (in a chat) · **agent + model picker** · send. |
| **Chat header** | Chat title and folder · **Chat / Terminal** switch · **bell** with a count of pending approvals. |
| **Chat** | User messages in a beige bubble on the right; agent replies on the left, signed "Claude Code · Sonnet 5.5"; tool calls as a collapsible list of rows; artifact cards; handoff dividers. |
| **Side panel** | Only artifacts (Preview / Code). Approvals live in the bell, not here. |
| **Type** | Sans-serif for UI and messages. Serif for the home headline and page titles. |

---

## 3. Use cases

### UC-01 · Start a new chat *(mockup: "New chat")*

- The home screen shows the headline, the message box and quick-start chips.
- The **folder** button picks the project folder the agent will run in. It defaults to the last folder used.
- The picker shows the last used agent and model. On first run that's the first installed agent and its default model.
- Sending the first message creates the chat and starts the agent.

**How it's built**: the agent CLI is spawned in a PTY (AC-1.1) with `cwd` set to the folder. A new Chorus *thread* is created and linked to that CLI session (see §6, `threads`). At session start Chorus injects the skill index (AC-3.5).

**Acceptance criteria**
- [ ] AC-01.1: No setup screens before the first chat. The only choices are folder, agent and model, and all have defaults.
- [ ] AC-01.2: The chat title is generated from the first message.

### UC-02 · Pick agent, model, and see usage *(mockup: "Agent, model and usage")*

- The picker in the message box opens a menu with one row per agent: name, number of models, and a state tag (✓ current, **Install**, **Limit until 6 PM**).
- Expanding an agent shows its models as radio options, each with a one-line description and a default.
- At the bottom, a **usage box** for the highlighted agent:
  - **Plan limit**: "72% used · resets 6:00 PM" with a bar, or "Not reported" when the CLI doesn't expose it.
  - **This chat** (inside a chat): tokens used and context-window fill.
- In a chat, the message box also shows a **context ring** ("34%"). Hovering shows "68k / 200k tokens".
- **Changing the model** applies from the next message.
- **Changing the agent** mid-chat is a handoff (UC-08).

**How it's built**
| Data | Source |
|---|---|
| Installed? | Look up the binary on `PATH` (`claude`, `agy`, `codex`) and run `--version`. |
| Model list | Each CLI's own model list or config. Mockup names are examples. |
| Model selection | Start the CLI with its model flag (e.g. `claude --model sonnet`, `codex --model …`). Mid-session changes use the CLI's in-session model command where it has one; otherwise they apply when Chorus next starts a session. |
| Tokens this chat, context % | Usage fields in each CLI's session transcript (JSONL), which Chorus already parses for the chat view. |
| Plan limit % and reset time | Only where the CLI reports it, e.g. rate-limit data in Codex session events. Otherwise "Not reported", and Chorus relies on detecting the limit message (UC-08). |

**Acceptance criteria**
- [ ] AC-02.1: The model list comes from the CLI, not a hard-coded list.
- [ ] AC-02.2: Usage figures name their source; nothing is estimated without saying so.
- [ ] AC-02.3: An agent at its limit can't be picked and shows when it resets.

### UC-03 · Agent not installed *(mockup: "Agent not installed")*

- Picking an agent with the **Install** tag opens a popup: "Codex isn't installed yet. Chorus looked for the `codex` command and didn't find it."
- Three steps, each ticked when done:
  1. **Install**: **Install for me** (background install with progress), or the command to paste into Terminal, with a copy button.
  2. **Sign in with ChatGPT**: runs the CLI's login, which opens the browser.
  3. **Quick check**: version found, signed in, models listed.
- When all three are done: "Codex is ready" and a **Use Codex** button. **Not now** closes the popup and keeps the previous agent.

**How it's built**: the 1-Click CLI Auto-Installer ([`open-vs-closed-core.md`](open-vs-closed-core.md)). If a prerequisite is missing (e.g. Node.js for npm installs), an extra first step installs it.

**Acceptance criteria**
- [ ] AC-03.1: A user can install and sign in without opening a terminal.
- [ ] AC-03.2: The manual command is always shown.
- [ ] AC-03.3: A failed install shows the error in plain words, with **Try again** and the manual command.

### UC-04 · Tool calls in the chat *(mockup: "Tool calls in chat")*

- Under the agent's reply, one summary line: "Searched 1 time, created 2 files, edited 1 file, ran 2 commands ›".
- Expanding it shows one **row per tool call**:

| Kind | Row | Expanded detail |
|---|---|---|
| Search | `Searched "nav" in components/` · 3 matches | Matching lines |
| Read | `Read prisma/schema.prisma` · 41 lines | — |
| Create | `Created app/order/page.tsx` · +64 | New-file diff (first lines) |
| Edit | `Edited components/NavBar.tsx` · +1 −0 | Unified diff |
| Command | `Ran npm run build` · exit 0 · 14.2s | Output preview, **Full output**, **See in terminal** |
| MCP | `Asked Chorus get_tool_execution(exec_907)` | Request and result |
| Waiting | `Run npx prisma migrate …` · *Waiting for approval* | **Review in notifications** |
| Running | spinner | Live output |
| Failed / blocked | red ✕ | Error output, or "You didn't allow it" |

**How it's built**: rows come from the `executions` collection. Each one is recorded from the CLI transcript (tool call and result) and from `PostToolUse` hooks. Output over 4 KB is offloaded to `raw_log_path` (AC-4.3); the row shows `stdout_preview` and links to the full log.

**Acceptance criteria**
- [ ] AC-04.1: Every tool call appears as a row, in order, with status.
- [ ] AC-04.2: Edits show a diff; commands show exit code and duration.
- [ ] AC-04.3: The group is collapsed once the turn finishes; while running it stays open.

### UC-05 · Terminal view *(mockup: "Terminal view")*

- The **Chat / Terminal** switch in the chat header shows the agent's real terminal session for this chat.
- One tab per CLI session in the chat (e.g. `claude · 8f92a`, and `codex · 3c1d7` after a handoff), each with a status dot.
- A meta line shows process ID, command line with model, folder and terminal size.
- An input at the bottom sends keystrokes straight to the process, with **Ctrl+C** and **Esc** buttons.
- Approvals still go through the bell. The terminal shows "waiting for approval in Chorus" while a tool is held.

**How it's built**: Terminal Plane, `portable-pty` + `xterm.js` ([`system-architecture.md`](system-architecture.md) §1, AC-1.1–1.3). The chat view and terminal view read the same session, so switching never restarts it (AC-5.6).

**Acceptance criteria**
- [ ] AC-05.1: Switching views keeps the process running and the scroll position of each view.
- [ ] AC-05.2: Input typed in the terminal appears in the chat as a user message once the CLI records it.
- [ ] AC-05.3: Every CLI session the chat has used is reachable as a tab, including ended ones (read-only).

### UC-06 · Approvals in the bell *(mockup: "Approvals in the bell")*

- When an agent wants to do something in an "ask" category (§4):
  - the bell gets a count badge;
  - the tool row in the chat says *Waiting for approval* with **Review in notifications**.
- The bell menu has two sections: **Waiting for your approval** (from all chats) and **Earlier** (other notices).
- Each approval shows:
  - agent, chat and time;
  - a plain-words title and one sentence on what changes;
  - **Show what will run** (tool, command, folder);
  - **Allow** / **Don't allow** / **Go to chat**;
  - a countdown: "9:41 left, then the agent is told 'no answer'".
- **Risky** items have a red tag and a second confirmation ("Yes, delete 214 files").

**How it's built**: the `PreToolUse` hook passes the tool payload to `chorus-hook-adapter` over the local socket. The hook process blocks until Chorus answers (system-architecture §2). Hooks have a timeout, so Chorus sets it as high as the CLI allows (e.g. 600 s). If time runs out, Chorus answers *deny, reason: no answer from user*, and the agent pauses or asks again. The plain-words title comes from the Risk Analyzer.

**Acceptance criteria**
- [ ] AC-06.1: The CLI does not run the tool until the user decides or the timeout passes (AC-2.2).
- [ ] AC-06.2: A timeout never counts as an approval.
- [ ] AC-06.3: The decision and the full hook payload are recorded in Activity.

### UC-07 · Artifact preview *(mockup: "Artifact preview")*

- An artifact card ("Order a cake page · Web page") appears in the reply.
- Clicking it opens the side panel with **Preview / Code**, copy, open in browser and close. The header shows the file path, version and "live".

**How it's built**: §5 of the storage spec. `PostToolUse` registers the file in `artifacts`. The daemon emits `artifact:updated` and the panel hot-reloads (AC-5.1–5.4).

### UC-08 · Usage limit: hand off *(mockup: "Usage limit, hand off")*

- When the agent reports its limit, a card above the message box says: "Claude Code has reached its usage limit. It resets at 6:00 PM."
- It offers **Continue with Codex**, **Continue with Antigravity**, or **Wait until 6 PM**. The message box is disabled until the user picks.
- On **Continue with Codex**:
  1. A divider "Continued with Codex · GPT Codex" appears in the same chat.
  2. "What Codex was told" (collapsible) shows the exact summary and its size (138 tokens).
  3. Codex says it has caught up and continues. Its tool rows can include MCP calls to fetch more detail.
  4. The picker, the Recents mark and the Terminal tabs switch to Codex.
- Picking another agent in the picker without a limit does the same handoff.

**How it's built**
| Step | Mechanism |
|---|---|
| Detect the limit | The transcript parser matches the CLI's limit message or error event and reads the reset time. |
| Build the summary | Smart Context Handoff Engine, from the thread's `turns.handoff_summary` (goal, done, files, verification, open items), within 200 tokens (AC-3.2, AC-3.3). |
| Start the new agent | Spawn the new CLI in the same folder, with the model chosen in the picker. |
| Deliver the summary | Through the new CLI's prompt hook where it has one (`UserPromptSubmit` for Claude Code, `PreInvocation` for Antigravity). Otherwise prepend it to the first prompt. |
| Deeper detail | The new agent calls `agent-bridge-mcp` (`list_agent_activities`, `get_tool_execution`, `get_artifact_content`) — Tier 2. |

**Acceptance criteria**
- [ ] AC-08.1: One chat thread holds all agents' messages, each signed with agent and model.
- [ ] AC-08.2: The summary text is visible in the chat and in Shared memory → Handoff summaries.
- [ ] AC-08.3: Pending approvals of the limited agent are cancelled; the new agent asks again if it needs the same action.

### UC-09 · Skills and sync *(mockup: "Skills and sync")*

- The **Skills** page explains the model: "Skills are stored in Chorus. Turning one on writes it to `.agents/skills/`, which every agent reads. Turning it off removes the folder; Chorus keeps the files."
- **Sync skills** button:
  1. Scans `.agents/skills`, `.claude/skills` and `.codex/skills`.
  2. Imports new or changed skill folders into Chorus as bundles.
  3. Rewrites the folders of skills that are on.
  4. Shows a result: **New** (imported, off until turned on), **Updated** (disk copy was newer), **Conflict** (changed in both places → **Keep Chorus version** / **Use disk version**).
  A "Last synced" time is shown under the title.
- Each skill row shows:
  - title and folder name, description, origin (`Created in Chorus`, `Imported from .claude/skills`, `Created by Claude Code (create_project_skill)`);
  - file count and "has scripts";
  - where it lives ("On disk at `.agents/skills/db-migrate`" or "Off · stored in Chorus only");
  - **Edit** and an on/off switch.
- **New skill / Edit** opens a form: title, folder name, description, the bundle's file list (SKILL.md marked as entry, an "executable" checkbox for scripts), a file editor, **AI Refine**, **Add file**.

**How it's built**: `skills` collection and §2.4.1 of the storage spec. Turning a skill on materializes it (files plus `chmod +x`); turning it off dematerializes it; Chorus keeps the bundle (AC-4.5–4.7). Sharing to each agent uses the `.agents/skills` symlink engine (roadmap Phase 2, e.g. `.claude/skills` → `.agents/skills`).

**Acceptance criteria**
- [ ] AC-09.1: Nothing is imported or overwritten until the user presses **Sync skills**.
- [ ] AC-09.2: A conflict is never resolved without the user's choice.
- [ ] AC-09.3: Turning a skill off removes its folder and keeps the bundle; turning it on restores files and executable bits.
- [ ] AC-09.4: Changes reach agents from their next session; the skill index updates too.

### UC-10 · Shared memory *(mockup: "Shared memory")*

Shows the different kinds of memory agents share, split by how they reach an agent:

| Tier | Kind | What the page shows |
|---|---|---|
| **Pushed automatically** (Tier 1) | **Handoff summaries** | From → to agent, chat, reason, exact text, token bar (138 / 200), how it was delivered, which turns and executions it was built from |
| | **Skill index** | The exact index injected at session start, token bar (84 / 100) |
| **Available on request** (Tier 2) | **Turns** | Fields of each `turns` record: `raw_prompt`, `outcome`, `files_touched`, `verification`, `open_milestones`, `execution_ids`, `artifact_ids` |
| | **Tool runs** | Fields of each `executions` record, with link to Activity for the full list |
| | **Artifacts** | Fields of each `artifacts` record |
| | **Peer questions** | `ask_peer_agent` question and answer |

Each record has a **"Read by"** line, e.g. "Read by Codex via `get_tool_execution` (tail, 40 lines) at 3:21 PM".

**Acceptance criteria**
- [ ] AC-10.1: Every kind listed in the table has its own tab with a count.
- [ ] AC-10.2: Tier 1 items always show their exact text and token count.
- [ ] AC-10.3: "Read by" lists every MCP read of that record (needs §6 `mcp_reads`).

### UC-11 · Activity *(mockup: "Activity log")*

For technical users, so everything is shown.

- **Stats**: tool calls (and failures), approvals waiting, handoffs (and tokens pushed), tokens per agent.
- **Filters**: by agent; by type (Tools, Hooks, Approvals, MCP, Errors).
- **Table**: time (to the second), agent, type, name (`Bash`, `PreToolUse`, `ask_peer_agent`, `handoff:inject`, `usage_limit`, `SessionStart`…), summary, status, duration, tokens.
- **Row detail**: raw payloads side by side. Examples:
  - hook stdin and Chorus's stdout decision;
  - the `executions` document and its output;
  - the injected handoff text and delivery metadata;
  - the transcript line that signalled the limit.
  Buttons: **Copy JSON**, **Open raw log**, **Show in terminal**.
- **Export JSONL**.

**Acceptance criteria**
- [ ] AC-11.1: Every tool call, hook event, approval decision, MCP call, handoff and detected limit is an event.
- [ ] AC-11.2: Every event's raw payload can be viewed and copied.

---

## 4. Approval levels

| Level | Shown as | Examples |
|---|---|---|
| **No approval** | Tool row only | Read/search, edit files inside the project, run the project's tests, start the dev server |
| **Ask** | Bell item | Database migrations, installing packages, network calls, unfamiliar commands |
| **Risky** | Bell item with red tag and second confirmation | Deleting many files, anything outside the project folder, deploy/publish, using stored secrets |

---

## 5. Words on screen

| Internal | On screen |
|---|---|
| CLI / binary | Agent: Claude Code, Antigravity, Codex |
| PreToolUse hold | "Waiting for approval", bell item |
| Context handoff | "Continued with Codex", "What Codex was told" |
| Tier 1 / Tier 2 | "Pushed automatically" / "Available on request" |
| Materialize / dematerialize | Skill on / off |
| PTY | Terminal |

---

## 6. What the specs need for this UI

The current [`context-and-storage-spec.md`](specs/context-and-storage-spec.md) covers turns, executions, artifacts and skills. This UI also needs:

| Need | Proposed addition | Used by |
|---|---|---|
| Chats that span agents | `threads` collection: `_id`, `title`, `workspace_path`, `created_at`, `segments: [{agent_id, model, cli_session_id, started_at, ended_at, end_reason}]` | UC-01, UC-05, UC-08 |
| Link records to chats | `thread_id` on `turns`, `executions`, `artifacts` | All |
| Model and tokens per turn | `model`, `usage: {input_tokens, output_tokens, context_pct}` on `turns` | UC-02, UC-11 |
| Approval history | `approvals` collection: `exec_id`, `hook_payload`, `risk_level`, `title`, `decision`, `decided_by` (user / timeout), `held_ms` | UC-06, UC-11 |
| Handoff records | `handoffs` collection: `from_agent`, `to_agent`, `reason` (usage_limit / manual), `text`, `token_count`, `delivery` (hook / prepend), `source_turn_ids` | UC-08, UC-10 |
| "Read by" | `mcp_reads` log: `tool`, `params`, `record_id`, `caller_agent`, `at` | UC-10, UC-11 |
| Agent status | Per agent: `installed`, `version`, `signed_in`, `models[]`, `limit {used_pct, resets_at, source}` | UC-02, UC-03 |
| Skill sync | On `skills`: `origin` values (`user_created`, `agent_created`, `imported:<dir>`), `source_path`, `disk_sha256`, `last_synced_at` | UC-09 |

### To check against the real CLIs before building

1. Which hook events **Antigravity** (`agy`) and **Codex** support for prompt injection and tool approval, and their timeout limits.
2. Where each CLI reports **plan-limit usage** and **reset time**, and the exact wording or event of its limit-reached message.
3. How each CLI lists **available models** and whether the model can be changed **mid-session**.
4. Whether Codex and Antigravity read skills from `.agents/skills` directly or need a symlink like `.claude/skills`.

---

## 7. Open questions

1. When an agent hits its limit, should Chorus switch automatically (with undo) or always ask, as in UC-08?
2. Should the handoff summary be editable before it's sent?
3. Should an approval timeout deny, or pause the agent until the user returns?
4. Should Shared memory be per chat, per project, or both (the ledger file is global today)?
