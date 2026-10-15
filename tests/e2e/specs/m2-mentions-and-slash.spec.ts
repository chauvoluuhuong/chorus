import { test, expect } from '@playwright/test';

test.describe('Milestone 2: Chat Plane, Composer Dock, Context Mentions (@) & Skills (/)', () => {
  test('E2E-M2-MENTIONS-AND-SLASH: should trigger popovers on @ and /, insert tokens, and inject context into Prompt Envelope', async ({
    page,
  }) => {
    // 1. Navigate to app and wait for harness
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__CHORUS_HARNESS__));

    const composer = page.locator('[data-test="composer-input"]');
    await expect(composer).toBeVisible();

    // 2. Type "Review " then "@" to trigger Mention Popover
    await composer.fill('Review ');
    await composer.pressSequentially('@');

    const mentionPopover = page.locator('[data-test="mention-popover"]');
    await expect(mentionPopover).toBeVisible();

    // Assert tabs are present: Files, Folders, Artifacts
    await expect(page.locator('[data-test="mention-tab-files"]')).toBeVisible();
    await expect(page.locator('[data-test="mention-tab-folders"]')).toBeVisible();
    await expect(page.locator('[data-test="mention-tab-artifacts"]')).toBeVisible();

    // 3. Select src/components/OrderForm.tsx
    const orderFormItem = page.locator('[data-test="mention-item-src/components/OrderForm.tsx"]');
    await expect(orderFormItem).toBeVisible();
    await orderFormItem.click();

    // Assert token @src/components/OrderForm.tsx is inserted into composer
    await expect(composer).toHaveValue(/@src\/components\/OrderForm\.tsx/);
    await expect(mentionPopover).not.toBeVisible();

    // 4. Type " using " then "/" to trigger Slash Popover
    await composer.pressSequentially('using /');

    const slashPopover = page.locator('[data-test="slash-popover"]');
    await expect(slashPopover).toBeVisible();

    // Assert /db-migrate and /tailwind-ui are visible
    await expect(page.locator('[data-test="slash-item-/db-migrate"]')).toBeVisible();
    const tailwindItem = page.locator('[data-test="slash-item-/tailwind-ui"]');
    await expect(tailwindItem).toBeVisible();

    // 5. Select /tailwind-ui
    await tailwindItem.click();

    // Assert /tailwind-ui token is inserted into composer
    await expect(composer).toHaveValue(/\/tailwind-ui/);
    await expect(slashPopover).not.toBeVisible();

    // 6. Click submit button
    const submitBtn = page.locator('[data-test="composer-submit"]');
    await expect(submitBtn).toBeVisible();
    await submitBtn.click();

    // 7. Verification: Inspect window.__CHORUS_HARNESS__.getLastPromptEnvelope()
    const envelope = await page.evaluate(() => window.__CHORUS_HARNESS__!.getLastPromptEnvelope());
    expect(envelope).not.toBeNull();
    expect(envelope!.user_prompt).toContain('@src/components/OrderForm.tsx');
    expect(envelope!.user_prompt).toContain('/tailwind-ui');

    // Context files must include the mentioned file
    expect(envelope!.context_files).toContain('src/components/OrderForm.tsx');

    // On-demand skills must include the resolved skill content
    expect(envelope!.on_demand_skills.length).toBeGreaterThan(0);
    const tailwindSkill = envelope!.on_demand_skills.find(s => s.toLowerCase().includes('tailwind'));
    expect(tailwindSkill).toBeDefined();
  });
});
