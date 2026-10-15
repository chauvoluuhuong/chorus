# End-to-End (E2E) Testing Architecture: Controllable Component Testing for Chorus Desktop

> **Status**: Approved Specification  
> **Target Branch**: `dev`  
> **Companions**: [`../ui-use-cases.md`](../ui-use-cases.md), [`../ui-mockup-v3.html`](../ui-mockup-v3.html), [`cli-engine-adapters.md`](cli-engine-adapters.md), [`../system-architecture.md`](../system-architecture.md)

---

## 1. Executive Summary & Philosophy

Testing an AI multi-engine desktop application like Chorus presents unique challenges that traditional E2E web testing frameworks cannot address:

1. **The PTY & Subprocess Boundary**: Chorus doesn't just call HTTP APIs; it spawns native OS processes (`claude`, `agy`, `codex`) inside pseudo-terminals (`portable-pty`/`node-pty`), streams raw ANSI escape codes to `xterm.js`, and pipes raw keystrokes (`y\n`, `Ctrl+C`) back through stdin.
2. **Deterministic Reproducibility**: Relying on live LLM APIs (Anthropic, Google, OpenAI) for E2E tests is non-viable: it costs real money, takes 30–90 seconds per test, suffers from network flakes, and is inherently non-deterministic.
3. **Deep Component Controllability**: To make tests as **real as possible**, tests must drive the actual application UI via real DOM events (clicks, mouse drags on `#art-resizer`, text inputs) while simultaneously possessing white-box control over internal component states, PTY event streams, filesystem watch events, and database persistence.

### The Chorus Testing Principle: "Real OS Mechanics with Deterministic Component Control"

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       PLAYWRIGHT TEST CONTROLLER                            │
│  - Real DOM clicks, drag-and-drop, keyboard input                           │
│  - Assertions on Canvas, Chat bubbles, Approvals, Resizers                  │
└──────────────────────┬───────────────────────────────┬──────────────────────┘
                       │                               │
         (1) Component Test Harness        (2) PTY & Subprocess Control
                       ▼                               ▼
┌──────────────────────────────────────┐  ┌───────────────────────────────────┐
│     window.__CHORUS_HARNESS__        │  │     chorus-cli-mock (Real PTY)    │
│  - Inspect React/DOM component state │  │  - Real OS subprocess via PTY    │
│  - Fast-forward async states         │  │  - Real stdin/stdout/ANSI pipes   │
│  - Subscribe to internal bus events  │  │  - Scriptable interactive prompts │
│  - Override settings & feature flags │  │  - Deterministic exit codes/errors│
└──────────────────────┬───────────────┘  └─────────────────┬─────────────────┘
                       │                                    │
                       ▼                                    ▼
┌──────────────────────────────────────┐  ┌───────────────────────────────────┐
│     OS Filesystem & File Watcher     │  │     SQLite & MCP Test Sandbox     │
│  - Isolated temp workspace per test  │  │  - Isolated DB fixture in /tmp    │
│  - Real writes to .chorus/artifacts/ │  │  - Inspect threads, executions    │
│  - Real Chokidar hot-reload events   │  │  - Validate agent-bridge-mcp      │
└──────────────────────────────────────┘  └───────────────────────────────────┘
```

---

## 2. The 4-Layer Testing Architecture

### Layer 1: Component & UI Control Plane (Playwright + Test Harness)

Playwright runs against the real Electron application bundle (or development app). To eliminate brittle DOM polling and allow precise component inspection, Chorus exposes a typed test harness on `window.__CHORUS_HARNESS__` when launched with `CHORUS_TEST_MODE=1`.

#### The `window.__CHORUS_HARNESS__` Contract

```typescript
export interface ChorusTestHarness {
  // --- Component State Accessors ---
  getState(): ChorusAppState;
  getActiveThread(): Thread | null;
  getPendingApprovals(): ApprovalRequest[];
  getArtifactPanelWidth(): number;
  isArtifactPanelVisible(): boolean;
  getActiveSkills(): SkillBundle[];
  
  // --- Component Action Dispatchers ---
  setAutonomousMode(enabled: boolean): void;
  setArtifactPanelWidth(widthPx: number): void;
  resetArtifactPanelWidth(): void;
  selectAgentModel(agentId: 'claude' | 'agy' | 'codex', modelId: string): void;
  triggerMidSessionHandoff(targetAgentId: 'claude' | 'agy' | 'codex'): Promise<void>;
  simulateFileDrop(files: { name: string; content: string }[]): Promise<void>;
  
  // --- Observability & Synchronization ---
  waitForState<T>(selector: (state: ChorusAppState) => T, predicate: (val: T) => boolean, timeoutMs?: number): Promise<T>;
  waitForEvent(event: 'pty:data' | 'artifact:updated' | 'approval:requested' | 'handoff:completed', timeoutMs?: number): Promise<any>;
  on(event: string, callback: (...args: any[]) => void): () => void;
  
  // --- DB & Subsystem Inspection ---
  getDatabaseRecords(table: 'threads' | 'turns' | 'executions' | 'artifacts' | 'skills'): Promise<any[]>;
}
```

#### Deterministic Selector Contract
All interactive components from [`ui-mockup-v3.html`](../ui-mockup-v3.html) must provide explicit `data-test` attributes:

| Element | `data-test` Identifier | Purpose |
|---|---|---|
| New Chat Textarea | `[data-test="composer-input"]` | Typing initial user prompt |
| Autonomous Switch | `[data-test="toggle-skip-permissions"]` | Toggling `--dangerously-skip-permissions` |
| Agent Picker Button | `[data-test="agent-picker-btn"]` | Opening agent & model selection menu |
| Send / Stop Button | `[data-test="composer-submit"]` / `[data-test="composer-stop"]` | Sending prompt / Sending `SIGINT` |
| Mid-Session Handoff | `[data-test="handoff-trigger-btn"]` | Opening candidate agent popover |
| Handoff Agent Choice | `[data-test="handoff-agent-opt-codex"]` | Selecting Codex for context transfer |
| Inline Approval Card | `[data-test="inline-approval-card"]` | Card representing held command |
| Approval Allow / Deny | `[data-test="approval-allow-btn"]` / `[data-test="approval-deny-btn"]` | Emitting native `y` or `n` |
| Resizer Splitter | `[data-test="art-resizer"]` | Mouse drag handle on Canvas panel border |
| Canvas Reset Button | `[data-test="canvas-reset-width"]` | Restoring default 580px width |
| Fullscreen Button | `[data-test="canvas-fullscreen-btn"]` | Expanding Canvas to 100vw |
| Sync Skills Button | `[data-test="sync-skills-btn"]` | Triggering filesystem skill scanning |

---

### Layer 2: Native PTY & Deterministic CLI Simulator (`chorus-cli-mock`)

Instead of mocking child processes at the JavaScript layer, Chorus uses an **actual executable binary** (`tests/e2e/stubs/cli-stub.js`) acting as `claude`, `agy`, or `codex`.

1. **Real Pseudo-Terminal**: Chorus executes the stub via `node-pty`. The process has a real PID, an active TTY, stdin, stdout, stderr, and signal traps.
2. **Controllable Script Recipes**: Tests control what the CLI stub does by writing a recipe to a shared FIFO/socket or temp scenario file (`scenario.json`):
   - **Stream Simulation**: Emits realistic ANSI tokens with configurable delay (e.g. 5ms per chunk).
   - **Interactive Tool Approval**: Prints an interactive prompt (`Do you want to run npx prisma migrate? (y/n): `) and blocks on `process.stdin.read()`.
   - **Autonomous Mode Verification**: If `--dangerously-skip-permissions` was passed in `process.argv`, the stub automatically executes the command without printing the prompt.
   - **Rate Limit Trigger**: Outputs `429 Too Many Requests: Claude usage limit reached until 18:00` and exits with code 1.
   - **Real File Creation**: Actually writes artifact files to `.chorus/artifacts/sample.html` during execution.

```typescript
// Example: Test tells the CLI Stub what scenario to run
await cliHarness.setScenario({
  agent: 'claude',
  script: [
    { type: 'stdout', text: 'Analyzing repository structure...\n' },
    { type: 'tool_call', name: 'Bash', command: 'npx prisma migrate dev --name add_orders' },
    { 
      type: 'prompt_approval',
      prompt: 'Allow bash command `npx prisma migrate dev`? (y/n)',
      expectedInput: 'y',
      onApprove: [
        { type: 'stdout', text: 'Applying migration...\n' },
        { type: 'create_file', path: '.chorus/artifacts/dashboard.html', content: '<h1>Orders Dashboard</h1>' }
      ],
      onReject: [
        { type: 'stderr', text: 'Command aborted by user.\n' }
      ]
    },
    { type: 'exit', code: 0 }
  ]
});
```

---

### Layer 3: OS Filesystem & File Watcher Sandbox

Every E2E test runs inside a pristine, isolated workspace folder created dynamically in `/tmp/chorus-e2e-test-${UUID}/`:

```text
/tmp/chorus-e2e-test-a7f3c/
├── .agents/
│   └── skills/
│       └── db-migrate/
│           ├── SKILL.md
│           └── migrate.sh  (chmod +x)
├── .claude/
│   └── skills/
│       └── tailwind-ui/
│           └── SKILL.md
├── .chorus/
│   ├── chorus.sqlite3       (Isolated DB)
│   └── artifacts/           (Watched directory)
│       └── order-flow.html
└── src/
    └── index.ts
```

- When the CLI stub writes to `.chorus/artifacts/order-flow.html`, the real OS `kqueue` / `inotify` event fires.
- Chorus's internal `chokidar` file watcher detects the change and dispatches an `artifact:updated` event to the Canvas WebView.
- Playwright verifies that the Canvas reloaded the updated HTML content without any full page refresh.

---

### Layer 4: SQLite Database & MCP Bridge Sandbox

The test runner has direct access to the isolated SQLite instance in the test workspace:
- Can verify that records in `threads`, `turns`, `executions`, `approvals`, `artifacts`, and `skills` strictly adhere to [`context-and-storage-spec.md`](context-and-storage-spec.md).
- Simulates `agent-bridge-mcp` queries during handoff to verify that Tier 2 context (`get_tool_execution`, `get_artifact_content`) works end-to-end.

---

## 3. Concrete Test Scenarios Mapping to Acceptance Criteria

### Test Scenario 1: Autonomous Mode (`--dangerously-skip-permissions`) Flag (AC-01, UC-01)
1. **Goal**: Verify that toggling the autonomous switch on Home screen passes `--dangerously-skip-permissions` to the CLI spawn command and marks tool execution as auto-approved.
2. **Execution**:
   - Playwright navigates to Home screen.
   - Click `[data-test="toggle-skip-permissions"]`.
   - Verify UI displays `⚡ auto-approve` chiplet.
   - Type `"Run database migrations"` into `[data-test="composer-input"]` and press Enter.
   - **PTY Verification**: Assert CLI stub receives `--dangerously-skip-permissions` in its command line arguments.
   - **UI Verification**: Assert that no Inline Approval Card appears, tool executes immediately, and the tool row displays `⚡ auto-approved (--dangerously-skip-permissions)`.

---

### Test Scenario 2: Interactive Approval Flow & Native Stdin Pipe (AC-06, UC-06)
1. **Goal**: Ensure that when a CLI requires permission, execution halts, an Inline Approval Card appears in Chat, and clicking **Allow (`y`)** pipes `y\n` to the CLI's stdin.
2. **Execution**:
   - Start chat in Safe Mode (autonomous mode OFF).
   - CLI stub emits tool call `npx prisma migrate dev` and halts.
   - Assert `[data-test="inline-approval-card"]` is rendered in chat with command details.
   - Assert Header Bell badge count increases to `1`.
   - Click `[data-test="approval-allow-btn"]`.
   - **Subprocess Verification**: Assert CLI stub stdin receives `y\n`.
   - CLI stub continues execution and exits with 0.
   - Assert card transitions to approved state and Header Bell count resets to `0`.

---

### Test Scenario 3: Artifact Viewer Panel Resizing & Bounds Control (AC-07, UC-07)
1. **Goal**: Real mouse drag testing on `#art-resizer`, verifying min/max clamping, double-click reset, and fullscreen toggle.
2. **Execution**:
   - Open Artifact Viewer (default width = 580px).
   - Locate resizer handle: `const resizer = page.locator('[data-test="art-resizer"]');`
   - **Mouse Drag**: Dispatch `mousedown` on `resizer`, move mouse left by 150px, dispatch `mouseup`.
   - Assert panel width equals `730px` (± 2px).
   - Assert title bar shows `730px` pill indicator.
   - **Double-click Reset**: Dispatch `dblclick` on `resizer`.
   - Assert panel width smoothly snaps back to default `580px`.
   - **Fullscreen Toggle**: Click `[data-test="canvas-fullscreen-btn"]`.
   - Assert panel width expands to `100vw` / chat area hides. Click again to restore.

---

### Test Scenario 4: Voluntary Mid-Session Handoff (AC-08, UC-08)
1. **Goal**: User clicks `[ ⇄ Hand off ]` in composer toolbar, selects Codex, and verifies context transfer via Prompt Envelope.
2. **Execution**:
   - In an active chat session with Claude, click `[data-test="handoff-trigger-btn"]`.
   - Assert `.handoff-popover` appears listing candidate agents (Codex, Antigravity) with quota statuses.
   - Click `[data-test="handoff-agent-opt-codex"]`.
   - **Chat Verification**: Assert handoff divider appears: *"Continued with Codex · GPT Codex"*.
   - **Handoff Envelope Verification**: Assert "What Codex was told" contains Prompt Envelope (<150 tokens) referencing recent goals and touched files.
   - **Process Plane Verification**: Verify Claude PTY is cleanly halted, and Codex stub is spawned in the workspace with Prompt Envelope arguments.

---

### Test Scenario 5: Skills Studio Synchronization (AC-09, UC-09)
1. **Goal**: Verify `Sync skills` button scans workspace directories, imports bundles, and creates real executable files when toggled on.
2. **Execution**:
   - Test harness writes a new skill folder `.claude/skills/tailwind-ui/SKILL.md` to disk.
   - Open Skills Studio in Chorus.
   - Click `[data-test="sync-skills-btn"]`.
   - Assert toast shows: *"Scanned 2 skill folders · 1 new skill imported"*.
   - Assert `tailwind-ui` row appears in the skills list with origin `Imported from .claude/skills`.
   - Toggle switch for `tailwind-ui` to **ON**.
   - **Filesystem Verification**: Assert directory `.agents/skills/tailwind-ui/` is materialized on disk with correct permissions.

---

## 4. Implementation Blueprint & Code Harness

### 4.1 CLI Simulator Stub (`tests/e2e/stubs/cli-stub.ts`)

```typescript
#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

// Read scenario configuration passed via environment or temp file
const scenarioPath = process.env.CHORUS_SCENARIO_FILE;
if (!scenarioPath || !fs.existsSync(scenarioPath)) {
  console.log("Mock CLI initialized. Ready.");
  process.exit(0);
}

const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));

async function runScenario() {
  const hasSkipPerms = process.argv.includes('--dangerously-skip-permissions');

  for (const step of scenario.steps) {
    if (step.type === 'stdout') {
      process.stdout.write(step.text);
    } else if (step.type === 'tool_prompt') {
      if (hasSkipPerms) {
        process.stdout.write(`\n[Auto-Approved --dangerously-skip-permissions] Running: ${step.command}\n`);
      } else {
        process.stdout.write(`\nAuthorize command: ${step.command} [y/n]: `);
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>(resolve => rl.question('', ans => { rl.close(); resolve(ans.trim()); }));
        if (answer.toLowerCase() !== 'y') {
          process.stderr.write(`Permission denied by user.\n`);
          process.exit(1);
        }
        process.stdout.write(`Permission granted.\n`);
      }
    } else if (step.type === 'write_artifact') {
      fs.mkdirSync('.chorus/artifacts', { recursive: true });
      fs.writeFileSync(step.path, step.content);
      process.stdout.write(`Created artifact: ${step.path}\n`);
    } else if (step.type === 'delay') {
      await new Promise(r => setTimeout(r, step.ms));
    }
  }
  process.exit(scenario.exitCode || 0);
}

runScenario().catch(err => {
  console.error(err);
  process.exit(1);
});
```

---

### 4.2 Playwright Test Example: Resizer & Approval Flow

```typescript
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { setupTestWorkspace, createScenario } from '../harness/test-env';

test.describe('Chorus Desktop E2E: Interactive Component Control', () => {
  let workspaceDir: string;

  test.beforeEach(async () => {
    workspaceDir = await setupTestWorkspace();
  });

  test('UC-06 & UC-07: Approvals stream over PTY, trigger artifact creation and resizer drag', async ({ page }) => {
    // 1. Script the CLI stub scenario
    const scenarioFile = await createScenario(workspaceDir, {
      steps: [
        { type: 'stdout', text: 'Scaffolding orders dashboard...\n' },
        { type: 'tool_prompt', command: 'npx prisma migrate dev --name init' },
        { 
          type: 'write_artifact', 
          path: '.chorus/artifacts/dashboard.html', 
          content: '<div class="dashboard"><h1>Live Orders</h1></div>' 
        },
        { type: 'stdout', text: 'All operations completed successfully.\n' }
      ],
      exitCode: 0
    });

    // 2. Launch Chorus with Test Harness & Stubbed CLI PATH
    await page.goto(`file://${path.resolve(__dirname, '../../documents/ui-mockup-v3.html')}`);
    await page.evaluate(() => (window as any).__INIT_TEST_MODE?.());

    // 3. Initiate Chat
    await page.fill('[data-test="composer-input"]', 'Build the orders dashboard with migrations');
    await page.click('[data-test="composer-submit"]');

    // 4. Verify Inline Approval Card appears in chat
    const approvalCard = page.locator('[data-test="inline-approval-card"]');
    await expect(approvalCard).toBeVisible();
    await expect(approvalCard).toContainText('npx prisma migrate dev');

    // 5. Click Allow (y) -> Pipes native 'y' to child PTY stdin
    await page.click('[data-test="approval-allow-btn"]');
    await expect(approvalCard).toContainText('Allowed');

    // 6. Verify Artifact Viewer opens automatically
    const artifactPanel = page.locator('#art-panel');
    await expect(artifactPanel).toBeVisible();
    await expect(page.locator('.art-title')).toContainText('dashboard.html');

    // 7. Test Draggable Resizer Component (#art-resizer)
    const resizer = page.locator('#art-resizer');
    const initialBox = await artifactPanel.boundingBox();
    expect(initialBox?.width).toBeCloseTo(580, 5);

    // Drag splitter left by 120px to widen panel
    const resizerBox = await resizer.boundingBox();
    if (resizerBox) {
      await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 100);
      await page.mouse.down();
      await page.mouse.move(resizerBox.x - 120, resizerBox.y + 100, { steps: 5 });
      await page.mouse.up();
    }

    const draggedBox = await artifactPanel.boundingBox();
    expect(draggedBox?.width).toBeCloseTo(700, 10);

    // Double-click resizer to reset to 580px
    await resizer.dblclick();
    const resetBox = await artifactPanel.boundingBox();
    expect(resetBox?.width).toBeCloseTo(580, 5);
  });
});
```

---

## 5. Performance, CI Integration & Zero-Cost Execution

1. **Sub-30s CI Execution**: Because all CLI operations run via the local `chorus-cli-mock` binary, the entire test suite executes in under 30 seconds without network delays.
2. **Zero API Cost**: No Anthropic, OpenAI, or Google API keys are required in CI.
3. **Full Native High-Fidelity**: Because `node-pty` handles real stdin/stdout and signals, tests catch real race conditions, ANSI rendering bugs, and file watcher events that pure mocks would miss.
4. **Headless & Visual Debugging**: Runs headlessly in GitHub Actions (`npx playwright test`) and with visual inspector (`npx playwright test --ui`) during local development.
