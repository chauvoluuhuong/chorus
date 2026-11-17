# Deleting a task, and a Planner chat that owns one

The host's side (`chorus serve`, the desktop page) of deleting a task (owner, 2026-11-16). The task data, Task details' **Delete task**
button and its warning are the optional module's (chorus-core); this page is what the host gives it and the dialog the host shows.

## What a deleted task takes with it

A deleted task takes its approvals, its chats' requests and its stored rows with it; the Planner's chat, the failures the user
noted and every file stay.

- Its running chats are stopped first.
- From the module's database: the task, its steps, sessions, comments, events, waiting items and queued messages. Noted failures
  stay, without their link to the task.
- Its Worker chats (every chat of the task that did not make its plan) are deleted from Chorus as any deleted chat is: their
  turns, approvals, requests and artifacts lists. They leave the sidebar, Approvals, the top bar's waiting count and the badges.
- The Planner's chat stays, as a plain chat, when the task is deleted from Task details. It goes only when the user deletes that
  chat and chooses "and the task" (below).
- Nothing on disk is touched: no project file, no agent session log.

## The module's `deleteChat` (host function)

`ProCtx.deleteChat(threadId)` is optional: it deletes a chat with no question asked (`deleteChatQuietly` in
`src/serve/server.ts`). The Controller's own "Delete this chat?" is answered while it runs, the chat's rows go as for
`DELETE chats/:id`, and the module hears `onChatEvent({ type: 'deleted' })`. A host without it leaves the Worker chats in place,
stopped.

## Deleting a chat: two calls to the module

`DELETE chats/:id` asks the module first, `GET /api/pro/chat-task?thread=<id>`:

- **No task** (any other chat, a locked module, no answer): today's dialog, unchanged: "Delete this chat?" with **Delete the chat**
  and **Keep it**.
- **The chat is the Planner of a task:** one dialog, "Delete this chat and its task?", with two choices (owner, 2026-11-17: "Delete
  only the chat" is gone, so a task never stays without its Planner):
  - **Delete the chat and task #N**: `POST /api/pro/task/remove { id, planner: true }`, which also deletes the Planner's chat
    through `deleteChat`. The host then deletes the chat itself if it is still there.
  - **Keep it**: nothing changes, and Esc does the same.

  While the task's plan is still being made, the dialog names "the plan" ("Delete this chat and its plan?") and the first choice is **Delete the chat and its plan**.

Neither call is gated by the plan: a locked task can still be deleted.

## Tests

`test/serve/delete-task.test.ts` (a stand-in module: today's dialog, the two choices, each answer, `deleteChat`, a locked module).
The module's own tests and its e2e check are in chorus-core. The live run of this feature is in `.chorus/proof/feature/delete-task/`
(not committed).
