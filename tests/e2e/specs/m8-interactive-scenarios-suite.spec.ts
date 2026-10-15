import { test, expect } from '@playwright/test';

test.describe('Milestone 8: Interactive Desktop Scenarios (UC-01 to UC-12)', () => {
  test('E2E-M8-SCENARIOS: should cycle through all 13 mockup scenarios and verify UI state integrity', async ({
    page,
  }) => {
    // 1. Boot app and wait for harness
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__CHORUS_HARNESS__));

    // Verify scenario buttons bar exists
    const scenariosBar = page.locator('[data-test="scenarios-bar"]');
    await expect(scenariosBar).toBeVisible();

    // -------------------------------------------------------------
    // Scenario: UC-01 New Chat (with Handoff select)
    // -------------------------------------------------------------
    await page.locator('[data-test="scenario-btn-home"]').click();
    await expect(page.locator('[data-test="home-screen"]')).toBeVisible();
    await expect(page.locator('#handoff-select')).toBeVisible();
    await expect(page.locator('[data-test="composer-input"]')).toBeVisible();

    // -------------------------------------------------------------
    // Scenario: UC-01 New Chat w/ --dangerously-skip-permissions
    // -------------------------------------------------------------
    await page.locator('[data-test="scenario-btn-skip_perm"]').click();
    await expect(page.locator('[data-test="home-screen"]')).toBeVisible();
    const skipPermToggle = page.locator('[data-test="toggle-skip-permissions"]');
    await expect(skipPermToggle).toBeVisible();
    await expect(skipPermToggle).toHaveClass(/on-warn/);

    // -------------------------------------------------------------
    // Scenario: UC-02 Agent & Quota picker
    // -------------------------------------------------------------
    await page.locator('[data-test="scenario-btn-pick"]').click();
    await expect(page.locator('.menu.up')).toBeVisible();
    await expect(page.locator('.menu.up')).toContainText('Claude Code');
    await expect(page.locator('.menu.up')).toContainText('Plan usage');

    // -------------------------------------------------------------
    // Scenario: UC-06 Direct inline approval (y/n)
    // -------------------------------------------------------------
    await page.locator('[data-test="scenario-btn-inline_approval"]').click();
    const approvalCard = page.locator('[data-test="inline-approval-card"]');
    await expect(approvalCard).toBeVisible();
    await expect(page.locator('[data-test="approval-allow-btn"]')).toBeVisible();
    await expect(page.locator('[data-test="approval-deny-btn"]')).toBeVisible();
    await expect(page.locator('[data-test="approval-command-text"]')).toContainText('npx prisma migrate dev');

    // -------------------------------------------------------------
    // Scenario: UC-04 Running tool & Stop button
    // -------------------------------------------------------------
    await page.locator('[data-test="scenario-btn-tools"]').click();
    await expect(page.locator('[data-test="composer-stop"]')).toBeVisible();

    // -------------------------------------------------------------
    // Scenario: UC-08 1-click Handoff on limit
    // -------------------------------------------------------------
    await page.locator('[data-test="scenario-btn-limit"]').click();
    await expect(page.locator('.limit')).toBeVisible();
    await expect(page.locator('.limit')).toContainText('Claude Code reached its plan usage limit');

    // -------------------------------------------------------------
    // Scenario: UC-08 Mid-session Handoff (Input button)
    // -------------------------------------------------------------
    await page.locator('[data-test="scenario-btn-mid_handoff"]').click();
    const handoffPop = page.locator('[data-test="handoff-popover"]');
    await expect(handoffPop).toBeVisible();
    await expect(page.locator('[data-test="handoff-agent-opt-codex"]')).toBeVisible();
    await expect(page.locator('[data-test="handoff-agent-opt-agy"]')).toBeVisible();

    // -------------------------------------------------------------
    // Scenario: UC-07 Native Artifact (Resizable, Diff, Fullscreen)
    // -------------------------------------------------------------
    await page.locator('[data-test="scenario-btn-artifact"]').click();
    const artPanel = page.locator('[data-test="artifact-canvas-panel"]');
    await expect(artPanel).toBeVisible();
    await expect(page.locator('[data-test="art-resizer"]')).toBeVisible();
    await expect(page.locator('[data-test="artifact-tab-preview"]')).toBeVisible();
    await expect(page.locator('[data-test="artifact-tab-code"]')).toBeVisible();
    await expect(page.locator('[data-test="artifact-tab-diff"]')).toBeVisible();

    // Switch tabs
    await page.locator('[data-test="artifact-tab-code"]').click();
    await expect(page.locator('[data-test="artifact-source"]')).toBeVisible();

    await page.locator('[data-test="artifact-tab-diff"]').click();
    await expect(page.locator('[data-test="artifact-diff"]')).toBeVisible();

    // -------------------------------------------------------------
    // Scenario: UC-05 Raw PTY Terminal
    // -------------------------------------------------------------
    await page.locator('[data-test="scenario-btn-terminal"]').click();
    await expect(page.locator('[data-test="terminal-container"]')).toBeVisible();

    // -------------------------------------------------------------
    // Scenario: UC-10 Shared Memory (Tier 1 & Tier 2)
    // -------------------------------------------------------------
    await page.locator('[data-test="scenario-btn-memory"]').click();
    await expect(page.locator('[data-test="shared-memory-page"]')).toBeVisible();

    // -------------------------------------------------------------
    // Scenario: UC-09 Skills Studio (live search)
    // -------------------------------------------------------------
    await page.locator('[data-test="scenario-btn-skills"]').click();
    await expect(page.locator('[data-test="skills-studio-page"]')).toBeVisible();

    // -------------------------------------------------------------
    // Scenario: UC-11 Activity (Workspace Tools vs Agent Bridge)
    // -------------------------------------------------------------
    await page.locator('[data-test="scenario-btn-activity"]').click();
    await expect(page.locator('[data-test="activity-log-page"]')).toBeVisible();

    // -------------------------------------------------------------
    // Scenario: UC-12 @-Mentions & /-Skills
    // -------------------------------------------------------------
    await page.locator('[data-test="scenario-btn-mention"]').click();
    await expect(page.locator('[data-test="mention-popover"]')).toBeVisible();

    // -------------------------------------------------------------
    // Theme Switcher Verification
    // -------------------------------------------------------------
    const darkBtn = page.locator('[data-test="theme-dark-btn"]');
    await darkBtn.click();
    const windowEl = page.locator('#window');
    await expect(windowEl).toHaveAttribute('data-theme', 'dark');

    const lightBtn = page.locator('[data-test="theme-light-btn"]');
    await lightBtn.click();
    await expect(windowEl).toHaveAttribute('data-theme', 'light');
  });
});
