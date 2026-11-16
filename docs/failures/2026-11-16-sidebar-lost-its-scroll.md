# The sidebar jumped back to the top by itself

Reported by the owner · 2026-11-16 · fixed on `feature/delete-task` (d2a0006)

## What broke
With more chats and tasks than fit, the left sidebar went back to the top on its own: while an agent worked, after opening a chat,
after folding a task.

## Why
`renderChrome()` in `src/desktop/app.js` rewrote the whole `#side` with `innerHTML` on every state push and every refresh from the
optional module. The scrolling list `.tree` was a new element each time, so its scroll position started at 0. Nothing saved it,
although the main view already kept its own scroll.

## Fix
Read `.tree`'s `scrollTop` before the sidebar is redrawn, and put it back after the module's slots are filled. The markup and the
style did not change.

## How to avoid it
A view that is redrawn with `innerHTML` and scrolls keeps its `scrollTop` across the redraw, or it is redrawn in place.

## Regression test
`test/serve/sidebar-scroll.test.ts`: real `chorus serve` and headless Chrome. It scrolls the sidebar, causes a state push and checks
that `scrollTop` did not change. It fails without the fix (`scrollTop` 0).
