import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPORT_DIR =
  '/Users/huong/.gemini/antigravity/brain/bed1d1fc-a1d0-4c28-bdc8-4facfda1e088';

test.describe.serial('Real AGY CLI E2E Suite (Zero Mocks)', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    // Remove any previous artifact files so Test 3 verifies fresh creation
    const artifactsDir = path.resolve(process.cwd(), '.chorus/artifacts');
    if (fs.existsSync(artifactsDir)) {
      fs.rmSync(artifactsDir, { recursive: true, force: true });
    }
    const rootArtifact = path.resolve(process.cwd(), 'this_is_artifact.html');
    if (fs.existsSync(rootArtifact)) {
      fs.rmSync(rootArtifact, { force: true });
    }

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    page = await context.newPage();
    await page.goto('/');
  });

  test.afterAll(async () => {
    await page?.context().close();
  });

  test('Test 1: Create a new chat thread, ask AGY to say back "got it" if available -> capture "got it" in Terminal', async () => {
    // 1. Click "New chat" to create a fresh thread
    await page.locator('[data-test="new-chat-btn"]').click();

    // 2. Ask AGY a simple sentence to say back "got it" if available
    const composer = page.locator('[data-test="composer-input"]');
    await expect(composer).toBeVisible();
    await composer.fill('If you are available, say back "got it" and nothing else.');
    await page.locator('[data-test="composer-submit"]').click();

    // 3. Wait for real AGY CLI response on chat screen
    const assistantMsg = page.locator('[data-test="assistant-text"]').last();
    await expect(assistantMsg).toContainText(/got it/i, { timeout: 180000 });

    await page.screenshot({
      path: path.join(REPORT_DIR, 'test1-chat-got-it.png'),
    });

    // 4. Switch to Terminal view and verify "got it" is captured in the terminal
    await page.locator('[data-test="nav-terminal"]').click();
    const terminalContainer = page.locator('[data-test="terminal-container"]');
    await expect(terminalContainer).toBeVisible();
    await expect(terminalContainer).toContainText(/got it/i, { timeout: 30000 });

    // Wait briefly for xterm canvas/DOM rows to settle before screenshot
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(REPORT_DIR, 'test1-terminal-got-it.png'),
    });
  });

  test('Test 2: Tell AGY to call a tool -> see tool on Chat screen and its data captured in Shared Memory', async () => {
    // Switch back to Chat mode
    await page.locator('[data-test="nav-chat-mode"]').click();

    // Ask AGY to call a real tool (view_file on package.json)
    const composer = page.locator('[data-test="composer-input"]');
    await composer.fill(
      'Call the view_file tool to read /Users/huong/chorus/package.json and reply with the package name and version.',
    );
    await page.locator('[data-test="composer-submit"]').click();

    // Verify tool call is rendered on the Chat screen
    const toolCallCard = page.locator('[data-test="chat-tool-call"]').first();
    await expect(toolCallCard).toBeVisible({ timeout: 180000 });
    await expect(toolCallCard.locator('[data-test="tool-call-name"]')).toContainText(
      /view_file/i,
    );
    await expect(toolCallCard.locator('[data-test="tool-call-target"]')).toContainText(
      /package\.json/i,
    );

    // Wait for assistant response text to complete
    const assistantMsg = page.locator('[data-test="assistant-text"]').last();
    await expect(assistantMsg).toContainText(/chorus|0\.1\.0/i, { timeout: 120000 });

    await page.screenshot({
      path: path.join(REPORT_DIR, 'test2-chat-tool-call.png'),
    });

    // Navigate to Shared Memory view and verify tool data is captured
    await page.locator('[data-test="nav-memory"]').click();
    const memoryView = page.locator('[data-test="shared-memory-page"]');
    await expect(memoryView).toBeVisible();

    const memoryList = page.locator('[data-test="working-memory-list"]');
    await expect(memoryList).toContainText(/tool:view_file/i);
    await expect(memoryList).toContainText(/package\.json/i);
    await expect(memoryList).toContainText(/touched_files/i);

    await page.screenshot({
      path: path.join(REPORT_DIR, 'test2-shared-memory.png'),
    });
  });

  test('Test 3: Tell AGY to create an artifact with file name "this_is_artifact.html" -> show that file as artifact in sidebar', async () => {
    // Switch back to Chats view
    await page.locator('[data-test="nav-chat"]').click();

    // Ask AGY to create an artifact file named "this_is_artifact.html"
    const composer = page.locator('[data-test="composer-input"]');
    await composer.fill(
      'Use the write_to_file tool to create an HTML file at "/Users/huong/chorus/.chorus/artifacts/agy/this_is_artifact.html" with a styled card saying "Hello from AGY Real Artifact". Do not use any other filename.',
    );
    await page.locator('[data-test="composer-submit"]').click();

    // Verify "this_is_artifact.html" appears in the left sidebar under Artifacts
    const sidebarArtifact = page.locator(
      '[data-test="sidebar-artifact-this_is_artifact.html"]',
    );
    await expect(sidebarArtifact).toBeVisible({ timeout: 180000 });
    await expect(sidebarArtifact).toContainText('this_is_artifact.html');

    // Verify the right-hand Artifact Canvas Panel is also open showing this_is_artifact.html
    const canvasPanel = page.locator('[data-test="artifact-canvas-panel"]');
    await expect(canvasPanel).toBeVisible();
    await expect(page.locator('[data-test="artifact-title"]')).toHaveText(
      'this_is_artifact.html',
    );

    // Wait for assistant turn to finish and iframe to render
    await expect(page.locator('[data-test="composer-submit"]')).toBeVisible({
      timeout: 120000,
    });
    await page.waitForTimeout(500);

    await page.screenshot({
      path: path.join(REPORT_DIR, 'test3-artifact-sidebar.png'),
    });
  });
});
