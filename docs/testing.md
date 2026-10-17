# Testing strategy

Chorus wraps three CLIs that need logins, cost money per call, and change often. Testing is split
so that most tests are free and deterministic, and the expensive real-CLI tests are few and
scripted.

## Layers

| Layer | What it tests | Real CLI? | Runs where | Cost |
|---|---|---|---|---|
| **L1 contract** | Adapters parse real captured output (`fixtures/<cli>/<version>/`) into the right normalized events | No (fixtures) | CI, anywhere | free |
| **L2 flow** | chorus-cli + chorus-mcp + store end to end, with `fake-agent` standing in for the AI CLI (it launches like one, emits recorded-style events, calls MCP tools, writes artifacts, can simulate a limit hit) | No (fake) | CI, anywhere | free |
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

- `tools/probe/`: the L3 capability probe (5 scenarios per CLI).
- `fixtures/claude/2.1.301/`: real Claude Code output for all 5 scenarios.
- L1 tooling (test runner, fixture tests) arrives with Phase 1; `fake-agent` with Phase 3.
