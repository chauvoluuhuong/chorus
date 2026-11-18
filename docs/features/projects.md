# Projects: a page per project, its working environment, and the model's tools

Every project that has a chat gets its own page: Settings › Projects › *project* on the desktop (the sidebar menu, or ⋯ on the
project's row), More › Projects › *project* on a phone. Hovering a project in the sidebar shows ＋ (new chat in it) and ⋯ (its
page); on touch screens both are always shown. Delete is no longer in the sidebar: it lives in the page's Danger zone.

## The page

- **Header**: the project's name, its folder, and its counts: chats, tasks (only with Pro, from the paid module's `projectCounts`
  hook) and artifacts. A short **description** (the project's note) says what the project is and how its folders relate; every
  later chat reads it through `get_project`.
- **Stale banner**: "N running chats still use the old folders and variables" with **Restart idle ones**. An idle chat is resumed
  (conversation kept) with the new settings; a chat in the middle of a turn is never restarted: it waits until its turn ends.
- **Working folders**: the project folder, then extra folders every chat started in the project gets, each with who added it
  (you, or the chat that asked) and why. Removing one leaves the folder on disk.
- **Environment variables**: names only on the page (`••••••••`), with Edit and ×. The value is typed into a hidden field.
- **Export this project**: one `.zip` in Downloads (`chorus-<project>-<YYYY-MM-DD>.zip`) with only this project's chats and artifacts,
  `project.json` with the description, folders and variable names with their why (never a value), and with Pro its tasks
  (`pro/tasks.json` plus one Markdown page per task, the module's `exportProject` hook).
- **Danger zone › Delete…**: the warning lists what goes (chats, tasks, artifacts Chorus keeps, the project's description,
  folders and variables), says the folder and every file in it stay, offers **Export first**, and keeps **Delete project**
  disabled until the project's name is typed. A toast says what was deleted.

## Where settings and values live

| File | Holds | Mode |
|---|---|---|
| `<store root>/projects.json` (normally `~/.chorus`) | per project: the note, the folders and the variable **names**, each with why, by, at and the approval that allowed it | default |
| `<store root>/project-env.json` | the variables' **values** | `0600` |

`src/core/projects.ts` (`ProjectSettings`) is the one reader and writer. Values are read only by `env()` for a launch. They never go
into an export, a log, an event, a card answer, a chat turn, the start text or an MCP reply, and never onto a command line: the
launch passes them in the process environment only (`test/serve/proposal-answer.test.ts` and `npm run smoke:projects` grep for a
typed value and expect it only in `project-env.json`).

## How a chat gets them

`src/serve/pro.ts` `ChatLaunch.extras` gives every start and every resume, for every CLI, `addDirs` (the extra folders), `env` (the
variables) and `liveDirs`. chorus-core's `launch.ts` turns them into each CLI's own per-session flag: Claude `--add-dir`, Codex
`--add-dir` (before `resume`), agy its add-dir argument (probed in chorus-core, [integrations/](../integrations/README.md): the "Project folders and
variables" section of each CLI's file, with its "Running chat" rows). No CLI settings file is written.

What reaches a **running** chat (`src/serve/project-runtime.ts`, `ProjectRuntime`):
- **A new folder** goes live, without a restart, the CLI's own way (chorus-core `src/livedir.ts`): Claude and agy get `/add-dir`
  typed while the chat is idle, and Chorus answers "for this session"; Codex gets it through its `request_permissions` tool (turned
  on per chat with `-c features.request_permissions_tool=true`), answered "grant for this session" through the mailbox. Chorus never
  types over the user's input and never into a chat in the middle of a turn. If a live add fails, the chat restarts at turn end.
- **A removed folder, a new, changed or removed variable** only marks the other running chats stale: they show in the banner and
  get the change at their next resume or when the user presses Restart idle ones.
- Idle and turn end come from the one watcher (TurnWatch, [watcher-and-mail.md](watcher-and-mail.md)).

## Model tools

All four are in Chorus's MCP server (`src/mcp/server.ts`, `PROJECT_TOOL_NAMES`), answered by `chorus serve`
(`src/serve/project-tools.ts`), callable without a permission prompt, and limited to the calling chat's own project.

| Tool | Does |
|---|---|
| `get_project()` | The chat's project: name, folder, note, working folders (why, by, created, exists), variable **names** with `in_this_chat`, `suggested_folders` (e.g. a sibling folder its `package.json` depends on), chats `{total, running}`, tasks `{total, open}` (only with Pro, from `projectTasks`), artifact count, last activity, `pending_restart` and `this_chat.missing`. Never a value, never another project. |
| `propose_project_change(changes, reason?)` | One card for the **user** with a list of changes: `set_note`, `add_folder`, `create_folder` (its parent must exist), `remove_folder`, `set_variable` (name only; an optional `suggested_value` that is not secret), `remove_variable`, each with its own why. Every change is checked first; all errors come back together and no card is made. The card goes to the user from any chat, Workers and sub threads included, never to a Planner. The chat reads only "approved/declined" and "<NAME> is set (value hidden)". |
| `reload_project_settings()` | Restart this chat at the end of its current turn, conversation kept, so it gets the project's current folders and variables. |
| `rename_chat(title)` | Names this chat (below). |

`MCP_INSTRUCTIONS` tells models: when the project has no description, when `get_project` suggests folders, or when a folder outside
the project or a variable is needed, set it up with one `propose_project_change` call; never ask the user to edit a CLI config or a
shell profile, and never ask for a secret in the chat; once there is a plan, name the chat with `rename_chat` (a Planner also
renames its task with `task_update`).

### The proposal card

Stored in `requests` with the changes in its `proposal` column, and shown where every card shows (the chat, Approvals, the phone's
Approvals tab). A card with a `set_variable` has a hidden value field per variable (Show reveals it); the user may edit the
description. Choices: **Decline**, **Approve** (or Add folder / Set variable for one change) and **Approve and restart this chat**.
Approving applies every change with who asked, why and the card's id; `create_folder` makes exactly one folder. A new folder goes live
to every running chat of the project, the asking one included. "Approve and restart" restarts the asking chat once the turn that
reads the answer has ended. A `set_variable` without a typed value refuses the whole answer: nothing is applied and the card stays.

## Naming a chat: `rename_chat`

A chat is named from its first message (the first 28 characters), so a Planner chat reads "You are Planner. Read the in…". The
model fixes that with `rename_chat(title)`: one line, at most 60 characters, its own chat only. Serve's `renameChat` (route
`POST /api/chats/:id/title`, `by: "model"`) updates the store and the CLI app's entry title, and sends a `renamed` event; the
desktop shows the new name at once with an **Undo** toast (the existing toast style), and Undo calls the same route with
`by: "you"`.

## The one change in the CLI app

The owner allowed one small change in `src/app/` for this feature (decision 3): `src/app/controller.ts` passes the launch's `env`
to the chat process (`env: launch.env`; ThreadHost already accepted `env`). Without it the variables would not reach chats that
`chorus serve` starts through the app's controller. Nothing else in `src/app/` changed.

## API (`chorus serve`, under `/api/`)

`GET projects`, `GET projects/one?project=`, `POST`/`DELETE projects/folders`, `POST`/`DELETE projects/variables`,
`POST projects/note`, `POST projects/restart-idle`, `POST export {project}`, `DELETE projects`. No GET returns a value.

## Tests

`test/core/projects.test.ts`, `test/core/export-project.test.ts`, `test/serve/projects-api.test.ts`,
`test/serve/project-launch.test.ts`, `test/serve/proposal-answer.test.ts`, `test/serve/projects-ui.test.ts`,
`test/mcp/get-project.test.ts`, `test/mcp/propose-project-change.test.ts`, `test/mcp/rename-chat.test.ts`; e2e with the real CLIs:
`npm run smoke:projects` (`test/smoke/projects.ts`: new and resumed chats, the live folder add, a Claude chat setting a project up
by itself, export and delete, rename and Undo).
