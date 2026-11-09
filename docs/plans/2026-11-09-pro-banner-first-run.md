# Fix: what Free and Pro give, and the first-launch order

Status: **part A built**, 2026-11-09 (approved by the owner: "implement the all the plans"). Part B is a separate task. Mockup: `docs/mockups/pro-first-run.html` in chorus-core (private: it holds the Welcome's Pro words, which live in the backend).

## Outcome (owner, 2026-11-09)

1. **Free (Community, no sign-up)**: the Planner builds plans; everyone sees tasks, steps and their details; Workers run the
   steps automatically and Review checks them. The Planner and teammates are used as they come; their instructions are read-only.
2. **Pro**: exactly the gates set to Pro in Admin › Free and Pro, each with one line on the Welcome:

   | Gate | Where it stops | New |
   |---|---|---|
   | Open the Portal (`portal`) | Sidebar › Portal, a project's row | |
   | Edit instructions (`instructions`) | The Planner's and every teammate's instructions | ✓ |
   | Create and edit actions (`actions`) | Teammates › Actions › New, Edit | ✓ |
   | Edit processes (`processes`) | Processes › an action's next step and Ask first | ✓ |
   | Add failure notes (`failures`) | A task, a step, the Portal, the Planner's proposed failures | ✓ |
   | Create a new teammate (`teammate.create`) | Teammates › New teammate | |
   | Use remote access (`remote`) | Settings › Remote access | |

   Goals live on the Portal, so they need Pro with it; no gate of their own.
3. **First launch** after install: the Welcome (Community or Pro) first, then the Doctor popup.

## What is wrong today

| Where | Today | Fix |
|---|---|---|
| Welcome, Pro card (chorus-admin `server/plans.mjs`, `GET /v1/plans`) | Five items that are not the paid ones | The gates set to Pro, with their lines |
| Welcome, Community card | Doesn't say it plans and runs work (it can't today: Community has no Pro code) | Two items, once Community gets the bundle (part B) |
| Welcome offline (`welcomeHtml()`) | Pro card empty | The gate names |
| Trial ended (`endedHtml()`) | Names two gates | What stays, and every locked gate from the account's `locked` list |
| First launch | `firstDoctor()` opens the Doctor over the Welcome at once | The Doctor waits for the Welcome choice |

## Approach, in two parts

**A. This fix** (ships first; the Welcome's words come from the backend, so the Community lines wait for B):

- **chorus-admin** (`fix/pro-words`): `server/gates.mjs` holds each gate's id, name, where, what keeps working and the Welcome line,
  read by `accounts.mjs`, `plans.mjs` and `admin/pro.mjs`. Four new gates, Pro by default. `plansContent(settings)` returns
  `pro.features` (`[{ name, detail }]`) and `pro.items` as plain strings for apps already installed.
- **chorus-core** (`fix/pro-gates`, own worktree): `src/pro/index.ts` answers 402 with the gate on the writes each new gate covers
  (teammate instructions, action create/edit, process edits, failure add/edit including adding a proposed one);
  `src/pro/ui/app.js` shows those buttons with a lock and the upgrade dialog. The main session is editing the failure UI in the same
  file: coordinate before merging.
- **chorus** (`fix/pro-banner-first-run`, `src/desktop/`): the Doctor waits for the Welcome choice (Keep Community, Not now, or
  signed in; if the plan can't be read, it opens as today); the Welcome draws `features` (bold name, line under), else `items`;
  offline names; the trial-ended text; `.plan-card ul { align-content: start }`. The Community sidebar's locked items stay.
  Docs: `docs/doctor.md` §6.1, `docs/phase5.md`.

**B. Community gets the Pro bundle** (separate task): the backend gives each Community install an anonymous approval with every
Pro gate locked, so Community downloads the same obfuscated, per-install bundle. When it is live, the Community card gets
"The Planner plans your work" and "Steps run on their own".

## Test

- chorus-core: per new gate, locked → 402 and the dialog, trial → works. `npm test`, `npm run typecheck`.
- chorus-admin `npm test`: `/v1/plans` lists exactly the Pro gates; one set to Free drops out.
- chorus L2: a Community first launch shows the Welcome and no Doctor; Keep Community opens the Doctor; a later launch opens it at once.
- Proof: screenshots of a real first launch (empty `HOME`, `chorus serve`) in `.chorus/proof/fix/pro-banner-first-run/`.

## Risks

- Words and gates come from the production backend: until chorus-admin `main` is deployed, apps show the old list.
- Apps with an older chorus-core ignore the four new gates until they update.
- Someone who quits during the Welcome sees it again next launch, then the Doctor: as before.
