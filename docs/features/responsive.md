# The desktop page on a phone and a tablet

The desktop page (`src/desktop/`) and the optional module's screens work at three sizes, so Chorus can be used from a phone or a
tablet through the private link. At 1025 px and wider with a mouse the page looks as it always did.

| | Phone ≤ 640 px | Tablet 641–1024 px | Desktop ≥ 1025 px |
|---|---|---|---|
| Moving around | tab bar with drawn icons: Home · Chats · a raised round ＋ (New chat) · Approvals (red count) · More; ‹ Back in the top bar | ☰ opens the sidebar over the page | sidebar |
| Top bar | a big serif title on the four places (the bell on Home); ‹ and the title elsewhere; Cancel · New chat · Start on New chat | crumbs, icon-only buttons | as before |
| Home | the first waiting request as a card with Deny / Allow (none when nothing waits), one counts strip (working · your turn · resting), Active now rows, projects as rows | sidebar | sidebar |
| Chats | search, filter chips with counts, one card per project; sub threads and hand-offs under their owner with a connector | sidebar | sidebar |
| New chat | the text, then Teammate, Work as, Project / Model, Permissions as labelled rows in two cards; no tab bar | composer with picker chips | as before |
| A chat | back, the agent's avatar, title, agent · state, the Raw / Chat switch, ⋯; one segmented row Chat · (Steps · Plan) · Files; opens in the Chat view ([`chat-view.md`](chat-view.md)) with its message box, or the agent's screen edge to edge in Raw (unchanged); a request docks as a card at the bottom; Share, Hand off, the module's actions, Activity, Record, Delete in the ⋯ sheet | icon buttons, Raw · Chat in the header, the drawer over the agent screen; opens in Raw | Raw · Chat in the header; opens in Raw |
| Approvals | the same request card, All projects / this project as a segmented control, Decided today with Allowed / Denied tags | as before | as before |
| More | grouped rows (Library, Team, This Mac) with drawn icons in colour tiles and each row's state on the right; the plan card at the bottom | sidebar | sidebar |
| Dialogs, picker menus | bottom sheets (a picker: its name on top, a line of help per choice, a tick on the chosen one); a tap on the dim area cancels | as before | as before |
| Notifications | full screen | popover | popover |
| Memory | the list, then a record as its own step | two columns | two columns |
| Task chat (module) | Chat · Steps · Plan · Files tabs; Chat is the Chat view or Raw by the same switch | the panel over the chat | beside the chat |
| Portal (module) | Tasks, Needs you, Goals, Failures as tabs; tasks as a list grouped by state, Done folded | the board scrolls and snaps to a column | as before |
| Processes (module) | the chain as a vertical list | the canvas, pinch and buttons to zoom | as before |

On touch at any size (`@media (hover: none), (pointer: coarse)`) every button and field is at least 36 px tall (Sync skills' Edit and
its tick-boxes included), list, sheet and tab-bar rows 44 px, text fields use 16 px text (iOS does not zoom in on focus), and what
shows on hover (a project's ＋ and ×) shows always. The agent's own screen is not changed by this. On a phone a chat opens in the
Chat view, which has its own message box (owner, 2026-11-22: the one exception to "a chat never gets a Chorus composer"); Raw, and
the Chat view on a tablet or a desktop, have none: you type in the agent's own screen. A chat's top bar on a phone has the switch
beside ⋯, the one addition to Raw there.

The phone's look is the mockup `@workspace/mockups/phone-ui-v2.html` (approved 2026-11-22; it replaces the phone frames of
`ui-mockup-v3.html`'s Responsive scenarios). Its tokens are the app's own plus `--plan`, `--plan-soft` (the Planner's purple) and
`--bar` (the translucent tab bar). The phone's classes start with `pv-` so the module's own styles never reach them.

## How it is built
- **One page.** Media queries do most of it (`style.css`: the tablet block `max-width: 1024px`, the touch block, the phone block
  `max-width: 640px`). `index.html` adds `<nav id="tabs">` and `.side-scrim`, hidden on a desktop; `viewport-fit=cover`, `100dvh`
  and safe-area padding (`--safe-top`, `--safe-bot`) handle the notch and the iOS address bar.
- **`app.js`** keeps `S.size` (`phone`, `tablet`, `desktop`) from two `matchMedia` queries, writes it on `<html data-size>` and
  redraws the screen when it changes. A phone gets its own `home`, `chats` and `more` views (on wider screens they open New chat),
  the tab bar (`renderTabs`), its top bar (`phoneTop`), the ⋯ sheet (`drawSheet`) and Memory's record step. New chat and Approvals
  draw a phone layout of their own (`newChatHtml`, `approvalsPhone`). The shared parts: `avatar` (agent colour and letter, the
  Planner purple, a state dot), `phState` (needs you · working · your turn · resting), `chatRowPv`, and `reqCard` with `reqAnswers`
  (the request card of Home, Approvals and a chat's dock). Files is the chat's Artifacts, drawn in place of the agent's screen.
  "Always allow in this chat" shows only when the CLI's prompt has an always answer (`approvals[].always`; `POST
  /api/chats/:id/approve {always: true}` types it). The tab bar steps
  aside while the on-screen keyboard is up (`visualViewport`, `html.kb`). Picking a folder on a touch device uses the page's own
  folder browser: the Mac's picker would open on the Mac.
- **The module** (chorus-core `src/pro/ui/`) uses the same three sizes. Its own screens (Portal, Processes, Teammates, a task,
  Remote access) keep their v1 phone layout until their v2 mockup is drawn. Its contract with the page:
  - `document.documentElement.dataset.size` picks its phone renderings (Processes as a list, the Portal's tabs and grouped list).
  - `nav` slot with `data-part="team"` or `"mac"`: More's rows (`.mrow` with `data-pro-go`); the page gives them its tiles and
    chevron (`tileMoreRows`). A bundle older than the page ignores the part; More then shows its sidebar items under Team.
  - `home` slot: Chorus's own requests, as Home's card when no chat request waits.
  - `chat-actions` slot: over the chat on wider screens; on a phone it is drawn in the ⋯ sheet instead.
  - `sideTabs(chatId)` → `[['steps', 'Steps'], ['plan', 'Plan']]` or null; the `chat-side` slot gets `data-tab` for the part shown.
    Its Chat tab is the page's own chat column, so it shows the Chat view or Raw by the page's switch with nothing from the module.

## Test
`npm run proof:desktop -- --sizes` (`test/smoke/proof-sizes.ts`, checks in `test/smoke/sizes.ts`): fake agents, seeded chats in three
projects, an approval card; every screen at 390 × 844, 820 × 1180 and 1280 × 800, light and dark. On each: the page never scrolls
sideways, no visible control is cut off, and on touch the sizes above. The desktop screens are also taken from the newest release
(`--before <ref>`) and compared pixel by pixel (under 1 % may differ). Report in `.chorus/proof/<branch>/sizes/`.
The module's screens run in chorus-core with Pro unlocked: `npm run build:pro -- --dev && node test/pro-e2e/run.ts --stage sizes
--public <chorus checkout>`. The public checkout loads chorus-core through its `node_modules`: that copy must be the dev build (it holds
the fake licence's test key), or Pro stays locked and the check stops at "Pro unlocks".
