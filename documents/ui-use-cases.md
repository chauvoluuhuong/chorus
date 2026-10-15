# UI Use Cases — Chorus Desktop

> Companion to [`ui-mockup-v2.html`](ui-mockup-v2.html). Open it in a browser and use the buttons at the top; each one is labelled with the use case IDs it shows.
>
> [`ui-mockup.html`](ui-mockup.html) is the v1 mockup, kept for history only.

---

## 1. The core value, in one line

**Start a chat, pick which coding agent does the work (Claude Code, Antigravity or Codex), and when that agent hits its usage limit, hand the chat to another one without starting over.**

Everything else in the app supports that loop.

```text
 New chat ──► Pick agent ──► Installed? ──no──► Install popup ──┐
                                 │ yes                          │
                                 ▼                              │
                               Chat ◄───────────────────────────┘
                                 │
         ┌───────────────────────┼─────────────────────────┐
         ▼                       ▼                         ▼
  Agent needs approval    Agent makes a file        Usage limit reached
  → bell notification     → artifact card,          → "Continue with Codex"
    Allow / Don't allow     opens in side panel       → new agent gets a summary
                                                        and keeps going
```

---

## 2. It looks and works like an AI chat desktop app

Chorus copies the layout and feel of the Claude desktop app on purpose. People already know how to use it.

| Element | How it looks in Chorus |
|---|---|
| **Home** | Logo and a serif greeting ("Good evening, Linh"), a large rounded message box, quick-start chips under it |
| **Sidebar** | New chat, Chats, Skills, Activity, Recents, the user at the bottom. Each recent chat shows a small mark for the agent it uses. |
| **Messages** | Sans-serif text. The user's messages sit in a beige bubble on the right. The agent's replies are plain text on the left, signed with the agent's name. |
| **Tool use** | One quiet line under the reply ("Created 2 files, edited 1 file ›") that expands to a short plain list |
| **Message box** | `+` (attach), skills, **agent picker** at the bottom right (where Claude has its model picker), clay send button |
| **Artifacts** | A card in the chat ("Order a cake page · Web page · Click to open"). Clicking it opens a side panel with Preview / Code. |
| **Approvals** | A **bell icon** at the top right with a count badge. Approvals live in its dropdown, like notifications. |
| **Type** | Sans-serif for UI and messages; serif only for the home greeting and page titles. Same warm off-white and dark charcoal backgrounds, one clay accent. |

---

## 3. Words on screen

| Internal term | What the user sees |
|---|---|
| CLI, binary, `agy` / `claude` / `codex` | Agent: **Claude Code**, **Antigravity**, **Codex** |
| PreToolUse hook / intercepted tool call | Approval in the bell: "Set up storage for cake orders" with **Allow** / **Don't allow** |
| Context handoff | "Continued with Codex", plus a collapsible "What Codex was told" |
| Usage limit / rate limit | "Claude Code has reached its usage limit. It resets at 6:00 PM." |
| Tool telemetry | "Created 2 files, edited 1 file" |
| Shared bus, context ledger | Activity page: **Timeline** and **Shared memory** |
| `.agents/skills` | **Skills** |

---

## 4. Use cases

### UC-01 · Start a new chat *(mockup: "New chat")*

- **Trigger**: App opens, or **New chat** in the sidebar.
- **Main flow**
  1. Home shows the greeting, the message box and quick-start chips (Build a page, Fix something, Make a tool, Explain my code).
  2. The agent picker in the message box shows the last used agent (Claude Code on first run, or the first installed one).
  3. The user types and sends. The chat opens with the selected agent.
- **Acceptance criteria**
  - [ ] AC-01.1: No setup screens before the first chat. The only choice is the agent, and it has a default.
  - [ ] AC-01.2: The first message creates the chat and a title is generated from it.

### UC-02 · Pick an agent *(mockup: "Pick an agent")*

- **Trigger**: Clicking the agent picker in the message box.
- **Main flow**
  1. A menu lists the three agents. Each has a one-line strength: "Great for building and fixing", "Great for planning big changes", "Great for testing and reviews".
  2. The current agent has a check. An agent that isn't installed shows an **Install** tag. An agent at its usage limit shows **Limit until 6 PM** and can't be picked.
  3. Footer: "Agents run on your computer with your own accounts."
- **Acceptance criteria**
  - [ ] AC-02.1: Chorus detects which agents are installed and signed in when it starts, and again when the menu opens.
  - [ ] AC-02.2: Picking an installed agent takes effect for the next message.

### UC-03 · The agent isn't installed *(mockup: "Agent not installed")*

- **Trigger**: Picking an agent with the **Install** tag.
- **Main flow**: a popup titled "Codex isn't installed yet" with "Codex runs on your computer. Install it once and use it in any chat." and three steps:
  1. **Install**: **Install for me** runs the installer in the background with a progress bar. Below it: "Or paste this into Terminal:" with the command and a copy button.
  2. **Sign in with ChatGPT**: opens the sign-in page in the browser.
  3. **Quick check**: Chorus confirms the agent runs.
  When all three are done, the title changes to "Codex is ready" and **Use Codex** selects it in the picker.
- **Alternate flows**
  - *Missing prerequisite* (e.g. Node.js): an extra first step, "Codex needs Node.js. **Install it for me**."
  - *Install fails*: "Couldn't install Codex. Check your internet connection and try again." with **Try again** and the manual command.
  - **Not now** closes the popup and keeps the previous agent selected.
- **Acceptance criteria**
  - [ ] AC-03.1: A user can install and sign in without opening a terminal.
  - [ ] AC-03.2: The manual command is always shown, with copy.
  - [ ] AC-03.3: Closing the popup never leaves the chat without a working agent.

### UC-04 · Chat with the agent *(mockup: "Chatting")*

- **Main flow**
  1. Each reply is signed with the agent's mark and name.
  2. Tool use collapses into one line ("Created 2 files, edited 1 file ›"). Expanding it shows plain steps.
  3. While the agent works, a small animated "Working…" line shows under the reply.
- **Acceptance criteria**
  - [ ] AC-04.1: No terminal output, file diffs or thinking traces in the chat.
  - [ ] AC-04.2: Every reply shows which agent wrote it.

### UC-05 · Approvals in the bell *(mockup: "Approvals in the bell")*

- **Trigger**: An agent wants to do something in an "ask first" category (§5).
- **Main flow**
  1. The agent pauses. The **bell** at the top right gets a badge with the number of pending approvals.
  2. In the chat, a row shows "Waiting for your approval · Set up storage for cake orders" with **Review**, which opens the bell with that item highlighted.
  3. The bell dropdown, "Notifications":
     - **Waiting for your approval**: one item per request, from any chat. Agent, chat name and time; a title in plain words; one sentence on what changes; "Show what will run" (collapsed); **Allow** / **Don't allow** / **Go to chat**.
     - **Earlier**: other notices ("Antigravity finished the holiday landing page").
  4. **Allow** marks the item "Allowed", the chat row turns green ("You allowed: …") and the agent continues. **Don't allow** tells the agent to find another way.
- **Alternate flows**
  - *Risky action* (deleting many files, publishing, touching files outside the project): a red **Risky** tag. **Allow** asks again with a specific button ("Yes, delete 214 files").
  - *App in the background*: also sent as a system notification.
- **Acceptance criteria**
  - [ ] AC-05.1: The agent stays paused until the user decides. Nothing is approved on a timeout (AC-2.2 in [system-architecture.md](system-architecture.md)).
  - [ ] AC-05.2: The bell shows approvals from all chats, newest first.
  - [ ] AC-05.3: The headline is the outcome, not the command. The command is one click away.

### UC-06 · Preview an artifact *(mockup: "Chatting")*

- **Trigger**: The agent creates or edits a web page, image, document or diagram.
- **Main flow**
  1. An artifact card appears in the reply.
  2. Clicking it opens a side panel with **Preview** / **Code**, copy, open in browser, and close.
  3. Later edits by any agent update the open preview and add a version.
- **Acceptance criteria**
  - [ ] AC-06.1: Artifacts are detected from file writes automatically (AC-5.1).
  - [ ] AC-06.2: Web pages render sandboxed and reload on change (AC-5.2, AC-5.3).

### UC-07 · Usage limit: hand off to another agent *(mockup: "Usage limit, hand off")*

This is the core of Chorus.

- **Trigger**: The current agent reports that its usage limit is reached.
- **Main flow**
  1. A card appears above the message box: "Claude Code has reached its usage limit. It resets at 6:00 PM. Hand this chat to another agent to keep going. It gets a summary of everything so far."
  2. Buttons: **Continue with Codex** (primary: the best installed alternative), **Continue with Antigravity**, **Wait until 6 PM** (sets a reminder).
  3. The message box is disabled until the user picks ("Pick an agent above to keep going").
  4. On **Continue with Codex**:
     - a divider "Continued with Codex" is added to the same chat
     - a collapsible "What Codex was told" shows the exact summary: goal, what's done, what's in progress, files
     - Codex replies that it has caught up and continues the unfinished work
     - the picker switches to Codex, and the chat's mark in Recents changes to Codex
- **Alternate flows**
  - *No other agent installed*: the card offers **Install Codex** (UC-03) or **Wait until 6 PM**.
  - *Other agents also limited*: the card lists when each resets.
  - *Manual switch without a limit*: picking another agent in the picker does the same handoff with a "Continued with …" divider.
  - *The original agent's limit resets*: the user can switch back the same way; the summary includes what the second agent did.
- **Acceptance criteria**
  - [ ] AC-07.1: The chat history stays in one thread across agents.
  - [ ] AC-07.2: The summary given to the new agent is under 200 tokens and covers goal, done, in progress, and files (AC-3.2, AC-3.3).
  - [ ] AC-07.3: The exact summary is visible in the chat ("What Codex was told") and in Activity → Shared memory.
  - [ ] AC-07.4: Pending approvals from the limited agent are cancelled and the new agent re-asks if it needs the same action.

### UC-08 · Recents show which agent each chat uses

- Each item in Recents has the mark of its current agent. After a handoff the mark changes.
- **Acceptance criteria**
  - [ ] AC-08.1: Opening an old chat restores its last agent in the picker.

### UC-09 · Skills *(mockup: "Skills")*

- **Main flow**
  1. Sidebar → **Skills**: a list of skills, each with a name, source ("Made in Chorus", "From Claude Code"), one-line description, **Edit**, an on/off switch, and **Synced to** pills (one per agent) to choose which agents get it.
  2. **New skill**: name, what it's for, instructions, **Write it for me**, **Add files**, sync targets.
  3. When Chorus finds skills in one agent that others don't have, a box offers "Found 2 skills in Codex" with checkboxes and **Share with all agents**.
- **Acceptance criteria**
  - [ ] AC-09.1: Turning a skill off removes it from the agents but keeps it in Chorus (AC-4.7).
  - [ ] AC-09.2: Multi-file skills keep their folders and script permissions (AC-4.5, AC-4.6).
  - [ ] AC-09.3: Nothing found in an agent is shared without the user choosing it.

### UC-10 · Activity *(mockup: "Activity")*

For people who want the detail. It is a separate page, not a mode.

- **Timeline**: every step by every agent, newest first: time, agent, kind (Started, Changed files, Made an artifact, Asked for approval, Took over), a plain sentence, and the exact files or command.
- **Shared memory**: per chat, what all agents know (goal, done, next, files) and each handoff summary word for word.
- **Acceptance criteria**
  - [ ] AC-10.1: Every tool run, approval, artifact and handoff appears in the Timeline.
  - [ ] AC-10.2: Shared memory mirrors the context ledger in [context-and-storage-spec.md](specs/context-and-storage-spec.md).

---

## 5. Approval levels

| Level | Shown as | Examples |
|---|---|---|
| **No approval** | Only the "Created 2 files…" line | Read or edit files inside the project, run the project's tests, start the dev server |
| **Ask** | Bell item with **Allow** / **Don't allow** | Change database structure, install a package, contact a web service, run an unfamiliar command |
| **Risky** | Bell item with a red **Risky** tag and a second confirmation | Delete many files, touch files outside the project, publish or deploy, use stored passwords or keys |

| Exact command ("Show what will run") | Title in the bell |
|---|---|
| `npx prisma migrate dev --name add_orders` | Set up storage for cake orders |
| `rm -rf ./dist` | Delete 214 old build files |
| `npm install stripe` | Add a payments tool (Stripe) |
| `vercel deploy --prod` | Publish your website |

---

## 6. Open questions

1. When an agent hits its limit, should Chorus **pick the next agent automatically** (with an undo), or always ask as in UC-07?
2. Should the handoff summary be **editable** before it's sent, or only viewable?
3. Should approvals that were pending on the limited agent **carry over** to the new agent instead of being cancelled (AC-07.4)?
4. Should the user be able to set a **preferred order** of agents for handoffs (e.g. Claude Code → Codex → Antigravity)?
