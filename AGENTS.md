# Chorus: notes for AI coding agents

Read this first in every session (Claude Code loads it through `CLAUDE.md`, which only imports this file; Codex and agy read it
directly). **Follow the build-app-workflow skill** (`~/.claude/skills/build-app-workflow/SKILL.md`) for every feature, bug fix,
release and doc: plan and agree the approach, prove what is uncertain, build, ship a preview, production only on approval.
This file holds the Chorus decisions and what differs from the skill. Docs start at [`docs/map.md`](docs/map.md).

## Decisions

- **App type**: a desktop app (`chorus serve` + `src/desktop/` + the Tauri shell `desktop/`, macOS and Linux) with the `chorus`
  command, installed by `install.sh` from the website. The CLI app (`src/app/`) is on hold (rule 7).
- **Branches**: `main` (preview releases) ← `dev` ← `feature/<slug>` | `fix/<slug>`; `hotfix/<slug>` from a production tag.
  (Branches before 2026-10-28 used `feat/`.)
- **Releases**: tag `vX.Y.Z-preview.N` (agent, after every `dev → main` merge) · tag `vX.Y.Z` (production, only after the owner
  approves that version). Versions come from Conventional Commits (`feat` → minor, `fix` → patch, breaking → major). Differs
  from the skill: **`package.json` is bumped for a production release** (see "Releases" below), and **`dev`/`main` keep their
  required review**, so the owner merges every PR into `main`.
- **Test**: `npm test` + `npm run typecheck`; e2e with the real CLIs: `npm run smoke*` and `npm run proof:desktop`
  (harness: [`docs/testing.md`](docs/testing.md)). Evidence in `.chorus/proof/<branch>/` (gitignored).
- **Deploy**: GitHub Releases of this repo (built by `.github/workflows/release.yml`); production also goes to the website
  `https://chorus-cli.web.app` (chorus-admin CI on its `main`). Rollback: revert on `dev`, ship a preview, propose a patch.
  Never move or delete a pushed production tag.
- **Cost**: est. $0/month here (GitHub Actions on a public repo, GitHub Releases); the website and backend costs are in
  chorus-admin's docs.

## Install

- Preview: `curl -fsSL https://chorus-cli.web.app/install.sh | bash -s -- --preview` (the rolling GitHub prerelease `preview`,
  always the newest `vX.Y.Z-preview.N`)
- Production: `curl -fsSL https://chorus-cli.web.app/install.sh | sh`
- To try either without touching the installed app: add `CHORUS_INSTALL_DIR=<tmp> CHORUS_BIN_DIR=<tmp>/bin
  CHORUS_APP_DIR=<tmp>/apps CHORUS_NO_OPEN=1 CHORUS_NO_MODIFY_PATH=1` before `bash`.

## What we are building

Chorus makes it easy for developers to work across AI coding CLIs (Claude Code `claude`, OpenAI
Codex `codex`, Google Antigravity `agy`): handoff with shared context, all threads in one place,
visibility of tool calls / approvals / artifacts, one set of skills for every CLI.

- **Priority now: the desktop app** (`chorus serve` + the page in `src/desktop/` + the Tauri shell
  in `desktop/`). The `chorus` CLI app (npm package `@chauvoluuhuong/chorus`, terminal UI in `src/app/`) runs on
  the same core and is on hold (rule 7).
- This repo is public: no business material (pricing, sales goals, competitors, launch or marketing plans) goes in it, in code,
  docs or commit messages. That belongs in chorus-core.

## Three repos

| Repo | Visibility, licence | Holds |
|---|---|---|
| `chauvoluuhuong/chorus` (this one) | Public from launch. AGPL-3.0-only, with an additional permission to combine it with chorus-core (`LICENSE`, `NOTICE.md`) | The app: store, handoff, memory, MCP tools, desktop, CLI app, installers (curl, Homebrew, npx), the release build. Users install from here and file issues and doctor reports here |
| `chauvoluuhuong/chorus-core` (private, `git@github.com:chauvoluuhuong/chorus-core.git`, checked out next to this one; branches `dev` and `main`) | Private source, `UNLICENSED`. Only its built bundle is published, to public npm as `@chauvoluuhuong/chorus-core`, so installing Chorus installs it with no login | The CLI integration: adapters, launch flags, transcript discovery, approval detection, the doctor, the probes, the version matrix, fixtures, `docs/integrations/` |
| `chauvoluuhuong/chorus-admin` (private, `git@github.com:chauvoluuhuong/chorus-admin.git`, checked out next to this one; branches `dev` and `main`) | Private. The migrated site keeps its AGPL terms; new admin/backend code is `UNLICENSED` | The landing page and its Vietnamese page, `install.sh`, `release.json` and the installer downloads at `https://chorus-cli.web.app`; the notification admin (`/admin/`); the backend API the desktop app calls once per launch (notifications, approximate counts). Has its own CI/CD (see "chorus-admin" below) |

- This repo's npm package is **`@chauvoluuhuong/chorus`**. `chorus-cli` on npm belongs to someone else: never install or publish it.
- The split is done (`docs/chorus-core.md` §6): CLI integration code (adapters, launch flags, the doctor and its install commands,
  probes, fixtures, `docs/integrations/`) lives in chorus-core; `src/core/` here is what Chorus does with it (store, handoff,
  skills, launch with the MCP server). A fact or fix about how a CLI behaves goes in chorus-core, not here.
- **Clone both side by side**: `chorus/` and `chorus-core/` in the same folder. Here `fixtures/` and `docs/integrations/` are
  symlinks to `../chorus-core/`, and `package.json` depends on `file:../chorus-core` (run `npm run build` there first).
  `fixtures/` is the real captured output of each CLI per version: the evidence for every integration fact, and the data the
  tests replay (contract tests in chorus-core; the fake agent, approval and screen tests here).
- Before this repo goes public, its history must not carry core material (`docs/chorus-core.md` §6, step 4b).
- After install the doctor runs a 1–5 s check with no model calls, and the deeper integration test only for untested CLI
  versions (`docs/doctor.md`). The tested versions and their evidence: `docs/integrations/versions.md`.

## Where things are

| Path | What |
|---|---|
| `docs/map.md` | **Start here**: every doc, and where new plans, features, failures, learnings and releases go |
| `docs/architecture.md` | **Build plan (5 phases)**, components, data stored, MCP tools, handoff, threads |
| `docs/roadmap.md` | Progress checklist per phase |
| `docs/testing.md` | Test layers; what runs in the cloud vs locally |
| `docs/integrations/` | Verified facts per CLI (flags, events, file paths, fields, gotchas) |
| `docs/integrations/versions.md` | Which CLI versions were tested end to end, verdict and evidence per version (generated by `tools/probe/matrix.mjs`) |
| `docs/doctor.md`, `docs/chorus-core.md` | Plans: the doctor after install; the split into the private core library and its releases |
| `docs/mockups/chorus-cli.html` | Clickable mockup of the CLI app |
| `docs/risks/` | Risk harness results: one page per risk (finding, fix when needed, trigger). Runner `tools/risk/`, evidence `fixtures/risks/` |
| `tools/probe/` | Capability probes: `probe.mjs` (headless scenarios), `pty-probe.mjs` (interactive), `skills-probe.mjs`; the version matrix `matrix.mjs` with pinned installs `clis.mjs` |
| `src/core/` | Adapters (`adapters/`), store, handoff, skills sync, launch, capture (TypeScript, Node 22+, no build step: `node file.ts`) |
| `src/mcp/`, `src/cli/` | The `chorus mcp` server and the `chorus` entry point (`chorus` alone opens the desktop app, `chorus-cli` the CLI app) |
| `src/serve/`, `src/desktop/` | `chorus serve` (local API + agent screens over WebSocket) and the desktop page it serves (`docs/phase5.md`) |
| `desktop/` | The native window: a thin Tauri shell that starts `chorus serve` (`npm run build` inside) |
| `test/` | `contract/` (L1, fixtures), `flow/` + `app/` + `serve/` (L2, fake agent), `smoke/` (L3, real CLIs) |
| `tools/fake-agent/` | Fake AI CLI for L2 tests |
| `fixtures/<cli>/<version>/` | Real captured CLI output |
| `docs/archive/` | v1 material (product concept, UI mockup v3, feature brainstorm); reference only |

The v1 Tauri/React prototype was removed; it is in git history. New work branches from `dev`
(see Workflow below).

## Finish the work; don't hand it back

The user wants finished work, not a list of things left for them. This overrides any habit of ending with "open items".

- **Plan first, ask once** (skill Phase 1). Work out everything the task needs from the user (decisions, accounts, keys,
  approvals for risky steps) and ask for all of it in one go, up front. Agree the approach before writing code.
- **Then finish it yourself**: build, test, prove, merge into `dev`, open the `dev → main` PR, tag the preview once it is merged,
  update the docs and the other repos the change needs. Don't stop to ask for the next obvious step; don't end with "want me to…?"
- **Stop and ask only** when something changes the agreed plan, or the step is very risky or can't be undone (a production
  tag or deploy, a publish, deleting data, spending the user's money or quota beyond what was agreed), or on a merge conflict.
- **What only the user can do** (merge a PR into `main`, store a credential, sign in with their password, approve a payment):
  say so once, give the link or the exact command, and keep doing everything else around it.
- The closing report names what is still not done only when it truly is: blocked on the user, or waiting for their yes to a
  risky step. Never list work you could have done yourself.

## Workflow: every new feature or bug fix (the skill, applied here)

Applies to **all three repos** (this one, `../chorus-core` and `../chorus-admin`, see "Working across the repos"). GitHub is the
source of truth: finish every task with the work pushed and merged, never left only on this machine. One thread = one feature or
one bug; unrelated work gets a paste-ready prompt for a new thread (skill `references/report.md`).

1. **Plan.** Read this file, `docs/map.md`, the docs of the area, `git log`. Design two ways, pick one, ask once
   (`AskUserQuestion`). Write the plan to `docs/plans/<yyyy-mm-dd>-<slug>.md` (a bug: outcome, approach, test, risks only) and
   wait for the go-ahead on the approach. Rule 1 still applies: an approach that rests on how a CLI behaves is unproven until a
   probe has captured it.
2. **Prove** what is uncertain with the smallest spike, shipped as a preview (step 6) and checked with the real CLIs.
3. **Start from the remote.** `git fetch origin`. Local `dev` must equal `origin/dev`: if it is behind, `git merge --ff-only
   origin/dev`; if it is ahead (unpushed work), push it first. Then `git switch -c feature/<slug> dev` (or `fix/<slug>`). Never
   work directly on `dev` or `main`.
4. **Build.** Small Conventional Commits (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`, `test:`, `chore:`; `feat!:` or a
   `BREAKING CHANGE:` footer): the version is computed from them. Stage files by path (`git add <files>`), never `git add -A` or
   `git commit -a`: other sessions may be editing this same checkout, and their half-done files must not end up in your commit
   (run `git status` and look at what is staged). Run `npm test` and `npm run typecheck`; when the change touches an agent
   integration, also the matching `npm run smoke*`. Every bug fix gets a regression test that failed before the fix. Push the
   branch (`git push -u origin <branch>`) after the first commit and again after each later one.
5. **Prove it** in the real app:
   - UI (desktop page): a screenshot of the new or fixed screen, or a short video (≤30 s) for a flow or an animation.
   - No visible UI: the terminal output of the command or test that shows it working.
   Save proof in `.chorus/proof/<branch-name>/` (gitignored; don't commit videos).
6. **Ship a preview.**
   1. Open a PR `<branch> → dev` (skill PR body: What / Tested / Risk). The required review is bypassed for the owner's push, so
      merge it locally: `git switch dev && git merge --no-ff <branch> && git push origin dev` (GitHub marks the PR merged). If
      `dev` is checked out in another worktree, merge there with `git -C <that path>`, but only if that checkout is clean;
      otherwise ask.
   2. Open (or update) the PR `dev → main` titled `Preview vX.Y.Z-preview.N` (skill body). **The owner merges it** (review kept;
      don't use `--admin`). Send the link and go on with what does not need it.
   3. Once it is merged, tag the merge commit and push the tag (production tags sit on `main`'s merge commits, hence `--ref`):
      ```bash
      python3 ~/.claude/skills/build-app-workflow/scripts/bump_version.py --repo . --preview --ref origin/main
      git tag -a v1.1.0-preview.1 origin/main -m "preview" && git push origin v1.1.0-preview.1
      ```
      `release.yml` builds that prerelease and refreshes the rolling `preview`. Then check it installs with the preview command
      in "Install" (into temporary folders).
7. **Merge conflicts: never resolve them yourself.** Abort (`git merge --abort` / `git rebase --abort`) and show the owner the
   skill's conflict block (files, which branch/PR each side comes from, what each does, options, recommendation). Resolve as
   chosen, re-run the tests, continue.
8. **Docs, then report.** Update `docs/` (one home per fact, `docs/map.md`), in the same PR when possible. Report with the
   skill's final report: ✅ Done (honest: what was not run is said), 📦 Install (preview and production commands), 🙋 Needs you,
   ⚠️ Risks ("none found" when there are none), 💾 Worth saving globally (a suggestion only), 🔓 Open (with a new-thread prompt
   for unrelated items). Send the screenshot or video with its path. "Pushed" and "merged into dev" are part of done.

**Issues and hotfixes** follow the skill: every bug found or reported goes on GitHub (`gh issue create`, the skill's issue
template, logs redacted: this repo is public), the lesson in `docs/failures/`, then the owner chooses **hotfix** or **normal
fix**. A hotfix branches from the latest production tag (`git switch -c hotfix/<slug> vX.Y.Z`), bumps `package.json` to the
patch, is tagged on its head after "approve vX.Y.Z", goes through the website steps ("Releases" below), and is then merged into
`dev` (never into `main` directly; never `main → dev`).

In chorus-core `main` is meant to publish a new version; that release workflow is not built yet (`docs/chorus-core.md` §7). In
chorus-admin a merge into `main` is a production deploy (see its section below).

### Working across the repos

- The checkouts sit side by side (`chorus/`, `chorus-core/`, `chorus-admin/`) and a session may edit any of them. `gh` is logged
  in as `chauvoluuhuong` (SSH remotes), so pushing each repo works.
- A change that needs both goes **core first**: workflow above in `../chorus-core` (its own `npm test`, `npm run typecheck`,
  branch from `dev`, push, merge into `dev`, push), then `cd ../chorus-core && npm run build` so this repo sees it (`package.json`
  depends on `file:../chorus-core`), then the workflow here. Say in the report which commit of each repo belongs together.
- Never copy chorus-core source into this repo or print its source into public places (issues, the landing page, docs here).
  The release build (`npm run release:downloads`) builds the core from `../chorus-core` and ships only its `dist/`.
- `fixtures/` and `docs/integrations/` here are symlinks into chorus-core: edits to them are commits in chorus-core.

## Rules

1. **Verify against the real CLIs.** Never build on an assumed flag, event or file path. Run it,
   capture it with `tools/probe`, commit the fixture, then write the code. v1 failed because its
   tests passed against a fake harness while the real app didn't work.
2. **Every integration fact goes in `docs/integrations/<cli>.md`** with its status
   (✅ verified / 📄 docs only / ❓ unknown) and the version it was checked on.
3. **A phase is done only when its e2e proof passes with the real CLIs** (see architecture §2).
4. Never edit the user's global CLI config; use per-session flags.
5. When spawning a CLI: close stdin for headless runs, and remove `CLAUDECODE`,
   `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_PID` from the environment
   (a parent Claude session leaks its session id otherwise).
6. Review fixtures for personal data before committing (the probe redacts emails, account ids and
   the home path).
7. **Desktop app first; don't touch the CLI app without asking.** Build every feature and fix for
   the desktop app (`src/serve/`, `src/desktop/`, `desktop/`). Never change the CLI app
   (`src/app/`, its screens and `mux`, `test/app/`, `npm run proof`/`smoke:app`) unless the user
   says so in this session, even when the same change would fit there. Changes to shared code
   (`src/core/`, `src/mcp/`, `src/cli/`) are fine; if one changes how the CLI app behaves, say so
   and ask before merging.

## Commands

```bash
npm test                                   # L1 + L2, no login needed
npm run typecheck
npm run smoke -- --agents claude,codex,agy --phase 1,2,3   # L3 against the real CLIs (not-logged-in CLIs are SKIPped)
npm run smoke:app                          # the real app hosting the real agent TUIs in PTYs
npm run smoke:artifacts                    # each real agent saves a note in the thread's artifacts folder without being told in the prompt
npm run smoke:ask                          # each real agent asks for approval through a Chorus card (request_approval) and continues after the answer
npm run proof                              # Phase 4 e2e with screenshots → docs/proof/phase4/report.html, opened in the browser (real Claude + Codex, ~10 min)
npm run proof:agy                          # the same with agy (docs/proof/phase4-agy/, 30/30); agy has a small plan quota, don't repeat it often
npm run proof:desktop                      # Phase 5 e2e: the desktop page in Chrome + the native app, real Claude + Codex → docs/proof/phase5/
node src/cli/index.ts serve --open         # the desktop page in your browser (--fake-agents for UI work without model calls)
node src/cli/index.ts desktop              # the native window (installed app, else this checkout's build, else the browser); `chorus` alone does this
node src/cli/index.ts app                  # the CLI app (`chorus-cli`)
npm run install:global                     # `chorus` on the PATH (npm link) + Chorus.app built and copied to /Applications
node src/cli/index.ts mux codex agy        # try the app by hand
npm run risk -- free|cheap|<case>          # risk harness (docs/risks/README.md); `cheap` makes a few real model calls
node tools/probe/probe.mjs <cli>           # recapture fixtures after a CLI update
node tools/probe/matrix.mjs <cli> <v1,v2|installed>   # test given CLI versions end to end → docs/integrations/versions.md
npm run release:fetch                      # the GitHub Release's downloads (built by .github/workflows/release.yml on a vX.Y.Z tag) → ../chorus-admin/site/dl/; then npm run deploy:site
npm run release:downloads                  # the same downloads built on this Mac instead (Docker + Tauri); --out=<dir> writes elsewhere
```

## Current state and next steps

Phases 1–5 are built and proven with the real CLIs: 1–4 with Claude Code 2.1.302, Codex 0.163.0 and agy 1.4.2; Phase 5 (desktop:
`chorus serve` + the page in `src/desktop/` + the Tauri shell in `desktop/`, D3 decided) with Claude Code 2.1.306 and Codex 0.163.0,
43/43 in `docs/proof/phase5/` (`docs/phase5.md`, `docs/roadmap.md`).
2026-10-22 (`docs/phase5.md` §8): ＋ on each project row (New chat in that project), agy's screen anchored to the bottom, dropped
files (path like a terminal, or a copy into the chat; recorded for handoff), approval cards with room and Other…; proof:desktop
53/54. `npm run proof:agy` is stale since UI pass 2 (fails at step 1).
Phase 4 includes UI pass 2 (P4.10): the CLI app now matches `docs/mockups/chorus-cli.html` (top bar, project-tree sidebar, New chat
screen with skip-permissions, approvals inbox, shared Memory across projects in `~/.chorus/chorus.db`, Skills screen, window-size
steps). The e2e proof with screenshots of every step is `docs/proof/phase4/README.md` (`npm run proof`).

The risks found before Phase 5 are probed and written down in `docs/risks/`; the fixes wait for their triggers and are listed as
technical debt TD-2..TD-10 in `docs/roadmap.md` (memory must be injected, not left to agents; errors and file changes are invisible
to the adapters; transcript matching; kitty keyboard; Windows; plan-limit capture).

1. Technical debt that a user would hit first: TD-3 (a failed run looks empty), TD-4 for agy (two agy chats started together; Codex is matched by thread marker since 2026-10-22), TD-2
   (memory digest at chat start), TD-1 (one global skill library).
2. Desktop before release: signing and notarisation of `Chorus.app`, the Windows build (TD-6; Linux has the window since 1.0.11), a guard against the CLI app and
   the desktop resuming the same chat at once (`docs/phase5.md` §7).
3. D4 (provider terms) before release.

Known gaps: `file_change`, `reasoning`, `turn.failed` Codex events, agy errors/quota and the Claude plan-limit hit are not
captured by the adapters (fixtures of the first three are in `fixtures/risks/capture-errors/`, TD-3); ctx % in the status line is not built
(TD-11); the hand pointer (OSC 22) is not probed.

## chorus-admin: website, admin, backend, and their CI/CD

Clone it next to this repo (`../chorus-admin`) or set `CHORUS_SITE_DIR` to its `site/` folder. Read its `AGENTS.md`, `README.md`
and `docs/ci-cd.md` before changing it; the facts below are a pointer, those files are the source of truth.

- **CI/CD is set up there (GitHub Actions, `.github/workflows/ci-cd.yml`).** PRs and pushes to `dev`/`main` run validation only
  (tests, site/admin build, release metadata, generated pages match sources). **A push or merge to `main` deploys production**:
  Firestore indexes, the Cloud Run API, then the website, and verifies the live pages and installer URLs. Auth is keyless
  (Workload Identity Federation, `main` only). So merging chorus-admin `dev` into `main` is a production deploy: do it only when
  the user asks, same as a release here.
- **Releases** (`.github/workflows/release.yml`, the skill's release by tag with one change: `package.json` is bumped for
  production).
  - **Preview**: a `vX.Y.Z-preview.N` tag (workflow step 6) builds the GitHub prerelease of that tag and replaces the rolling
    prerelease `preview` with the same files, `VERSION` and `SHA256SUMS`, which `install.sh --preview` (or
    `CHORUS_CHANNEL=preview`) installs; the plain command goes back to production. The version is stamped from the tag into the
    build only. The website, `release.json` and the backup bucket are not touched. A preview build still offers the production
    release of its version, or a later one, in the app (`src/serve/updates.ts`).
  - **Production**: only after the owner approves that version. Propose it with the skill's production proposal (version from
    `bump_version.py --repo . --dry-run --ref <latest preview tag>`, save that changelog to a file first, the preview it rests
    on and its evidence, risks) and wait for "approve vX.Y.Z" (the owner may also say "release X.Y.Z": same thing). The approval
    covers that version and every step below, through the website. A `vX.Y.Z` tag must equal `package.json`'s version, or the
    build fails.
  - Rollback: revert on `dev`, ship a preview, propose a patch. Never move or delete a pushed tag; previews are disposable.
- **Releasing a production version** touches both repos: this repo's `.github/workflows/release.yml` builds the downloads on a
  `vX.Y.Z` tag; `npm run release:fetch` (or `release:downloads` on this Mac) writes `release.json`, `install.sh` and the
  ignored `site/dl/` into chorus-admin. Then in chorus-admin: `npm run backup:downloads` (copies the archives to its private
  release bucket; CI restores them from there and fails without it), commit the generated metadata, merge through `dev` to `main`,
  and CI deploys. `npm run deploy:site` here still delegates to chorus-admin for a manual deploy, but CI on `main` is the normal path.
- **The install command follows the website, not the GitHub Release.** `curl https://chorus-cli.web.app/install.sh | sh` reads
  `install.sh` and `release.json` from chorus-admin, so until the manual steps below are done a new release installs the previous
  version. Backing up needs the owner's Mac: CI cannot write to the release bucket on purpose (so a workflow can't replace the
  archives). Run them after **every** release, in this order, and don't call a release done before step 7:

  1. Bump: `npm version <v> --no-git-tag-version` on `release/<v>` from `dev` (commit `chore(release): <v>` with
     `package.json` and `package-lock.json`), merge into `dev`, push, open the PR `dev → main` (`Release <v>`); **the owner merges
     it**. Then tag its merge commit twice, so production is byte for byte the preview you checked: first the next preview
     (`bump_version.py --repo . --preview --ref origin/main`, push, wait for its build, install it with `--preview` into
     temporary folders), then `git tag -a v<v> <that preview tag>^{} -m "v<v>" && git push origin v<v>`. The tag starts the
     production build in `release.yml`.
  2. `gh run list --workflow release.yml --branch v<v> --limit 1` until it is `completed success`; `gh release view v<v>` lists
     the 5 files and `SHA256SUMS`.
  3. In this repo (a clean checkout of `main` at that release; `node_modules` present): `npm run release:fetch` → downloads the
     release into `../chorus-admin/site/dl/`, checks every file against `SHA256SUMS`, sets `VERSION` in `site/install.sh` and
     writes `site/release.json`.
  4. In `../chorus-admin` (on `dev`, clean): `npm run backup:downloads`, `npm test`, `npm run check:site`.
  5. Commit only the two generated files on `release/<v>`, merge into `dev`, push, open the PR `dev` → `main` and merge it (no
     review needed there). This is the production deploy.
  6. `gh run watch` the `CI and deploy` run on `main`.
  7. Verify what users get: `curl -s https://chorus-cli.web.app/release.json` shows the new `version`, the `install.sh` line
     `VERSION=` matches, and `curl -sI` on each `downloads.*.url` answers 200. If only the workflow's "Verify production" step is
     red, the CDN served the old `release.json` for a moment: compare the live file with `site/release.json` before treating it
     as a failure.

  The same steps as one script, run from the Chorus checkout (version as the argument; it stops at the first failing step and
  never uses `git add -A`):

  ```bash
  #!/usr/bin/env bash
  # usage: save as release-website.sh, run at the root of a clean chorus checkout:  V=1.1.0 P=v1.1.0-preview.2 bash release-website.sh
  set -euo pipefail
  V="${V:?set V to the released version, e.g. V=1.1.0}"
  ADMIN="${ADMIN:-../chorus-admin}"

  # 1. (done before: package.json bumped, merged into main by the owner, its preview tag P built and checked)
  P="${P:?set P to the checked preview tag on that commit, e.g. P=v1.1.0-preview.2}"
  git fetch -q --tags origin && git tag -a "v$V" "$P^{}" -m "v$V" && git push -q origin "v$V"

  # 2. the GitHub Release is built
  sleep 15
  until [ "$(gh run list --workflow release.yml --branch "v$V" --limit 1 --json conclusion -q '.[0].conclusion')" = success ]; do sleep 20; done
  gh release view "v$V" --repo chauvoluuhuong/chorus --json assets -q '.assets[].name'

  # 3. downloads, checksums, install.sh VERSION, release.json
  npm run release:fetch -- "$V"

  # 4. back up the archives, then the admin checks
  cd "$ADMIN"
  git fetch -q origin && git switch -q dev && git merge --ff-only -q origin/dev
  git status --porcelain | grep -v -e 'site/install.sh' -e 'site/release.json' && { echo "admin checkout not clean"; exit 1; } || true
  npm run backup:downloads
  npm test
  npm run check:site

  # 5. commit the two generated files, dev, PR to main, merge = production deploy
  git switch -q -c "release/$V"
  git add site/install.sh site/release.json
  git commit -q -m "Release $V metadata"
  git switch -q dev && git merge --no-ff -q "release/$V" -m "Merge release/$V"
  git push -q origin dev "release/$V"
  PR=$(gh pr create --base main --head dev --title "Release $V" --body "Website metadata for Chorus $V. Merging deploys production." | tail -1)
  gh pr merge "$PR" --merge

  # 6. wait for the deploy
  sleep 10
  gh run watch "$(gh run list --branch main --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status || echo "workflow red: compare the live file in step 7"

  # 7. verify what users get
  live=$(curl -s "https://chorus-cli.web.app/release.json?x=$RANDOM")
  [ "$(printf '%s' "$live" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')" = "$V" ] || { echo "live release.json is not $V"; exit 1; }
  curl -s https://chorus-cli.web.app/install.sh | grep -m1 "^VERSION=\"$V\"" || { echo "install.sh is not $V"; exit 1; }
  printf '%s' "$live" | node -pe 'Object.values(JSON.parse(require("fs").readFileSync(0,"utf8")).downloads).map(d=>d.url).join("\n")' | while read -r u; do
    echo "$(curl -s -o /dev/null -w '%{http_code}' -I "$u") $u"
  done
  echo "Release $V is live: curl -fsSL https://chorus-cli.web.app/install.sh | sh"
  ```

  Write `docs/releases/v<v>.md` (skill template: the preview it rests on, changelog, evidence) in the next docs PR.

  Things that went wrong before: the installed app stayed on the old version because only `release.yml` had run (a preview
  never changes the website either: only the steps above do); a checkout on
  another branch (another session switched it) changes what `release:fetch` and `git` act on, so use a separate worktree
  (`git worktree add ../chorus-release origin/main`) when another session is working here.
- The public domain `https://chorus-cli.web.app` and every installer/download URL must stay unchanged; never recreate or delete
  its Firebase Hosting site. Cloud project ids, the admin login and the backend's rules live in chorus-admin's docs; don't copy
  them here (this repo goes public).
- The desktop app's side of the backend (one request per launch, user-triggered open events, no polling, no prompts, code, paths
  or fingerprints sent) is specified in chorus-admin's `docs/client-contract.md`. A change to that call here must match it.
- Workflow there follows its `AGENTS.md` (branches, `npm test` and `npm run check:site` before a deploy, never commit installer
  archives or credentials), plus steps 1–5 above: branch from `dev`, push, merge into `dev`.
