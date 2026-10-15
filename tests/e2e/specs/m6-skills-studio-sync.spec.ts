import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test.describe('Milestone 6: Cross-Engine Skills Studio & Workspace Auto-Sync', () => {
  const claudeSkillDir = path.resolve(process.cwd(), '.claude/skills/tailwind-ui');
  const claudeSkillFile = path.join(claudeSkillDir, 'SKILL.md');
  const agentSkillDir = path.resolve(process.cwd(), '.agents/skills/tailwind-ui');
  const agentSkillFile = path.join(agentSkillDir, 'SKILL.md');

  test.beforeEach(() => {
    // 1. Write .claude/skills/tailwind-ui/SKILL.md to disk
    fs.mkdirSync(claudeSkillDir, { recursive: true });
    fs.writeFileSync(
      claudeSkillFile,
      '# Tailwind UI Skill\nGenerate accessible UI components styled with Tailwind CSS.',
    );

    // Ensure .agents/skills/tailwind-ui does not exist initially
    if (fs.existsSync(agentSkillDir)) {
      fs.rmSync(agentSkillDir, { recursive: true, force: true });
    }
  });

  test.afterEach(() => {
    // Cleanup generated skill test files
    if (fs.existsSync(claudeSkillDir)) {
      fs.rmSync(claudeSkillDir, { recursive: true, force: true });
    }
    if (fs.existsSync(agentSkillDir)) {
      fs.rmSync(agentSkillDir, { recursive: true, force: true });
    }
  });

  test('E2E-M6-SKILLS-STUDIO-SYNC: should scan multi-engine skills, update origin, and materialize on toggle', async ({
    page,
  }) => {
    // 1. Navigate to app and wait for harness
    await page.goto('/');
    await page.waitForFunction(() => Boolean(window.__CHORUS_HARNESS__));

    // 2. Click nav-skills button in sidebar
    const navSkillsBtn = page.locator('[data-test="nav-skills"]');
    await expect(navSkillsBtn).toBeVisible();
    await navSkillsBtn.click();

    // Verify Skills Studio page is rendered
    const studioPage = page.locator('[data-test="skills-studio-page"]');
    await expect(studioPage).toBeVisible();

    // 3. Click sync-skills-btn to scan workspace directories
    const syncBtn = page.locator('[data-test="sync-skills-btn"]');
    await expect(syncBtn).toBeVisible();
    await syncBtn.click();

    // 4. Verification: Toast notification appears with scan stats
    const toast = page.locator('[data-test="toast-notification"]');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('Scanned 2 skill folders · 1 new skill imported');

    // 5. Verification: Skill row appears with origin Imported from .claude/skills
    const tailwindRow = page.locator('[data-test="skill-row-tailwind-ui"]');
    await expect(tailwindRow).toBeVisible();
    await expect(tailwindRow).toContainText('Imported from .claude/skills');

    // 6. Toggle switch to ON
    const toggle = page.locator('[data-test="skill-toggle-tailwind-ui"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await expect(toggle).toBeChecked();

    // 7. Verification: Assert .agents/skills/tailwind-ui/SKILL.md is materialized on disk
    await expect.poll(() => fs.existsSync(agentSkillFile), {
      message: 'Wait for .agents/skills/tailwind-ui/SKILL.md to be materialized',
      timeout: 5000,
      intervals: [100, 250, 500],
    }).toBe(true);

    const materializedContent = fs.readFileSync(agentSkillFile, 'utf8');
    expect(materializedContent).toContain('Tailwind');
  });
});
