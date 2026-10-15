# UI Use Cases: Simple Mode — Chorus

> Companion to [`ui-mockup-simple.html`](ui-mockup-simple.html). Open the mockup in a browser and use the scenario buttons at the top; each one is labelled with the use case ID it shows (UC-01, UC-03, …).
>
> The earlier [`ui-mockup.html`](ui-mockup.html) is kept as a reference for the **technical view** (power users only). It is no longer the default screen.

---

## 1. Why this document exists

The first mockup showed the machinery: process IDs, transcript paths, hook names, skill folders, raw terminal output and model version strings. That is useful for us as builders, but our target user (see [`product-concept.md`](../ideas/product-concept.md)) is a solo founder, marketer, designer or "vibe coder". For them every one of those labels is noise at best and a reason to feel anxious at worst.

This document defines:

1. The design rules for **Simple mode**, the default Chorus screen.
2. A vocabulary table: what we stop showing and what we say instead.
3. The use cases the UI must support, each with its flow, the words on screen, edge cases and acceptance criteria.

---

## 2. Design rules for Simple mode

| # | Rule | What it means in practice |
|---|------|---------------------------|
| R1 | **Talk about the user's project, never about our plumbing.** | Say "your website", "the order page", "saved orders". Never say "PTY", "hook", "MCP", "stdin", "JSONL", "PID", "binary". |
| R2 | **One question at a time.** | Only one approval card asks for a decision at once per helper. Others queue behind a "2 need your OK" pill. |
| R3 | **Every risky action is explained before it happens, in one sentence.** | Card title = what the helper wants to do. First line = what changes and what does not. |
| R4 | **Everything can be undone, and the user is told so.** | A save point is made before every change. The approval card says "Undo: Yes". |
| R5 | **Show results, not logs.** | The side panel shows the live website, a plain-language list of changes, and History. Logs are hidden. |
| R6 | **Progress is a short checklist, collapsed when done.** | "What Claude did · 4 of 4 steps · Show". No streaming tool calls. |
| R7 | **Errors say what broke, what still works, and offer a next step.** | "The order page is missing its cake photo. Everything else worked." + "Ask Codex to fix it". |
| R8 | **Helpers have names and jobs, not versions.** | "Claude · Writes and fixes", "Antigravity · Plans big changes", "Codex · Checks and tests". |
| R9 | **Technical detail is opt-in, never removed.** | Settings → "Show technical details" adds exact commands, a Technical log tab and the terminal. |
| R10 | **No dead ends.** | Every screen has a clear primary action. Every error has at least two ways forward. |

---

## 3. Vocabulary: what we hide and what we say instead

| Old label (v1 mockup / internal term) | Simple mode | Where the technical form still lives |
|---|---|---|
| `PID 4812`, `TTY Active`, process status | *Removed.* Helper status: **Working…**, **Ready**, **Finished**, **Needs your OK**, **Stuck**, **Catching up…** | Technical log |
| `~/.claude/projects/app/8f92a.jsonl` (transcript path) | *Removed.* | Technical log |
| `.agents/skills (4 shared)` | **Know-how** (Settings): "3 instructions your helpers share" | Settings → Know-how → "Show files" |
| `agy`, `claude`, `codex` (binary names) | **Antigravity**, **Claude**, **Codex** | Technical log |
| Model strings (`Sonnet 4.5`, `o4-mini`) | *Removed.* | Settings → Helpers |
| `PreToolUse (Bash)` / "Hook intercepted" | **Needs your OK** | Approval card, with technical details on |
| `npx prisma migrate deploy` | "Claude wants to create a place to save cake orders" | Approval card, with technical details on |
| `rm -rf ./dist` | "Codex wants to delete 214 old build files" | Approval card, with technical details on |
| Hook context sync / `PreInvocation` injection | **Catching up** — "Codex caught up on Claude's work: order page, form, and saved orders." | Technical log (token count) |
| "Inspect Hook JSON" | *Removed.* | Technical log |
| `mcp__agent_bridge__ask_agent` | **Asked a teammate** — "Claude asked Codex to test the form." | Technical log |
| Shared Bus | *Removed as a tab.* Relevant events appear as small notes in the conversation. | Technical log |
| Canvas UI / PTY Terminal toggle | *Removed.* Only one view by default. | Settings → Show technical details → "Open terminal" |
| Git checkpoint / commit / branch | **Save point**, **History**, **Go back here** | Technical log (commit hash) |
| Exit code 1, `ENOENT` | "Couldn't finish" + a plain sentence | Problem card, with technical details on |
| Diff | **Changes** → "See before and after" | Changes → "Line-by-line comparison" (technical) |
| Workspace / repo / cwd | **Project** ("Sweet Crumb Bakery") | Settings → Project → "Folder location" |

---

## 4. Personas used in the scenarios

| Persona | Who | What they fear | What "done" looks like |
|---|---|---|---|
| **Linh — bakery owner** | Runs a small bakery, built her site with a template. Has never opened a terminal. | Breaking the live website; losing orders. | Customers can order cakes online and she can see the orders. |
| **Marco — product marketer** | Comfortable with Notion and Figma. Builds landing pages and small internal tools. | Being asked questions he can't answer ("Run migration?"). | Ships a landing page by Friday without waiting for engineering. |
| **Dana — indie developer** | Knows Git and the terminal. Uses Chorus to run three agents side by side. | Losing control or visibility. | Can switch on technical details and see exactly what ran. |

Linh and Marco are the default audience. Dana is served by **Show technical details** (UC-14) and must never be the reason the default screen gets more complex.

---

## 5. Screen anatomy (Simple mode)

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ ▮ Project: Sweet Crumb Bakery ▾ │ (C) Claude   (A) Antigravity  (X) Codex  │ [1 needs your OK] ⚙ │
│                                 │  Working…     Ready            Ready      │                      │
├─────────────────────────────────────────────┬────────────────────────────┤
│ Conversation with the selected helper       │ Preview │ Changes │ History │
│  • your messages                            │                            │
│  • helper replies                           │  live website /             │
│  • "What Claude did · 4 of 4 steps"         │  plain list of changes /    │
│  • approval cards / problem cards           │  save points                │
│  • small notes ("Codex caught up…")         │                            │
│ [suggestion chips]                          │                            │
│ [ Ask Claude to…               ] [Pass to…] [Send]                       │
└─────────────────────────────────────────────┴────────────────────────────┘
```

- **Top bar**: project switcher, the three helpers with a one-word status, an attention pill when something needs a decision, and Settings.
- **Left**: conversation with the selected helper. Selecting a different helper switches the conversation; work in the background keeps going.
- **Right**: what the user actually cares about: the result (Preview), what changed (Changes), and how to go back (History).
- **Phone / narrow window**: helpers wrap to their own row, the side panel moves under the conversation, and sheets become full-screen modals.

---

## 6. Use cases

Each use case lists: **actor, trigger, preconditions, main flow, on-screen copy, alternate flows, acceptance criteria**. Copy in quotes is the intended wording; it can be refined but must keep the same level of plainness.

### UC-01 · First launch and helper setup *(mockup: "First launch")*

- **Actor**: Linh, first time opening Chorus.
- **Trigger**: App opens with no project and at least one helper missing or signed out.
- **Preconditions**: None.

**Main flow**
1. Chorus shows "Let's get your helpers ready" with one card per helper.
2. Each card shows a state: **Ready · signed in as you**, **Not installed yet**, or **Needs you to sign in**.
3. Linh clicks **Install for me** on Antigravity. A progress bar replaces the button; she can keep going.
4. Linh clicks **Sign in** on Codex. Her browser opens the provider sign-in page; the card turns **Ready** when she returns.
5. Below the cards Linh picks **Open a project**, **Start something new**, or **Use a starter**.

**Copy**: "Chorus works with three AI helpers. You only need one to start. We'll install anything that's missing, so you don't have to type commands."

**Alternate flows**
- *Install fails* (no internet, disk full): card says "Couldn't install Antigravity. Check your internet connection, then try again." with **Try again** and **Skip for now**.
- *No helper ready at all*: project buttons are disabled with the hint "Get at least one helper ready to start."
- *Corporate machine blocks installs*: "Your computer didn't allow the install. Ask your IT team to allow Antigravity, or skip it."

**Acceptance criteria**
- [ ] AC-01.1: A user can reach a working project without typing any command.
- [ ] AC-01.2: Install runs in the background; the user can open a project while it runs.
- [ ] AC-01.3: No paths, version numbers or package-manager names appear on this screen.

---

### UC-02 · Open or start a project

- **Actor**: Linh or Marco.
- **Trigger**: Clicks the project switcher or a start option.

**Main flow**
1. **Open a project** → system folder picker. The project is named after the folder ("Sweet Crumb Bakery").
2. **Start something new** → one text box: "Describe what you want to build in a sentence." Chorus creates the folder in the default projects location and hands the description to the default helper as the first request.
3. **Use a starter** → cards: Shop website, Booking page, Internal tool, Landing page.

**Alternate flows**
- *Folder isn't a project yet* (empty or random files): "This folder doesn't have a website or app in it yet. Start one here?"
- *Folder has unsaved changes from outside Chorus*: a save point "Changes made outside Chorus" is created silently so UC-09 still works.

**Acceptance criteria**
- [ ] AC-02.1: The project is shown by name; the full path only appears in Settings → Project.
- [ ] AC-02.2: A save point is created when a project is first opened.

---

### UC-03 · Ask a helper to do something *(mockup: "Working on a request")*

- **Actor**: Linh.
- **Trigger**: Types "Add a page where customers can order a birthday cake and pick it up later." and presses **Send**.

**Main flow**
1. The helper replies in one or two sentences describing the plan.
2. A step list appears: "Working on it · 1 of 4 steps". Each step is a plain past-tense sentence ("Created the 'Order a cake' page"). The current step shows a spinner.
3. The helper's status in the top bar shows **Working…**.
4. The Preview tab updates live as files change.
5. When finished, the list collapses to "What Claude did · 4 of 4 steps · Show" and the status becomes **Finished**.

**Alternate flows**
- *User switches to another helper while this one works*: work continues; the top bar status keeps updating.
- *User sends a new message while the helper works*: it is queued and shown as "Next: …" under the step list, with **Send now** (interrupt) and **Remove**.
- *User wants to stop*: a **Stop** button replaces **Send** while the helper works. Stopping keeps what was done and makes a save point.
- *Request is vague*: the helper asks one clarifying question with up to three quick-reply chips.

**Acceptance criteria**
- [ ] AC-03.1: No raw tool names (Edit, Bash, replace_file_content) appear in the step list.
- [ ] AC-03.2: Each step is one sentence of at most ~12 words.
- [ ] AC-03.3: Thinking traces are not shown in Simple mode.
- [ ] AC-03.4: Suggestion chips under the conversation offer 1–3 likely next requests.

---

### UC-04 · Approve or decline a risky action *(mockup: "Needs your OK")*

- **Actor**: Linh.
- **Trigger**: A helper tries an action that falls into an "ask first" category (see §7).

**Main flow**
1. The helper pauses. Its status becomes **Needs your OK** (amber). The top bar shows "1 needs your OK".
2. An approval card appears in the conversation:
   - Risk tag: "Please check · changes stored data"
   - Title: "Claude wants to create a place to save cake orders"
   - One sentence on what changes and what doesn't: "This adds a new 'Orders' list to your website's storage. Your existing menu and customer list stay as they are."
   - Facts: **Affects**: Your website's saved information · **Undo**: Yes, a save point is made first
   - "What does this mean?" expands a 2–3 sentence explanation with an everyday analogy.
   - Checkbox: "Don't ask again for storage changes in this project"
   - Buttons: **Allow** · **Don't allow** · **Ask Claude about it**
3. Linh clicks **Allow**. A save point is made, the card collapses to "✓ You allowed this. Claude is creating the place to save orders.", and the helper continues.

**Alternate flows**
- *Don't allow*: card collapses to "✕ You said no. Claude won't change how orders are stored and will suggest another way." The helper receives the refusal and proposes an alternative.
- *Ask Claude about it*: the composer is pre-filled with "Why do you need to change how orders are stored? Is there a simpler way?" The action stays paused until Linh decides.
- *Several approvals pending*: the pill says "3 need your OK". Clicking it jumps to the oldest. Each helper shows at most one card at a time.
- *User is away*: the helper waits indefinitely; a system notification says "Claude needs your OK to keep going." No timeout auto-approves.
- *High-risk action* (delete many files, touch files outside the project, spend money, publish to the internet): red tag "Risky", the **Allow** button needs a second click ("Yes, delete 214 files"), and "Don't ask again" is not offered.
- *Technical details on*: the exact command is shown in a monospace box under the explanation (Dana's case).

**Acceptance criteria**
- [ ] AC-04.1: The card title describes the outcome in the user's terms, not the command.
- [ ] AC-04.2: The command text is hidden unless technical details are on.
- [ ] AC-04.3: Every card states whether the action can be undone.
- [ ] AC-04.4: The helper stays paused until a decision; nothing is auto-approved on timeout.
- [ ] AC-04.5: "Don't ask again" is scoped to one category in one project and can be reversed in Settings → Ask before.
- [ ] AC-04.6: Risky actions require a confirming second click.

---

### UC-05 · See what changed

- **Actor**: Marco.
- **Trigger**: Opens the **Changes** tab after a helper finishes.

**Main flow**
1. The tab lists changes grouped by what the user sees: "New · Page: Order a cake", "Updated · Menu bar", "New · Saved orders".
2. Each item has one sentence of description and a **See before and after** toggle showing a plain before/after ("Menu · About" → "Menu · Order a cake · About").
3. For visual changes, before/after is shown as two small screenshots.

**Alternate flows**
- *Technical details on*: each change links to a line-by-line code comparison.
- *Many small file edits*: grouped under one user-visible change ("Updated the checkout page") rather than listed per file.

**Acceptance criteria**
- [ ] AC-05.1: Changes are grouped by page/feature, not by file.
- [ ] AC-05.2: No file names or line counts appear unless technical details are on.

---

### UC-06 · Pass the work to another helper *(mockup: "Pass to another helper")*

- **Actor**: Linh.
- **Trigger**: Clicks **Pass to…** or a suggestion chip like "Pass to Codex to test it".

**Main flow**
1. A sheet opens: "Pass this work to another helper".
2. Linh picks a helper card (name + job). Codex is preselected because the next step is testing.
3. A pre-filled, editable summary shows exactly what the new helper will be told:
   ```
   Goal: Let customers order a birthday cake online and pick it up later.
   Done so far: Claude added an "Order a cake" page with a form. New orders are saved and show on a private Orders page.
   Please: Check that ordering works on a phone and fix anything that's broken.
   ```
4. Hint: "If they need more detail, they can look through Claude's work themselves. Your conversation stays here."
5. **Send to Codex** switches to Codex's conversation. Codex shows **Catching up…** briefly, then a note: "Codex caught up on Claude's work: order page, form, and saved orders."

**Alternate flows**
- *Linh switches helper tabs directly without passing work*: the new helper is still caught up automatically (the short summary is injected); a note says so. No sheet is shown.
- *Target helper is busy*: "Codex is busy with another task. Send when it's free?" with **Queue it** / **Pick another helper**.
- *Target helper isn't set up*: card is disabled with "Not set up · Set up".

**Acceptance criteria**
- [ ] AC-06.1: The summary is visible and editable before sending (maps to AC-3.1 in [system-architecture.md](system-architecture.md)).
- [ ] AC-06.2: Summary uses the Goal / Done so far / Please structure and stays under ~150 tokens (AC-3.2).
- [ ] AC-06.3: The words "context", "token", "hook" and "inject" do not appear in the sheet.

---

### UC-07 · Helpers ask each other

- **Actor**: Helpers (with the user watching).
- **Trigger**: A helper decides it needs another helper's skill (e.g. Claude asks Codex to run tests).

**Main flow**
1. A small note appears in the asking helper's conversation: "Claude asked Codex to test the order form."
2. Codex's status changes to **Working…**.
3. When done, a note returns: "Codex finished: 4 checks passed." The asking helper continues.

**Alternate flows**
- *The asked helper needs approval*: the approval card appears in the asked helper's conversation; the top bar pill counts it.
- *User wants to see the details*: clicking the note opens the other helper's conversation at that point.

**Acceptance criteria**
- [ ] AC-07.1: Cross-helper requests are always visible to the user as a note; nothing happens silently.
- [ ] AC-07.2: Approval rules (UC-04) apply to work done on another helper's behalf.

---

### UC-08 · Something went wrong *(mockup: "Something went wrong")*

- **Actor**: Linh.
- **Trigger**: A helper can't finish (test failed, file missing, app won't start).

**Main flow**
1. The failed step shows a red "!" in the step list ("Loaded the cake photo").
2. A problem card appears:
   - Tag: "Couldn't finish"
   - Title: what's broken, from the user's point of view ("The order page is missing its cake photo")
   - Body: the effect and what still works ("On phones, the page shows a broken image… Everything else worked, and the test order was saved.")
   - Actions: **Ask Codex to fix it** (primary) · **Choose a photo** (if the user can fix it directly) · **Go back to before** (opens History at the last good save point)
3. Helper status becomes **Stuck** (red).

**Alternate flows**
- *Fix attempt fails twice*: the card says "Codex tried twice and couldn't fix this." and suggests **Pass to Claude** or **Go back to before**.
- *Helper ran out of usage / is signed out*: see UC-13.
- *The whole app won't start in Preview*: Preview shows "Your website stopped working after the last change." with **Ask a helper to fix it** and **Go back to before**.
- *Technical details on*: the raw error is shown in a monospace box.

**Acceptance criteria**
- [ ] AC-08.1: Every problem card says what's broken, what still works, and gives at least two actions.
- [ ] AC-08.2: No stack traces, exit codes or error codes are visible unless technical details are on.
- [ ] AC-08.3: No apology language; no blame on the user.

---

### UC-09 · Go back to a save point *(mockup: "Go back to a save point")*

- **Actor**: Linh.
- **Trigger**: "The new dark red menu looks worse. Can we go back?" or clicks **History**.

**Main flow**
1. History lists save points newest first: time, one-line description, who made it ("Claude", "Claude, after you allowed it", "Saved automatically"). The newest is marked **You are here**.
2. The helper may pre-select the right save point and say so in the conversation.
3. Linh clicks **Go back here**. An inline confirmation explains the outcome: "Go back to 2:58 PM? Your website will look the way it did then. The dark red menu stays in History, so you can bring it back."
4. **Go back** restores the project. A toast confirms: "Back to 2:58 PM. You can return to the newer version from History."

**Alternate flows**
- *A helper is working*: "Claude is still working. Stop Claude and go back?"
- *Saved data* (e.g. real customer orders) *was added after the save point*: warn explicitly: "3 orders were placed after 2:58 PM. Going back keeps those orders and only changes the website." Data rollback is a separate, high-risk action.

**Acceptance criteria**
- [ ] AC-09.1: A save point is created before every approved action and at the end of every request.
- [ ] AC-09.2: Going back never deletes later save points.
- [ ] AC-09.3: The words "commit", "branch", "revert" and "reset" don't appear in Simple mode.

---

### UC-10 · Preview the result

- **Actor**: Marco.
- **Trigger**: Opens the **Preview** tab (default while a helper works).

**Main flow**
1. Preview shows the running website or app ("Your website, running on this computer. It updates as helpers work.").
2. **Open in browser** opens it in the user's normal browser.
3. Documents (markdown), images and diagrams open in the same panel when a helper creates them.

**Alternate flows**
- *Nothing to preview yet*: "Your preview will appear here once a helper builds something."
- *App needs starting*: Chorus starts it automatically; if it can't, see UC-08.
- *Phone view*: a toggle shows the page at phone width.

**Acceptance criteria**
- [ ] AC-10.1: Preview starts without the user running a command (maps to AC-5.1–5.3).
- [ ] AC-10.2: Port numbers and localhost URLs are not shown unless technical details are on.

---

### UC-11 · Manage know-how (shared skills)

- **Actor**: Marco.
- **Trigger**: Settings → **Know-how** → **Manage**.

**Main flow**
1. A list of short instructions all helpers follow, written as sentences: "Use our brand colors (navy and coral)", "Write in a friendly, simple tone", "Always make pages work on phones".
2. Each has an on/off switch, **Edit**, and "Used by: all helpers".
3. **Add know-how** offers: "Write it yourself" or "Ask a helper to write it for me".

**Alternate flows**
- *Know-how imported from a helper's own settings*: tagged "Found in Claude's settings" so the user knows where it came from.
- *Technical details on*: shows the underlying files and folders (maps to AC-4.5–4.7).

**Acceptance criteria**
- [ ] AC-11.1: Folder paths (`.agents/skills`, `.claude/skills`) are never shown in Simple mode.
- [ ] AC-11.2: Turning know-how off takes effect for the next request of every helper.

---

### UC-12 · Several helpers working at once

- **Actor**: Dana or Marco.
- **Trigger**: Two or more helpers are **Working…** at the same time.

**Main flow**
1. Each helper's status updates independently in the top bar.
2. When a background helper finishes or needs a decision, its status changes and, if the app is not focused, a system notification is sent ("Codex finished testing the order form.").
3. If two helpers want to change the same page, the second one waits and shows "Waiting for Claude to finish the order page."

**Acceptance criteria**
- [ ] AC-12.1: Background helpers never steal focus from the conversation the user is in.
- [ ] AC-12.2: Two helpers never edit the same file at the same time without the user knowing.

---

### UC-13 · A helper is unavailable

- **Actor**: Linh.
- **Trigger**: Helper hits a usage limit, gets signed out, or loses internet.

**Main flow**
1. Helper status shows **Paused** with a reason in plain words: "Claude has reached its usage limit until 6:00 PM."
2. The conversation shows actions: **Pass to Codex** (UC-06), **Try again at 6:00 PM** (reminder), or **Sign in again**.

**Acceptance criteria**
- [ ] AC-13.1: The message says when or how the helper becomes available again.
- [ ] AC-13.2: Work done so far is kept and a save point exists.

---

### UC-14 · Show technical details (power users)

- **Actor**: Dana.
- **Trigger**: Settings → **Show technical details** switch on.

**What appears**
- Approval cards show the exact command and the project folder.
- Problem cards show the raw error.
- Side panel gains a **Technical log** tab: timestamp, helper, tool, arguments, result (the v1 Shared Bus, condensed).
- **Open terminal** opens the full terminal for the selected helper (the v1 PTY view).
- Changes link to line-by-line code comparisons.

**Acceptance criteria**
- [ ] AC-14.1: Turning the switch on or off never interrupts a running helper (maps to AC-5.6).
- [ ] AC-14.2: The setting is remembered per user, not per project.
- [ ] AC-14.3: With the switch off, the main screen contains none of the items in the left column of §3.

---

### UC-15 · Closing Chorus while helpers are working

- **Actor**: Linh.
- **Trigger**: Closes the window or quits while a helper is **Working…** or **Needs your OK**.

**Main flow**
1. Dialog: "Claude is still working on the order page. Keep it running in the background, or stop it now?" with **Keep running** · **Stop and quit**.
2. *Stop and quit* makes a save point first.
3. On next launch, the project reopens where it left off, with a note: "Claude stopped when you quit. Continue?"

**Acceptance criteria**
- [ ] AC-15.1: Quitting never leaves the project half-changed without a save point.
- [ ] AC-15.2: Pending approvals survive a restart.

---

## 7. Approval categories ("Ask before")

Defaults for Settings → **Ask before**. Users can relax a category per project; **Risky** items always ask.

| Level | Tag on card | Examples (what the helper wants) | How it's written on the card | "Don't ask again" offered? |
|---|---|---|---|---|
| **Safe** | none — no card | Read files, edit files inside the project, run the preview, run tests | Shown only in the step list | n/a |
| **Please check** | amber | Change stored data structure, install a package, add a new service, contact the internet | "Claude wants to create a place to save cake orders" | Yes, per category per project |
| **Risky** | red | Delete many files, touch anything outside the project, change real customer data, publish or deploy, spend money, use stored passwords/keys | "Codex wants to delete 214 old build files" | No; needs a second confirming click |

Translation examples the risk analyzer must produce (see the Human-Readable Risk Analyzer in [`roadmap.md`](../plans/roadmap.md), Phase 3):

| Command (technical view only) | Card title (Simple mode) | One-line explanation |
|---|---|---|
| `npx prisma migrate dev --name add_orders` | Claude wants to create a place to save cake orders | Adds a new "Orders" list; existing data stays as it is. |
| `npm install stripe` | Claude wants to add a payments tool (Stripe) | Downloads a well-known add-on so your site can take card payments. |
| `rm -rf ./dist` | Codex wants to delete 214 old build files | These files are rebuilt automatically. Your own work isn't touched. |
| `vercel deploy --prod` | Antigravity wants to publish your website | Your changes will be live for customers in about a minute. |
| `cat ~/.ssh/id_rsa` | Claude wants to read a private key file outside your project | This is unusual. We recommend **Don't allow**. |

---

## 8. Status vocabulary

| Status | Color | When | Top-bar label | Needs user? |
|---|---|---|---|---|
| Ready | green dot | Idle, set up | "Ready" | No |
| Working | accent dot, pulsing | Doing a request | "Working…" | No |
| Catching up | blue dot, pulsing | Receiving a hand-off summary | "Catching up…" | No |
| Finished | green dot | Just completed a request (until the next one) | "Finished" | No |
| Needs your OK | amber, bold | Paused on an approval | "Needs your OK" | **Yes** |
| Stuck | red, bold | Couldn't finish (UC-08) | "Stuck" | **Yes** |
| Paused | grey | Usage limit, signed out, offline (UC-13) | "Paused" | Sometimes |
| Not set up | grey, dashed | Not installed / signed out (UC-01) | "Set up" | Yes, to use it |

---

## 9. Open questions

1. **Helper brand names**: do we show "Claude / Antigravity / Codex", or role names only ("Builder / Planner / Tester") with the brand as a subtitle? Brand names build trust with users who already pay for those products; role names are easier for total beginners.
2. **Default helper for a new project**: always Claude, or pick by request type?
3. **Data rollback** (UC-09 alt flow): do we ever let Simple mode roll back stored data, or only code and content?
4. **"Don't ask again" scope**: per project (current proposal) or global?
5. **Notifications**: system notifications on by default, or only for "Needs your OK"?
6. **Technical details as a per-project setting** for teams where one person is technical?
