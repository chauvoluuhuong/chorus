# Phase 4 e2e proof (UI pass 2)

Real `chorus` app, real Claude Code and Codex, driven through a PTY with keys and mouse clicks (`npm run proof`).
Each screenshot is the terminal as the user sees it at that step.

## Result

| | check |
|---|---|
| ✅ | chorus opens on New chat with the top bar, the project tree, Skills and Memory |
| ✅ | the sidebar already lists the chat recorded in another project (one shared database) |
| ✅ | the screen offers agent, model, effort, project folder and permissions |
| ✅ | clicking haiku selects it (the model list is Claude's) |
| ✅ | Claude opens inside the app |
| ✅ | the top bar shows the path and the sidebar names the chat after the first message |
| ✅ | status line has the menu button |
| ✅ | the agent's own permission prompt is detected (sidebar shows !, the top bar counts it) |
| ✅ | + New chat opens the screen over the work in progress |
| ✅ | the effort list follows the agent (Codex lists the levels of its own models) |
| ✅ | ticking skip shows the warning and the Codex flag |
| ✅ | Codex opens in chat 2 and its own banner says what skip means (permissions: YOLO mode) |
| ✅ | chat 2 is in front, shows the amber skip marker, and Claude (chat 1) is still pending |
| ✅ | an approval card for the background chat appears over Codex, and the top bar badge stays |
| ✅ | clicking the badge opens the approvals inbox |
| ✅ | the inbox has the this project / all projects switch and lists the request with its risk tag |
| ✅ | at least one request was approved from the inbox |
| ✅ | the inbox keeps the decisions ("Decided") |
| ✅ | the store logged the approvals |
| ✅ | Claude created calc.js |
| ✅ | Claude chat finished: waiting dot, store state |
| ✅ | live tailing recorded the turns, the node call and the usage |
| ✅ | the artifact notes.md was registered in the chat project |
| ✅ | the Codex chat was started with its skip flag and its effort, and remembers both |
| ✅ | Codex answers in its own chat |
| ✅ | a click on a chat in the sidebar opens it |
| ✅ | handoff dialog names the chat and lists the other agents first with their plan |
| ✅ | the handoff chat appears in front, listed under the chat it continues (↳) |
| ✅ | the new chat is a child of the Claude chat in the store, in the same project |
| ✅ | Codex called get_handoff_context (Chorus saw the MCP call) |
| ✅ | its summary names calc.js |
| ✅ | the handoff chat settles as waiting |
| ✅ | Memory lists the chats of every project |
| ✅ | / searches the memory: only the matching chat is left |
| ✅ | selecting a chat shows what it asked and which files it touched |
| ✅ | Skills shows the library with on/off and what the agents already have |
| ✅ | ⏎ turns a skill off and unlinks it from the agents' folders |
| ✅ | clicking import copies a skill into the library |
| ✅ | ☰ Menu opens the ten rows of the menu |
| ✅ | activity view has the filter bar with counts and lists the tool and MCP calls |
| ✅ | f filters the timeline by kind |
| ✅ | the mcp filter keeps the MCP call |
| ✅ | r shows the raw trace next to what was parsed |
| ✅ | artifacts view lists the artifact with its version |
| ✅ | ⏎ opens the artifact (served with live reload) and shows its address |
| ✅ | the preview page serves what the agent wrote and reloads when it changes |
| ✅ | 100 columns: narrow sidebar (names only), the chat keeps the rest |
| ✅ | 78 columns: icon sidebar |
| ✅ | 56 columns: sidebar hidden, top bar and status line stay (the buttons shrink to ☰) |
| ✅ | under 50x12 only a notice shows |
| ✅ | back to full size: the sidebar and the chat are back |
| ✅ | app quits and restores the terminal |

## Screenshots

### 01-new-chat
chorus opens on New chat: pick agent, model, project folder and whether it may skip permission prompts. Enter alone starts with the defaults. The sidebar is the map: projects and their chats, Skills and Memory at the bottom

![chorus opens on New chat: pick agent, model, project folder and whether it may skip permission prompts. Enter alone starts with the defaults. The sidebar is the map: projects and their chats, Skills and Memory at the bottom](01-new-chat.png)

### 02-new-chat-choices
Claude + haiku in this folder, chosen with the mouse; the key is inside the chip, so ⏎ starts it

![Claude + haiku in this folder, chosen with the mouse; the key is inside the chip, so ⏎ starts it](02-new-chat-choices.png)

### 03-claude-starts
chat 1 is Claude Code (haiku) under its project; the task was typed into its own screen. The top bar says where you are: the chat title

![chat 1 is Claude Code (haiku) under its project; the task was typed into its own screen. The top bar says where you are: the chat title](03-claude-starts.png)

### 04-claude-asks-in-front
Claude is in front and asks permission; the top bar says "! 1 waiting" and the sidebar already shows ! for the chat

![Claude is in front and asks permission; the top bar says "! 1 waiting" and the sidebar already shows ! for the chat](04-claude-asks-in-front.png)

### 05-new-chat-skip
+ New chat: Codex with effort low and "Skip permission prompts" ticked. The screen says what that means and which flag is used (per chat, never global)

![+ New chat: Codex with effort low and "Skip permission prompts" ticked. The screen says what that means and which flag is used (per chat, never global)](05-new-chat-skip.png)

### 06-card-for-background-thread
Codex (skip) is in front; Claude (background) is waiting: the top bar badge, the sidebar ! and a card with its request

![Codex (skip) is in front; Claude (background) is waiting: the top bar badge, the sidebar ! and a card with its request](06-card-for-background-thread.png)

### 07-approvals-inbox
the approvals inbox: every chat waiting on you in one list, with the request and a risk tag. y approves, x denies, ⏎ opens the chat; the agent gets the same key you would have typed

![the approvals inbox: every chat waiting on you in one list, with the request and a risk tag. y approves, x denies, ⏎ opens the chat; the agent gets the same key you would have typed](07-approvals-inbox.png)

### 08-after-approvals
approved 3 request(s) from the inbox; the list is empty and "Decided" keeps what was answered

![approved 3 request(s) from the inbox; the list is empty and "Decided" keeps what was answered](08-after-approvals.png)

### 09-codex-own-thread
chat 2 (Codex) answers independently while chat 1 is parked in the background

![chat 2 (Codex) answers independently while chat 1 is parked in the background](09-codex-own-thread.png)

### 10-handoff-dialog
ctrl+\ h (or ☰ Menu → Hand off): choose the agent that continues the work

![ctrl+\ h (or ☰ Menu → Hand off): choose the agent that continues the work](10-handoff-dialog.png)

### 11-handoff-summary
the continuing Codex chat loaded the context through the Chorus MCP server and summarises the work

![the continuing Codex chat loaded the context through the Chorus MCP server and summarises the work](11-handoff-summary.png)

### 12-memory-search
Memory: / searches titles, projects, what a chat asked and its files

![Memory: / searches titles, projects, what a chat asked and its files](12-memory-search.png)

### 13-memory
Memory: one list for all projects and agents (the shared database). Selecting a row shows what it asked, its last message and its files; any agent can read it through the chorus MCP tools

![Memory: one list for all projects and agents (the shared database). Selecting a row shows what it asked, its last message and its files; any agent can read it through the chorus MCP tools](13-memory.png)

### 14-skills
Skills: the library with on/off for all three agents; skills the agents already keep in their own folders are offered for import

![Skills: the library with on/off for all three agents; skills the agents already keep in their own folders are offered for import](14-skills.png)

### 15-menu
☰ Menu (or ctrl+\): hand off, new chat, artifacts, approvals, skills, memory, activity, sidebar, help, quit. ↑↓ and ⏎, a click, or the letter

![☰ Menu (or ctrl+\): hand off, new chat, artifacts, approvals, skills, memory, activity, sidebar, help, quit. ↑↓ and ⏎, a click, or the letter](15-menu.png)

### 16-activity-view
Activity on the handoff chat: its timeline shows the chorus.get_handoff_context MCP call that loaded the context

![Activity on the handoff chat: its timeline shows the chorus.get_handoff_context MCP call that loaded the context](16-activity-view.png)

### 17-raw-trace
r: the raw transcript lines and how Chorus parsed them (for debugging an adapter)

![r: the raw transcript lines and how Chorus parsed them (for debugging an adapter)](17-raw-trace.png)

### 18-artifacts-view
Artifacts: name, version, who wrote it, and the files its tools wrote. ⏎ or a click opens the file with the default app (here through the served link that reloads while the agent edits)

![Artifacts: name, version, who wrote it, and the files its tools wrote. ⏎ or a click opens the file with the default app (here through the served link that reloads while the agent edits)](18-artifacts-view.png)

### 19-size-narrow
100 columns: the sidebar shrinks to names (the agent name goes), the agent screen gets the room

![100 columns: the sidebar shrinks to names (the agent name goes), the agent screen gets the room](19-size-narrow.png)

### 20-size-icons
70-89 columns: the sidebar is just icons: state dot and agent letter

![70-89 columns: the sidebar is just icons: state dot and agent letter](20-size-icons.png)

### 21-size-too-small
under 50×12: a notice; the chats keep running

![under 50×12: a notice; the chats keep running](21-size-too-small.png)

### 22-help-view
Help: the keys

![Help: the keys](22-help-view.png)

### 23-overview
final state: two projects, three chats (Claude, Codex, and the Codex handoff chat under it), the sidebar tree, Skills and Memory

![final state: two projects, three chats (Claude, Codex, and the Codex handoff chat under it), the sidebar tree, Skills and Memory](23-overview.png)

## Commands after the run

```
$ chorus threads
id          agent   state    parent      title
t_769b1e30  codex   waiting  t_c6b5e3cd  Create calc.js in the curre… → codex
t_3220bcc1  codex   waiting  -           Reply with only the text co…
t_c6b5e3cd  claude  waiting  -           Create calc.js in the curre…
t_seed      codex   waiting  -           Rate limiter
```

```
$ chorus activity
thread      agent   turns  tools  mcp   tokens in/out     cost     limit
t_769b1e30  codex   3      1      1     60072/202         -        5%
t_3220bcc1  codex   2      0      0     18301/9           -        5%
t_c6b5e3cd  claude  2      3      0     38082/719         -        -
t_seed      codex   2      1      0     100/50            -        -
```

```
$ chorus artifacts
t_c6b5e3cd	34417ff19e33	/private$TMPDIR/chorus-proof-bgAz9m/.chorus/threads/t_c6b5e3cd/artifacts/notes.md
```

```
$ chorus trace <claude chat>
thread t_c6b5e3cd (claude 2.1.302)
raw terminal capture: $PROJECT/.chorus/threads/t_c6b5e3cd/raw/pty.log (29467 bytes)
transcript: ~/.claude/projects/-private-var-folders-hj-b9dgqj-s11738sh6-z2w79bm0000gn-T-chorus-proof-bgAz9m/dbc33027-620a-4983-8f24-1e48be033011.jsonl
transcript lines: 52  → parsed turns: 2, tool calls: 3, status: waiting

last raw lines (cut) → what we made of the session:
  raw  {"parentUuid":"888fb03b-34f5-42ae-b955-bb7ff4fd3a5b","isSidechain":false,"message":{"model":"claude-haiku-5-5","id":"msg_011Cg9U6Bo3ZcWnMRAz6bTnL","type":"messa
  raw  {"parentUuid":"7f402e27-10d9-46e6-8ab0-51f2f80f503a","isSidechain":false,"type":"system","subtype":"turn_duration","durationMs":7607,"messageCount":27,"timestam
  raw  {"type":"cost-state","sessionId":"dbc33027-620a-4983-8f24-1e48be033011","totalCostUSD":0.009350910000000002,"totalAPIDuration":7154,"totalAPIDurationWithoutRetr
  raw  {"type":"last-prompt","lastPrompt":"Create calc.js in the current directory that exports a function add(a, b). Run it once with your shell tool as: node -e \"co
  raw  {"type":"cost-state","sessionId":"dbc33027-620a-4983-8f24-1e48be033011","totalCostUSD":0.009350910000000002,"totalAPIDuration":7154,"totalAPIDurationWithoutRetr
  tool ok Bash printf 'module.exports.add = function add(a, b) {\n return a + b;\n};\n' > calc.
  tool ok Bash mkdir -p /private/var/folders/hj/b9dgqj_s11738sh6_z2w79bm0000gn/T/chorus-proof-b
  tool ok Write $PROJECT/.ch
  turn user: Create calc.js in the current directory that exports a function add(a, b). Run it once with your she
  turn assistant: done

MCP calls from this thread: none
```

```
$ chorus doctor
chorus doctor

node v26.10.0
project: $PROJECT
store: $PROJECT/.chorus/chorus.db (created on first use)

claude  2.1.302   verified 2.1.301  logged in
        ⚠ claude 2.1.302 is newer than the last verified 2.1.301; re-run tools/probe and check docs/integrations/claude.md
        data: ~/.claude
codex   0.163.0   verified 0.163.0  logged in
        data: ~/.codex
agy     1.4.2     verified 1.4.0    has a settings file (no status command; start agy once to sign in)
        ⚠ agy 1.4.2 is newer than the last verified 1.4.0; re-run tools/probe and check docs/integrations/agy.md
        data: ~/.gemini/antigravity-cli
```
