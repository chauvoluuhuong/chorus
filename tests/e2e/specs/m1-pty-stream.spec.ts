import { test, expect } from '@playwright/test';
import { createTestWorkspace } from '../harness/test-env';

test.describe('Milestone 1: PTY Stream & Component Test Harness', () => {
  let workspace: Awaited<ReturnType<typeof createTestWorkspace>>;

  test.beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  test.afterEach(async () => {
    workspace?.cleanup();
  });

  test('E2E-M1-PTY-STREAM: should spawn real PTY process, stream ANSI to xterm, and handle SIGINT', async ({
    page,
  }) => {
    // 1. Prepare deterministic scenario script
    const scenarioPath = workspace.createScenario({
      steps: [
        {
          type: 'stdout',
          text: '\x1b[32m[chorus-mock]\x1b[0m Initialized Claude Code session.\n',
        },
        {
          type: 'delay',
          ms: 4000,
        },
      ],
      exitCode: 0,
    });

    // 2. Navigate to app and wait for harness
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__CHORUS_HARNESS__));

    // 3. Spawn test PTY session with scenario configuration
    await page.evaluate(async (path) => {
      await window.__CHORUS_HARNESS__!.spawnTestPty({
        env: { CHORUS_SCENARIO_FILE: path },
      });
    }, scenarioPath);

    // 4. Assert PTY status in state is 'connected'
    await page.evaluate(async () => {
      await window.__CHORUS_HARNESS__!.waitForState(
        (s) => s.ptyStatus,
        (status) => status === 'connected',
      );
    });
    const status = await page.evaluate(() => window.__CHORUS_HARNESS__!.getState().ptyStatus);
    expect(status).toBe('connected');

    // 5. Verify Terminal view renders the stream text in @xterm/xterm
    const terminal = page.locator('[data-test="terminal-xterm"]');
    await expect(terminal).toBeVisible();

    // Verify ANSI rendered content appears in the xterm accessibility layer or text content
    await expect(terminal).toContainText('Initialized Claude Code session.');

    // 6. Click Stop button to send SIGINT
    const stopBtn = page.locator('[data-test="composer-stop"]');
    await expect(stopBtn).toBeVisible();

    // Setup listener for pty:exit event before triggering SIGINT
    const exitCodePromise = page.evaluate(() => {
      return new Promise<number>((resolve) => {
        window.__CHORUS_HARNESS__!.on('pty:exit', (code: number) => {
          resolve(code);
        });
      });
    });

    await stopBtn.click();

    // 7. Verify PTY receives SIGINT and exits with code 130
    const exitCode = await exitCodePromise;
    expect(exitCode).toBe(130);

    // 8. Assert harness state transitions to 'terminated'
    const finalState = await page.evaluate(() => window.__CHORUS_HARNESS__!.getState());
    expect(finalState.ptyStatus).toBe('terminated');
  });
});
