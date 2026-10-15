import { test, expect } from '@playwright/test';
import { createTestWorkspace } from '../harness/test-env';

test.describe('Milestone 3: Inline Approvals & Autonomous Execution', () => {
  let workspace: Awaited<ReturnType<typeof createTestWorkspace>>;

  test.beforeEach(async () => {
    workspace = await createTestWorkspace();
  });

  test.afterEach(async () => {
    workspace?.cleanup();
  });

  test('E2E-M3-APPROVAL-AND-AUTONOMOUS: Safe Mode halts on approval gate; Autonomous Mode bypasses cleanly', async ({
    page,
  }) => {
    // 1. Safe Mode Scenario
    const scenarioPath = workspace.createScenario({
      steps: [
        {
          type: 'tool_prompt',
          command: 'npx prisma migrate dev',
        },
      ],
      exitCode: 0,
    });

    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__CHORUS_HARNESS__));

    // Assert initially in Safe Mode
    const initialAutonomous = await page.evaluate(
      () => window.__CHORUS_HARNESS__!.getState().autonomousMode,
    );
    expect(initialAutonomous).toBe(false);

    // Spawn test PTY in Safe Mode
    await page.evaluate(async (path) => {
      await window.__CHORUS_HARNESS__!.spawnTestPty({
        env: { CHORUS_SCENARIO_FILE: path },
      });
    }, scenarioPath);

    // Wait for approval card to appear in chat
    const approvalCard = page.locator('[data-test="inline-approval-card"]');
    await expect(approvalCard).toBeVisible({ timeout: 5000 });

    // Verify command text inside approval card
    await expect(page.locator('[data-test="approval-command-text"]')).toContainText(
      'npx prisma migrate dev',
    );

    // Verify Header Bell badge shows '1'
    const bellBadge = page.locator('[data-test="header-bell-badge"]');
    await expect(bellBadge).toBeVisible();
    await expect(bellBadge).toHaveText('1');

    // Click Allow (y)
    const allowBtn = page.locator('[data-test="approval-allow-btn"]');
    await expect(allowBtn).toBeVisible();

    const exitPromise = page.evaluate(() => {
      return new Promise<number>((resolve) => {
        window.__CHORUS_HARNESS__!.on('pty:exit', (code: number) => {
          resolve(code);
        });
      });
    });

    await allowBtn.click();

    // Verify PTY unblocks and exits cleanly with 0
    const exitCode = await exitPromise;
    expect(exitCode).toBe(0);

    // Verify Bell badge is cleared
    await expect(bellBadge).not.toBeVisible();

    // Verify card transitions to allowed
    await expect(approvalCard).toContainText('Allowed · piped y to stdin');

    // -------------------------------------------------------------
    // 2. Autonomous Mode Run
    // -------------------------------------------------------------
    const autoScenarioPath = workspace.createScenario({
      steps: [
        {
          type: 'tool_prompt',
          command: 'npx prisma migrate dev',
        },
      ],
      exitCode: 0,
    });

    // Toggle autonomous mode switch
    const toggleBtn = page.locator('[data-test="toggle-skip-permissions"]');
    await toggleBtn.click();
    await expect(toggleBtn).toContainText('auto-approve');

    const autoExitPromise = page.evaluate(() => {
      return new Promise<number>((resolve) => {
        window.__CHORUS_HARNESS__!.on('pty:exit', (code: number) => {
          resolve(code);
        });
      });
    });

    // Spawn PTY with autonomous mode flag
    await page.evaluate(async (path) => {
      await window.__CHORUS_HARNESS__!.spawnTestPty({
        args: ['tests/e2e/stubs/cli-stub.js', '--dangerously-skip-permissions'],
        env: { CHORUS_SCENARIO_FILE: path },
      });
    }, autoScenarioPath);

    // Verify PTY completes without user intervention
    const autoExitCode = await autoExitPromise;
    expect(autoExitCode).toBe(0);

    // Verify auto-approved tool row is rendered
    const autoApprovedRow = page.locator('[data-test="tool-row-auto-approved"]');
    await expect(autoApprovedRow).toBeVisible();
    await expect(autoApprovedRow).toContainText('auto-approved (--dangerously-skip-permissions)');
  });
});
