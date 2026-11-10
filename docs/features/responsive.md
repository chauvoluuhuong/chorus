# The desktop page on a phone and a tablet

The desktop page (`src/desktop/`) and the optional module's screens work at three sizes, so Chorus can be used from a phone or a
tablet through the private link. At 1025 px and wider with a mouse the page looks as it always did.

| | Phone ≤ 640 px | Tablet 641–1024 px | Desktop ≥ 1025 px |
|---|---|---|---|
| Moving around | tab bar: Home · Chats · ＋ (New chat) · Approvals · More; ‹ Back in the top bar | ☰ opens the sidebar over the page | sidebar |
| Top bar | ‹ Back, the screen's title, at most two icons (the bell on Home, ⋯ on a chat) | crumbs, icon-only buttons | as before |
| A chat | agent and state; Hand off, Artifacts, Activity, Record, Delete in a ⋯ sheet; the drawer is a bottom sheet | icon buttons, the drawer over the agent screen | as before |
| Dialogs, picker menus | bottom sheets; a tap on the dim area cancels | as before | as before |
| Notifications | full screen | popover | popover |
| Memory | the list, then a record as its own step | two columns | two columns |
| Task chat (module) | Chat · Steps · Plan tabs | the panel over the chat | beside the chat |
| Portal (module) | Tasks, Needs you, Goals, Failures as tabs; tasks as a list grouped by state, Done folded | the board scrolls and snaps to a column | as before |
| Processes (module) | the chain as a vertical list | the canvas, pinch and buttons to zoom | as before |

On touch at any size (`@media (hover: none), (pointer: coarse)`) every button and field is at least 36 px tall, list, sheet and
tab-bar rows 44 px, text fields use 16 px text (iOS does not zoom in on focus), and what shows on hover (a project's ＋ and ×) shows
always. The agent's own screen is not changed by this: its size on a phone is a later plan.

## How it is built
- **One page.** Media queries do most of it (`style.css`: the tablet block `max-width: 1024px`, the touch block, the phone block
  `max-width: 640px`). `index.html` adds `<nav id="tabs">` and `.side-scrim`, hidden on a desktop; `viewport-fit=cover`, `100dvh`
  and safe-area padding (`--safe-top`, `--safe-bot`) handle the notch and the iOS address bar.
- **`app.js`** keeps `S.size` (`phone`, `tablet`, `desktop`) from two `matchMedia` queries, writes it on `<html data-size>` and
  redraws the screen when it changes. A phone gets its own `home`, `chats` and `more` views (on wider screens they open New chat),
  the tab bar (`renderTabs`), its top bar (`phoneTop`), the ⋯ sheet (`drawSheet`) and Memory's record step. The tab bar steps
  aside while the on-screen keyboard is up (`visualViewport`, `html.kb`). Picking a folder on a touch device uses the page's own
  folder browser: the Mac's picker would open on the Mac.
- **The module** (chorus-core `src/pro/ui/`) uses the same three sizes. Its contract with the page:
  - `document.documentElement.dataset.size` picks its phone renderings (Processes as a list, the Portal's tabs and grouped list).
  - `nav` slot with `data-part="team"` or `"mac"`: More's rows. A bundle older than the page ignores the part; More then shows its
    sidebar items under Team.
  - `home` slot: Chorus's own requests under Home's "Needs you".
  - `sideTabs(chatId)` → `[['steps', 'Steps'], ['plan', 'Plan']]` or null; the `chat-side` slot gets `data-tab` for the part shown.

## Test
`npm run proof:desktop -- --sizes` (`test/smoke/proof-sizes.ts`, checks in `test/smoke/sizes.ts`): fake agents, seeded chats in three
projects, an approval card; every screen at 390 × 844, 820 × 1180 and 1280 × 800, light and dark. On each: the page never scrolls
sideways, no visible control is cut off, and on touch the sizes above. The desktop screens are also taken from the newest release
(`--before <ref>`) and compared pixel by pixel (under 1 % may differ). Report in `.chorus/proof/<branch>/sizes/`.
The module's screens run in chorus-core with Pro unlocked: `npm run build:pro -- --dev && node test/pro-e2e/run.ts --stage sizes`.
