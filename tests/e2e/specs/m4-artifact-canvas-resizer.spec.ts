import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test.describe('Milestone 4: Scoped Artifacts & Draggable Canvas Viewer', () => {
  const artifactRelPath = '.chorus/artifacts/claude/test-thread/dashboard.html';
  const artifactFullPath = path.resolve(process.cwd(), artifactRelPath);

  test.afterEach(() => {
    try {
      if (fs.existsSync(artifactFullPath)) {
        fs.unlinkSync(artifactFullPath);
      }
    } catch {
      // ignore
    }
  });

  test('E2E-M4-ARTIFACT-CANVAS-RESIZER: should drag-resize canvas panel, reset on double click, toggle fullscreen, and watch disk artifacts', async ({
    page,
  }) => {
    // 1. Navigate to app and wait for harness
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__CHORUS_HARNESS__));

    // 2. Open Artifact Viewer with initial mock artifact
    await page.evaluate(() => {
      window.__CHORUS_HARNESS__!.setActiveArtifact({
        id: 'art-initial',
        threadId: 'test-thread',
        agent: 'claude',
        path: '.chorus/artifacts/claude/test-thread/dashboard.html',
        name: 'dashboard.html',
        version: 1,
        content: '<h1>Initial Dashboard</h1>',
        createdAt: 'Just now',
      });
      window.__CHORUS_HARNESS__!.setArtifactPanelWidth(580);
    });

    const panel = page.locator('[data-test="artifact-canvas-panel"]');
    await expect(panel).toBeVisible();

    const resizer = page.locator('[data-test="art-resizer"]');
    await expect(resizer).toBeVisible();

    // Verify initial width is 580px
    const initialBox = await panel.boundingBox();
    expect(initialBox).not.toBeNull();
    expect(Math.round(initialBox!.width)).toBe(580);

    // 3. Mouse Drag: mousedown on resizer, move mouse left by 150px (to 730px), mouseup
    const resizerBox = await resizer.boundingBox();
    expect(resizerBox).not.toBeNull();

    const startX = resizerBox!.x + resizerBox!.width / 2;
    const startY = resizerBox!.y + resizerBox!.height / 2;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    // Drag left by 150px
    await page.mouse.move(startX - 150, startY, { steps: 5 });
    await page.mouse.up();

    // 4. Assert panel width equals 730px (± 2px)
    await expect.poll(async () => {
      const b = await panel.boundingBox();
      return b ? Math.round(b.width) : 0;
    }).toBeGreaterThanOrEqual(728);

    await expect.poll(async () => {
      const b = await panel.boundingBox();
      return b ? Math.round(b.width) : 0;
    }).toBeLessThanOrEqual(732);

    // Assert meta text includes '730px'
    await expect(page.locator('[data-test="artifact-meta"]')).toContainText('730px');

    // 5. Double-click Reset: dblclick on resizer
    await resizer.dblclick();

    // 6. Assert panel width snaps back to default 580px
    await expect.poll(async () => {
      const b = await panel.boundingBox();
      return b ? Math.round(b.width) : 0;
    }).toBe(580);

    // 7. Fullscreen Toggle: click canvas-fullscreen-btn
    const fullscreenBtn = page.locator('[data-test="canvas-fullscreen-btn"]');
    await fullscreenBtn.click();

    // Assert .app has class 'art-full'
    const appEl = page.locator('.app');
    await expect(appEl).toHaveClass(/art-full/);

    // Click again to restore
    await fullscreenBtn.click();
    await expect(appEl).not.toHaveClass(/art-full/);

    // -------------------------------------------------------------
    // 8. Filesystem Watcher Verification:
    // Write new artifact to .chorus/artifacts/claude/test-thread/dashboard.html
    // -------------------------------------------------------------
    const updatedHtml = '<!DOCTYPE html><html><body><h1>Live Streamed Analytics</h1></body></html>';
    
    // Setup harness event listener for artifact:updated
    const artifactUpdatedPromise = page.evaluate(() => {
      return new Promise<string>((resolve) => {
        window.__CHORUS_HARNESS__!.on('artifact:updated', (art: any) => {
          resolve(art.name);
        });
      });
    });

    // Write file via bridge endpoint (or direct fs)
    await page.request.post('/api/artifacts/notify', {
      data: {
        filePath: artifactRelPath,
        content: updatedHtml,
      },
    });

    const updatedArtName = await artifactUpdatedPromise;
    expect(updatedArtName).toBe('dashboard.html');

    // Verify canvas viewer automatically loads the artifact
    await expect(page.locator('[data-test="artifact-title"]')).toHaveText('dashboard.html');

    // Verify iframe or preview contains updated content
    const iframe = page.locator('[data-test="artifact-iframe"]');
    await expect(iframe).toBeVisible();
    const srcDoc = await iframe.getAttribute('srcDoc');
    expect(srcDoc).toContain('Live Streamed Analytics');
  });
});
