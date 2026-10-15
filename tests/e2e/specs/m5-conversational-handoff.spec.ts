import { test, expect } from '@playwright/test';

test.describe('Milestone 5: Conversational Handoff & Prompt Envelope Delta', () => {
  test('E2E-M5-CONVERSATIONAL-HANDOFF: should trigger handoff, show candidate agents, transfer context, and spawn target engine', async ({
    page,
  }) => {
    // 1. Navigate to app and wait for harness
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__CHORUS_HARNESS__));

    // Verify initially with Claude
    const initialAgent = await page.evaluate(
      () => window.__CHORUS_HARNESS__!.getState().selectedAgent,
    );
    expect(initialAgent).toBe('claude');

    // 2. Click Handoff trigger button
    const handoffBtn = page.locator('[data-test="handoff-trigger-btn"]');
    await expect(handoffBtn).toBeVisible();
    await handoffBtn.click();

    // 3. Assert handoff popover opens with candidate agents
    const popover = page.locator('[data-test="handoff-popover"]');
    await expect(popover).toBeVisible();

    const codexOpt = page.locator('[data-test="handoff-agent-opt-codex"]');
    const agyOpt = page.locator('[data-test="handoff-agent-opt-agy"]');
    await expect(codexOpt).toBeVisible();
    await expect(agyOpt).toBeVisible();

    // Verify candidate options display quota indicators
    await expect(codexOpt).toContainText('quota remaining');
    await expect(agyOpt).toContainText('quota remaining');

    // 4. Setup listener for handoff:completed event
    const handoffEventPromise = page.evaluate(() => {
      return new Promise<any>((resolve) => {
        window.__CHORUS_HARNESS__!.on('handoff:completed', (data: any) => {
          resolve(data);
        });
      });
    });

    // 5. Click Codex candidate option
    await codexOpt.click();
    await expect(popover).not.toBeVisible();

    // 6. Chat Verification: Assert handoff divider appears
    const divider = page.locator('[data-test="handoff-divider"]');
    await expect(divider).toBeVisible();
    await expect(divider).toContainText('Continued with Codex · GPT Codex');

    // 7. Envelope Verification: Assert "What Codex was told" card appears
    const envelopeCard = page.locator('[data-test="handoff-envelope-card"]');
    await expect(envelopeCard).toBeVisible();
    await expect(envelopeCard).toContainText('What CODEX was told');
    await expect(envelopeCard).toContainText('Order form responsive layout');
    await expect(envelopeCard).toContainText('src/components/OrderForm.tsx');
    await expect(envelopeCard).toContainText('<150 tokens');

    // 8. Process Plane & State Verification
    const eventData = await handoffEventPromise;
    expect(eventData.targetAgent).toBe('codex');

    const state = await page.evaluate(() => window.__CHORUS_HARNESS__!.getState());
    expect(state.selectedAgent).toBe('codex');
    expect(state.selectedModel).toBe('GPT Codex');

    const lastEnvelope = await page.evaluate(() =>
      window.__CHORUS_HARNESS__!.getLastPromptEnvelope(),
    );
    expect(lastEnvelope).not.toBeNull();
    expect(lastEnvelope!.target_engine).toBe('codex');
    expect(lastEnvelope!.context_files).toContain('src/components/OrderForm.tsx');
  });
});
