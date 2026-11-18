# One watcher and one mailbox: what chorus serve does

Task #10 (2026-11-18). Chorus no longer types its messages into a chat's input, and an action no longer ends only when the model
remembers to say so. Two free engines from chorus-core do that work, and `chorus serve` runs exactly one of each:

- **TurnWatch** (chorus-core `src/watch/`): the only code that looks at chats over time.
- **Mailbox** (chorus-core `src/mail/`): every message between chats, and from Chorus to a chat, as a record delivered through one
  transport per CLI, with a watchdog that makes delivery certain (task #14, below).

How the engines work is in chorus-core's `docs/watch-and-mail.md`; this page is the host's side. The optional module gets the same
two instances as `ProCtx.watch` and `ProCtx.mail` (an older host without them makes its own, ticked every 2 s).

```mermaid
flowchart LR
  T[500 ms ticker] --> W[TurnWatch]
  W -- look(thread): state, activity, waitsOn --> S[(store: threads, approvals)]
  W -- events --> O[owners: SubThreads, Mailbox, the module's runner]
  O -- send --> M[Mailbox]
  M -- deliver --> X{transport per CLI}
  X -- Claude: channel push --> C1[chat's chorus mcp → notifications/claude/channel]
  X -- Codex: codex queue --> C2[Codex TUI]
  X -- agy: agentapi send-message --> C3[agy TUI]
  C1 & C2 & C3 -- read_mail --> M
  W & M --> DB[(watch, watch_event, mail)]
```

## Relations

| Relation | Watch key | What is expected |
|---|---|---|
| main → sub (a sub thread; a task's step Workers are the Planner's sub threads) | `sub:<thread>` (SubThreads, `src/serve/subthreads.ts`); `step:<session>` (the module) | a turn end → a report mail to main; quiet `QUIET_MS` → "may be stuck"; gone → "has ended" |
| sub → main | the question's `answer:<id>` | an unanswered question, main idle `IDLE_MS` after its turn → one reminder to main |
| calling an action (any chat, from `start_action` or a button) | `action:<session>` (the module) | the chat calls `action_done` (below) |
| sibling (A opened B with `start_thread`) | none | nothing is watched between them |

A chat that ended its turn while waiting (on its card, a working sub thread, its own question) has missed nothing. What a task does
next stays in the task code: the Planner's "silence = step done" rule is the module's `planner:<session>` watch.

`look(thread)` leaves out `sub:<x>` waits: a wait in the look would hold back every watch on that chat. The action watch adds the sub
thread waits itself through `Watch.waits()`.

## Events and time windows

Events: `turnEnd {ms, waited?}`, `waiting {on}`, `idleAfterWait`, `idle`, `again`, `quiet`, `gone`, and `due` (a watch's clock ran
out, whatever the chat's state; meaning of each: chorus-core `docs/watch-and-mail.md`).

| Constant | Value | Use |
|---|---|---|
| `QUIET_MS` | 2 min | working with no activity: "may be stuck" (never while waiting on a card) |
| `IDLE_MS` | 3 min | idle after a wait is over: a reminder or a miss |
| `WAKE_MS` | 30 s | a turn must start after a delivery |
| `COURIER_MS` | 3 min (`CHORUS_COURIER_MS` in tests and smokes) | a message must be confirmed delivered, time on a card not counted: the watchdog's retry, then the type-in |
| `STALE_TURN_MS` (serve) | 15 s | a resumed chat whose row still says working and that recorded nothing since its CLI started is idle (below) |

## Watch records

Three tables in `chorus serve`'s store (`src/core/store.ts`), so a restart keeps each watch's data and deadline:

| Table | What |
|---|---|
| `watch` | one row per key: `thread`, `belongs_to` (the chat the watch reports to), `kind`, `owner`, `expect`, `seen`, `since`, `waits_on`, `deadline`, `data` (the owner's, e.g. the action's miss count), `extra`, `created_at`, `ended_at` |
| `watch_event` | each event per key (`type`, `at`, `detail`, `action`); the last 30 days, at most 50 000 rows, pruned at start |
| `mail` | one row per message (below) |

At start serve reads them back and the owners re-register their keys (`rewatch()`, `Mailbox.restore()`); TurnWatch reuses the saved
state.

**`list_watches`** (MCP, free, pre-allowed; `src/mcp/server.ts` → `/api/pro/mcp/call`) shows the calling chat the records whose
`belongs_to` is that chat: the open ones, ended ones from the last 24 h with `ended`, and with `key` that record's last 20 events. The
start text tells the model to use it instead of checking in a loop.

## Mail

A message: `id`, `kind` (`report`, `question`, `answer`, `reminder`, `brief`, `note`), `subject`, a Markdown `body`, the sender (a
thread or `chorus`, with teammate, role, session), the receiver thread, `refs` (task, step, question, action session, about-thread),
`meta` (the sender's own data), `state`, `channel`, `tries`, `error` and the times. The Planner loop's old `message` rows moved onto it.

States: `queued → delivered → read → answered`, or `failed`, or `dropped`.

| Situation | What happens |
|---|---|
| receiver working | stays `queued` until it is idle (or its card wait ends) |
| receiver ended or parked | serve resumes it first (the CLI's resume, nothing typed); an agy resume must show the conversation before mail goes in; a lost session gets the Restore card |
| no turn within `WAKE_MS` | one retry, then the watchdog's type-in (below) |
| not confirmed `COURIER_MS` after it was sent (the look may still say working) | the watchdog sends it through the transport once more, then types one line (below) |
| the line cannot be typed for 10 min, or it shows no turn in 5 min | `failed` and the **Not delivered** card |
| delivered, not read by the turn end | miss 1: a reminder mail; miss 2: the Not delivered card |
| a question read, not answered | one reminder after `IDLE_MS` idle |
| receiver deleted | `dropped`, and the sender is told |

**`read_mail`** (MCP, free, pre-allowed): the unread messages, which then count as read; one message by `id` (another chat's message
is refused); or all with `all`. Mailbox events reach the module as `onChatEvent({type: 'mail', event})`.

## Cards

All on Approvals, raised by the module and drawn with Markdown:

- **Reminder** (not a card): the first miss of an action or an unread message gets a `reminder` mail.
- **Stopped** (need kind `missed`): an action missed twice. **Remind again** puts the count back to 0; **End it** sets the session
  `stopped` with event `action.ended` and no verdict. The user typing into the chat resets the count; `action_done` closes the card.
- **Not delivered** (need kind `undelivered`): **Retry** (`mailbox.retry`) or **Open chat**. It closes when the message is read,
  answered or dropped. A lost session gets only the Restore card.

## start_action

`suggest_action`, its need kind `suggest` and its card are gone (old rows deleted once). A main chat asks "Would you like me to
<action>? <why>" with a question card, and after the user's yes calls `start_action(action)`: Chorus creates the session row and
returns the brief as the tool's answer. It is refused in sub threads, Workers and a chat already running an action. The start text
(`PROPOSE`, `startText`, `MCP_INSTRUCTIONS`) names no tools for this.

## Transports

One per CLI, none writing to a terminal (`src/serve/mail.ts` gives them the host's hooks; launch adds each one's `wake` args, env
and files per session; the user's CLI config is never touched):

| CLI | How a message arrives | Launch addition | Probe |
|---|---|---|---|
| Claude Code | the chat's own `chorus mcp` holds `GET /api/pro/mcp/channel?thread=<id>` open; serve writes a line there and it is sent as `notifications/claude/channel` | `--dangerously-load-development-channels server:chorus`; its warning screen is answered with Enter (option 1) once per launch and resume | [claude-code.md §15](../integrations/claude-code.md) |
| Codex | `codex queue --thread <id> --message <text>` (needs the shared background server, Chorus's default) | none | [codex.md §14](../integrations/codex.md) |
| agy | `agy agentapi send-message <conversation> <text>` against the TUI's port, found with `lsof` | env `ANTIGRAVITY_SERVER_CSRF_TOKEN=<token>` per launch, applied through `/usr/bin/env` | [antigravity-agy.md §16](../integrations/antigravity-agy.md) |

Claude Team/Enterprise accounts need `channelsEnabled`: the doctor's critical `channel` check gates the provider.

## The mail watchdog (task #14)

Messages between chats sometimes never arrived: the mailbox sent queued mail only when the watcher saw the receiver idle, and a chat
whose look stayed `working` (below) never got it. Now every message has a `deliver:<id>` watch on the receiver, with TurnWatch's due
clock (`COURIER_MS`, paused while the chat waits on its card). The watchdog runs on the watcher serve already ticks: no loop, timer
or process of its own (`git grep setInterval src/serve/server.ts` shows only the 500 ms ticker).

1. **Retry**: not confirmed when the clock runs out, the message goes through its transport once more, whatever the watcher thinks
   of the chat. Skipped when `transportUp` says the transport is down (a Claude chat whose `chorus mcp` stream is still not open
   `CHANNEL_WAIT_MS` after its CLI started). This shows nothing on screen.
2. **Type-in**: still not confirmed, serve types **one short line** into the chat's CLI for all its unconfirmed mail:
   `Chorus: you have N unread messages (m_…, m_…); read them with read_mail.` (`typeIn` → `typeLine` in `src/serve/mail.ts`):
   read the input off the screen (chorus-core `inputState`, with xterm's wrap flag), hold the user's keys, clear the draft with Ctrl+U
   (never Ctrl+C or Esc), type the line and Enter, wait for it to leave the input (a turn starts, or the CLI queues it after the
   running turn), type the draft back with Option+Enter between its lines, release. Never while a dialog or launch screen is on
   screen, never over a draft that holds an image or paste marker: `not-ready`, tried again every 5 s.
3. **Confirm**: a typed line counts as delivered only once the chat's transcript shows it as a user message (`seen` →
   `transcriptHas`), never while the CLI only queued it. So the Planner's "silence after a delivered report" rule and the `read:<id>`
   miss count never see it early. Each try is in the message's `attempts`; `route`, `typed_at` and `channel: 'typed'` say how it went.

**One terminal lock per chat** (`src/serve/termlock.ts`): every write into a chat's CLI that is not the user's own keys goes through
`locks.run(thread, …)`, one at a time: Claude's channel warning, the launch screens (`answerLaunchScreens`), a live working folder
(`liveAddDir`), the card answers that type into the CLI (`answerRequest`, `answer`, Approvals' Skip, held 800 ms for the Controller's
delayed Enter), the older hosts' typing (`sendToChat`) and the type-in. While the type-in holds the terminal, any other write to that
chat's host (the Controller's own, too) waits and goes after it. **The key hold**: keys the user presses meanwhile are kept by the
`in` handler and replayed through the user path afterwards, so `noteTyped`/`typedTo` count them; the watchdog's keys never go there.

**The overlay** (mockup `mail-courier.html` v3, scenes 1–3; `src/desktop/mail-typing.js`): serve sends the page
`{t: 'mail-typing', thread, phase: 'start' | 'end', from}`; while the chat being typed into is open, the whole window dims and takes no
clicks, with one card in the centre ("Delivering a message to this chat", "From **<sender>**. What you typed is saved and comes back in
a moment."). It fades (0.35 s) at `end`, and after 10 s whatever happened; no "Delivered" message; nothing for a retry; nothing in
another chat or on Home. Keys still go to serve. With reduced motion the letter rests mid-arc. The mailbox's `courier` events go to
serve's log only.

**Serve's address**: each chat's `chorus mcp` gets `CHORUS_SERVE_URL` and `CHORUS_MCP_TOKEN` in its launch env (Codex forwards them to
its MCP server with `-c mcp_servers.chorus.env_vars=[…]`: it does not pass its env on, typein-probe F/F2), so `serve.json` is only a
fallback. A second `chorus serve` on the same home that finds a live one in `serve.json` (`GET /api/pro/mcp/health`, same home)
leaves the file alone and never deletes it: on 2026-11-18 a second serve took it and every Claude chat lost its channel.

**Chats stuck at working**: a chat whose CLI was killed mid-turn (a Chorus restart) never wrote that turn's end, so its transcript
said "working" for good while the resumed CLI waited for input. `look()` notes each CLI process's activity mark when it first sees
it; a row still `working`, with history, nothing new since that process started and past `STALE_TURN_MS`, is idle.

Tests: chorus-core `test/watch/due.test.ts`, `test/mail/courier.test.ts`, `test/mail/typein.test.ts`; here
`test/serve/serve-env.test.ts`, `test/serve/stale-turn.test.ts`, `test/serve/courier.test.ts`, `test/serve/desktop-courier.test.ts`.
With the real CLIs: `npm run smoke:courier` ([testing.md](../testing.md)).

