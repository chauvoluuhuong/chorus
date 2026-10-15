# UI Use Cases — Chorus Desktop

> Companion to [`ui-mockup-v2.html`](ui-mockup-v2.html). Open it in a browser and use the buttons at the top; each one is labelled with the use case IDs it shows.
>
> [`ui-mockup.html`](ui-mockup.html) is the v1 mockup, kept for history only. It is superseded by v2.

---

## 1. Product concept in one paragraph

Chorus is a desktop app that feels like the Claude desktop app, but the "model" you talk to is a **coding agent running on your computer**: Claude Code, Antigravity or Codex. You chat with an agent in the middle of the screen. When an agent wants to do something important, it **pauses and asks you in the right panel**. When an agent makes something you can look at (a web page, an image, a document), it shows up as an **artifact** you can open in that same right panel. Agents share one memory of the project, so you can switch agents mid-chat without explaining again. Skills are shared across agents from one place. A separate **Activity** page holds the full detail for anyone who wants it.

---

## 2. Layout

```text
┌────────────┬───────────────────────────────────────┬──────────────────────────┐
│ Sidebar    │ Chat                                  │ Right panel              │
│            │                                       │ (only when needed)       │
│ + New chat │  Cake order page        [2 need you]  │ [Needs you 2] [Artifact] │
│ Chats      │                                       │                          │
│ Skills     │  You: Add a page where customers…     │  Approval cards          │
│ Activity   │  Claude Code: Done. …                 │    or                    │
│            │   [Order a cake page · Web page]      │  Artifact preview        │
│ Project ▾  │   [Waiting for your OK]               │                          │
│ Recents    │  ── Codex caught up on this chat ──   │                          │
│ …          │                                       │                          │
│ Agents     │ ┌───────────────────────────────────┐ │                          │
│ ● Claude   │ │ Reply to Claude Code…             │ │                          │
│ ● Antigrav │ │ 📎  ✦ 3 skills    [Claude Code ▾] ↑│ │                          │
│ ● Codex    │ └───────────────────────────────────┘ │                          │
└────────────┴───────────────────────────────────────┴──────────────────────────┘
```

| Area | Holds | Never holds |
|---|---|---|
| **Sidebar** | New chat, Chats, Skills, Activity, project switcher, recent chats, each agent's status (Ready / Working / Needs you / Not set up) | Process IDs, file paths, versions |
| **Chat** | Your messages, agent replies, a collapsed "Worked for 2 min · changed 3 files" summary, artifact cards, "Waiting for your OK" chips, "switched / caught up" dividers | Raw terminal output, hook data, thinking traces |
| **Composer** | Message box, attach, skills count, **agent picker** (like Claude's model picker), send | — |
| **Right panel** | Only two things: **Needs you** (approvals) and **artifacts** (preview). It opens when there is something there and closes when there isn't. | Live app preview, logs, file lists, settings |
| **Activity page** | Timeline of everything every agent did, and **Shared memory** (what agents know and told each other) | — |

On a phone-width window the sidebar becomes a top row, and the right panel moves under the chat.

---

## 3. Design rules

| # | Rule |
|---|---|
| R1 | **Look and behave like the Claude desktop app.** Warm neutral surfaces, serif for agent replies and headings, one clay accent, a large rounded composer, artifacts in a side panel. |
| R2 | **Ask very little up front.** First launch only asks which agents to use. Everything else has a sensible default. |
| R3 | **The right panel is for action and results only.** Approvals and artifacts. Nothing else. |
| R4 | **Agents are chosen like models.** The picker lives in the composer. Switching keeps the chat. |
| R5 | **Every approval says what will happen in plain words first.** The exact command is one click away ("Show exactly what will run"), never the headline. |
| R6 | **No technical mode.** Detail lives on the Activity page, which anyone can open at any time. |
| R7 | **Skills are managed in one place** and synced to the agents you choose. |
| R8 | **Every error offers a next step.** |

---

## 4. Words we use

| Internal term | On screen |
|---|---|
| CLI, binary, `agy` / `claude` / `codex` | **Agent**: Claude Code, Antigravity, Codex |
| PreToolUse hook, intercepted tool call | **Needs you**, "Waiting for your OK" |
| Allow / deny decision | **Allow**, **Don't allow**, **Ask why** |
| Tool calls, tool telemetry | "Worked for 2 min · changed 3 files" (expandable plain list) |
| Context handoff, PreInvocation injection | "Codex caught up on this chat" |
| `agent-bridge-mcp` `ask_peer_agent` | "Claude Code asked Codex to test the site" |
| Shared bus | **Activity → Timeline** |
| Context ledger (turns, handoff summaries) | **Activity → Shared memory** |
| `.agents/skills`, skill bundle, materialize / dematerialize | **Skills**: on / off, "Synced to" |
| Artifact registry entry | **Artifact** card ("Order a cake page · Web page") |
| Workspace / repo / cwd | **Project** ("Sweet Crumb Bakery") |

---

## 5. Personas

| Persona | Who | What they need from Chorus |
|---|---|---|
| **Linh, bakery owner** | Has never used a terminal. Has a Claude subscription. | Get an order page live without breaking her site. |
| **Marco, product marketer** | Uses Notion and Figma. Has ChatGPT and Claude. | Use whichever agent is best for each step, and never answer a question he doesn't understand. |
| **Dana, indie developer** | Knows Git and the terminal. Uses all three agents. | See exactly what ran and what agents told each other (Activity page). |

---

## 6. Use cases

Each use case lists the trigger, the main flow, the words on screen, alternate flows and acceptance criteria.

### Getting started

#### UC-01 · Pick your agents *(mockup: "Pick your agents")*

- **Trigger**: First launch.
- **Main flow**
  1. One screen: "Which AI agents do you want to use?" with a row per agent: Claude Code, Antigravity, Codex.
  2. Chorus has already checked the computer. Each row shows **Installed** or **Not installed · Set up**.
  3. Installed agents are pre-selected. The user ticks or unticks agents and clicks **Start building**.
  4. The app opens on a new chat in the default project folder, using the first selected agent.
- **Copy**: "Pick one or more. You can switch between them in any chat, and change this later."
- **Alternate flows**
  - *A selected agent isn't installed*: footer says "Codex isn't installed yet. Set it up now, or start without it." **Start building** still works if at least one selected agent is ready.
  - *Nothing installed*: all rows show **Set up**; **Start building** is disabled until one agent is ready.
- **Acceptance criteria**
  - [ ] AC-01.1: First launch has exactly one decision (which agents). No project, theme, permission or account questions.
  - [ ] AC-01.2: Installed agents are detected automatically and pre-selected.
  - [ ] AC-01.3: The user can reach a working chat in two clicks if any agent is installed.

#### UC-02 · Install helper for a missing agent *(mockup: "Install helper")*

- **Trigger**: **Set up** on an agent (from UC-01, the agent picker, or the sidebar).
- **Main flow**: a sheet "Set up Codex" with three steps:
  1. **Install** — **Install for me** (Chorus runs the installer in the background with a progress bar). Under it: "Prefer to do it yourself? Paste this into Terminal:" and the command with a **Copy** button.
  2. **Sign in** — "Codex uses your ChatGPT account. A sign-in page opens in your browser." **Sign in**.
  3. **Check it works** — Chorus runs a quick test and shows "Codex is ready."
  Each step turns into a green check when done. **Done** closes the sheet; the agent is now selectable.
- **Alternate flows**
  - *A prerequisite is missing* (e.g. Node.js for npm-based agents): an extra first step "Codex needs Node.js. **Install it for me**."
  - *Install fails*: "Couldn't install Codex. Check your internet connection and try again." with **Try again** and the manual command.
  - *User closes the sheet*: **Do this later**; the agent stays "Not set up" and can be finished from the sidebar.
- **Acceptance criteria**
  - [ ] AC-02.1: A non-technical user can install and sign in to an agent without opening a terminal.
  - [ ] AC-02.2: The manual command is always shown as an alternative, with copy.
  - [ ] AC-02.3: Install runs in the background; the rest of the app stays usable.

#### UC-03 · Start a chat in a project

- **Trigger**: **New chat** or the project switcher in the sidebar.
- **Main flow**
  1. **New chat** opens an empty chat in the current project with the last used agent selected.
  2. The project switcher lists recent projects and **Open folder…**.
  3. A first-time project starts in a default folder named after the first request ("Sweet Crumb Bakery").
- **Acceptance criteria**
  - [ ] AC-03.1: The project shows by name; the folder location only appears in the project switcher's menu.
  - [ ] AC-03.2: Every chat belongs to one project; Recents shows chats of the current project.

### Working with agents

#### UC-04 · Chat with an agent *(mockup: "Chat + approvals")*

- **Trigger**: User sends a message.
- **Main flow**
  1. The reply streams in as normal text (serif), signed with the agent's name.
  2. While working, a collapsed line shows progress: "Working… · reading your website". When done it becomes "Worked for 2 min · changed 3 files". Expanding it shows a short plain list ("Created the 'Order a cake' page").
  3. Anything the agent made that can be previewed appears as an **artifact card** under the reply (UC-06).
  4. The agent's status in the sidebar moves Ready → Working → Ready.
- **Alternate flows**
  - *User sends another message while the agent works*: it queues under the current reply with **Send now** / **Remove**.
  - *Stop*: the send button becomes **Stop** while the agent works.
  - *Attach*: images and files can be attached from the composer.
- **Acceptance criteria**
  - [ ] AC-04.1: No raw tool names, file diffs or terminal output appear in the chat.
  - [ ] AC-04.2: The progress line is collapsed by default once the agent finishes.
  - [ ] AC-04.3: Skills count in the composer reflects skills that are on and synced to the selected agent.

#### UC-05 · Approve or decline an action *(mockup: "Chat + approvals")*

- **Trigger**: An agent tries an action in an "ask first" category (§7).
- **Main flow**
  1. The agent pauses. In chat, a chip says **Waiting for your OK**. The chat header shows "2 need you". The sidebar agent shows **Needs you**.
  2. The right panel opens on **Needs you** with one card per pending action, newest first:
     - Agent name, level tag (**Please check** or **Risky**), time
     - Title in plain words: "Set up storage for cake orders"
     - One or two sentences on what changes and what doesn't
     - **Show exactly what will run** (collapsed): the command and files
     - Optional: "Always allow database changes in this project"
     - **Allow** · **Don't allow** · **Ask why**
  3. **Allow**: the card moves to "Earlier in this chat · Allowed …", the chat chip turns green ("You allowed this"), and the agent continues.
  4. When nothing is pending and no artifact is open, the right panel closes.
- **Alternate flows**
  - *Risky action*: **Allow** asks for a second click with a specific label ("Yes, delete 214 files"). "Always allow" is not offered.
  - *Don't allow*: the chip turns red ("You said no"); the agent gets the refusal and suggests another way ("I can email each order to you instead").
  - *Ask why*: focuses the composer for that agent with "Why do you need to do this? Is there a safer way?" The action stays paused.
  - *Clicking a "Waiting for your OK" chip*: opens the panel and highlights that card.
  - *App in background*: a system notification "Claude Code needs your OK to keep going."
  - *Multiple agents*: cards from all agents in this chat appear in one list.
- **Acceptance criteria**
  - [ ] AC-05.1: The agent stays paused until the user decides; nothing auto-approves on timeout (maps to AC-2.2 in [system-architecture.md](system-architecture.md)).
  - [ ] AC-05.2: The card headline is the outcome, not the command; the command is available on demand.
  - [ ] AC-05.3: "Always allow" is scoped to one category in one project and can be undone from the project menu.
  - [ ] AC-05.4: Risky actions need a confirming second click.
  - [ ] AC-05.5: The right panel never shows anything other than approvals and artifacts.

#### UC-06 · Preview an artifact *(mockup: "Preview an artifact")*

- **Trigger**: An agent creates or edits a previewable file: web page (`.html`), image (`.png`, `.jpg`, `.svg`), document (`.md`), diagram.
- **Main flow**
  1. An artifact card appears in the chat: icon, title ("Order a cake page"), type ("Web page"), "Click to open".
  2. Clicking it opens the artifact as a tab in the right panel next to **Needs you**.
  3. Web pages render live in a sandboxed frame; documents render as formatted text; images with zoom.
  4. Header: title and a **version** picker (each agent edit makes a new version). Footer: **Open in browser** / **Copy** / **Save to project**, and **Ask for changes** (focuses the composer).
  5. When the agent edits the same artifact again, the open preview updates in place.
- **Alternate flows**
  - *Approvals arrive while an artifact is open*: the **Needs you** tab shows a count badge; the artifact stays open.
  - *Close*: the × on the tab closes the artifact; the panel closes if nothing else is in it.
- **Acceptance criteria**
  - [ ] AC-06.1: Artifacts are detected from agent file writes automatically (AC-5.1).
  - [ ] AC-06.2: HTML renders sandboxed and hot-reloads on change (AC-5.2, AC-5.3).
  - [ ] AC-06.3: Previous versions can be viewed.
  - [ ] AC-06.4: Only files the user would want to see become artifacts (no config files, lockfiles, source code by default).

#### UC-07 · Switch agent mid-chat

- **Trigger**: User picks another agent in the composer's agent picker.
- **Main flow**
  1. The picker lists each agent with a one-line strength ("Writes and fixes code", "Plans bigger changes", "Tests and reviews") and a check on the current one.
  2. Picking another agent adds a divider: "Switched to Antigravity · caught up on this chat".
  3. The new agent receives a short summary from Shared memory (goal, what's done, files, open items) and continues in the same chat.
- **Alternate flows**
  - *Agent not set up*: picking it opens the install helper (UC-02).
  - *Agent at its usage limit*: shown in the picker as "Paused until 6:00 PM" and can't be picked.
- **Acceptance criteria**
  - [ ] AC-07.1: The chat history stays in one thread across agents; each reply is labelled with its agent.
  - [ ] AC-07.2: The summary given to the new agent stays under 200 tokens and is viewable in Activity → Shared memory (AC-3.2, AC-3.3).

#### UC-08 · One agent asks another

- **Trigger**: The user types `@Codex …`, or an agent decides it needs another agent ("Claude Code asked Codex to run the tests").
- **Main flow**
  1. A divider in the chat: "Claude Code asked Codex to test the site · Codex caught up on this chat".
  2. The asked agent's replies appear in the same chat, labelled with its name.
  3. Its approvals go to the same **Needs you** list.
- **Acceptance criteria**
  - [ ] AC-08.1: Agent-to-agent requests are always visible in the chat and in Activity.
  - [ ] AC-08.2: The same approval rules apply to work done on another agent's behalf.

#### UC-09 · Something went wrong

- **Trigger**: An agent can't finish (test fails, app won't start, missing file).
- **Main flow**: the agent's reply explains in plain words what's broken and what still works, followed by suggested actions as buttons: **Try to fix it**, **Ask another agent** (opens the picker), **Show details** (opens Activity filtered to this step).
- **Acceptance criteria**
  - [ ] AC-09.1: Raw error text is never the first thing the user sees; it is available in Activity.
  - [ ] AC-09.2: There are always at least two ways forward.

### Skills

#### UC-10 · Browse, turn on and off, and choose where skills sync *(mockup: "Skills")*

- **Trigger**: Sidebar → **Skills**, or the skills count in the composer.
- **Main flow**
  1. Page title "Skills": "Instructions and small tools your agents follow. Turn a skill on and Chorus keeps it in sync with every agent you pick."
  2. Search box and **All / On / Off** filter.
  3. One row per skill: name, where it came from ("Made in Chorus", "From Claude Code"), one-line description, **Edit**, and an on/off switch.
  4. Under each row, **Synced to** pills, one per agent. Clicking a pill adds or removes that agent.
- **Behavior**
  - **On** → Chorus writes the skill (with its files and scripts) into each selected agent's skill folder.
  - **Off** → Chorus removes it from the agents' folders but keeps it in Chorus, so turning it back on restores it.
  - Agents that aren't set up show a disabled pill.
- **Acceptance criteria**
  - [ ] AC-10.1: Turning a skill on/off or changing its sync targets takes effect from the agent's next message (AC-4.7).
  - [ ] AC-10.2: Folder paths are not shown on this page.
  - [ ] AC-10.3: Turning a skill off never deletes it.

#### UC-11 · Add or edit a skill

- **Trigger**: **New skill** or **Edit** on the Skills page.
- **Main flow**: a sheet with
  - **Name**
  - **What it's for** (one line; agents use it to decide when the skill applies)
  - **Instructions** (plain text)
  - **Write it for me** (an agent drafts the instructions from the one-line description)
  - **Add files** (scripts, templates, examples)
  - **Sync to** checkboxes per agent
  - **Create and turn on** / **Save**
- **Alternate flows**
  - *An agent offers to save a skill during a chat* ("Want me to save this as a skill?"): opens the same sheet pre-filled.
  - *Import*: **New skill → Import** from a folder or a file.
- **Acceptance criteria**
  - [ ] AC-11.1: A new skill can be created with only a name and one line of description.
  - [ ] AC-11.2: Multi-file skills keep their folder structure and script permissions (AC-4.5, AC-4.6).

#### UC-12 · Share skills found in one agent *(mockup: "Skills")*

- **Trigger**: Chorus finds skills in an agent's own folder that other agents don't have.
- **Main flow**
  1. A banner at the top of Skills: "Found 2 skills in Codex that your other agents don't have. Pick which ones to share."
  2. Each found skill is listed with a checkbox (pre-ticked), name and description.
  3. **Share with all agents** adds them to the list as "From Codex", on, synced to all set-up agents.
  4. **Not now** hides the banner; the skills stay available under **New skill → Import**.
- **Acceptance criteria**
  - [ ] AC-12.1: Discovery runs on launch and when an agent is set up.
  - [ ] AC-12.2: Nothing is synced without the user's choice.

### Detail for those who want it

#### UC-13 · See everything that happened (Activity → Timeline) *(mockup: "Activity")*

- **Trigger**: Sidebar → **Activity**, or **Show details** from a problem (UC-09).
- **Main flow**
  1. Reverse-chronological timeline for the current project. Each row: time, agent, kind of event (Started, Changed files, Ran a check, Made an artifact, Asked another agent, Caught up, Asked for approval), a plain sentence, and where useful the files touched and the exact command.
  2. Filter by agent.
- **Acceptance criteria**
  - [ ] AC-13.1: Every tool run, approval, artifact, handoff and agent-to-agent request is listed.
  - [ ] AC-13.2: Long outputs are linked, not inlined (AC-4.3).

#### UC-14 · See what agents know (Activity → Shared memory) *(mockup: "Activity")*

- **Trigger**: Activity → **Shared memory**.
- **Main flow**
  1. "What every agent can see about this project. When you switch agents, they start from here."
  2. One card per request: goal, outcome, files, checks, artifacts, still to do.
  3. Under the card, any summary handed to another agent, word for word ("What Codex was told").
- **Acceptance criteria**
  - [ ] AC-14.1: Shared memory mirrors the context ledger (`turns` and handoff summaries in [context-and-storage-spec.md](specs/context-and-storage-spec.md)).
  - [ ] AC-14.2: The exact text sent to an agent in a handoff is always viewable.

### Edge cases

#### UC-15 · Agent unavailable

- **Trigger**: Usage limit, signed out, or offline.
- **Main flow**: the sidebar shows **Paused** with the reason ("Usage limit until 6:00 PM", "Signed out"). In chat: "Claude Code reached its usage limit until 6:00 PM." with **Switch agent** and **Sign in again** (when signed out).
- **Acceptance criteria**
  - [ ] AC-15.1: The message says when or how the agent becomes available again.
  - [ ] AC-15.2: Pending approvals and work done so far are kept.

#### UC-16 · Several agents working, app in background

- **Main flow**: each agent's status updates in the sidebar. A system notification is sent when an agent needs approval, finishes, or gets stuck. Clicking it opens the right chat with the panel on **Needs you**.
- **Acceptance criteria**
  - [ ] AC-16.1: Background work never steals focus.
  - [ ] AC-16.2: Two agents never edit the same file at once without the user being told.

#### UC-17 · Quit while an agent is working

- **Main flow**: "Claude Code is still working. Keep it running in the background, or stop it now?" **Keep running** · **Stop and quit**. On next launch: "Claude Code stopped when you quit. Continue?"
- **Acceptance criteria**
  - [ ] AC-17.1: Pending approvals survive a restart.

---

## 7. Approval levels

| Level | On card | Examples | "Always allow" offered |
|---|---|---|---|
| **No card** | — | Read files, edit files inside the project, run the project's own tests, start the dev server | n/a |
| **Please check** (amber) | Plain title + explanation | Change database structure, install a package, contact a web service, run an unfamiliar command | Yes, per category per project |
| **Risky** (red) | Plain title + explanation + second confirmation | Delete many files, touch files outside the project, publish/deploy, use stored passwords or keys, spend money | No |

Example translations the risk analyzer produces (roadmap Phase 3):

| Exact command (behind "Show exactly what will run") | Card title | Explanation |
|---|---|---|
| `npx prisma migrate dev --name add_orders` | Set up storage for cake orders | Adds an "Orders" table so each order is kept. Your menu and customer list aren't changed. |
| `rm -rf ./dist` | Delete 214 old build files | These files are rebuilt automatically. Your own work isn't touched. |
| `npm install stripe` | Add a payments tool (Stripe) | Downloads a well-known add-on so your site can take card payments. |
| `vercel deploy --prod` | Publish your website | Your changes go live for customers in about a minute. |
| `cat ~/.ssh/id_rsa` | Read a private key outside your project | This is unusual. We recommend **Don't allow**. |

---

## 8. Agent status

| Status | Dot | Where it shows |
|---|---|---|
| Ready | green | Sidebar, agent picker |
| Working | clay, pulsing | Sidebar; progress line in chat |
| Needs you | amber | Sidebar; "Waiting for your OK" chip; "N need you" in chat header |
| Paused | grey | Sidebar, agent picker (with reason) |
| Not set up | grey | Sidebar, agent picker, onboarding (with **Set up**) |

---

## 9. Open questions

1. Should the user be able to keep **two chats with different agents open side by side**, or is one chat at a time enough for v1?
2. Default **"ask first" list**: should installing packages ask by default for non-technical users, or only for unknown packages?
3. Should **artifacts** include source code files when the user asks to see them, or only web pages, images and documents?
4. Should **Skills** support per-project skills as well as global ones, or global only for v1?
5. Should **Activity** be per project (current proposal) or across all projects?
