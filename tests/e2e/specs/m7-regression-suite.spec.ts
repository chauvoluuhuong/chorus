import { test, expect } from '@playwright/test';

test.describe('Milestone 7: Shared Memory, Activity Log Telemetry & Full System Regression Suite', () => {
  test('E2E-M7-SHARED-MEMORY: should render two-tier memory architecture, budget meter, and KV stores', async ({
    page,
  }) => {
    // 1. Navigate to app and wait for harness
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__CHORUS_HARNESS__));

    // 2. Click nav-memory button in sidebar
    const navMemoryBtn = page.locator('[data-test="nav-memory"]');
    await expect(navMemoryBtn).toBeVisible();
    await navMemoryBtn.click();

    // Verify Shared Memory page is visible
    const memoryPage = page.locator('[data-test="shared-memory-page"]');
    await expect(memoryPage).toBeVisible();

    // 3. Verify Ring Buffer Telemetry Banner
    const ringBanner = page.locator('[data-test="ring-banner"]');
    await expect(ringBanner).toBeVisible();
    await expect(ringBanner).toContainText('In-DB Ring Buffer Telemetry');
    await expect(ringBanner).toContainText('142 / 500 events');
    await expect(ringBanner).toContainText('3,850 / 8,000 tokens');

    const budgetBar = page.locator('[data-test="token-budget-bar"]');
    await expect(budgetBar).toBeVisible();

    // 4. Verify Two-Tier Memory Cards
    await expect(page.locator('[data-test="memory-tiers"]')).toBeVisible();
    await expect(page.locator('[data-test="tier-1-card"]')).toBeVisible();
    await expect(page.locator('[data-test="tier-1-card"]')).toContainText('Working Memory (Ephemeral KV)');
    await expect(page.locator('[data-test="tier-2-card"]')).toBeVisible();
    await expect(page.locator('[data-test="tier-2-card"]')).toContainText('Project Memory (Persistent Stores)');

    // 5. Verify Tier 1 Working Memory entries
    const goalEntry = page.locator('[data-test="memory-entry-active_goal"]');
    await expect(goalEntry).toBeVisible();
    await expect(goalEntry).toContainText('Order form responsive layout');

    const touchedFilesEntry = page.locator('[data-test="memory-entry-touched_files"]');
    await expect(touchedFilesEntry).toBeVisible();
    await expect(touchedFilesEntry).toContainText('OrderForm.tsx');

    // 6. Verify Tier 2 Project Memory documents
    const archDoc = page.locator('[data-test="project-doc-doc-arch"]');
    await expect(archDoc).toBeVisible();
    await expect(archDoc).toContainText('.chorus/memory/ARCHITECTURE.md');

    const decisionsDoc = page.locator('[data-test="project-doc-doc-decisions"]');
    await expect(decisionsDoc).toBeVisible();
    await expect(decisionsDoc).toContainText('.chorus/memory/DECISIONS.md');

    // 7. Verify Harness DB inspection for memory
    const memoryRecords = await page.evaluate(() => window.__CHORUS_HARNESS__!.getDatabaseRecords('memory'));
    expect(memoryRecords.length).toBeGreaterThanOrEqual(3);
    const goalRecord = memoryRecords.find((r: any) => r.key === 'active_goal');
    expect(goalRecord).toBeDefined();
    expect(goalRecord.updatedBy).toBe('claude');
  });

  test('E2E-M7-ACTIVITY-LOG: should inspect In-DB Ring Buffer events, filter by type, and display event JSON payloads', async ({
    page,
  }) => {
    // 1. Navigate to app and wait for harness
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__CHORUS_HARNESS__));

    // 2. Click nav-activity button in sidebar
    const navActivityBtn = page.locator('[data-test="nav-activity"]');
    await expect(navActivityBtn).toBeVisible();
    await navActivityBtn.click();

    // Verify Activity Log page is visible
    const activityPage = page.locator('[data-test="activity-log-page"]');
    await expect(activityPage).toBeVisible();

    // 3. Verify Telemetry Stats
    await expect(page.locator('[data-test="stat-total-events"]')).toBeVisible();
    await expect(page.locator('[data-test="stat-tool-calls"]')).toContainText('18');
    await expect(page.locator('[data-test="stat-approvals"]')).toContainText('3');
    await expect(page.locator('[data-test="stat-handoffs"]')).toContainText('2');

    // 4. Verify Activity Table rows
    const ev101 = page.locator('[data-test="event-row-ev-101"]');
    const ev102 = page.locator('[data-test="event-row-ev-102"]');
    const ev103 = page.locator('[data-test="event-row-ev-103"]');
    await expect(ev101).toBeVisible();
    await expect(ev102).toBeVisible();
    await expect(ev103).toBeVisible();

    // 5. Test Filter Buttons: Filter by "appr"
    const apprFilterBtn = page.locator('[data-test="filter-btn-appr"]');
    await expect(apprFilterBtn).toBeVisible();
    await apprFilterBtn.click();

    // Assert only appr event is visible
    await expect(ev103).toBeVisible();
    await expect(ev101).not.toBeVisible();
    await expect(ev102).not.toBeVisible();

    // 6. Click on the appr event row to inspect details
    await ev103.click();

    const detailPane = page.locator('[data-test="event-detail-pane"]');
    await expect(detailPane).toBeVisible();
    await expect(detailPane).toContainText('Event Detail: ev-103');
    await expect(detailPane).toContainText('Privileged execution gate requested');

    const jsonPayload = page.locator('[data-test="event-json-payload"]');
    await expect(jsonPayload).toBeVisible();
    await expect(jsonPayload).toContainText('npx prisma migrate dev');
    await expect(jsonPayload).toContainText('HIGH');

    // 7. Reset filter to "all"
    const allFilterBtn = page.locator('[data-test="filter-btn-all"]');
    await allFilterBtn.click();
    await expect(ev101).toBeVisible();
    await expect(ev102).toBeVisible();
  });

  test('E2E-M7-REGRESSION-SUITE: should verify cross-view state preservation and harness lifecycle consistency', async ({
    page,
  }) => {
    // 1. Navigate to app and wait for harness
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__CHORUS_HARNESS__));

    // 2. Cycle through all views and verify clean switching
    await page.locator('[data-test="nav-terminal"]').click();
    await expect(page.locator('[data-test="terminal-container"]')).toBeVisible();

    await page.locator('[data-test="nav-skills"]').click();
    await expect(page.locator('[data-test="skills-studio-page"]')).toBeVisible();

    await page.locator('[data-test="nav-memory"]').click();
    await expect(page.locator('[data-test="shared-memory-page"]')).toBeVisible();

    await page.locator('[data-test="nav-activity"]').click();
    await expect(page.locator('[data-test="activity-log-page"]')).toBeVisible();

    await page.locator('[data-test="nav-chat"]').click();
    await expect(page.locator('[data-test="chat-timeline"]')).toBeVisible();

    // 3. Verify Theme toggling
    const darkBtn = page.locator('[data-test="theme-dark-btn"]');
    await darkBtn.click();
    await expect(page.locator('.window')).toHaveAttribute('data-theme', 'dark');

    const lightBtn = page.locator('[data-test="theme-light-btn"]');
    await lightBtn.click();
    await expect(page.locator('.window')).toHaveAttribute('data-theme', 'light');

    // 4. Verify Thread creation
    const newChatBtn = page.locator('[data-test="new-chat-btn"]');
    await newChatBtn.click();
    const state = await page.evaluate(() => window.__CHORUS_HARNESS__!.getState());
    expect(state.threads.length).toBe(3);
  });
});
