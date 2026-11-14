# Report issue: to the admin page, with screenshots; which AI CLI fits best

Built 2026-11-14 (branch `feature/report-images`). The Doctor's Report issue sends to the Chorus team's admin page instead of
GitHub, with optional screenshots and email; the Welcome screen and New chat say which AI CLI fits best.

## Report issue

What the user sees and what is sent: [`../doctor.md`](../doctor.md) §7.1.

| Part | Where |
|---|---|
| Dialog, screenshots (scale to ~1 MB, pick / drop / paste), sent and not-reached states | `src/desktop/app.js` (`reportIssue`, `scaleShot`, `addShots`, `sendReport`), `src/desktop/style.css` (`.rp-*`) |
| Details text, `setup`, chips | `src/core/doctor.ts` (`reportDetails`, `installMethod`, `channelOf`, `osName`) |
| Routes `POST /api/doctor/issue`, `/issue/image`, `/issue/send` | `src/serve/server.ts` |
| To the backend: `POST /v1/reports`, `PUT /v1/reports/<id>/images/<n>` | `src/serve/reports.ts` (`parseReport`, `imageType`, `ReportSender`) |
| The backend and the admin Reports tab | chorus-admin, `docs/client-contract.md` "User-started report" |

What the app sends to the backend:

- `POST /v1/reports` (JSON): `installationId`, `installationKey`, `title` (the first words of what happened when the user gave
  none; the backend needs one), `what`, `details`, `setup` (`channel` preview / production / dev, `install`, `core`, `paid`, `os`,
  `kernel`, `arch`, `cpu`, `ram`, `node`, `shell`, and `clis`: a list of `{ id, name, version, state, tested, test }` with state
  `ready`, `login`, `update` or `missing`), `email` (only when given), `platform`, `appVersion`, `imageCount` → `{ id, ref }`.
- Then per image n = 1…imageCount: `PUT /v1/reports/<id>/images/<n>`, the raw bytes, `content-type` from the image's first bytes,
  headers `x-installation-id`, `x-installation-key`. A screenshot that fails is tried once more; the report is kept and the sent
  screen says how many did not arrive.
- Limits checked before sending (the backend checks them too): title 200, what 5,000, details 60,000 characters, email 200, 4
  images of at most 1.5 MB each, PNG / JPEG / WebP by magic bytes.

## Which AI CLI fits best

`src/desktop/cli-fit.js` (mockup `ui-mockup-v3.html` scenes "Welcome: which CLI fits best (strip)" and UC-01 New chat):

- Welcome: one bordered strip under the lead, with the three CLI marks: "🙏 Thank you for supporting Chorus. It works best with
  Claude Code today: every feature is built and tested with it first. Codex and Antigravity work too, and we're still improving
  them. Use any of them, and switch at any time."
- New chat: with Codex or Antigravity picked (no teammate), the faint line under the box reads "<CLI> works, and we're still
  improving it. Claude Code works best today."; with Claude Code the usual hint stays; a hand-off and the optional module's own
  hint keep theirs.

## Tests

- Unit: `test/serve/reports.test.ts` (fake backend: shapes, not reached, 5xx, rate limit, an image that fails),
  `test/serve/serve.test.ts` (the routes, an image past the 1 MB body limit, a dropped path), `test/serve/doctor-report.test.ts`
  (sections, nothing naming the machine, `setup`, chips, install method and channel), `test/serve/cli-fit.test.ts`.
- E2E: `node test/smoke/proof-report-images.ts` (headless Chrome, a fresh Chorus home, notifications off, a fake backend; with
  `--admin <chorus-admin checkout>` chorus-admin's local run (`test/local-admin.mjs`: in-memory store and bucket) instead, read back through its admin route). Each screen beside its
  mockup scene in `.chorus/proof/<branch>/`.
