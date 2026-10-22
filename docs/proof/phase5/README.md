# Phase 5 e2e proof: the desktop app

The desktop page over `chorus serve`, driven in Chrome with real clicks and key presses, with the real Claude Code and Codex (`npm run proof:desktop`). Then the native window (Tauri) starting its own server.

## Result

| | check |
|---|---|
| ✅ | the page loads from chorus serve and the token leaves the address bar |
| ✅ | New chat shows the three agents with their versions, model, effort, folder and the skip switch |
| ✅ | the sidebar lists the chat recorded in another project (one shared database) |
| ✅ | the model list is Claude's and haiku is chosen |
| ✅ | Start opens the chat with the agent's own screen |
| ✅ | Claude starts working on the first message (folder trust answered with the keyboard) |
| ✅ | the chat is named after the first message in the sidebar and the top bar |
| ✅ | the effort list follows the agent (Codex lists its own levels) |
| ✅ | ticking skip shows what it means and the Codex flag |
| ✅ | Codex opens in chat 2 with its own YOLO banner and an empty composer |
| ✅ | typing in the window reaches Codex and it answers in its own screen |
| ✅ | the header shows the amber skip tag and effort low |
| ✅ | the agent's own permission prompt is detected on the background chat |
| ✅ | the top bar counts it, the sidebar marks it, and a toast offers the answer without covering Codex |
| ✅ | the badge opens the approvals inbox with the request and its risk tag |
| ✅ | requests were approved from the inbox |
| ✅ | Decided today keeps the answers |
| ✅ | Claude created calc.js |
| ✅ | the store logged the approvals |
| ✅ | the Claude chat settles as "waiting for you" and the store has its turns, the node call and usage |
| ✅ | Artifacts lists notes.md with its version and the files the tools wrote |
| ✅ | Open serves the artifact on a local page that reloads while the agent edits it |
| ✅ | Activity shows the tool calls with status and duration |
| ✅ | Record shows what get_handoff_context returns for this chat |
| ✅ | Hand off opens the form for the chat, another agent chosen first |
| ✅ | the new chat is listed under the chat it continues (↳) and is its child in the store |
| ✅ | Codex called get_handoff_context (Chorus saw the MCP call) |
| ✅ | its summary names calc.js |
| ✅ | Memory lists the chats of every project, continued ones under their source |
| ✅ | search keeps only the matching chat |
| ✅ | selecting it shows what it asked and the files it touched |
| ✅ | "What an agent reads" shows the handoff record |
| ✅ | Skills shows the library with on/off and the skills the agents already keep |
| ✅ | turning a skill off unlinks it from the agents' folders |
| ✅ | Import copies a skill into the library |
| ✅ | Doctor lists the agents, versions, logins and the store |
| ✅ | the window says it lost the server |
| ✅ | after a restart the chats are listed again and the Claude chat resumes its own session when opened |
| ✅ | the resumed Claude screen is in the window |
| ✅ | Chorus.app starts chorus serve through the login shell and loads its page |
| ✅ | the app's server has the same chats (the shared database) |
| ✅ | the native window can be photographed (window found on screen) |
| ✅ | closing the app stops its chorus serve |

## Screenshots

### 01-new-chat
The window opens on New chat: agent (with version and login), model, effort, project folder, an optional first message, and whether it may skip permission prompts. The sidebar already lists a chat from another project (one shared database)

![The window opens on New chat: agent (with version and login), model, effort, project folder, an optional first message, and whether it may skip permission prompts. The sidebar already lists a chat from another project (one shared database)](01-new-chat.png)

### 02-new-chat-filled
Claude Code + haiku in this folder, with the task as the first message. The first message is passed to the agent when it starts; you can also type it in the agent's own screen

![Claude Code + haiku in this folder, with the task as the first message. The first message is passed to the agent when it starts; you can also type it in the agent's own screen](02-new-chat-filled.png)

### 03-claude-working
Chat 1: Claude Code (haiku) works in its own screen, in the window. The chat took its name from the first message; the header shows agent, state, model and folder

![Chat 1: Claude Code (haiku) works in its own screen, in the window. The chat took its name from the first message; the header shows agent, state, model and folder](03-claude-working.png)

### 04-new-chat-skip
+ New chat: Codex with effort low and "Skip permission prompts" ticked; the form says what that means and which flag is used (per chat, never global)

![+ New chat: Codex with effort low and "Skip permission prompts" ticked; the form says what that means and which flag is used (per chat, never global)](04-new-chat-skip.png)

### 05-codex-skip
Chat 2: Codex with skip permissions answers in its own screen; the header shows the amber skip tag and effort low. Claude keeps working in the background

![Chat 2: Codex with skip permissions answers in its own screen; the header shows the amber skip tag and effort low. Claude keeps working in the background](05-codex-skip.png)

### 06-background-asks
Codex is in front; Claude (background) asks: the top bar says "! 1 waiting", the sidebar dot turns red, and a toast offers Approve / Deny / Open. Nothing covers the chat in front

![Codex is in front; Claude (background) asks: the top bar says "! 1 waiting", the sidebar dot turns red, and a toast offers Approve / Deny / Open. Nothing covers the chat in front](06-background-asks.png)

### 07-approvals-inbox
The approvals inbox: every chat waiting on you, the request as the agent wrote it, a risk tag, and Approve / Deny / Open chat. Approve types the agent's own answer key

![The approvals inbox: every chat waiting on you, the request as the agent wrote it, a risk tag, and Approve / Deny / Open chat. Approve types the agent's own answer key](07-approvals-inbox.png)

### 08-after-approvals
Approved 4 request(s) from the inbox without opening the chat; the list is empty and "Decided today" keeps the answers

![Approved 4 request(s) from the inbox without opening the chat; the list is empty and "Decided today" keeps the answers](08-after-approvals.png)

### 09-artifacts
The Artifacts drawer next to the agent's screen: notes.md (v1) with Open, Show in folder, Copy path, and the files Claude's tools wrote

![The Artifacts drawer next to the agent's screen: notes.md (v1) with Open, Show in folder, Copy path, and the files Claude's tools wrote](09-artifacts.png)

### 10-activity
The Activity drawer: the chat's timeline of tool calls, approvals and files, with filters by kind

![The Activity drawer: the chat's timeline of tool calls, approvals and files, with filters by kind](10-activity.png)

### 11-record
The Record drawer: exactly what the next agent reads through get_handoff_context

![The Record drawer: exactly what the next agent reads through get_handoff_context](11-record.png)

### 12-handoff-form
Hand off: the same form, for the chat that continues "Create calc.js…"; the other agent comes first and the folder is the source's

![Hand off: the same form, for the chat that continues "Create calc.js…"; the other agent comes first and the folder is the source's](12-handoff-form.png)

### 13-handoff-summary
The continuing Codex chat loaded the record through the Chorus MCP server and sums up the work; it waits for your OK

![The continuing Codex chat loaded the record through the Chorus MCP server and sums up the work; it waits for your OK](13-handoff-summary.png)

### 14-memory-search
Memory: every chat in every project (one shared database). Search finds the chat from another project; its details say what it asked, its last answer and its files

![Memory: every chat in every project (one shared database). Search finds the chat from another project; its details say what it asked, its last answer and its files](14-memory-search.png)

### 15-memory-record
Memory: the Claude chat and what an agent reads when it continues it; Open chat, Continue with another agent and Delete are one click away

![Memory: the Claude chat and what an agent reads when it continues it; Open chat, Continue with another agent and Delete are one click away](15-memory-record.png)

### 16-skills
Skills: one library for the three agents, with on/off; skills found in the agents' own folders are offered for import

![Skills: one library for the three agents, with on/off; skills found in the agents' own folders are offered for import](16-skills.png)

### 17-doctor
Doctor: the agents Chorus starts, their versions and logins, and where the data lives

![Doctor: the agents Chorus starts, their versions and logins, and where the data lives](17-doctor.png)

### 18-dark
The same window in dark mode (it follows the system)

![The same window in dark mode (it follows the system)](18-dark.png)

### 19-disconnected
chorus serve stopped (the app closing, a crash): the window says so and keeps trying

![chorus serve stopped (the app closing, a crash): the window says so and keeps trying](19-disconnected.png)

### 20-resumed
After a restart of chorus serve: the sidebar lists every chat again, and opening the Claude chat resumes its own session (claude --resume) in the window

![After a restart of chorus serve: the sidebar lists every chat again, and opening the Claude chat resumes its own session (claude --resume) in the window](20-resumed.png)

### 21-native-window
The native window (desktop/, Tauri, 4.9 MB): it started its own chorus serve and shows the same chats. Closing it stops the server and the agents

![The native window (desktop/, Tauri, 4.9 MB): it started its own chorus serve and shows the same chats. Closing it stops the server and the agents](21-native-window.png)

## Commands after the run

```
$ chorus threads
id          agent   state    parent      title
t_c08d57ef  claude  waiting  -           Create calc.js in the curre…
t_654a48cc  codex   waiting  t_c08d57ef  Create calc.js in the curre… → codex
t_c215bc0b  codex   waiting  -           Reply with only the text co…
t_seed      codex   waiting  -           Rate limiter
```

```
$ chorus activity
thread      agent   turns  tools  mcp   tokens in/out     cost     limit
t_c08d57ef  claude  2      5      0     39786/1230        $0.0120  -
t_654a48cc  codex   3      1      1     60274/228         -        11%
t_c215bc0b  codex   2      0      0     18356/9           -        11%
t_seed      codex   2      1      0     100/50            -        -
```

```
$ chorus artifacts
t_c08d57ef	a9dca613a2ae	$PROJECT/.chorus/threads/t_c08d57ef/artifacts/notes.md
```
