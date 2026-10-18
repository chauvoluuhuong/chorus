# Phase 4 e2e proof

Real `chorus` app, real Claude Code and Codex, driven through a PTY (`npm run proof`).
Each screenshot is the terminal as the user sees it at that step.

## Result

| | check |
|---|---|
| ✅ | chorus opens on the home screen: agents with versions, and this project's threads |
| ✅ | n opens the new-thread form |
| ✅ | the form offers agent, model and the project folder |
| ✅ | model list is Claude's: haiku selected |
| ✅ | Claude opens inside the app |
| ✅ | the sidebar names the thread after the first message |
| ✅ | status line shows the menu key |
| ✅ | the agent's own permission prompt is detected (sidebar shows !) |
| ✅ | the new-thread form opens over the work in progress |
| ✅ | Codex opens in thread 2 |
| ✅ | thread 2 is in front and Claude (thread 1) is still pending |
| ✅ | an approval card for the background thread appears over Codex |
| ✅ | at least one request was approved from a card |
| ✅ | Claude created calc.js |
| ✅ | Claude thread finished: waiting dot, store state |
| ✅ | live tailing recorded the turns, the node call and the usage |
| ✅ | the artifact notes.md was registered |
| ✅ | Codex answers in its own thread |
| ✅ | handoff dialog names the thread |
| ✅ | the handoff thread appears in front, listed under the thread it continues (↳) |
| ✅ | the new thread is a child of the Claude thread in the store |
| ✅ | Codex called get_handoff_context (Chorus saw the MCP call) |
| ✅ | its summary names calc.js |
| ✅ | the handoff thread settles as waiting |
| ✅ | memory view shows what the next agent reads |
| ✅ | activity view lists the tool calls with their status |
| ✅ | f filters the timeline by kind |
| ✅ | the mcp filter keeps the MCP call |
| ✅ | r shows the raw trace next to what was parsed |
| ✅ | a mouse click on the first sidebar item opens the Claude thread |
| ✅ | artifacts view lists the artifact with its version |
| ✅ | o starts the live preview and shows its address |
| ✅ | the preview page serves what the agent wrote and reloads when it changes |
| ✅ | v lists the versions of the artifact |
| ✅ | app quits and restores the terminal |

## Screenshots

### 01-home
chorus in a project: the installed agents with their versions, and this project's threads (none yet). n starts one

![chorus in a project: the installed agents with their versions, and this project's threads (none yet). n starts one](01-home.png)

### 02-new-thread-form
n: the new-thread form: agent, model, folder (default: this project). Nothing else to fill in

![n: the new-thread form: agent, model, folder (default: this project). Nothing else to fill in](02-new-thread-form.png)

### 03-new-thread-form-choices
Claude + haiku, in this folder: Enter starts it

![Claude + haiku, in this folder: Enter starts it](03-new-thread-form-choices.png)

### 04-claude-starts
thread 1 is Claude Code (haiku); the task was typed into its own screen

![thread 1 is Claude Code (haiku); the task was typed into its own screen](04-claude-starts.png)

### 05-claude-asks-in-front
Claude is in front and asks permission; the sidebar already shows ! for thread 1

![Claude is in front and asks permission; the sidebar already shows ! for thread 1](05-claude-asks-in-front.png)

### 06-new-thread-form-codex
ctrl+space n again: pick Codex (its model list is Codex's own), Enter

![ctrl+space n again: pick Codex (its model list is Codex's own), Enter](06-new-thread-form-codex.png)

### 07-card-for-background-thread
Codex is in front; Claude (background) is waiting, and Chorus shows its request as a card

![Codex is in front; Claude (background) is waiting, and Chorus shows its request as a card](07-card-for-background-thread.png)

### 08-card-detail
the card names the thread, the command or file, and the key to answer

![the card names the thread, the command or file, and the key to answer](08-card-detail.png)

### 09-after-approvals
approved 3 request(s) from the card; thread 2 stayed in front

![approved 3 request(s) from the card; thread 2 stayed in front](09-after-approvals.png)

### 10-codex-own-thread
thread 2 (Codex) answers independently while thread 1 is parked in the background

![thread 2 (Codex) answers independently while thread 1 is parked in the background](10-codex-own-thread.png)

### 11-handoff-dialog
ctrl+space h on thread 1: choose the agent that continues the work

![ctrl+space h on thread 1: choose the agent that continues the work](11-handoff-dialog.png)

### 12-handoff-summary
the continuing Codex thread loaded the context through the Chorus MCP server and summarises the work

![the continuing Codex thread loaded the context through the Chorus MCP server and summarises the work](12-handoff-summary.png)

### 13-memory-view
ctrl+space m: the digest a handoff carries (first request, files touched, commands, tests, last message)

![ctrl+space m: the digest a handoff carries (first request, files touched, commands, tests, last message)](13-memory-view.png)

### 14-activity-view
ctrl+space e on the handoff thread: its timeline shows the chorus.get_handoff_context MCP call that loaded the context

![ctrl+space e on the handoff thread: its timeline shows the chorus.get_handoff_context MCP call that loaded the context](14-activity-view.png)

### 15-activity-filter
f cycles the filter (all, tool, mcp, file): here only the MCP calls

![f cycles the filter (all, tool, mcp, file): here only the MCP calls](15-activity-filter.png)

### 16-raw-trace
r: the raw transcript lines and how Chorus parsed them (for debugging an adapter)

![r: the raw transcript lines and how Chorus parsed them (for debugging an adapter)](16-raw-trace.png)

### 17-artifacts-view
ctrl+space a: the artifacts of the thread (name, version, who wrote it) and the files its tools wrote

![ctrl+space a: the artifacts of the thread (name, version, who wrote it) and the files its tools wrote](17-artifacts-view.png)

### 18-preview
o: the artifact is served at a local address that reloads while the agent keeps editing it

![o: the artifact is served at a local address that reloads while the agent keeps editing it](18-preview.png)

### 19-versions
v: every version of the artifact (a hash per change)

![v: every version of the artifact (a hash per change)](19-versions.png)

### 20-help-view
ctrl+space ?: the keys

![ctrl+space ?: the keys](20-help-view.png)

### 21-overview
final state: three threads (Claude, Codex, and the Codex handoff thread), all waiting

![final state: three threads (Claude, Codex, and the Codex handoff thread), all waiting](21-overview.png)

## Commands after the run

```
$ chorus threads
id          agent   state    parent      title
t_187c829e  codex   waiting  t_00bb052f  Create calc.js in the curren → codex
t_23e4d60a  codex   waiting  -           Reply with only the text cod
t_00bb052f  claude  waiting  -           Create calc.js in the curren
```

```
$ chorus activity
thread      agent   turns  tools  mcp   tokens in/out     cost     limit
t_187c829e  codex   3      1      1     59484/361         -        2%
t_23e4d60a  codex   2      0      0     19383/9           -        2%
t_00bb052f  claude  2      3      0     65725/1093        -        -
```

```
$ chorus artifacts
t_00bb052f	3948ac12aea2	/private$TMPDIR/chorus-proof-plb27S/.chorus/threads/t_00bb052f/artifacts/notes.md
```

```
$ chorus trace <claude thread>
thread t_00bb052f (claude 2.1.302)
raw terminal capture: $PROJECT/.chorus/threads/t_00bb052f/raw/pty.log (30029 bytes)
transcript: ~/.claude/projects/-private-var-folders-hj-b9dgqj-s11738sh6-z2w79bm0000gn-T-chorus-proof-plb27S/05f72d4e-8f3a-41a7-aaa1-98bc02b77487.jsonl
transcript lines: 54  → parsed turns: 2, tool calls: 3, status: waiting

last raw lines (cut) → what we made of the session:
  raw  {"parentUuid":"2545b289-29af-4320-bb6e-17c7086cfc53","isSidechain":false,"message":{"model":"claude-haiku-5-5","id":"msg_011Cg91dER2Sr6wN5HpvL2Fq","type":"messa
  raw  {"parentUuid":"b191b1aa-8f6c-42c9-a2b2-0220131b9922","isSidechain":false,"type":"system","subtype":"turn_duration","durationMs":9089,"messageCount":28,"timestam
  raw  {"type":"cost-state","sessionId":"05f72d4e-8f3a-41a7-aaa1-98bc02b77487","totalCostUSD":0.01479742,"totalAPIDuration":9040,"totalAPIDurationWithoutRetries":9012,
  raw  {"type":"last-prompt","lastPrompt":"Create calc.js in the current directory that exports a function add(a, b). Run it once with your shell tool as: node -e \"co
  raw  {"type":"cost-state","sessionId":"05f72d4e-8f3a-41a7-aaa1-98bc02b77487","totalCostUSD":0.01479742,"totalAPIDuration":9040,"totalAPIDurationWithoutRetries":9012,
  tool ok Write $PROJECT/cal
  tool ok Bash node -e "console.log(require('./calc.js').add(2, 3))" && mkdir -p .chorus/thread
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
store: $PROJECT/.chorus/chorus.db (exists)

claude  2.1.302   verified 2.1.301  logged in
        ⚠ claude 2.1.302 is newer than the last verified 2.1.301; re-run tools/probe and check docs/integrations/claude.md
        data: ~/.claude
codex   0.163.0   verified 0.163.0  logged in
        data: ~/.codex
agy     1.4.2     verified 1.4.0    has a settings file (no status command; start agy once to sign in)
        ⚠ agy 1.4.2 is newer than the last verified 1.4.0; re-run tools/probe and check docs/integrations/agy.md
        data: ~/.gemini/antigravity-cli
```
