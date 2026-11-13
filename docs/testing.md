# Testing strategy

Chorus wraps three CLIs that need logins, cost money per call, and change often. Testing is split
so that most tests are free and deterministic, and the expensive real-CLI tests are few and
scripted.

## Layers

| Layer | What it tests | Real CLI? | Runs where | Cost |
|---|---|---|---|---|
| **L1 contract** | Adapters parse real captured output (`fixtures/<cli>/<version>/`) into the right normalized events | No (fixtures) | CI, anywhere | free |
| **L2 flow** | the chorus CLI + `chorus mcp` + store end to end, with `fake-agent` standing in for the AI CLI (it launches like one, emits recorded-style events, calls MCP tools, writes artifacts, can simulate a limit hit) | No (fake) | CI, anywhere | free |
| **L3 smoke** | The same flows against the real `claude`, `codex`, `agy` | Yes | where the CLI is installed and logged in | small (~$0.02–0.10 per run with cheap models) |

Rules:

- A phase is done only when its **L3 smoke test passes** with the real CLIs. Passing L1/L2
  alone isn't enough. (v1 had a fully "green" suite that drove a test harness, and the real app
  didn't work.)
- Every L3 run saves its raw capture. When it fails, the capture becomes a new fixture and an L1
  test that reproduces the bug.
- `fake-agent` behaviour is derived from fixtures, not invented.

## Where each CLI can run

| CLI | Cloud container (Claude Code on the web) | Developer's Mac |
|---|---|---|
| **claude** | ✅ Works today. The container's `claude` is already logged in; all probe scenarios pass. Uses your plan quota. | ✅ |
| **codex** | 🟡 Installs from npm (`@openai/codex`) and starts, but isn't logged in. Works if `OPENAI_API_KEY` is added as an environment secret (then `codex login --with-api-key`). | ✅ |
| **agy** | 🔴 Not possible now: `antigravity.google` (installer) isn't reachable from the container, there's no official npm package, and login is a Google account. Possible only if the network policy allows the installer and a `GEMINI_API_KEY` secret is added. | ✅ |

## Workflow between the cloud and the Mac

1. On the Mac (all three CLIs logged in):
   ```bash
   node tools/probe/probe.mjs codex
   node tools/probe/probe.mjs agy
   ```
   Review `fixtures/` (emails and account ids are redacted, but check), commit, push.
2. In the cloud, L1 parsers and L2 flows get written against those fixtures; L3 runs for Claude
   (and Codex if a key is provided).
3. Each phase ends with an L3 smoke script you run on the Mac:
   `npm run smoke -- --agents claude,codex,agy` (built with the Phase 1 proof). It prints pass/fail and saves
   captures to attach when something fails.

## What's in place now

- `tools/probe/`: capability probe (`probe.mjs`: 5 scenarios per CLI; `pty-probe.mjs`: interactive; `skills-probe.mjs`).
- `fixtures/<cli>/<version>/`: real output for claude 2.1.301, codex 0.163.0, agy 1.4.0 (+ `pty/`, `skills/`).
- **L1** `test/contract/`: adapters against those fixtures. `npm run test:l1`
- **L2** `test/flow/`: store, capture, handoff, MCP server (through a real MCP client), skills sync,
  with `tools/fake-agent` as the AI CLI. `npm test` runs L1 + L2 (no login needed, ~1 s)
- **L3** `test/smoke/run.ts`: `npm run smoke -- --agents claude,codex,agy --phase 1,2,3`. A CLI that is
  not logged in is reported as SKIP with the fix, not FAIL.
- **App (Phase 4)**: `test/app/` (input router, compositor, app shell with a fake TUI in real PTYs; part of `npm test`) and
  `npm run smoke:app` (the real app hosting real claude, codex and agy).
- **Phase 4 proof**: `npm run proof` (`test/smoke/proof.ts`) drives the real `chorus` app in a PTY with real Claude and Codex and saves a PNG per step to `docs/proof/phase4/` and a `report.html` (screenshots + checks) that `npm run proof` opens when it ends. `npm run proof:agy` is the same with agy (30/30 on agy 1.4.2 + Claude 2.1.302); agy's free plan has a small quota, so don't repeat it often (rendered by Chrome headless from the virtual screen). Unit-level app tests: `test/app/` (controller, approval detector on real prompt screens, commands).
- **Phase 5**: `test/serve/` (L2) drives `chorus serve` over HTTP and its WebSocket with the fake TUI: auth, screen replay and live bytes, approvals, handoff, dialogs, resume, skills. `npm run proof:desktop` (`test/smoke/proof-desktop.ts`) drives the desktop page in Chrome headless over the DevTools protocol (real mouse clicks and key presses) with real Claude and Codex, restarts the server, then starts the native app (`desktop/`, built first) and photographs its window; PNGs and `report.html` in `docs/proof/phase5/`.
- **Scripted fake agent** `tools/fake-agent/script.ts`: steps that call given tools with given arguments, from `fake-agent.ts --script <file>` or the fake TUI (`CHORUS_FAKE_SCRIPT`, with `chorus serve --fake-agents`), so a run costs no quota. `test/flow/fake-script.test.ts`.
- **Chat and update fixes**: `test/smoke/proof-chat-fixes.ts` is a stage of chorus-core's Pro harness (fake agents, the module's
  dev bundle; no model calls): the docked ask card (asked twice, Show more, Fold), the right sidebar (Task, Artifacts, Activity,
  Record; open, swap, close, a click or key in the screen), the Update band's states, each beside its scene of
  `ui-mockup-v3.html`. It needs a core built with `--dev` (`node scripts/build.mjs --dev` and `node scripts/build-pro.mjs --dev`)
  that `node_modules/@chauvoluuhuong/chorus-core` points at: `node <core>/test/pro-e2e/run.ts --public "$PWD" --stage <path of
  test/smoke/proof-chat-fixes relative to <core>/test/pro-e2e/checks>`. Pictures and pairs in `.chorus/proof/<branch>/`.
  Update Chorus itself: `test/serve/updates.test.ts` (a fake installer and download server; with `../chorus-admin` next to this
  checkout, also the real `install.sh` against a fake release in temporary folders).
- **Planner loop, approvals, artifacts**: `test/smoke/proof-planner-loop.ts` (the same Pro-harness setup as above, fake agents): New
  chat's `/` and `@`, Artifacts by report and from a device, the sidebar's resize, question and approval cards, Approvals' delete,
  each beside its mockup scene. `test/smoke/proof-planner-real.ts` is the same harness with `--real` (real Claude Code, haiku): a
  Planner plans, asks for the grant, "start" starts step 1 with the skip flag, the Worker asks the Planner and gets the answer; the
  chats' screens are saved as text in `.chorus/proof/<branch>/real-planner-loop/`. A page can draw a device's view on the Mac with
  `sessionStorage chorus-view=device` (only what is drawn changes).
- **First launch**: `npm run proof:first-run` (`test/smoke/proof-first-run.ts`, no model calls, ~30 s) drives the page in Chrome over a fresh Chorus home: the Welcome (Community or Pro) first while the Doctor waits, Keep Community opens the Doctor, a second launch shows neither, and the trial-ended text. `--plans <file>` shows given Welcome words (a backend change not deployed yet). PNGs in `.chorus/proof/first-run/`.
- **Sizes**: `npm run proof:desktop -- --sizes` (`test/smoke/proof-sizes.ts`) opens every screen at a phone, a tablet and a desktop size, light and dark, with fake agents, and checks sideways scroll, cut-off controls and touch sizes; desktop screens are compared with the newest release. Details: [`features/responsive.md`](features/responsive.md).
- **Chrome driver** `test/smoke/chrome.ts`: headless Chrome over the DevTools protocol with real clicks and key presses, used by `proof:desktop` and other e2e runs.
- **Risk harness** `tools/risk/` (`npm run risk -- free|cheap|<case>`): probes known risks with the real CLIs and writes the findings to [risks/](risks/README.md); not part of `npm test`.
- `npm run typecheck`.

## The optional module's seam

`test/serve/pro.test.ts` tests the seam in `chorus serve` and `chorus mcp` with a stand-in module. The real bundle needs a dev build in the
core checkout (`npm run build:pro -- --dev` there, plus its fake licence server); with a plain `npm run build` the app simply has nothing to unlock.
