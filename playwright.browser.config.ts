import { defineConfig } from '@playwright/test';

/**
 * Non-pixel Chromium harness suite: DOM behaviour, focus management, keyboard
 * navigation, scroll pinning, and layout/geometry invariants.
 *
 * Unlike `playwright.config.ts` (`test/screenshots`, `workers: 1`), none of
 * these specs compare pixels against Linux-rendered PNG baselines, so they run
 * deterministically across parallel workers AND pass natively on both macOS
 * and Linux without needing `dev-builder` or the pinned Playwright container.
 */
export default defineConfig({
  testDir: './test/browser',
  workers: process.env.CI ? 4 : undefined,
  use: {
    viewport: { width: 420, height: 740 },
    deviceScaleFactor: 2,
    timezoneId: 'America/New_York',
    locale: 'en-US',
  },
  projects: [{ name: 'chromium' }],
  outputDir: 'test-results-browser',
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-browser-report' }]]
    : 'list',
});
