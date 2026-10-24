# chorus-core: the CLI integration layer and doctor as a library in its own repo (plan)

Status: **proposal**, 2026-10-23. Name: `chorus-core` (private repo `chauvoluuhuong/chorus-core`, npm `@chauvoluuhuong/chorus-core`;
both names were free on npm on 2026-10-23).

Decided 2026-10-23:
- `chauvoluuhuong/chorus` becomes **public** under **AGPL-3.0-only** (`LICENSE`), with an additional permission (AGPL §7) to combine it
  with chorus-core (`NOTICE.md`). Installing (installers, release downloads) and issues, doctor reports included, live there.
- chorus-core is **private**: its source, the probes, fixtures, the doctor suite and `docs/integrations/` are not published.
- Installing Chorus installs chorus-core with it, with no extra step and no login (§5).
- Merging `dev` into `main` in chorus-core builds and releases a new version on its own (§7).

## 1. Why

Everything Chorus knows about `claude`, `codex` and `agy` (flags, event formats, transcript paths, prompt screens and keys, plan
limits, install commands) changes when a CLI updates, on the CLI's schedule. Chorus's own code (store, handoff, memory, MCP tools, UI)
changes on ours. Today both live in one tree, so a Codex update means a Chorus release.

Split:

| chorus-core (new repo) | Chorus (this repo) |
|---|---|
| How to start, resume, read and answer each CLI; how to check one works on this machine (doctor) | What Chorus does with that: threads, handoff, memory, skills library, MCP tools, CLI app, desktop |

A CLI update that breaks something is then a patch release of chorus-core, and Chorus picks it up with a dependency bump (§7).

## 2. What moves

From the import graph today (`src/core/*` and `src/app/*`), these have no dependency on the store or the UI, or only a small one
to cut:

| Today | In chorus-core | Cut needed |
|---|---|---|
| `src/core/types.ts` (event and session types) | `types` | none |
| `src/core/adapters/{claude,codex,agy,util}.ts` (`parseStream`, `parseTranscript`) | `adapters` | none |
| `src/core/launch.ts` (`buildHeadless`, `buildInteractive`, `homes`, `run`, env cleanup of rule 5, agy workspace files) | `launch` | imports `TOOL_NAMES` and `APPROVAL_NOTE` from `src/mcp/server.ts` and paths from `skills.ts`: make them inputs (`mcp: {command, args, toolNames}`, `instructions: string`) |
| `src/core/discover.ts` (which transcript file is this chat's) | `discover` | none |
| `src/app/approval.ts` (prompt detector on the virtual screen) + the approve/deny keys | `approval` | none |
| `src/app/limits.ts`, `src/app/models.ts` (plan-limit reading, model and effort lists) | `limits`, `models` | `models.ts` reads launch only |
| `src/app/pty.ts`, `src/app/screen.ts` (PTY spawn, headless xterm screen) | `pty` (optional entry; `node-pty` and `@xterm/headless` as peer dependencies) | none |
| per-CLI skills folders (from `src/core/skills.ts`) | `skills.folders(agent)` | the skills **library** stays in Chorus |
| `VERIFIED_VERSION`, `versionWarning`, login status (`src/cli/commands.ts`) | `versions`, `prereq` | none |
| install commands and links (new) | `install` | none |
| `tools/probe/*` (with the version matrix `matrix.mjs` and pinned installs `clis.mjs`), `fixtures/claude|codex|agy/`, `docs/integrations/*` (with `versions.md`) | same paths in the new repo | these are the evidence for the code above; they move with it, with history (§10) |
| `tools/fake-agent/` | `fake-agent` (a test double other users can use too) | none |
| `fixtures/risks/` and the CLI-side cases of `tools/risk/` (terminal protocols, plan limit, capture errors, approval drift) | `risks/` | the Chorus-side cases (store concurrency, memory adoption) stay |
| doctor: prerequisites, suite, report, issue (`docs/doctor.md`) | `doctor` | new code |

Stays in Chorus: `store.ts`, `capture.ts` (writes adapter output into the store), `handoff.ts`, `preview.ts`, `drop.ts`, `opener.ts`,
`src/mcp/`, `src/app/` (controller, compositor, screens, tailer, thread-host), `src/serve/`, `src/desktop/`, `desktop/`, the skills
library, `docs/proof/`, the phase docs.

## 3. Shape of the library

```
chorus-core/
  src/
    types.ts
    agents/{claude,codex,agy}/        one folder per CLI: launch.ts, adapter.ts, approval.ts, limits.ts, install.ts, facts.ts
    launch.ts discover.ts approval.ts limits.ts models.ts versions.ts prereq.ts install.ts   the per-CLI parts behind one API
    pty/                              optional: spawn + virtual screen
    doctor/
      prereq.ts suite.ts report.ts issue.ts
      cases/c01-envelope.ts … c13-artifacts.ts x1-handoff.ts
      stub-mcp.ts                     the doctor's own tiny MCP server (§4)
    cli.ts                            `chorus-core doctor`, `chorus-core probe <cli>`
  fixtures/<cli>/<version>/
  docs/integrations/<cli>.md          moved from Chorus; still the source of truth (rules 1 and 2)
  tools/probe/ tools/fake-agent/ risks/
  test/contract/                      L1 against fixtures
  test/smoke/                         L3 against the real CLIs
```

Adding a fourth CLI is a new `agents/<cli>/` folder, its fixtures and its integrations page; the doctor suite then runs on it
unchanged.

The API Chorus calls (sketch; the names follow today's code so the move is mostly imports):

```ts
import { agents, buildHeadless, buildInteractive, parseStream, parseTranscript, findTranscript,
         detectApproval, approvalKeys, readLimits, prereq, installInfo } from '@chauvoluuhuong/chorus-core';
import { spawnPty, VirtualScreen } from '@chauvoluuhuong/chorus-core/pty';
import { runDoctor, buildIssue, sendIssue } from '@chauvoluuhuong/chorus-core/doctor';

buildInteractive('codex', { cwd, prompt, model, effort, skipPermissions,
  mcp: { name: 'chorus', command, args, toolNames },      // Chorus's MCP server, passed in
  instructions: artifactNote(project, threadId) });       // the envelope text, passed in
```

## 4. Doctor in the library, without Chorus

The cases of `docs/doctor.md` §4 test the CLI, not Chorus, so they run with no Chorus code:

- C6 (MCP binding) and C10 (`request_approval`) use `doctor/stub-mcp.ts`: a 50-line stdio MCP server with `list_threads` (returns
  the case's nonce as a thread title) and `request_approval` (writes a request file the suite watches, answers with `b.txt`). It
  goes through the exact same per-session wiring Chorus uses (`mcp` input of `buildHeadless` / `buildInteractive`), so a pass means
  Chorus's server is reached the same way.
- C1, C10 and C13 get their envelope text from the suite (the same shape as `artifactNote`).
- X1 (handoff) gives B the digest through the stub server's `get_handoff_context`, built from A's parsed stream.

`runDoctor` takes options and an event callback and returns the report; it never prompts. The prompts are the host's job: the
library's own `chorus-core doctor` CLI, `chorus doctor`, and the desktop popup (`docs/doctor.md` §6) all drive the same function:

```ts
const report = await runDoctor({ level: 'short' | 'quick' | 'full', agents, workspaceRoot, keep },
  ev => send(ev));   // { type: 'prereq' | 'case-start' | 'case-end' | 'agent-skip' | 'done', … }
```

Issues, integration failures included, go to the public `chauvoluuhuong/chorus` repo. The report carries the chorus-core version;
the fix is made in chorus-core and reaches buyers through §7.

## 5. Build, packaging and how buyers get it

**A private repo, a public build.** For `npm install -g @chauvoluuhuong/chorus` (and the curl installer, and `Chorus.app`, which installs
`@chauvoluuhuong/chorus` when it is missing) to bring chorus-core along with no login, npm must download it without credentials. A private npm
package or GitHub Packages both need a token on the buyer's machine, so they are out. Instead:

| What | Where | Who can see it |
|---|---|---|
| Source, probes, fixtures, doctor cases' source, `docs/integrations/`, risk harness | `chauvoluuhuong/chorus-core` (private) | us |
| The **built bundle only**: `dist/index.js`, `dist/pty.js`, `dist/doctor.js` (esbuild, minified, no source maps) + `.d.ts` + `LICENSE` | npm `@chauvoluuhuong/chorus-core`, public, `"license": "UNLICENSED"` | anyone who installs Chorus |

A guard in the release (§7) fails if anything but `dist/`, `package.json`, `README.md` and `LICENSE` is in the tarball, so
fixtures (real captures) can never be published. How much the build protects is §5.1.

- Node won't strip types inside `node_modules` (checked on Node 26.10.0: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), which is one
  more reason it ships built JS. Inside its own repo, tests still run with `node file.ts`, with no build step.
- No native addons in chorus-core itself: `node-pty` is a peer dependency that `@chauvoluuhuong/chorus` provides, so installing it never compiles
  anything.
- `@chauvoluuhuong/chorus` depends on an exact version (`"@chauvoluuhuong/chorus-core": "1.2.3"`), so a Chorus release always ships the chorus-core
  it was proven with, and npm installs it automatically.
- The single-executable build (`tools/packaging/build-sea.mjs`, esbuild) bundles it into the `chorus` binary like any other
  dependency.
- Anyone who clones the public Chorus repo gets chorus-core from npm on `npm install`, so Chorus still builds and runs from source.
- Local work on both at once: `npm link` (or a `file:../chorus-core` dependency) while developing; never committed.
- **The Chorus package is `@chauvoluuhuong/chorus`** (renamed 2026-10-23). `chorus-cli` on npm belongs to someone else
  (`npm@getchorusai.com`, "Automated ticket resolution with AI, Teams, and Slack integration", 0.5.4), and the older installers
  (`packaging/install.sh`, the Homebrew cask, `packages/installer`) ran `npm install -g @chauvoluuhuong/chorus`. The `chorus` command is the
  same. The current installer (`site/install.sh`) installs from a tarball on our site, so it never pulled their package.

### 5.1 Does the build stop people stealing the code?

It makes it harder, not impossible. Any code that runs on a buyer's machine can be read by someone who wants to. What each layer
buys:

| Layer | What it does | Cost | Plan |
|---|---|---|---|
| Private repo: source, fixtures, probes, `docs/integrations/`, history | Keeps the know-how private: why each flag and pattern is there, the captured evidence, how to re-verify after a CLI update | none | yes |
| Minify and mangle (esbuild `minify`, no source maps in the package) | Names and comments gone, one long line per file | Buyers' stack traces in doctor reports become unreadable, so each release keeps its source maps as a **private** release asset in chorus-core, used to decode reports | yes |
| Licence | `UNLICENSED`, a copyright banner at the top of each built file, terms in the package README: reusing it is a licence breach, so npm and GitHub takedowns apply | none | yes |
| Obfuscation (e.g. `javascript-obfuscator`: encoded strings, scrambled control flow) | Hides the flag strings and patterns from a plain search; slows a reader down | Bigger and slower code (the stream parsers run on every event); AI tools undo much of it | only if a copy shows up, and only on `launch` and `discover`, not the parsers |
| V8 bytecode instead of JS (`bytenode`) inside the app's own bundled Node | No JS source in `Chorus.app` at all | Tied to one exact Node version. The npm install runs on the buyer's Node, so it can't work there, only in the app or the single-file binary | not now |

Two things decide how much this matters:

- The rest of Chorus (UI, store, MCP server, handoff) is public source in `chauvoluuhuong/chorus` anyway. chorus-core is the part
  that is not, and it is the part that goes stale.
- **Copies go stale fast.** The facts move with every CLI release: agy auto-updated between two probe runs, Claude Code went from
  2.1.284 to 2.1.307 between 2026-10-17 and 2026-10-22 (`docs/integrations/`). A copied bundle is a snapshot that starts breaking
  within weeks. What keeps chorus-core working (the daily real-CLI run, the probes, the fixtures, the doctor reports coming in) all
  stays private. Copies are expected; this is why they don't hurt much.

## 6. Moving it (steps)

| Step | What | Done when |
|---|---|---|
| 1 | Cut the two dependencies in place, inside Chorus: `launch.ts` takes `mcp` and `instructions` as inputs; nothing under the "moves" list imports from `src/mcp`, `store.ts` or `src/app/controller.ts` | `npm test` + `npm run typecheck` green; a lint rule (or a test that reads the imports) keeps it so |
| 2 | New repo with history: `git filter-repo` on the paths of §2 into `chauvoluuhuong/chorus-core`, then the layout of §3 | its `npm test` (contract tests on the fixtures) green |
| 3 | Its API (§3), its build (§5), its own `chorus-core probe` | `npm pack` installs into an empty folder and `import` works from plain JS |
| 4 | Chorus switches imports to the package and deletes the moved files; `docs/integrations/` in Chorus becomes one line pointing at chorus-core | Chorus `npm test`, `npm run smoke`, `npm run smoke:app`, `npm run smoke:ask` green with the real CLIs |
| 5 | Doctor in chorus-core (`docs/doctor.md` §2–§5, §7, §9–§10) and `chorus-core doctor` | `chorus-core doctor --full` green on the Mac with claude + codex + agy |
| 6 | Chorus hosts: `chorus doctor` and the desktop popup (`docs/doctor.md` §6) | `npm run proof:desktop` with new doctor steps green; screenshots in `docs/proof/doctor/` |

| 4b | **Before `chauvoluuhuong/chorus` goes public**: its history still holds everything that is meant to stay private (`fixtures/`, `tools/probe/`, `docs/integrations/`, `fixtures/risks/`, the v1 prototype on `dev`). Switching the repo to public would publish all of it. Either rewrite the history with `git filter-repo --invert-paths` on those paths (all branches and tags; every clone must re-clone), or start the public repo from a fresh first commit of the cleaned tree and keep the old repo private as the archive (simpler, proposed) | a scan of the public repo's full history (`git log --all --name-only`) finds none of those paths, and no email or home path (`git grep` over all commits) |

Steps 1–4 change no behaviour; the existing proofs show it. Doctor starts only after the move, so it is written once, in its final
place.

## 7. Releases: GitHub workflows

Yes: merging `dev` into `main` in chorus-core builds, checks and publishes a new version, then opens the bump PR in Chorus. Neither
repo has workflows yet (no `.github/` here).

```
chorus-core (private)                                         chorus (public)
dev ──PR (version bumped)──▶ main
                              │ release.yml
                              ├─ test      ubuntu: typecheck, L1 + L2
                              ├─ real-clis self-hosted Mac: chorus-core doctor --full   (gate, §7.2)
                              ├─ build     esbuild bundle + .d.ts, tarball guard, install-from-tarball check
                              ├─ publish   npm publish (public), tag v1.2.3, GitHub release
                              └─ dispatch ───────────────────────────────▶ chorus-core-bump.yml
                                                                           branch deps/chorus-core-1.2.3,
                                                                           exact version, npm test, PR into dev
```

### 7.1 `chorus-core/.github/workflows/release.yml`

| Step | What | Fails when |
|---|---|---|
| Trigger | `push` to `main` (the dev → main merge), plus `workflow_dispatch` to re-run | — |
| Version | the PR into `main` bumps `package.json` (`npm version patch\|minor` on `dev`). If `npm view @chauvoluuhuong/chorus-core@<version>` already exists, the workflow stops green with "nothing to release" (a docs-only merge) | — |
| test | `npm ci`, `npm run typecheck`, `npm test` on Node 22 and 26 (L1 against fixtures, L2 with the fake agent) | any test |
| real-clis | §7.2 | any doctor case ✖ |
| build | `npm run build`: esbuild for the three entries, `tsc --emitDeclarationOnly`; then `npm pack`; the guard lists the tarball and fails on anything outside `dist/`, `package.json`, `README.md`, `LICENSE`; the tarball is installed into an empty folder and imported from plain JS | a stray file; an import error |
| publish | `npm publish --access public` with secret `NPM_TOKEN` (a granular token that can publish only this package). npm provenance is not available from a private repo | — |
| tag | `git tag v<version>`, GitHub release in chorus-core with the changelog and the verified CLI versions | — |
| dispatch | `repository_dispatch` to `chauvoluuhuong/chorus`, event `chorus-core-released`, payload `{ version, verified: { claude, codex, agy } }`, with secret `CHORUS_DISPATCH_TOKEN` (a fine-grained token or GitHub App: contents and pull requests on `chorus` only) | — |

### 7.2 The real-CLI gate

Rule 3 wants the real CLIs, and a cloud runner can't log in to them. chorus-core is private, so a **self-hosted runner on the Mac**
(label `real-clis`, the CLIs logged in there) is safe to use; on the public Chorus repo it would not be (anyone's PR could run on
the Mac), so Chorus never gets one. The job runs `chorus-core doctor --full --json`, uploads the report as an artifact, and blocks
publishing on any ✖. When the Mac is off the job waits; `workflow_dispatch` with `skip-real-clis` (and the reason in the release
notes) is the way out for an urgent fix.

The same runner, on a daily schedule, runs `--quick` against whatever CLI versions are installed (they auto-update), so a CLI
update that breaks something is caught before buyers report it.

### 7.3 `chorus/.github/workflows/`

| Workflow | Trigger | What |
|---|---|---|
| `ci.yml` | PRs and pushes | `npm ci`, `npm run typecheck`, `npm test` (no secrets, safe for outside PRs) |
| `chorus-core-bump.yml` | `repository_dispatch: chorus-core-released` | branch `deps/chorus-core-<version>`, `npm install @chauvoluuhuong/chorus-core@<version> --save-exact`, CI, PR into `dev` with the release notes and verified versions |
| `release.yml` | push to `main` with a new `@chauvoluuhuong/chorus` version | `npm publish` of `@chauvoluuhuong/chorus` (public repo, so with provenance); `Chorus.app` built on a macOS runner (`scripts/package-release.mjs`), signed and notarised once that is set up, zip and dmg attached to a GitHub release of `chauvoluuhuong/chorus` |

The installers download `Chorus-macOS.zip` from `chauvoluuhuong/homebrew-chorus` releases today (`packaging/install.sh`,
`packages/installer`, `src/cli/desktop-install.ts`); they switch to `chauvoluuhuong/chorus` releases.

### 7.4 What a CLI break looks like end to end

1. The daily run (or a buyer's doctor report in `chauvoluuhuong/chorus` issues, which carries the chorus-core version) shows ✖ on a
   case.
2. Fix in chorus-core on `dev`: new fixtures from the probe, adapter change, `npm version patch`, PR to `main`.
3. Merge: `release.yml` tests, runs the real CLIs, publishes `1.2.4`, opens the Chorus bump PR.
4. Merge the bump PR into `dev`, then `dev` into `main` in Chorus: a new `@chauvoluuhuong/chorus` patch, and buyers get it with
   `npm update -g @chauvoluuhuong/chorus` (or the app's update, later).

The verified-versions table (today's `VERIFIED_VERSION`) is part of each chorus-core release; doctor shows ⚠ when an installed CLI is
newer than it.

## 8. Tests after the split

| Layer | chorus-core | Chorus |
|---|---|---|
| L1 | adapters, detector, discover, limits against fixtures; doctor case pass rules against fixtures; redaction and issue building | store, handoff, MCP tools, UI logic |
| L2 | doctor runner with `fake-agent` (missing CLI, no transcript, auth error, non-TTY) | app and serve with `fake-agent` (imported from chorus-core) |
| L3 | `npm run smoke` (the probes) and `chorus-core doctor --full` | the proofs (`proof`, `proof:desktop`), which use the real CLIs through chorus-core |

## 10. Versions: one probe per version, kept as evidence

The aim is to work with as many versions of each CLI as possible, not only the newest. Built 2026-10-23, in this repo for now
(it moves with the probes): `docs/integrations/versions.md`.

- **Pinned installs** (`tools/probe/clis.mjs`): any npm version of Claude Code or Codex goes into its own prefix under
  `~/.cache/chorus/clis/<cli>/<version>/`, beside the user's own install. agy can't be pinned (it updates itself), so its versions
  are captured as they come.
- **The matrix** (`tools/probe/matrix.mjs <cli> <versions>`): per version, the real CLI runs the probe scenarios (hello, MCP,
  shell, artifact, resume, envelope) and the approval prompt in its TUI; then Chorus's own adapters and approval detector are run
  on that capture (`test/contract/adapters.test.ts`, which now picks up every probed version by itself, so each version stays in
  `npm test` for good). The verdict and links go in `fixtures/<cli>/<version>/matrix.json` and the table in `versions.md`.
- **The tested list** the doctor reads (`docs/doctor.md` §2.1) is generated from the `matrix.json` files with verdict `tested`, and
  ships with each chorus-core release (§7).
- **Adapting to a version** is an adapter change with both versions' captures as tests, never a change that drops an older version
  silently (`versions.md` §4).
- In the release workflow (§7.2), the Mac runner runs the matrix for any new CLI version on the daily schedule, so a version is in
  the tested list, or known broken, before buyers get it.

## 9. Open decisions

1. **npm scope**: `@chauvoluuhuong` must be the npm account that publishes both packages (this Mac has no npm login, so it isn't
   confirmed yet).
2. **Real-CLI gate**: block every release on the Mac runner (proposed), or only warn and rely on the daily run?
3. **Bump PR**: always merged by hand after a look (proposed), or merged on its own when Chorus CI is green, for patch versions?
4. **The CLI-side risk cases** (`tools/risk/`): move them, or keep the whole harness in Chorus for now?
5. **`node-pty`** as a peer dependency of the `pty` entry (proposed), or keep PTY handling in Chorus and have chorus-core only take
   screen text?
